/**
 * Current DNS state plus passive DNS history.
 *
 * Live DNS answers the question the whole pipeline branches on: is this domain
 * alive, parked, or gone? Passive DNS answers what it USED to be - historical A
 * records, and crucially historical NAMESERVER records, which reveal who hosted
 * it and which registrar/DNS provider it sat behind over time.
 *
 * Both providers used here are keyless and were verified working: Robtex returns
 * time_first/time_last per record, and Mnemonic works unauthenticated (though
 * anonymous responses zero out firstSeen/lastSeen and flag partialResult).
 */
import { httpGet, withRetry } from './http.js';

const DOH = 'https://dns.google/resolve';
const TYPES = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'SOA', 'CNAME'];

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

  return {
    resolves: anyAnswer,
    nxdomain: nxdomain && !anyAnswer,
    records,
    mailProvider: (records.MX || [])[0] || null,
    vendorTokens: vendors,
    sourceUrl: `${DOH}?name=${domain}`,
    count: Object.keys(records).length,
  };
}

export async function fetchPassiveDns(domain) {
  const out = { robtex: null, mnemonic: null, historicalNameservers: [], historicalIps: [], count: 0 };

  try {
    const { json } = await withRetry(
      () => httpGet(`https://freeapi.robtex.com/pdns/forward/${encodeURIComponent(domain)}`, { timeoutMs: 20_000 }),
      { attempts: 2 },
    );
    // Robtex returns newline-delimited JSON objects in some cases; httpGet parses when it can.
    const rows = Array.isArray(json) ? json : (json ? [json] : []);
    const ns = new Set(); const ips = new Set();
    for (const r of rows) {
      if (r.rrtype === 'NS' && r.rrdata) ns.add(r.rrdata);
      if ((r.rrtype === 'A' || r.rrtype === 'AAAA') && r.rrdata) {
        ips.add(JSON.stringify({ ip: r.rrdata, firstSeen: r.time_first || null, lastSeen: r.time_last || null }));
      }
    }
    out.robtex = { rows: rows.length, sourceUrl: `https://freeapi.robtex.com/pdns/forward/${domain}` };
    out.historicalNameservers.push(...ns);
    out.historicalIps.push(...[...ips].map((s) => JSON.parse(s)));
  } catch (err) { out.robtex = { error: String(err.message).slice(0, 150) }; }

  try {
    const { json } = await withRetry(
      () => httpGet(`https://api.mnemonic.no/pdns/v3/${encodeURIComponent(domain)}?limit=200`, { timeoutMs: 25_000 }),
      { attempts: 2 },
    );
    const data = json?.data || [];
    const ns = new Set();
    for (const r of data) if (r.rrtype === 'ns' && r.answer) ns.add(r.answer);
    out.mnemonic = {
      rows: data.length,
      partial: (json?.responseFlags || []).includes('partialResult'),
      sourceUrl: `https://api.mnemonic.no/pdns/v3/${domain}`,
      note: 'Anonymous access returns partial results with first/last-seen timestamps zeroed.',
    };
    for (const n of ns) if (!out.historicalNameservers.includes(n)) out.historicalNameservers.push(n);
  } catch (err) { out.mnemonic = { error: String(err.message).slice(0, 150) }; }

  out.count = out.historicalNameservers.length + out.historicalIps.length;
  return out;
}
