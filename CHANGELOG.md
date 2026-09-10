# Changelog

## 1.0 - 2026-09-11 - first release

First public release. Everything below 1.0 was pre-release development; 0.4 was never deployed.

People, organisations, IP geolocation, and WHOIS history — closes the TruTrace spec gaps.

- **Named people and organisations extracted from archived pages, with roles.** Two
  layers, neither tied to a platform:
  1. *Declared* — schema.org JSON-LD and microdata (`Person`, `Organization`, `founder`,
     `employee`, `worksFor`, `jobTitle`), `<meta name="author">`, `rel="author"`, and the
     copyright footer (`© 2015 Theranos, Inc.`). The page states the type; nothing is guessed.
  2. *Named-entity recognition* — a multilingual token-classification model
     (`bert-base-multilingual-cased-ner-hrl`, int8, 173MB, baked into the image) reads the
     rendered page's `innerText` line by line. A job title on the same visible line becomes
     the person's `role` ("Geschäftsführer: Dirk Hünten, Michael Knippel" labels both), an
     organisation on the same line becomes `worksFor`, and the line itself is kept as a
     citable `snippet`. Lines repeated across a site's pages (header, nav, footer) are
     inferred once and replayed as sightings, so cost scales with unique text, not pages.

  A first version used capitalised-word regexes plus three word blocklists. It reached 4
  people / 0 false positives on the test WordPress site, then emitted "Kosten", "Buch" and
  "Rabatt" as people on the first German page it met — every blocklist entry was a patch
  for one site that guaranteed a different failure on the next. Bake-off across a WordPress
  blog, a hand-built Rails site and a German Impressum (13 ground-truth entities): rule-based
  `compromise` missed every non-Western name; English `bert-base-NER` scored 12/13 but leaked
  6 of 7 known false positives; the multilingual model scored 12/13 and leaked 1 (a lone first
  name, removed by the two-word rule). The one miss was declared in JSON-LD. Filters that
  remain are shape and frequency only: two words minimum for a person, score ≥ 0.9, an
  organisation found on a Title-Case-only line is a menu label unless it is a ≥2-word legal
  entity, and `worksFor` is taken only from short byline lines, never from biography prose.

  Verified end-to-end on theranos.com (dead corporate site, 2013–2015 archive) with no
  site-specific code: the full board — Elizabeth Holmes [Founder], Donald L. Lucas
  [Chairman], Robert B. Shapiro, Channing Robertson, Peter Thomas, William K. Bowes — plus
  the NPR host who interviewed Holmes, correctly left as a mention.
- **`relation: site | mention` on every person and organisation, list sorted site-first.**
  Correct NER on a blog about college admissions returns fifty universities; they are real
  organisations and real noise. `site` means declared in structured data, or (people) seen
  on 3+ distinct pages or carrying a job title, or (organisations) present on at least half
  the pages the way a footer name is. `pagesSeenOn` is exposed so the threshold is auditable.
  `snippet` carries the visible line each entity was read from.
- **Cost measured on the platform, not just the laptop.** Per-page timers log fetch /
  render / extraction / entity time, summed over the 3 parallel workers. On an M-series
  laptop the model was ~3% of a 30-page quick run (people+orgs 6s of 77s). The first live
  run on Apify at the 2048MB minimum told a different story: 531s total, people+orgs 679s -
  1.47s per line against 12ms locally. Cause: onnxruntime sizes its thread pool from the
  HOST's core count, the container's cgroup quota is invisible to it, and a dozen threads
  fought over a half-core share while also starving Chromium (render 346s). Fix: Apify gives
  one CPU per 4096MB and publishes `APIFY_MEMORY_MBYTES`, so `intraOpNumThreads` is
  `round(memory / 4096)`, minimum 1; unset locally, nothing changes. Same run, same 2048MB:
  **182s total, people+orgs 75s, render 162s, 0.10 compute units (was 0.30)**. For
  comparison, 4096MB without the fix: 275s, 0.31 CU - doubling memory halved the time at
  the same cost; fixing the threads cut the cost. Output was identical across all three runs
  and the laptop (same 40 contacts, same 4 site-level entities). Chromium rendering is now
  the largest CPU cost; archive.org fetch is 56s and outside our control.
