/**
 * Certificate transparency via crt.sh.
 *
 * Why this matters more than it looks: certificates OUTLIVE the domain. When a
 * domain drops, its CT log entries persist forever, which makes this one of the
 * few sources that still answers for a fully dead domain. Every SAN is a hostname
 * that once existed, and each is another surface that may hold contacts.
 *
 * crt.sh also runs an open anonymous PostgreSQL (guest@crt.sh:5432/certwatch) with
 * far richer queries - subject O=/L=/C= fields, and NAME_TYPE='san:rfc822Name'
 * which is literally email addresses embedded in certificates. That is a strong
 * follow-up; v1 uses the keyless JSON API to avoid shipping a pg driver.
 */
import { httpGet, withRetry } from './http.js';

export async function fetchCerts(domain, contactStore) {
  const url = `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json`;
  const { json } = await withRetry(
    () => httpGet(url, { timeoutMs: 45_000 }),
    { attempts: 3, label: 'crt.sh' },
  );
  const rows = Array.isArray(json) ? json : [];

  const hostnames = new Set();
  const issuers = new Set();
  const orgs = new Set();
  let earliest = null;
  let latest = null;

  for (const r of rows) {
    for (const n of String(r.name_value || '').split(/\s+/)) {
      const h = n.trim().toLowerCase().replace(/^\*\./, '');
      if (h && h.endsWith(domain.toLowerCase())) hostnames.add(h);
      // rfc822Name SANs land in name_value too - an email straight out of a cert.
      if (h.includes('@') && contactStore) {
        contactStore.add({
          type: 'email', value: h, sourceType: 'crtsh',
          sourceUrl: `https://crt.sh/?id=${r.id}`,
          extractionMethod: 'cert-san-rfc822', confidence: 'high',
          context: `certificate SAN, issuer ${r.issuer_name || 'unknown'}`,
        });
      }
    }
    if (r.issuer_name) {
      issuers.add(r.issuer_name);
      // OV/EV certs carry the legal org in the SUBJECT; the issuer O= is the CA, not the owner.
      const m = /O=([^,/]+)/.exec(r.issuer_name);
      if (m) orgs.add(m[1].trim());
    }
    const nb = r.not_before;
    if (nb) { if (!earliest || nb < earliest) earliest = nb; if (!latest || nb > latest) latest = nb; }
  }

  return {
    count: rows.length,
    sourceUrl: url,
    uniqueHostnames: [...hostnames].sort(),
    hostnameCount: hostnames.size,
    issuers: [...issuers].slice(0, 20),
    certificateAuthorities: [...orgs].slice(0, 20),
    firstCertificate: earliest,
    lastCertificate: latest,
    note: rows.length
      ? 'Certificates persist after a domain dies, so these hostnames are historical fact.'
      : 'No certificate transparency records. Common for domains that predate widespread HTTPS (before ~2015) or never served TLS.',
  };
}
