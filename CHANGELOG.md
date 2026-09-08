# Changelog

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