- **Output layout: the contacts table is the dataset.** One row per contact per source, with
  the URL and capture date that produced it; people and organisations also carry `role`,
  `worksFor`, `relation` and the evidence `snippet`. One summary row per domain closes each
  block with the coverage verdict, so a run is never an empty table. The full report is the
  run's `OUTPUT` record (Console's Output tab) and `REPORT-<domain>`. The previous layout put
  the report in the dataset and the contacts in a separate named dataset, so the Store preview
  showed one JSON blob per domain and the evidence table lived elsewhere. Now every output is
  inside the run's own default storages, which is the contract the Actor's limited-permissions
  declaration is meant for, the Store preview is the contacts table itself, and pay-per-result
  maps directly onto "one row per contact".
- **Store listing is deployed from the repo.** `apify push` never updates title, description,
  SEO fields, categories, permissions or the example input on an existing Actor, so those were
  empty on the platform. `scripts/store-metadata.mjs` runs after every deploy, validates the
  portfolio shipping rules (title 63, seoTitle 60, seoDescription 200, description 300, no
  em dashes, 3 categories max) and PUTs only what differs. Pricing is proposed in
  `.actor/store.json` with `apply: false`: Apify allows one pricing change per 30 days, so a
  human flips it. Logo lives at `.actor/logo.svg` / `.actor/logo.png`; the icon field is not
  writable through the API and is uploaded once in Console.
- **License is MIT** in both `LICENSE` and `package.json` (was Apache-2.0 in the latter).
- **IP geolocation via ip-api.com (free, no key).** Every historical IP from passive DNS
  is now auto-enriched with country, city, ISP, org and AS number using the free batch
  endpoint (up to 100 IPs in a single request). Zero config — runs automatically.
- **SecurityTrails integration (BYOK, free tier: 2500 queries/month).** New optional
  `securityTrailsApiKey` input field. Free signup at securitytrails.com, no credit card.
  Provides dated DNS history (A and NS records with first/last seen) and WHOIS history
  with full registrant details going back to 2008. Contacts from WHOIS records are fed
  into the ContactStore with provenance.
- **WHOIS history via Whoxy API (BYOK).** New optional `whoisHistoryApiKey` input field.
  Costs $0.005 per lookup, no monthly fee, data from November 2012. Pre-GDPR registrant
  names, emails, phones, addresses and organisations extracted as high-confidence contacts.
  Privacy-guard placeholders filtered out.
- **Contact breakdown includes people and orgs.** The `contacts` section `breakdown`
  now counts `person` and `organization` types alongside `email` and `phone`.
- **Source count: 14.** 12 run with zero config, 2 optional BYOK sources (SecurityTrails
  and Whoxy) unlock WHOIS history when keys are provided.

## 0.3 - 2026-09-09

Checkbox-based section picker and restructured JSON output.

