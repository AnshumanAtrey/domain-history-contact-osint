/**
 * WHOIS history via Whoxy API (BYOK — bring your own key).
 *
 * Whoxy costs $0.005 per history lookup with data from November 2012.
 * No monthly fee, no charge when no records found. JSON API at:
 *   https://api.whoxy.com/?key=xxxxx&history=example.com
 *
 * This is the only affordable way to get pre-GDPR registrant names,
 * addresses and emails for expired domains. After May 2018, ICANN let
 * registrars redact everything, so the only surviving copy of the
 * registrant's name is the WHOIS history — and no free/open-source
 * alternative exists for that.
 *
 * When no API key is provided this collector is skipped silently, so
 * the actor is still zero-config for everyone who doesn't need it.
 */

import { log } from 'apify';

const API_BASE = 'https://api.whoxy.com/';

/**
 * @param {string} domain
 * @param {string|null} apiKey - Whoxy API key. null = skip.
 * @param {import('../core/provenance.js').ContactStore|null} contacts
 * @returns {object|null}
 */
export async function fetchWhoisHistory(domain, apiKey, contacts) {
  if (!apiKey) return null;

  const url = `${API_BASE}?key=${encodeURIComponent(apiKey)}&history=${encodeURIComponent(domain)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'domain-history-contact-osint/0.4 (Apify actor)' },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    if (res.status === 403 || res.status === 401) {
      throw new Error(`Whoxy API key invalid or expired (HTTP ${res.status})`);
    }
    throw new Error(`Whoxy returned HTTP ${res.status}`);
  }

  const data = await res.json();

  // Whoxy returns { status: 1, ... } on success
  if (data.status !== 1 && data.status !== '1') {
    if (data.status_reason?.includes('no whois history')) {
      return { count: 0, records: [], sourceUrl: url.replace(apiKey, '***'), note: 'No WHOIS history records found.' };
    }
    throw new Error(`Whoxy error: ${data.status_reason || 'unknown'}`);
  }

  const records = (data.whois_records || []).map((r) => {
    const reg = r.registrant_contact || {};
    const admin = r.administrative_contact || {};
    const tech = r.technical_contact || {};

    return {
      queryDate: r.query_time || null,
      createDate: r.create_date || null,
      updateDate: r.update_date || null,
      expiryDate: r.expiry_date || null,
      registrar: r.domain_registrar?.registrar_name || null,
      registrant: {
        name: reg.full_name || null,
        company: reg.company_name || null,
        email: reg.email_address || null,
        phone: reg.phone_number || null,
        city: reg.city_name || null,
        state: reg.state_name || null,
        country: reg.country_name || reg.country_code || null,
      },
      admin: {
        name: admin.full_name || null,
        company: admin.company_name || null,
        email: admin.email_address || null,
      },
      tech: {
        name: tech.full_name || null,
        company: tech.company_name || null,
        email: tech.email_address || null,
      },
      nameservers: r.name_servers || [],
    };
  });

  // Feed contacts into the store with provenance
  if (contacts) {
    const sourceUrl = `https://www.whoxy.com/${encodeURIComponent(domain)}`;
    for (const rec of records) {
      const ts = rec.queryDate ? rec.queryDate.replace(/[^0-9]/g, '').slice(0, 14) : null;

      // Registrant contacts — the gold: pre-GDPR names + emails
      if (rec.registrant.email && !isPrivacyGuard(rec.registrant.email)) {
        contacts.add({
          type: 'email', value: rec.registrant.email.toLowerCase(),
          sourceType: 'whois-history', sourceUrl,
          snapshotTimestamp: ts,
          extractionMethod: 'whois-registrant',
          confidence: 'high',
          context: `WHOIS registrant (${rec.queryDate || 'unknown date'})`,
        });
      }
      if (rec.registrant.phone && !isPrivacyGuard(rec.registrant.phone)) {
        contacts.add({
          type: 'phone', value: rec.registrant.phone,
          sourceType: 'whois-history', sourceUrl,
          snapshotTimestamp: ts,
          extractionMethod: 'whois-registrant',
          confidence: 'high',
          context: `WHOIS registrant (${rec.queryDate || 'unknown date'})`,
        });
      }
      if (rec.registrant.name && !isPrivacyGuard(rec.registrant.name)) {
        contacts.add({
          type: 'person', value: rec.registrant.name,
          sourceType: 'whois-history', sourceUrl,
          snapshotTimestamp: ts,
          extractionMethod: 'whois-registrant',
          confidence: 'high',
          context: `WHOIS registrant (${rec.queryDate || 'unknown date'})`,
        });
      }
      if (rec.registrant.company && !isPrivacyGuard(rec.registrant.company)) {
        contacts.add({
          type: 'organization', value: rec.registrant.company,
          sourceType: 'whois-history', sourceUrl,
          snapshotTimestamp: ts,
          extractionMethod: 'whois-registrant',
          confidence: 'high',
          context: `WHOIS registrant (${rec.queryDate || 'unknown date'})`,
        });
      }

      // Admin contacts — often the real person behind a privacy-guarded registrant
      if (rec.admin.email && !isPrivacyGuard(rec.admin.email) && rec.admin.email !== rec.registrant.email) {
        contacts.add({
          type: 'email', value: rec.admin.email.toLowerCase(),
          sourceType: 'whois-history', sourceUrl,
          snapshotTimestamp: ts,
          extractionMethod: 'whois-admin',
          confidence: 'high',
          context: `WHOIS admin contact (${rec.queryDate || 'unknown date'})`,
        });
      }
      if (rec.admin.name && !isPrivacyGuard(rec.admin.name) && rec.admin.name !== rec.registrant.name) {
        contacts.add({
          type: 'person', value: rec.admin.name,
          sourceType: 'whois-history', sourceUrl,
          snapshotTimestamp: ts,
          extractionMethod: 'whois-admin',
          confidence: 'high',
          context: `WHOIS admin contact (${rec.queryDate || 'unknown date'})`,
        });
      }

      // Tech contacts
      if (rec.tech.email && !isPrivacyGuard(rec.tech.email)
        && rec.tech.email !== rec.registrant.email && rec.tech.email !== rec.admin.email) {
        contacts.add({
          type: 'email', value: rec.tech.email.toLowerCase(),
          sourceType: 'whois-history', sourceUrl,
          snapshotTimestamp: ts,
          extractionMethod: 'whois-tech',
          confidence: 'medium',
          context: `WHOIS tech contact (${rec.queryDate || 'unknown date'})`,
        });
      }
    }
  }

  return {
    count: records.length,
    records,
    sourceUrl: `https://www.whoxy.com/${encodeURIComponent(domain)}`,
    note: records.length
      ? `${records.length} historical WHOIS record(s) found, spanning ${records[0]?.createDate || '?'} to ${records[records.length - 1]?.queryDate || '?'}.`
      : 'No WHOIS history records found.',
  };
}

/**
 * WHOIS privacy guard strings — registrars and privacy services use these
 * as placeholder values when the real registrant is hidden. Extracting
 * "REDACTED FOR PRIVACY" as a person name would be absurd.
 */
const PRIVACY_KEYWORDS = [
  'redacted', 'privacy', 'private', 'protected', 'whoisguard', 'domains by proxy',
  'contact privacy', 'data protected', 'not disclosed', 'withheld', 'gdpr masked',
  'statutory masking', 'registration private', 'identity protect', 'domain protect',
  'perfect privacy', 'whois privacy', 'proxy', '1&1', 'tucows', 'super privacy',
];

function isPrivacyGuard(value) {
  if (!value || typeof value !== 'string') return true;
  const lower = value.toLowerCase().trim();
  if (!lower || lower === 'n/a' || lower === 'none' || lower === 'null') return true;
  return PRIVACY_KEYWORDS.some((kw) => lower.includes(kw));
}
