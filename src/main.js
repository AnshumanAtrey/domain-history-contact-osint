/**
 * domain-history-contact-osint
 *
 * Submit a domain. Get its history and its owner's contacts, with a citable
 * source URL and capture timestamp on every single finding.
 *
 * Design constraints that shaped this file:
 *  1. ONE input field that matters. Adoption across the sibling portfolio tracks
 *     inversely with field count (5 fields -> 1,704 users; 52 fields -> 3 users).
 *  2. A dead domain is the EXPECTED input, not an error. Every run must finish
 *     successfully with a populated, self-explaining report saying which sources
 *     answered and which did not. Apify penalises actors under ~95% success.
 *  3. Contacts are statements, never domain-level aggregates. One row per contact
 *     per source, each with its own provenance.
 */
import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';

import { ArchiveLimiter } from './core/ratelimit.js';
import { ContactStore } from './core/provenance.js';
import { SourceRegistry, STATUS } from './core/sources.js';
import { sampleSnapshots, dedupeByDigest, normalizePath, DEPTH_PRESETS } from './core/sampler.js';
import * as wayback from './collectors/wayback.js';
import { fetchRdap } from './collectors/rdap.js';
import { fetchCerts } from './collectors/crtsh.js';
import { fetchLiveDns, fetchPassiveDns } from './collectors/dns.js';
import { fetchUrlscan, fetchArquivo, fetchGrepApp, fetchCommonCrawl } from './collectors/references.js';
import { extractEmails, extractPhones, extractIdentifiers, classifyEmail } from './extractors/contacts.js';

await Actor.init();

const input = (await Actor.getInput()) || {};
const domains = String(input.domains || '')
  .split(/[\s,;]+/)
  .map((d) => d.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, ''))
  .filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));

const depth = ['quick', 'standard', 'deep'].includes(input.depth) ? input.depth : 'standard';
const pageCap = DEPTH_PRESETS[depth].cap;

if (!domains.length) {
  await Actor.pushData({
    domain: null,
    liveStatus: 'invalid_input',
    error: 'No valid domain found in the input. Enter a domain like example.com, one per line.',
    scannedAt: new Date().toISOString(),
  });
  log.warning('No valid domains in input.');
  await Actor.exit();
}

log.info(`Scanning ${domains.length} domain(s) at depth "${depth}" (up to ${pageCap} archived pages each)`);

const contactsDataset = await Actor.openDataset('contacts');
let browser = null;
let browserUnavailable = false;

/**
 * Render HTML so inline JS executes, WITHOUT spending another archive request.
 *
 * setContent runs the page's own inline scripts and JSON hydration blobs against
 * bytes we already hold, so JS-injected contacts are recovered without a second
 * fetch. That matters because archive.org is the rate-limited resource here, not
 * the CPU - naive `if_` re-navigation would halve throughput against a hard limit.
 *
 * Rendering is strictly a BONUS pass. Every failure path returns null, and a
 * browser that cannot launch at all is latched off rather than retried, so it can
 * never take down the extraction stage. Learned the hard way: launchPlaywright
 * sitting outside the try block let a local browser failure abort the whole
 * archived-pages source after 3 of 30 pages, discarding their extraction.
 */
