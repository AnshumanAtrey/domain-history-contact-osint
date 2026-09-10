# Domain History Contact OSINT

Type a domain. Press Start. Get its whole history and its owner's contact details, with a
clickable source URL and a capture timestamp on **every single finding**.

Built for investigators working dead ends: a defunct fraud company, a scrubbed about-us page,
a renamed legal entity, an expired domain that used to be a real business.

## What does it do?

You give it one domain. It returns:

- **Contacts with provenance** - emails, phones, people and organisations. One row per contact
  per source, each carrying the exact URL and archive timestamp that produced it.
- **Registration** - RDAP registrant and organisation where not redacted, registrar, the
  mandatory registrar abuse contact, creation and expiry events, nameservers.
- **DNS now and DNS then** - current A/AAAA/MX/NS/TXT/SOA, plus historical nameservers and
  historical IPs from passive DNS. SaaS verification tokens in TXT are flagged because they
  tie a domain to named vendors.
- **Certificate history** - every hostname that ever appeared in a certificate for the domain.
  Certificates outlive domains, so this keeps answering after the site is gone.
- **Past versions of the website** - archived pages, prioritised toward contact, about, team,
  imprint, careers, management and board pages, sampled across the domain's whole lifetime.
- **Hosting history** - the dead origin server's own response headers, recovered from the
  archive. Real example from a domain offline for years:
  `Apache/1.3.36 (Unix) ... PHP/4.4.2 FrontPage/5.0.2.2635 mod_ssl/2.8.27 OpenSSL/0.9.7a`.
- **Embedded identifiers** - Google Analytics, GTM, AdSense, Segment, Optimizely and Meta pixel
  IDs pulled out of archived bytes. Reverse-look these up to find every other domain the same
  owner ran. This survives the domain's death perfectly.
- **Inbound references** - who else mentioned this domain: urlscan submissions, full-text
  archive hits, and public source code. Config files and mail settings name real addresses.
- **A per-source coverage report** - which sources answered, which held nothing, and which
  rate-limited us. That last distinction matters: throttled is not the same as empty.

## Does it work on a dead domain?

That is the point. A dead domain is the expected input, not an error.

The run always completes successfully with a populated report. If a source returned nothing,
the report says so and says why. If the archive throttled us, the report says the data is
**unknown rather than absent**, so you know to re-run instead of concluding there is nothing
there. You will never get an empty dataset and never get a failed run because a domain is dead.

## How is it different from the alternatives?

| | This actor | Wayback-only tools | Contact scrapers |
|---|---|---|---|
| Works when the site is offline | Yes | Yes | No |
| Source URL on every contact | Yes | Partly, one per value | No, flat arrays |
| Registration and WHOIS layer | Yes | No | No |
| Certificate transparency | Yes | No | No |
| Passive DNS and nameserver history | Yes | No | No |
| Public code and full-text references | Yes | No | No |
| Install required | None, it is an API | pip / self-host | None |

Two honest notes. `kronikier` and `WayTrace` are both good open-source tools that mine web
archives for historical contacts, and both are MIT. If web archives are all you need, use them.
This actor exists for the case where the archive is thin and you still need an answer, which is
common on a fully dropped domain. Measured on a real dead domain, the archived contact page held
zero addresses while certificate transparency returned 2,644 certificates and public code search
returned three genuine addresses.

The other note: the well-known contact scrapers on this store output a flat array of pages
next to a flat array of emails, with no mapping between them. That looks like provenance and
is not. Here, one row is one claim you can cite.

## What do I need to configure?

One field. The domain.

There is a second optional field for how far back to dig (Quick, Standard, Deep) and Standard
is already selected. Everything else is decided for you, on purpose.

## What does it cost?

Pay per event. You pay for contacts found with provenance, not for pages crawled. The coverage
report and the domain history come with the run.

## Which sources does it use?

All keyless and free at the point of use: Internet Archive CDX and raw snapshot replay,
Common Crawl index, crt.sh certificate transparency, IANA RDAP bootstrap plus registry and
registrar RDAP, Google Public DNS, Robtex and Mnemonic passive DNS, urlscan.io, Arquivo.pt
full-text archive search and its CDX archive, and grep.app public code search.

Two web archives are used, not one. Arquivo.pt keeps its own captures behind a different
rate limiter to archive.org, which is the only resource here that throttles hard, so a
domain the Internet Archive will not serve you can still come back with pages.

Paid pre-GDPR WHOIS history is deliberately not wired in yet. It is the strongest route to a
named registrant on a dropped domain and it is on the roadmap.

## Credits

Snapshot sampling, the archive politeness stack and the email de-obfuscation branches are
adapted from [WayTrace](https://github.com/thomashousset/WayTrace) (MIT, (c) 2024-2026
thomashousset), whose author measured the numbers that justify them. Licence notices are kept
in the files that borrow from it.

Built by [Anshuman Atrey](https://atrey.dev). Missing a field or need a custom source wired in?
Message me on LinkedIn and it usually ships within a day or two.
