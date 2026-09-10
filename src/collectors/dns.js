/**
 * Current DNS state plus passive DNS history.
 *
 * Live DNS answers the question the whole pipeline branches on: is this domain
 * alive, parked, or gone? Passive DNS answers what it USED to be - historical A
 * records, historical NAMESERVER records (who hosted it, which provider it sat
 * behind over time), and CNAMEs, which quietly enumerate subdomains.
 *
 * Both providers used here are keyless and were verified working: Robtex returns
 * time_first/time_last per record, and Mnemonic works unauthenticated (though
 * anonymous responses zero out firstSeen/lastSeen and flag partialResult).
 */
import { httpGet, withRetry } from './http.js';

const DOH = 'https://dns.google/resolve';
const TYPES = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'SOA', 'CNAME'];

/**
 * "Does it resolve" is too coarse to report to an investigator.
 *
 * A domain can answer NOERROR on NS and SOA while having no A, no AAAA and no MX:
 * it is registered and delegated to nameservers, but nothing is hosted and it
 * cannot receive mail. Verified live on emoji.cafe - NS 2 answers, SOA 1 answer,
 * A/AAAA/MX all zero. Reporting that as "resolves" tells the user there is a site
 * to look at when there is not. These states are reported separately.
 */
const LIVE_STATE_MEANING = {
  hosted: 'Resolves to an IP address, so something is hosted here.',
  mail_only: 'No web host, but MX records exist, so this domain still receives email.',
  delegated_no_host: 'Registered and delegated to nameservers, but no A, AAAA or MX record - nothing is hosted and it cannot receive mail. A signpost with no building behind it.',
  nxdomain: 'The domain does not exist in DNS at all. Fully dropped or never registered.',
  no_records: 'DNS answered but returned no records of any type.',
  unknown: 'DNS could not be reached, so the live state is unknown rather than absent.',
};

export async function fetchLiveDns(domain) {
  const records = {};
  let anyAnswer = false;
  let nxdomain = false;

  for (const type of TYPES) {
    try {
      const { json } = await httpGet(`${DOH}?name=${encodeURIComponent(domain)}&type=${type}`, { timeoutMs: 12_000 });
      if (json?.Status === 3) { nxdomain = true; continue; }
      const answers = (json?.Answer || []).map((a) => a.data).filter(Boolean);
      if (answers.length) { records[type] = answers; anyAnswer = true; }
    } catch { /* one record type failing must not fail the whole lookup */ }
  }

  // SaaS verification tokens in TXT tie a domain to named vendors - a real identity signal.
  const txt = (records.TXT || []).join(' ');
  const vendors = [];
  for (const [re, name] of [
    [/google-site-verification/i, 'Google Workspace'],
    [/MS=|ms-domain-verification/i, 'Microsoft 365'],
    [/atlassian-domain-verification/i, 'Atlassian'],
    [/facebook-domain-verification/i, 'Meta'],
    [/stripe-verification/i, 'Stripe'],
    [/shopify/i, 'Shopify'],
    [/zoom/i, 'Zoom'],
    [/docusign/i, 'DocuSign'],
  ]) if (re.test(txt)) vendors.push(name);

  const hosted = !!(records.A || records.AAAA);
  const hasMail = !!records.MX;
  const delegated = !!(records.NS || records.SOA);

  let state;
  if (nxdomain && !anyAnswer) state = 'nxdomain';
  else if (hosted) state = 'hosted';
  else if (hasMail) state = 'mail_only';
  else if (delegated) state = 'delegated_no_host';
  else state = 'no_records';

  return {
    // `hosted` is the honest answer to "is there a website". `resolves` is kept
    // as its historical alias so nothing downstream silently changes meaning.
    hosted,
    resolves: hosted,
    answeredAnything: anyAnswer,
    delegated,
    hasMail,
    state,
    stateExplained: LIVE_STATE_MEANING[state],
    nxdomain: nxdomain && !anyAnswer,
    records,
    mailProvider: (records.MX || [])[0] || null,
    vendorTokens: vendors,
    sourceUrl: `${DOH}?name=${domain}`,
    count: Object.keys(records).length,
  };
}

/** Anonymous Mnemonic zeroes its timestamps; normalise those to null, not 0. */
const stamp = (v) => (v && v !== 0 && v !== '0' ? v : null);

/**
 * Passive DNS harvests EVERY record type, not just nameservers.
 *
 * The original version only collected rrtype NS and discarded everything else,
 * so a domain whose provider returned `a emojis.cafe -> 162.214.80.100` plus three
 * CNAMEs was reported as historicalIps: [] with the source marked empty. The
 * historical IP is one of the most valuable things here - it is what you pivot on
 * to find every other site that shared the box - and CNAME queries enumerate
 * subdomains for free.
 */