- **"What to include in the report" multi-select.** Eight checkboxes, all ticked by
  default so "type domain, press Start" is unchanged. Labels are data-level ("Emails
  and phone numbers", "Subdomains and sister brands"), not tool names. Unticking
  "Saved copies of the old website" genuinely saves ~10x runtime because it skips
  the archive page fetch. Unticking "Emails and phone numbers" alone makes the report
  cleaner but not faster, because contacts ride the same archive bytes.
- **JSON output sectioned by checkbox.** Top-level keys: `status` (always present),
  `youAskedFor` (echoes the ticks), `results` (one key per ticked section), `coverage`
  (one entry per section: complete vs incomplete with a note), `sourcesDetail` (raw
  per-source detail for power users). A section that was not ticked does not appear in
  `results` at all, and its collectors are not run.
- **Collector gating.** Each source is mapped to the sections that need it. When no
  section needs a source, it is skipped (status `skipped` in the sources array) and
  its network call is never made. Measured: "ownership + subdomains" runs in 5.5s vs
  28s for a full scan.
- **Per-section coverage.** The coverage report now says "6 of 8 sections complete"
  instead of listing raw source names. Each section carries `status` (complete /
  incomplete) and a `note` distinguishing "checked and genuinely empty" from "source
  was unreachable — data is UNKNOWN, not absent".
- **`aliveFrom` / `aliveUntil` in ISO date format** (was raw 14-digit timestamp).

## 0.2 - 2026-09-09

Five correctness fixes, every one found by running the actor on real domains rather
than by reading the code. Baseline output kept at
`runs/2026-09-09_baseline_emoji-cafe.json` so the change is diffable.

- **Common Crawl now asks the crawls that cover the domain's lifetime.** Indexes were
  sampled "newest plus three spread evenly across all history", so a domain that lived
  2024-2025 was looked up in the 2008, 2017, 2021 and 2026 crawls and reported as having
  no records. The domain's lifespan is now derived from Wayback captures, certificate
  dates and RDAP events, and indexes are picked from inside that window.
- **Passive DNS keeps every record type.** Only `NS` was harvested; `A`, `AAAA` and
  `CNAME` were fetched and discarded. A provider returning `a emojis.cafe ->
  162.214.80.100` plus three CNAMEs was reported as `historicalIps: []` with the source
  marked empty. Historical IPs are the main pivot point in this whole report, and CNAME
  queries enumerate subdomains for free. Measured on emojis.cafe: 0 items -> 7.
- **Arquivo.pt no longer pads the report with unrelated pages.** Full-text search rejects
  url-shaped queries, and the workaround was to strip the TLD and search the brand token
  - which returns the whole internet when the brand token is an ordinary word. Measured
  on emojis.cafe: `q=emojis` returned 50 rows out of an estimated 1,825,447 and *none of
  them mentioned the domain*, while scoring the source "ok". Quoting the FQDN bypasses
  the URL rejection: `"theranos.com"` returns 10 of 10 on-target, `"emoji.cafe"` narrows
  the universe from 3,853,882 to 18. Every result is additionally gated on containing the
  domain, and anything dropped is counted in `discarded` rather than silently binned.
- **Arquivo's CDX API is now queried too.** The 400 error names it, and it returns
  Arquivo's own archived captures - a second web archive sitting behind a different rate
  limiter than archive.org, which is the one resource this actor actually contends for.
- **`liveStatus` distinguishes delegated from hosted.** A domain answering NOERROR on NS
  and SOA with no A, AAAA or MX was reported as `resolves` - a signpost with no building
  behind it. States are now `hosted`, `mail_only`, `delegated_no_host`, `nxdomain` and
  `no_records`, each with a plain-English `liveStatusExplained`.
- **An unreachable source is no longer reported as an empty one.** Found while fixing the
  above: index.commoncrawl.org went fully dark mid-development, every index errored, and
  the collector still returned `count: 0` - which the registry scored `empty`, meaning
  "genuinely nothing there". That is precisely the distinction this actor's coverage
  report exists to preserve. Common Crawl and Arquivo now raise when no half of the
  source answered, so the run reports the data as unknown and re-runnable.

## 0.1 - 2026-09-08

First build.

- One-field input: a domain, plus an optional Quick/Standard/Deep depth selector.
- Nine sources: Wayback CDX and raw `id_` replay, Common Crawl index, crt.sh, RDAP
  (IANA bootstrap plus registry/registrar), Google Public DNS, Robtex and Mnemonic
  passive DNS, urlscan.io, Arquivo.pt full-text, grep.app public code search.
- Contacts emitted as statements: one dataset row per contact per source, each with
  source URL, capture timestamp, replay URL, extraction method and a sightings array.
- Per-source coverage report on every run. Rate-limited is reported separately from
  empty, so a throttled source is never mistaken for an absent one.
- Two-level hierarchical archive sampler (year floor, then path-score weighting, then
  even temporal spacing) so contact pages are never starved by homepage captures.
- Headless render pass over archived bytes via setContent, so inline JS executes
  without spending a second archive request.
