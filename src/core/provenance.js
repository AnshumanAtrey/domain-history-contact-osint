/**
 * Evidence-grade contact store.
 *
 * This is the actor's whole reason to exist, so it is worth being explicit about
 * what it does differently. Every comparable tool - including the Apify store
 * leader vdrmota/contact-info-scraper with 58,951 users - emits domain-level
 * aggregates: a flat array of pages next to a flat array of emails, with no
 * mapping between them. That looks like provenance and is not.
 *
 * WayTrace does better but keeps exactly ONE source_url per value (first page
 * wins) at month granularity, discarding the capture time of every other sighting.
 *
 * Here, a contact is a set of STATEMENTS. Every sighting keeps its own exact
 * 14-digit capture timestamp, original URL, replay URL and extraction method, so
 * an investigator can cite any individual observation.
 */

/** Values sharing a pageId were found on the same capture - a free pivot. */
export class ContactStore {
  constructor() {
    this.entries = new Map();   // `${type}|${key}` -> record
    this.pageIds = new Map();   // sourceUrl -> integer
  }

  #pageId(sourceUrl) {
    if (!this.pageIds.has(sourceUrl)) this.pageIds.set(sourceUrl, this.pageIds.size + 1);
    return this.pageIds.get(sourceUrl);
  }

  /**
   * @param {object} o
   * @param {'email'|'phone'|'person'|'organization'|'address'|'identifier'|'social'} o.type
   * @param {string} o.value            display value
   * @param {string} [o.key]            dedup key (defaults to lowercased value)
   * @param {string} o.sourceType       wayback | commoncrawl | rdap | crtsh | dns | live | urlscan | arquivo | grepapp
   * @param {string} o.sourceUrl        the citable URL
   * @param {string} [o.snapshotTimestamp] 14-digit Wayback timestamp, when applicable
   * @param {string} [o.replayUrl]      archive replay URL for the exact capture
   * @param {string} o.extractionMethod how it was found (regex, cloudflare-xor, json-ld, tel-href, rdap-field, cert-san ...)
   * @param {'high'|'medium'|'low'} [o.confidence]
   * @param {object} [o.context]        surrounding text or field name
   */
  add(o) {
    const key = `${o.type}|${(o.key || o.value || '').toLowerCase().trim()}`;
    if (!key.split('|')[1]) return null;
    if (!this.entries.has(key)) {
      this.entries.set(key, {
        type: o.type,
        value: o.value,
        confidence: o.confidence || 'medium',
        occurrences: 0,
        sightings: [],
      });
    }
    const rec = this.entries.get(key);
    // Highest confidence seen wins.
    const rank = { low: 0, medium: 1, high: 2 };
    if (rank[o.confidence || 'medium'] > rank[rec.confidence]) rec.confidence = o.confidence;
    rec.occurrences += 1;

    const sighting = {
      sourceType: o.sourceType,
      sourceUrl: o.sourceUrl,
      snapshotTimestamp: o.snapshotTimestamp || null,
      replayUrl: o.replayUrl || null,
      extractionMethod: o.extractionMethod,
      pageId: this.#pageId(o.sourceUrl),
      context: o.context || null,
    };
    // Do not store the identical observation twice.
    const dup = rec.sightings.some(
      (s) => s.sourceUrl === sighting.sourceUrl
        && s.snapshotTimestamp === sighting.snapshotTimestamp
        && s.extractionMethod === sighting.extractionMethod,
    );
    if (!dup) rec.sightings.push(sighting);
    return rec;
  }

  /** Fold `dropKey` into `keepKey`: sightings, occurrences and best confidence carry over. */
  merge(keepKey, dropKey) {
    const k = this.entries.get(keepKey); const d = this.entries.get(dropKey);
    if (!k || !d || k === d) return;
    k.sightings.push(...d.sightings);
    k.occurrences += d.occurrences;
    const rank = { low: 0, medium: 1, high: 2 };
    if (rank[d.confidence] > rank[k.confidence]) k.confidence = d.confidence;
    this.entries.delete(dropKey);
  }

  /**
   * "anshumanatrey" from a JSON-LD name field and "Anshuman Atrey" from visible
   * text are one person: identical letters, different spacing and case. So are
   * "Elizabeth A. Holmes" and "Elizabeth Holmes" - a middle initial is optional
   * rendering, not a different person. Merge entries of `type` whose letters
   * match once initials are dropped, keeping the spaced (display-worthy) form.
   */
  dedupeBySpelling(type) {
    const compact = (v) => v.split(/\s+/).filter((w) => w.replace(/\W/g, '').length > 1).join('')
      .toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const seen = new Map();   // compact -> key
    for (const [key, rec] of [...this.entries]) {
      if (rec.type !== type) continue;
      const c = compact(rec.value);
      const prevKey = seen.get(c);
      if (!prevKey) { seen.set(c, key); continue; }
      const prev = this.entries.get(prevKey);
      const keepKey = rec.value.includes(' ') && !prev.value.includes(' ') ? key : prevKey;
      this.merge(keepKey, keepKey === key ? prevKey : key);
      seen.set(c, keepKey);
    }
  }

  /** One row per contact per distinct source, ready to push to the contacts dataset. */
  toRows(domain) {
    const rows = [];
    for (const rec of this.entries.values()) {
      const stamps = rec.sightings.map((s) => s.snapshotTimestamp).filter(Boolean).sort();
      const bySource = new Map();
      for (const s of rec.sightings) {
        if (!bySource.has(s.sourceType)) bySource.set(s.sourceType, []);
        bySource.get(s.sourceType).push(s);
      }
      for (const [sourceType, sightings] of bySource) {
        const primary = sightings[0];
        rows.push({
          domain,
          type: rec.type,
          value: rec.value,
          confidence: rec.confidence,
          sourceType,
          sourceUrl: primary.sourceUrl,
          snapshotTimestamp: primary.snapshotTimestamp,
          replayUrl: primary.replayUrl,
          extractionMethod: primary.extractionMethod,
          pageId: primary.pageId,
          occurrences: sightings.length,
          firstSeen: stamps[0] || null,
          lastSeen: stamps[stamps.length - 1] || null,
          sightings,
        });
      }
    }
    return rows.sort((a, b) => b.occurrences - a.occurrences || a.value.localeCompare(b.value));
  }

  summary() {
    const byType = {};
    for (const rec of this.entries.values()) byType[rec.type] = (byType[rec.type] || 0) + 1;
    return { total: this.entries.size, byType };
  }
}
