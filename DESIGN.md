# domain-history-contact-osint — design notes

Actor: `anshumanatrey/domain-history-contact-osint`
Lead driving it: `manager/leads/2026-09-08_trutrace-expired-domain-contacts.md`
Tool research: `manager/research/domain-history-contact-osint-toolchain.md` (381 tools)

## Language decision: JavaScript

Not Python, for three reasons:
1. `netintel` is already JS and has working `src/analyzers/{ssl,whois,dns}.js` plus
   `utils/{confidence,correlation}.js` — directly reusable here.
2. Crawlee (JS) is the most mature crawl/render stack and is Apify-native.
3. Avoids the documented Python actor trap in `rules/README.md`
   (`apify<3.0` -> crawlee 0.6.x -> breaks on pydantic>=2.11 / browserforge>=1.2.4).

## UX principle — evidence-backed, not taste

Measured across the existing 14 actors, input-field count inversely tracks adoption:

| fields | actor | users |
|---|---|---|
| 5 (0 required, all prefilled) | holehe-email-osint | 1,704 |
| 5 | phoneinfoga-phone-osint | 213 |
| 8 | upi-id-osint | 177 |
| 25 | theharvester-osint | 49 |
| 27 | gitleaks-github-secret-scanner | 24 |
| 11 | netintel | 4 |
| 52 | betterleaks-cloud | 3 |

The best performer has **zero required fields** — everything prefilled, user clicks Start.
The 52-field actor has 3 users. Every field added must therefore pay for itself.

**Decided without needing to ask:** the domain input is ONE field, a `textarea` accepting
one domain per line, prefilled with a live example. A single domain is still "type it and
press Start", and bulk comes free with no extra field and no array editor. This also
earns the "Bulk" SEO hook that `rules/README.md` §2.5 ranks second-highest.

## Output principle — never an empty dataset

Adopt netintel's `{success, data, error}` envelope per source, and go further: emit an
explicit per-source coverage report so a dead domain returns a SUCCESSFUL run that states
which sources answered and which did not, and why. Apify penalises success rate below
~95%, and `agenscrape/expired-website-checker` sits at 0.0% success as the cautionary
example. A dead domain is the expected input, not an error.

Contacts are emitted as STATEMENTS — one row per (value, source, extraction method) —
never as domain-level aggregated arrays. `vdrmota/contact-info-scraper` (58,951 users)
has a `scrapedUrls` field that looks like provenance and is not: flat array of pages next
to a flat array of emails, no mapping between them. That gap is the entire moat.

## Open decisions — awaiting owner input

1. Archive depth control (hard-coded default vs one Quick/Standard/Deep selector)
2. WHOIS history — paid source, bake in a key vs BYOK vs defer
3. Backlinks — defer vs free-tier-only vs BYOK
4. Headless rendering — live domains only vs always vs defer
