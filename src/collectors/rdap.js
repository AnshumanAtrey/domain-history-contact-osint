/**
 * RDAP / WHOIS registration data.
 *
 * Context that shapes this file: ICANN sunset the WHOIS obligation on 28 Jan 2025
 * and 374 gTLDs had killed port-43 by Sep 2025, so RDAP is the live protocol now
 * (.com/.net via Verisign are the notable holdouts that still answer WHOIS).
 *
 * The critical behaviour for this actor: RDAP returns 404 for a domain that has
 * fully dropped. That is the EXPECTED case here, not an error - it is positive
 * evidence the registration is gone, and it is reported as such.
 *
 * GDPR redacts most contact fields, but `org` frequently survives - verified
 * live, google.com returns fn='REDACTED REGISTRANT' yet org='Google LLC'. The
 * registrar abuse contact is mandated by ICANN's RDAP Response Profile and is
 * always present, so it is a guaranteed contact with a citable source.
 */
import { httpGet, withRetry } from './http.js';

const BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
let bootstrapCache = null;

export async function loadBootstrap() {
  if (bootstrapCache) return bootstrapCache;
  const { json } = await httpGet(BOOTSTRAP, { timeoutMs: 20_000 });
  const map = new Map();
  for (const [tlds, urls] of json?.services || []) {
    for (const t of tlds) map.set(t.toLowerCase(), urls[0].replace(/\/$/, ''));
  }
  bootstrapCache = { map, publication: json?.publication, version: json?.version };
  return bootstrapCache;
}

function pickVcard(entity, field) {
  const arr = entity?.vcardArray?.[1] || [];
  const hit = arr.find((e) => e[0] === field);
  return hit ? (typeof hit[3] === 'string' ? hit[3] : JSON.stringify(hit[3])) : null;
}

function walkEntities(entities, out = []) {
  for (const e of entities || []) {
    out.push(e);
    if (e.entities) walkEntities(e.entities, out);
  }
  return out;
}

export async function fetchRdap(domain, contactStore) {
  const tld = domain.split('.').pop().toLowerCase();
  const { map, publication } = await loadBootstrap();
  const base = map.get(tld);

  if (!base) {
    return {
      status: 'no_rdap_for_tld',
      tld,
      note: `IANA bootstrap (published ${publication}) lists no RDAP service for .${tld}. `
        + 'Only 15 of 54 African ccTLDs have RDAP, so this is common; legacy port-43 WHOIS may still answer.',
      rdapServer: null, sourceUrl: BOOTSTRAP, handle: null, ldhName: null,
      domainStatus: [], events: [], nameservers: [], registrar: null,
      registrantOrg: null, registrantName: null, registrantRedacted: null,
      abuseEmail: null, abusePhone: null, secureDNS: null,
    };
  }

  const url = `${base}/domain/${domain}`;
  let json;
  try {
    ({ json } = await withRetry(() => httpGet(url, { timeoutMs: 25_000, accept: 'application/rdap+json' }), { attempts: 3 }));
  } catch (err) {
    if (err.status === 404) {
      return {
        status: 'not_registered',
        rdapServer: base,
        sourceUrl: url,
        note: 'RDAP returned 404: this domain is not currently registered. For a dropped domain '
          + 'this is expected and is itself a finding - the only registration record that survives is WHOIS history.',
        handle: null, ldhName: null, domainStatus: [], events: [], nameservers: [],
        registrar: null, registrantOrg: null, registrantName: null,
        registrantRedacted: null, abuseEmail: null, abusePhone: null, secureDNS: null,
      };
    }
    throw err;
  }

  const entities = walkEntities(json?.entities);
  const registrant = entities.find((e) => (e.roles || []).includes('registrant'));
  const registrar = entities.find((e) => (e.roles || []).includes('registrar'));
  const abuse = entities.find((e) => (e.roles || []).includes('abuse'));

  const registrantOrg = registrant ? pickVcard(registrant, 'org') : null;
  const registrantName = registrant ? pickVcard(registrant, 'fn') : null;
  const abuseEmail = (abuse ? pickVcard(abuse, 'email') : null)?.replace(/^mailto:/i, '') || null;
  const abusePhone = (abuse ? pickVcard(abuse, 'tel') : null)?.replace(/^tel:/i, '') || null;

  const redacted = (v) => !v || /redact|privacy|not disclosed|data protected/i.test(v);

  if (contactStore) {
    if (!redacted(registrantOrg)) {
      contactStore.add({
        type: 'organization', value: registrantOrg, sourceType: 'rdap', sourceUrl: url,
        extractionMethod: 'rdap-registrant-org', confidence: 'high', context: 'registrant org',
      });
    }
    if (!redacted(registrantName)) {
      contactStore.add({
        type: 'person', value: registrantName, sourceType: 'rdap', sourceUrl: url,
        extractionMethod: 'rdap-registrant-fn', confidence: 'high', context: 'registrant name',
      });
    }
    if (abuseEmail) {
      contactStore.add({
        type: 'email', value: abuseEmail, sourceType: 'rdap', sourceUrl: url,
        extractionMethod: 'rdap-abuse-email', confidence: 'high', context: 'registrar abuse contact',
      });
    }
    if (abusePhone) {
      contactStore.add({
        type: 'phone', value: abusePhone, sourceType: 'rdap', sourceUrl: url,
        extractionMethod: 'rdap-abuse-tel', confidence: 'high', context: 'registrar abuse contact',
      });
    }
  }

  return {
    status: 'registered',
    rdapServer: base,
    sourceUrl: url,
    handle: json?.handle || null,
    ldhName: json?.ldhName || null,
    domainStatus: json?.status || [],
    events: (json?.events || []).map((e) => ({ action: e.eventAction, date: e.eventDate })),
    nameservers: (json?.nameservers || []).map((n) => n.ldhName).filter(Boolean),
    registrar: registrar ? pickVcard(registrar, 'fn') : null,
    registrantOrg: redacted(registrantOrg) ? null : registrantOrg,
    registrantName: redacted(registrantName) ? null : registrantName,
    registrantRedacted: redacted(registrantOrg) && redacted(registrantName),
    abuseEmail,
    abusePhone,
    secureDNS: json?.secureDNS?.delegationSigned ?? null,
  };
}