export async function fetchPassiveDns(domain) {
  const out = {
    robtex: null,
    mnemonic: null,
    historicalNameservers: [],
    historicalIps: [],
    historicalCnames: [],
    discoveredSubdomains: [],
    count: 0,
  };

  const ns = new Set();
  const ips = new Map();          // ip -> record, deduped across both providers
  const cnames = new Map();       // "from->to" -> record
  const subs = new Set();

  const noteSubdomain = (q) => {
    const host = String(q || '').toLowerCase().replace(/\.$/, '');
    if (host && host !== domain && host.endsWith(`.${domain}`)) subs.add(host);
  };

  try {
    const { json } = await withRetry(
      () => httpGet(`https://freeapi.robtex.com/pdns/forward/${encodeURIComponent(domain)}`, { timeoutMs: 20_000 }),
      { attempts: 2 },
    );
    // Robtex returns newline-delimited JSON objects in some cases; httpGet parses when it can.
    const rows = Array.isArray(json) ? json : (json ? [json] : []);
    for (const r of rows) {
      const type = String(r.rrtype || '').toUpperCase();
      const answer = r.rrdata;
      noteSubdomain(r.rrname);
      if (!answer) continue;
      if (type === 'NS') ns.add(answer);
      else if (type === 'A' || type === 'AAAA') {
        if (!ips.has(answer)) {
          ips.set(answer, {
            ip: answer, firstSeen: stamp(r.time_first), lastSeen: stamp(r.time_last), via: 'robtex',
          });
        }
      } else if (type === 'CNAME') {
        const key = `${r.rrname}->${answer}`;
        if (!cnames.has(key)) cnames.set(key, { from: r.rrname || null, to: answer, via: 'robtex' });
        noteSubdomain(answer);
      }
    }
    out.robtex = { rows: rows.length, sourceUrl: `https://freeapi.robtex.com/pdns/forward/${domain}` };
  } catch (err) { out.robtex = { error: String(err.message).slice(0, 150) }; }

  try {
    const { json } = await withRetry(
      () => httpGet(`https://api.mnemonic.no/pdns/v3/${encodeURIComponent(domain)}?limit=200`, { timeoutMs: 25_000 }),
      { attempts: 2 },
    );
    const data = json?.data || [];
    for (const r of data) {
      const type = String(r.rrtype || '').toLowerCase();
      const answer = r.answer;
      noteSubdomain(r.query);
      if (!answer) continue;
      if (type === 'ns') ns.add(answer);
      else if (type === 'a' || type === 'aaaa') {
        if (!ips.has(answer)) {
          ips.set(answer, {
            ip: answer, firstSeen: stamp(r.firstSeen), lastSeen: stamp(r.lastSeen), via: 'mnemonic',
          });
        }
      } else if (type === 'cname') {
        const key = `${r.query}->${answer}`;
        if (!cnames.has(key)) cnames.set(key, { from: r.query || null, to: answer, via: 'mnemonic' });
        noteSubdomain(answer);
      }
    }
    out.mnemonic = {
      rows: data.length,
      partial: (json?.responseFlags || []).includes('partialResult'),
      sourceUrl: `https://api.mnemonic.no/pdns/v3/${domain}`,
      note: 'Anonymous access returns partial results with first/last-seen timestamps zeroed.',
    };
  } catch (err) { out.mnemonic = { error: String(err.message).slice(0, 150) }; }

  out.historicalNameservers = [...ns];
  out.historicalIps = [...ips.values()];
  out.historicalCnames = [...cnames.values()];
  out.discoveredSubdomains = [...subs].sort();
  out.count = out.historicalNameservers.length + out.historicalIps.length
    + out.historicalCnames.length + out.discoveredSubdomains.length;

  out.note = out.count
    ? 'Historical IPs are pivot points: reverse-lookup one to find every other domain that shared the same server.'
    : 'Neither passive DNS provider holds records for this domain.';

  return out;
}

/* ──────────────────────────── IP geolocation ──────────────────────────── */

/**
 * Geolocate historical IPs via ip-api.com (free, no key, 45 req/min).
 *
 * Takes the historicalIps array from fetchPassiveDns and enriches each
 * entry with country, city, ISP, org, AS number. Uses the batch endpoint
 * to geolocate up to 100 IPs in a single request.
 *
 * @param {{ ip: string }[]} ips - array from fetchPassiveDns().historicalIps
 * @returns {Map<string, object>} ip -> geolocation data
 */
export async function geolocateIps(ips) {
  const geo = new Map();
  if (!ips?.length) return geo;

  // ip-api.com batch endpoint: POST up to 100 IPs at once
  const unique = [...new Set(ips.map((r) => r.ip))].slice(0, 100);
  if (!unique.length) return geo;

  try {
    const res = await fetch('http://ip-api.com/batch?fields=status,query,country,countryCode,regionName,city,isp,org,as,hosting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(unique.map((ip) => ({ query: ip }))),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return geo;
    const results = await res.json();
    for (const r of results) {
      if (r.status === 'success') {
        geo.set(r.query, {
          country: r.country || null,
          countryCode: r.countryCode || null,
          region: r.regionName || null,
          city: r.city || null,
          isp: r.isp || null,
          org: r.org || null,
          as: r.as || null,
          isHosting: r.hosting ?? null,
        });
      }
    }
  } catch { /* geolocation is a bonus, never fail the run */ }

  return geo;
}