async function renderHtml(html) {
  if (browserUnavailable) return null;
  try {
    if (!browser) {
      const { launchPlaywright } = await import('crawlee');
      browser = await launchPlaywright({ launchOptions: { headless: true } });
    }
  } catch (err) {
    browserUnavailable = true;
    log.warning(`Headless rendering unavailable, continuing with raw archived bytes only: ${String(err.message).split('\n')[0]}`);
    return null;
  }
  let page = null;
  try {
    page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(400);
    return await page.content();
  } catch {
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

for (const domain of domains) {
  const started = Date.now();
  const sources = new SourceRegistry();
  const contacts = new ContactStore();
  const limiter = new ArchiveLimiter({ log });
  log.info(`=== ${domain}`);

  // 1. Live state first - everything downstream branches on this.
  const live = await sources.run('live_dns', 'Live DNS', () => fetchLiveDns(domain));
  const resolves = !!live?.resolves;
  const liveStatus = !live ? 'unknown' : resolves ? 'resolves' : (live.nxdomain ? 'nxdomain' : 'no_records');
  const regionHint = domain.split('.').pop().length === 2 ? domain.split('.').pop().toUpperCase() : undefined;

  // 2. Registration, certificates, passive DNS - all work on dead domains.
  const rdap = await sources.run('rdap', 'RDAP registration', () => fetchRdap(domain, contacts));
  const certs = await sources.run('crtsh', 'Certificate transparency (crt.sh)', () => fetchCerts(domain, contacts));
  const pdns = await sources.run('passive_dns', 'Passive DNS history', () => fetchPassiveDns(domain));

  // 3. Inbound references - who else mentioned this domain.
  const urlscan = await sources.run('urlscan', 'urlscan.io submissions', () => fetchUrlscan(domain));
  const arquivo = await sources.run('arquivo', 'Arquivo.pt full-text archive', () => fetchArquivo(domain));
  const codeRefs = await sources.run('grepapp', 'Public code search (grep.app)', () => fetchGrepApp(domain));
  const cc = await sources.run('commoncrawl', 'Common Crawl index', () => fetchCommonCrawl(domain));

  // Emails hiding in public code are real contacts - harvest them with provenance.
  if (codeRefs?.rawText) {
    const re = new RegExp(`[A-Za-z0-9._%+-]+@${domain.replace(/\./g, '\\.')}`, 'gi');
    for (const m of new Set(codeRefs.rawText.match(re) || [])) {
      const ref = codeRefs.codeReferences.find((c) => (c.snippet || '').includes(m));
      contacts.add({
        type: 'email',
        value: m.toLowerCase(),
        sourceType: 'grepapp',
        sourceUrl: ref?.url || codeRefs.sourceUrl,
        extractionMethod: 'code-search',
        confidence: classifyEmail(m).confidence,
        context: ref ? `${ref.repo}/${ref.path}` : 'public code',
      });
    }
  }

  // 4. The archive layer - the spine for a dead domain.
  let snapshots = [];
  const cdx = await sources.run('wayback_cdx', 'Wayback CDX index', async () => {
    snapshots = await wayback.fetchSnapshots(domain, limiter, {
      serverLimit: depth === 'deep' ? 15_000 : 5_000,
      deadlineMs: depth === 'deep' ? 120_000 : 60_000,
      maxPages: depth === 'deep' ? 10 : 3,
    });
    return snapshots;
  });

  const deduped = dedupeByDigest(snapshots);
  const sampled = sampleSnapshots(deduped, pageCap);
  log.info(`  archive: ${snapshots.length} captures -> ${deduped.length} deduped -> ${sampled.length} sampled`);

  let pagesFetched = 0; let pagesBlocked = 0; let pagesFailed = 0; let pagesRendered = 0;
  const identifiers = new Map();
  const originServers = new Set();

  if (sampled.length) {
    const limit = pLimit(3);                       // archive.org politeness, not CPU
    await sources.run('wayback_pages', 'Archived page contents', async () => {
      const results = await Promise.all(sampled.map((s) => limit(async () => {
        if (limiter.isHardBlocked) { pagesBlocked += 1; return null; }
        const page = await wayback.fetchSnapshot(s, limiter);
        if (page.error === 'blocked' || page.error === 'rate_limited') { pagesBlocked += 1; return null; }
        if (!page.html) { pagesFailed += 1; return null; }
        pagesFetched += 1;

        if (page.originHeaders?.server) originServers.add(page.originHeaders.server);

        // Parse the byte-original bytes, then the rendered DOM as a second pass.
        const variants = [{ html: page.html, method: 'raw' }];
        const rendered = await renderHtml(page.html);
        if (rendered && rendered !== page.html) { pagesRendered += 1; variants.push({ html: rendered, method: 'rendered' }); }

        for (const v of variants) {
          const $ = cheerio.load(v.html);
          for (const [email, meta] of extractEmails(v.html, $)) {
            const cls = classifyEmail(email);
            contacts.add({
              type: 'email', value: email, sourceType: 'wayback',
              sourceUrl: s.original, snapshotTimestamp: s.timestamp, replayUrl: page.replayUrl,
              extractionMethod: v.method === 'rendered' ? `${meta.method}+rendered` : meta.method,
              confidence: cls.confidence, context: meta.context,
            });
          }
          for (const [, ph] of extractPhones(v.html, $, regionHint)) {
            contacts.add({
              type: 'phone', value: ph.value, key: ph.value.replace(/\D/g, ''), sourceType: 'wayback',
              sourceUrl: s.original, snapshotTimestamp: s.timestamp, replayUrl: page.replayUrl,
              extractionMethod: v.method === 'rendered' ? `${ph.method}+rendered` : ph.method,
              confidence: ph.confidence, context: ph.context,
            });
          }
          for (const [id, kind] of extractIdentifiers(v.html)) {
            if (!identifiers.has(id)) {
              identifiers.set(id, { kind, sourceUrl: s.original, snapshotTimestamp: s.timestamp, replayUrl: page.replayUrl });
            }
          }
        }
        return true;
      })));
      return results.filter(Boolean);
    });
  }

  // 5. Assemble the report. This row is ALWAYS written.
  const summary = contacts.summary();
  const counts = sources.counts();
  const stamps = deduped.map((s) => s.timestamp).sort();

  const report = {
    domain,
    scannedAt: new Date().toISOString(),
    depth,
    liveStatus,
    isDead: !resolves,

    contactsFound: summary.total,
    contactBreakdown: summary.byType,

    sourcesOk: counts.ok,
    sourcesEmpty: counts.empty,
    sourcesFailed: counts.failed,
    sourcesRateLimited: counts.rate_limited,
    coverageExplanation: sources.explain(),
    sources: sources.toArray(),

    registrantOrg: rdap?.registrantOrg || null,
    registrantName: rdap?.registrantName || null,
    registration: rdap || { status: 'unavailable' },

    dns: live || null,
    dnsHistory: {
      historicalNameservers: pdns?.historicalNameservers || [],
      historicalIps: pdns?.historicalIps || [],
      providers: { robtex: pdns?.robtex || null, mnemonic: pdns?.mnemonic || null },
    },

    certificates: certs
      ? {
        total: certs.count,
        firstCertificate: certs.firstCertificate,
        lastCertificate: certs.lastCertificate,
        hostnameCount: certs.hostnameCount,
        hostnames: certs.uniqueHostnames?.slice(0, 200) || [],
        issuers: certs.issuers,
        sourceUrl: certs.sourceUrl,
      }
      : null,

    archive: {
      capturesFound: snapshots.length,
      capturesAfterDedupe: deduped.length,
      pagesSampled: sampled.length,
      pagesFetched,
      pagesRendered,
      renderingAvailable: !browserUnavailable,
      pagesFailed,
      pagesBlocked,
      firstSeen: stamps[0] || null,
      lastSeen: stamps[stamps.length - 1] || null,
      yearsCovered: [...new Set(stamps.map((t) => t.slice(0, 4)))],
      uniquePaths: [...new Set(deduped.map((s) => normalizePath(s.original)))].length,
      priorityPagesSampled: [...new Set(sampled.map((s) => normalizePath(s.original)))]
        .filter((p) => /contact|about|team|staff|imprint|impressum|careers|management|board/.test(p)),
      archiveNote: pagesBlocked
        ? `archive.org blocked or throttled ${pagesBlocked} page fetch(es). Missing contacts here are UNKNOWN, not absent - re-run later.`
        : null,
    },

    hostingHistory: {
      originServersObserved: [...originServers],
      note: originServers.size
        ? 'Recovered from x-archive-orig-* headers, which preserve the dead origin server\'s own response headers.'
        : null,
    },

    embeddedIdentifiers: [...identifiers.entries()].map(([value, m]) => ({ value, ...m })),
    identifierNote: identifiers.size
      ? 'Analytics and ad IDs are baked into archived bytes and survive the domain. Reverse-lookup them to find other domains the same owner ran.'
      : null,

    inboundReferences: {
      urlscan: urlscan ? { count: urlscan.count, total: urlscan.total, scans: urlscan.scans, sourceUrl: urlscan.sourceUrl } : null,
      archiveFullText: arquivo ? { count: arquivo.count, estimatedTotal: arquivo.estimatedTotal, queryUsed: arquivo.queryUsed, references: arquivo.references } : null,
      publicCode: codeRefs ? { count: codeRefs.count, references: codeRefs.codeReferences } : null,
    },

    commonCrawl: cc ? { count: cc.count, index: cc.index, urls: cc.urls?.slice(0, 50) } : null,

    firstSeen: stamps[0] || certs?.firstCertificate || null,
    lastSeen: stamps[stamps.length - 1] || certs?.lastCertificate || null,
    durationMs: Date.now() - started,
  };

  await Actor.pushData(report);

  const rows = contacts.toRows(domain);
  if (rows.length) await contactsDataset.pushData(rows);

  log.info(`  ${domain}: ${summary.total} contacts (${rows.length} statement rows), `
    + `${counts.ok} sources ok / ${counts.empty} empty / ${counts.failed} failed / ${counts.rate_limited} rate-limited`);
}

if (browser) await browser.close().catch(() => {});
await Actor.exit();
