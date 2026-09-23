# Domain History Contact OSINT - Previous Owner + WHOIS History

Domain history and previous owner lookup for dead, expired and parked domains. WHOIS history, Wayback Machine pages, and the owner's emails, phones, people and organisations, each with a source URL and capture date.

Available as an [Apify Actor](https://apify.com/anshumanatrey/domain-history-contact-osint). $0.25 per domain scan + $0.02 per contact found. One input field, no API key needed.

---

## What does it do?

You type a domain and press Start. You get who owned it and how to reach them, even when the website is gone, as a table where every row carries the URL and capture date it came from. It reads 14 public sources, works on domains that no longer resolve, and always finishes with a report that says which sources answered and which did not.

- **Contacts with provenance.** Emails, phones, people and organisations. One dataset row per contact per source, each with `sourceUrl`, `snapshotTimestamp`, `replayUrl` and `extractionMethod`. One row is one claim you can cite.
- **People and organisations, with roles.** A multilingual named-entity model reads the rendered archived pages. Each person carries a `role` when the page stated one ("Founder", "Geschäftsführer"), a `worksFor` when a company sat next to the name, a `relation` flag (`site` = part of the site itself, `mention` = named in its content) and the visible `snippet` the name was read from.
- **Registration.** RDAP registrant and organisation where not redacted, registrar, the registrar abuse contact, creation and expiry events, nameservers. **WHOIS history** back to 2008 with a free SecurityTrails key, or from 2012 with a Whoxy key: pre-GDPR registrant names, emails and phones.
- **DNS now and then.** Current A, AAAA, MX, NS, TXT and SOA, historical nameservers and historical IPs from passive DNS, each IP geolocated to country, city, ISP and AS number. SaaS verification tokens in TXT are flagged because they tie a domain to named vendors.
- **Certificate history.** Every hostname that ever appeared in a certificate for the domain. Certificates outlive domains.
- **Past versions of the website.** Archived pages sampled across the domain's whole lifetime and weighted toward contact, about, team, imprint, careers, management and board pages.
- **Server software.** The dead origin's own response headers, recovered from the archive. From a domain offline for years: `Apache/1.3.36 (Unix) ... PHP/4.4.2 FrontPage/5.0.2.2635 mod_ssl/2.8.27 OpenSSL/0.9.7a`.
- **Tracking IDs.** Google Analytics, GTM, AdSense, Google Ads, Segment, Optimizely, Hotjar, Mixpanel and Meta pixel IDs from the archived bytes. Reverse-look these up to find every other domain the same owner ran.
- **Inbound references.** Who else mentioned this domain: urlscan.io submissions, Arquivo.pt full-text archive hits, Common Crawl, and public source code on grep.app. Config files and mail settings name real addresses.
- **A per-source coverage report.** Which sources answered, which held nothing, and which throttled you. Throttled is reported as unknown, not as empty.

## How is it different from a contact scraper or a WHOIS history service?

| | This actor | Contact scrapers on Apify | Wayback-only tools | WHOIS history services |
|---|---|---|---|---|
| Works when the site is offline | Yes | No | Yes | Records only |
| Source URL and capture date on every contact | Yes, on every row | No, flat arrays | One URL per value | Not applicable |
| Named people with job titles | Yes | No | No | Registrant only, mostly redacted since 2018 |
| Registration, certificates, passive DNS, public code | Yes | No | No | WHOIS only |
| Price | $0.25 per scan + $0.02 per contact, $0.002 per mention | About $0.002 per page | $0.0035 per snapshot | $2 per 1,000 lookups (Whoxy) up to enterprise contracts (DomainTools) |
| Setup | None | None | pip or self-host for the open-source ones | Account and credits |

Three measurements behind that table. On one dropped domain the archived contact page held 0 addresses, while certificate transparency returned 2,644 certificates and public code search returned 3 genuine addresses: the extra sources are where dead domains still answer. The largest contact scraper on the Store (58,952 users) returns a flat array of pages next to a flat array of emails with no mapping between them, which looks like provenance and is not. And since GDPR in 2018, the registrant on current WHOIS is redacted for most domains, so a named owner comes from archived pages, certificates and WHOIS history, not from today's record.

Two open-source tools deserve a mention. [WayTrace](https://github.com/thomashousset/WayTrace) and kronikier both mine web archives for historical contacts and both are MIT. If archives are all you need, use them. This actor exists for the case where the archive is thin and you still need an answer, which is the normal case on a fully dropped domain.

## When should I use it?

- You need to find out who owned a domain in the past, or who ran a website that is now offline.
- A counterparty, supplier or "company" you are checking has a website that has vanished, been scrubbed or been parked, and you need the people behind it.
- You are investigating fraud, a scam or financial crime and every finding must carry a source URL and date you can put in a report.
- You are buying an expired domain and want to know what it used to be, who ran it, and which analytics IDs tie it to other sites.
- You are a journalist or in legal discovery and need the Wayback Machine mined for emails and phone numbers with the capture date on each hit.
- You want to contact the previous owner of a domain, for a purchase, a takedown, or a transfer.

## What does it cost?

Pay-per-event. You pay for the scan and for what it finds; platform compute is included.

| Event | Price | When it fires |
|---|---|---|
| `Domain scan` | $0.125 per GB of run memory, so **$0.25** at the default 2 GB | Once per domain, at any depth. Covers the archive crawl, page rendering, the entity model, registration, DNS, certificate and reference lookups, and the coverage report |
| `Contact with source` | $0.02 | Per row that identifies someone: an email, a phone number, a person or organisation that is part of the site, or a registrant detail from WHOIS history, certificates or public code |
| `Mention` | $0.002 | Per row naming a person or organisation that only appears in the site's content, such as a company in a biography. A tenth of a contact, kept for context |

The summary row is free.

### Typical scan costs

Row counts measured on the platform at Standard depth (Quick, the default, finds most of the same contacts from fewer pages); prices at the default 2 GB:

- Small dead site (youthgrowyouth.in): 6 contacts + 36 mentions, **$0.44**
- Sparse result (yikyakapp.com): 3 contacts, no mentions, **$0.31**
- Large corporate archive (theranos.com, 231 rows): 47 contacts + 183 mentions, **$1.56**
- Nothing recoverable: **$0.25**, the scan plus the free summary row that says why

A Quick run takes about 3 minutes at 2 GB and Standard about 6; raising memory to 4 GB roughly halves the time and doubles the scan fee. Deep depends on how much the archive holds. Set a spending limit on the run for a hard cap; the summary row says so if it was reached.

## Which inputs does it take?

| Field | Required | What it does |
|---|---|---|
| `domains` | Yes | One domain, or several, one per line. Full URLs and `www.` are cleaned automatically |
| `depth` | No | `quick` (about 30 archived pages, about 3 minutes, the default), `standard` (about 120), `deep` (up to 500) |
| `sections` | No | Which of the 8 report sections to build. All are ticked by default. Unticking "Saved copies of the old website" makes the run about 10x faster |
| `securityTrailsApiKey` | No | Dated DNS history and WHOIS history back to 2008. Free tier: 2,500 queries a month, no card |
| `whoisHistoryApiKey` | No | Whoxy WHOIS history from 2012 at $0.005 per lookup. Pre-GDPR registrant names, emails and phones |

## What does the output look like?

Each dataset record is one contact from one source. A person row from a real run, with the sightings array cut to one entry:

```json
{
  "domain": "youthgrowyouth.in",
  "type": "person",
  "value": "Anshuman Atrey",
  "role": null,
  "worksFor": "Youth Grow Youth",
  "relation": "site",
  "pagesSeenOn": 14,
  "confidence": "high",
  "sourceType": "wayback",
  "sourceUrl": "https://youthgrowyouth.in/businesses/",
  "snapshotTimestamp": "20230605184117",
  "replayUrl": "https://web.archive.org/web/20230605184117id_/https://youthgrowyouth.in/businesses/",
  "extractionMethod": "ner",
  "occurrences": 40,
  "firstSeen": "20230605184117",
  "lastSeen": "20240328173211",
  "snippet": "Copyright © 2023 Youth Grow Youth | Created with ❤ by Anshuman Atrey",
  "sightings": [
    {
      "sourceType": "wayback",
      "sourceUrl": "https://youthgrowyouth.in/businesses/",
      "snapshotTimestamp": "20230605184117",
      "replayUrl": "https://web.archive.org/web/20230605184117id_/https://youthgrowyouth.in/businesses/",
      "extractionMethod": "ner",
      "pageId": 1,
      "context": { "role": null, "worksFor": "Youth Grow Youth", "snippet": "Copyright © 2023 Youth Grow Youth | Created with ❤ by Anshuman Atrey" }
    }
  ]
}
```

An email row. This address was hidden behind Cloudflare's email obfuscation on the page and decoded:

```json
{
  "domain": "youthgrowyouth.in",
  "type": "email",
  "value": "mail@youthgrowyouth.in",
  "confidence": "medium",
  "sourceType": "wayback",
  "sourceUrl": "https://youthgrowyouth.in/businesses/",
  "snapshotTimestamp": "20230605184117",
  "replayUrl": "https://web.archive.org/web/20230605184117id_/https://youthgrowyouth.in/businesses/",
  "extractionMethod": "cloudflare-xor",
  "occurrences": 54,
  "firstSeen": "20230605184117",
  "lastSeen": "20240328173211"
}
```

The last row for each domain is a summary, so a domain with nothing recoverable still tells you why:

```json
{
  "domain": "youthgrowyouth.in",
  "type": "summary",
  "value": "40 contact(s). 6 of 8 sections complete. 2 section(s) have gaps - check the notes for which to re-run.",
  "occurrences": 40,
  "status": "nxdomain",
  "firstSeen": "2023-06-05",
  "lastSeen": "2024-05-24",
  "reportKey": "REPORT-youthgrowyouth.in"
}
```

The full report is the run's `OUTPUT` record (Console: the Output tab; API: the default key-value store, key `OUTPUT`). Shortened:

```json
{
  "domain": "youthgrowyouth.in",
  "status": { "state": "nxdomain", "isDead": true, "aliveFrom": "2023-06-05", "aliveUntil": "2024-05-24" },
  "results": {
    "contacts":     { "found": 40, "breakdown": { "email": 2, "organization": 29, "person": 9 }, "items": ["..."] },
    "ownership":    { "status": "not_registered", "registrar": null, "events": ["..."], "whoisHistory": "when a key is set" },
    "subdomains":   { "found": 3, "certificatesAnalysed": 12, "items": ["..."] },
    "hosting":      { "lastKnownIp": "…", "dnsHistory": { "historicalIps": [{ "ip": "…", "country": "…", "isp": "…" }] } },
    "old_pages":    { "found": 30, "capturesInArchive": 38, "coveringYears": ["2023", "2024"], "items": ["..."] },
    "server_tech":  { "items": ["LiteSpeed"] },
    "tracking_ids": { "items": [{ "value": "G-XXXXXXXX", "kind": "google-analytics-ga4", "proof": "…" }] },
    "mentions":     { "urlscan": "…", "arquivo": "…", "publicCode": "…", "commonCrawl": "…" }
  },
  "coverage": { "plainEnglish": "6 of 8 sections complete.", "bySection": { "contacts": { "status": "complete" }, "mentions": { "status": "incomplete", "note": "grep.app unreachable. This is UNKNOWN, not absent. Re-run." } } }
}
```

## Common questions

**Q: How do I find out who owned a domain in the past?** Run this actor on the domain. The contacts table lists the people and organisations that appeared on the archived site with `relation: site`, the emails and phones with the page and date each came from, and the registration record. Add a free SecurityTrails key and the ownership section gains dated WHOIS history back to 2008.

**Q: Does it work if the website is offline or the domain has expired?** That is the point. A dead domain is the expected input. The run always completes with a populated table and report; if a source held nothing the report says so, and if the archive throttled the run it says the data is unknown rather than absent, so you re-run instead of concluding there was nothing there.

**Q: Is WHOIS history included, and is it free?** Current registration (RDAP) is always included and free. Historical WHOIS is a paid dataset everywhere; this actor accepts your own key so you pay the provider directly and nothing on top. SecurityTrails gives 2,500 queries a month on its free tier with no card. Whoxy charges $0.005 per lookup and nothing when a domain has no history.

**Q: How accurate are the people and organisation names?** The entity model was chosen by a bake-off across a WordPress blog, a hand-built site and a German Impressum, 13 ground-truth names: 12 of 13 recovered, one false positive, removed by a two-word rule. On theranos.com's 2013 to 2015 archive it returned the full board and executive team with no site-specific code. Every name carries its `snippet`, so you read the evidence yourself, and `relation` separates the site's own people from names in its articles.

**Q: What does "UNKNOWN, not absent" mean?** archive.org, grep.app and crt.sh all rate-limit or fail on occasion. When that happens the affected section is marked incomplete with the reason, and the summary row repeats it. An empty section with status complete means the source answered and there was genuinely nothing.

**Q: Why did my run return only a summary row?** Nothing was recoverable for that domain from the sources you selected. Read the summary row: it says whether the sources were checked and empty, or unreachable. If unreachable, re-run later. If empty, try Deep depth or add a WHOIS history key.

**Q: Can I scan many domains at once?** Yes, one per line in the `domains` field. Each domain gets its own block of rows and its own `REPORT-<domain>` record; `OUTPUT` holds the list.

**Q: What about single-page apps and JavaScript-heavy sites?** Archived HTML is rendered in a headless browser and inline scripts run, so JavaScript-injected contacts are recovered. Script bundles hosted on the dead origin cannot load, so a site that drew everything from an external bundle will yield less. Certificates, DNS, registration and public code still answer.

**Q: Is this legal to use?** Every source is public: web archives, certificate transparency logs, registration records, passive DNS and public code. Nothing is fetched from the live site beyond a DNS lookup. Use it for legitimate investigation, due diligence, research and recovery, and handle personal data under the law that applies to you.

---

## About the maintainer (priority response within 1-2 hours)

Built and maintained by **Anshuman Atrey** ([@AnshumanAtrey](https://github.com/AnshumanAtrey)).

- Purple-team security researcher, 5x hackathon winner
- Co-founder of **Walrus Securitas** (AI cybersecurity SaaS) and **The Drone Syndicate** (autonomous defence drones)
- Author of the canonical OSINT actor portfolio on Apify Store: 15 shipped actors covering email, phone, username, IP and domain, network, secret, social, LinkedIn, domain history and Indian fintech OSINT

### Custom feature requests shipped within 1-2 hours (priority)

If you have a use case this actor does not cover, the maintainer ships custom additions (new fields, new modes, new sources, new output formats) directly into this actor, typically within 1-2 hours for priority requests during active hours and within 24 hours overnight, for legitimate security research, OSINT investigation, compliance, fraud detection and authorised penetration testing. This is direct one-to-one service from the maintainer, not a contractor queue.

**Fastest contact channels (ranked by response speed):**
1. **LinkedIn DM** -> [linkedin.com/in/anshumanatrey](https://linkedin.com/in/anshumanatrey), typically under 1 hour during active hours
2. **GitHub issue** on this actor's repo
3. **Apify Console** DM to `@anshumanatrey`
4. **Email** via [atrey.dev](https://atrey.dev)

The maintainer also takes paid custom OSINT and security-tooling engagements through [atrey.dev](https://atrey.dev): bespoke scanners, vendor-specific integrations, India-specific compliance pipelines (UPI, IFSC, GSTIN, PAN, Aadhaar), and end-to-end OSINT systems beyond what a single actor can express.

---

## Sibling actors in the same OSINT portfolio

When your need extends beyond this actor's scope, the matching sibling is maintained by the same author on the same 1-2 hour priority custom-feature-request SLA via LinkedIn:

| Actor | Use case |
|---|---|
| [holehe-email-osint](https://apify.com/anshumanatrey/holehe-email-osint) | Email -> registered accounts across 120+ platforms |
| [theharvester-osint](https://apify.com/anshumanatrey/theharvester-osint) | Domain -> emails + subdomains + IPs from 54+ public sources |
| [social-analyzer](https://apify.com/anshumanatrey/social-analyzer) | Username -> profiles across 900+ social sites with confidence scoring |
| [phoneinfoga-phone-osint](https://apify.com/anshumanatrey/phoneinfoga-phone-osint) | International phone -> country, footprint URLs, OSINT trail |
| [nmap-scanner](https://apify.com/anshumanatrey/nmap-scanner) | Network -> port + service + version detection, NSE scripts |
| [netintel](https://apify.com/anshumanatrey/netintel) | IP or domain -> unified WHOIS + DNS + GeoIP + ASN + ports |
| [bug-bounty-finder](https://apify.com/anshumanatrey/bug-bounty-finder) | Domain -> active HackerOne + Bugcrowd + security.txt programs |
| [instagram-profile-intel-no-login](https://apify.com/anshumanatrey/instagram-profile-intel-no-login) | Instagram username -> bio emails + phones + 25 fields (no login) |
| [telegram-channel-scraper](https://apify.com/anshumanatrey/telegram-channel-scraper) | Public Telegram channel -> posts, media links, inline buttons, reactions (no login) |
| [gitleaks-github-secret-scanner](https://apify.com/anshumanatrey/gitleaks-github-secret-scanner) | GitHub -> leaked API keys across 30+ services |
| [betterleaks-cloud](https://apify.com/anshumanatrey/betterleaks-cloud) | GitHub + S3 -> leaked secrets with live vendor-API validation |
| [upi-id-osint](https://apify.com/anshumanatrey/upi-id-osint) | Indian phone or VPA -> active UPI IDs + bank-registered name from NPCI |
| [linkedin-harvester](https://apify.com/anshumanatrey/linkedin-harvester) | Email -> best-match public LinkedIn profile URL + confidence score |

---

## Documentation

- Apify Store: https://apify.com/anshumanatrey/domain-history-contact-osint
- GitHub repo: https://github.com/AnshumanAtrey/domain-history-contact-osint
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- Issues / feature requests: open an issue on the GitHub repo or DM LinkedIn for the fastest response
- License: MIT
- Credits: snapshot sampling, the archive politeness stack and the email de-obfuscation branches are adapted from [WayTrace](https://github.com/thomashousset/WayTrace) (MIT, (c) 2024-2026 thomashousset). Licence notices are kept in the files that borrow from it.

## Last updated

2026-09-11 (version 1.0)
