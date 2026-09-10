/**
 * SecurityTrails API integration (BYOK - free tier: 2500 queries/month).
 *
 * SecurityTrails stores 3.4 trillion DNS records and 3 billion WHOIS records
 * collected daily since mid-2008. The free tier gives 2500 API calls/month,
 * which includes:
 *   - DNS history by record type (A, AAAA, MX, NS, SOA, TXT) with first/last dates
 *   - WHOIS history with full registrant details (pre-GDPR)
 *   - Subdomain discovery
 *
 * Free signup at https://securitytrails.com - no credit card needed.
 * When no API key is provided, this collector is silently skipped.
 */

import { log } from 'apify';

const API_BASE = 'https://api.securitytrails.com/v1';

async function stFetch(path, apiKey) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      APIKEY: apiKey,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 429) throw new Error('SecurityTrails rate limited (429)');
  if (res.status === 403 || res.status === 401) throw new Error(`SecurityTrails API key invalid (HTTP ${res.status})`);
  if (!res.ok) throw new Error(`SecurityTrails HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetch historical DNS records for a domain.
 * Uses 2 API calls: A records + NS records (the most useful for investigation).
 *
 * @param {string} domain
 * @param {string} apiKey
 * @returns {object} DNS history with dated records
 */
export async function fetchDnsHistory(domain, apiKey) {
  if (!apiKey) return null;

  const results = { sourceUrl: `https://securitytrails.com/domain/${domain}/history/a`, count: 0 };

  // Fetch A record history (IP addresses over time)
  try {
    const aHistory = await stFetch(`/history/${encodeURIComponent(domain)}/dns/a`, apiKey);
    results.aRecords = (aHistory.records || []).map((r) => ({
      ip: r.values?.[0]?.ip || null,
      allIps: (r.values || []).map((v) => v.ip).filter(Boolean),
      organization: r.organizations?.[0] || null,
      firstSeen: r.first_seen || null,
      lastSeen: r.last_seen || null,
      type: r.type || 'a',
    })).filter((r) => r.ip);
    results.count += results.aRecords.length;
  } catch (err) {
    log.warning(`SecurityTrails A history: ${err.message}`);
    results.aRecords = [];
    results.aError = err.message;
  }

  // Fetch NS record history (nameservers over time - shows hosting providers)
  try {
    const nsHistory = await stFetch(`/history/${encodeURIComponent(domain)}/dns/ns`, apiKey);
    results.nsRecords = (nsHistory.records || []).map((r) => ({
      nameserver: r.values?.[0]?.nameserver || null,
      allNameservers: (r.values || []).map((v) => v.nameserver).filter(Boolean),
      organization: r.organizations?.[0] || null,
      firstSeen: r.first_seen || null,
      lastSeen: r.last_seen || null,
      type: r.type || 'ns',
    })).filter((r) => r.nameserver);
    results.count += results.nsRecords.length;
  } catch (err) {
    log.warning(`SecurityTrails NS history: ${err.message}`);
    results.nsRecords = [];
    results.nsError = err.message;
  }

  results.note = results.count
    ? `${results.aRecords.length} historical A record(s) and ${results.nsRecords.length} NS record(s) with dates.`
    : 'No DNS history found.';

  return results;
}

/**
 * Fetch WHOIS history for a domain.
 * Uses 1 API call. Returns historical registrant details (pre-GDPR gold).
 *
 * @param {string} domain
 * @param {string} apiKey
 * @param {import('../core/provenance.js').ContactStore|null} contacts
 * @returns {object}
 */
export async function fetchWhoisHistory(domain, apiKey, contacts) {
  if (!apiKey) return null;

  const data = await stFetch(`/history/${encodeURIComponent(domain)}/whois`, apiKey);
  const sourceUrl = `https://securitytrails.com/domain/${domain}/history/whois`;

  const records = (data.result?.items || data.items || []).map((r) => {
    const registrant = r.registrant_contact || r.contact?.registrant || {};
    const admin = r.admin_contact || r.contact?.admin || {};
    const tech = r.tech_contact || r.contact?.tech || {};

    return {
      startDate: r.started_raw || r.started || null,
      endDate: r.ended_raw || r.ended || null,
      registrar: r.registrar_name || null,
      nameservers: r.nameservers || [],
      registrant: {
        name: registrant.name || null,
        organization: registrant.organization || null,
        email: registrant.email || null,
        telephone: registrant.telephone || null,
        country: registrant.country || null,
        state: registrant.state || null,
        city: registrant.city || null,
      },
      admin: {
        name: admin.name || null,
        organization: admin.organization || null,
        email: admin.email || null,
      },
      tech: {
        name: tech.name || null,
        email: tech.email || null,
      },
    };
  });

  // Feed contacts into the store
  if (contacts) {
    for (const rec of records) {
      const ts = rec.startDate ? String(rec.startDate).replace(/[^0-9]/g, '').slice(0, 14) : null;

      for (const [role, contact] of [['registrant', rec.registrant], ['admin', rec.admin], ['tech', rec.tech]]) {
        if (contact.email && !isPrivacyGuard(contact.email)) {
          contacts.add({
            type: 'email', value: contact.email.toLowerCase(),
            sourceType: 'securitytrails', sourceUrl,
            snapshotTimestamp: ts,
            extractionMethod: `whois-${role}`,
            confidence: 'high',
            context: `SecurityTrails WHOIS ${role} (${rec.startDate || 'unknown'})`,
          });
        }
        if (contact.name && !isPrivacyGuard(contact.name)) {
          contacts.add({
            type: 'person', value: contact.name,
            sourceType: 'securitytrails', sourceUrl,
            snapshotTimestamp: ts,
            extractionMethod: `whois-${role}`,
            confidence: 'high',
            context: `SecurityTrails WHOIS ${role} (${rec.startDate || 'unknown'})`,
          });
        }
        if (contact.organization && !isPrivacyGuard(contact.organization)) {
          contacts.add({
            type: 'organization', value: contact.organization,
            sourceType: 'securitytrails', sourceUrl,
            snapshotTimestamp: ts,
            extractionMethod: `whois-${role}`,
            confidence: 'high',
            context: `SecurityTrails WHOIS ${role} (${rec.startDate || 'unknown'})`,
          });
        }
        if (contact.telephone && !isPrivacyGuard(contact.telephone)) {
          contacts.add({
            type: 'phone', value: contact.telephone,
            sourceType: 'securitytrails', sourceUrl,
            snapshotTimestamp: ts,
            extractionMethod: `whois-${role}`,
            confidence: 'high',
            context: `SecurityTrails WHOIS ${role} (${rec.startDate || 'unknown'})`,
          });
        }
      }
    }
  }

  return {
    count: records.length,
    records,
    sourceUrl,
    note: records.length
      ? `${records.length} historical WHOIS record(s) found.`
      : 'No WHOIS history records found.',
  };
}

const PRIVACY_KEYWORDS = [
  'redacted', 'privacy', 'private', 'protected', 'whoisguard', 'domains by proxy',
  'contact privacy', 'data protected', 'not disclosed', 'withheld', 'gdpr masked',
  'statutory masking', 'registration private', 'identity protect', 'domain protect',
  'perfect privacy', 'whois privacy', 'proxy', 'super privacy', 'not applicable',
  'non-public', 'abuse@', 'select request',
];

function isPrivacyGuard(value) {
  if (!value || typeof value !== 'string') return true;
  const lower = value.toLowerCase().trim();
  if (!lower || lower === 'n/a' || lower === 'none' || lower === 'null' || lower === '-') return true;
  return PRIVACY_KEYWORDS.some((kw) => lower.includes(kw));
}
