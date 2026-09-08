/**
 * Archive snapshot sampler.
 *
 * Two-level hierarchical budget allocation, ported to JS from WayTrace
 * (backend/services/filters.py), which is MIT licensed:
 *
 *   Copyright (c) 2024-2026 thomashousset
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 * Why this exists: a single domain can have 150,000+ archived captures, and the
 * CDX server returns rows sorted by urlkey. Take the first N and the entire budget
 * is spent on N thousand captures of the homepage, so /contact is never seen.
 * Year-level allocation stops one busy year eating everything; path-level scoring
 * gives contact pages 3x the budget; even spacing inside a path captures change
 * over time rather than N copies of the same week.
 */

/** Paths worth 3x budget - these are where humans put contact details. */
export const HIGH_PRIORITY_KEYWORDS = [
  'contact', 'about', 'team', 'staff', 'people', 'privacy', 'terms', 'careers',
  'legal', 'imprint', 'impressum', 'kontakt', 'nous-contacter', 'quienes-somos',
  'login', 'admin', 'blog', 'jobs', 'press', 'partners', 'investors', 'security',
  'support', 'help', 'author', 'management', 'leadership', 'board', 'directors',
];

const YEAR_FLOOR = 3;

export const DEPTH_PRESETS = {
  quick: { cap: 30 },
  standard: { cap: 120 },
  deep: { cap: 500 },
};

/** Strip scheme, host, query and trailing slash so /contact and /contact/ collapse. */
export function normalizePath(originalUrl) {
  let p = String(originalUrl || '');
  p = p.replace(/^[a-z]+:\/\//i, '');
  const slash = p.indexOf('/');
  p = slash === -1 ? '/' : p.slice(slash);
  p = p.split('?')[0].split('#')[0];
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return (p || '/').toLowerCase();
}

export function scorePath(path) {
  const p = path.toLowerCase();
  if (HIGH_PRIORITY_KEYWORDS.some((k) => p.includes(k))) return 3;
  if (p === '/') return 2;
  return 1;
}

/**
 * Hamilton largest-remainder apportionment.
 * Integer-splits `budget` across `weights` without drift or double-rounding.
 */
export function hamilton(weights, budget) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || budget <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (budget * w) / total);
  const base = exact.map(Math.floor);
  let remaining = budget - base.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && remaining > 0; k += 1, remaining -= 1) {
    base[order[k].i] += 1;
  }
  return base;
}

/**
 * Pick `k` items spread evenly across `items`, not the first or last k.
 * Essential for catching analytics IDs and tech-stack changes over time.
 */
export function evenlySpaced(items, k) {
  const n = items.length;
  if (k >= n) return [...items];
  if (k <= 0) return [];
  if (k === 1) return [items[Math.floor(n / 2)]];
  const step = (n - 1) / (k - 1);
  const taken = new Set();
  const out = [];
  for (let i = 0; i < k; i += 1) {
    let idx = Math.round(i * step);
    while (taken.has(idx) && idx < n - 1) idx += 1;      // next free slot on collision
    while (taken.has(idx) && idx > 0) idx -= 1;
    if (taken.has(idx)) continue;
    taken.add(idx);
    out.push(items[idx]);
  }
  return out;
}

/** Level 2: split a year's budget across paths, weighted by score x volume. */
function allocateByScore(snapshots, cap) {
  const byPath = new Map();
  for (const s of snapshots) {
    const p = normalizePath(s.original);
    if (!byPath.has(p)) byPath.set(p, []);
    byPath.get(p).push(s);
  }
  const paths = [...byPath.keys()];

  // Degenerate case: less budget than unique paths. Take the best-scoring paths,
  // one representative each, rather than silently dropping whole path classes.
  if (cap < paths.length) {
    return paths
      .map((p) => ({ p, score: scorePath(p), n: byPath.get(p).length }))
      .sort((a, b) => b.score - a.score || b.n - a.n)
      .slice(0, cap)
      .map(({ p }) => byPath.get(p)[Math.floor(byPath.get(p).length / 2)]);
  }

  const weights = paths.map((p) => scorePath(p) * byPath.get(p).length);
  let alloc = hamilton(weights, cap);

  // Every path gets at least one representative.
  alloc = alloc.map((a) => Math.max(a, 1));

  // Clamp-and-redistribute: hand back budget from paths allocated more snapshots
  // than they actually have, and give it to paths still under their own ceiling.
  for (let pass = 0; pass < 8; pass += 1) {
    let surplus = 0;
    for (let i = 0; i < paths.length; i += 1) {
      const avail = byPath.get(paths[i]).length;
      if (alloc[i] > avail) { surplus += alloc[i] - avail; alloc[i] = avail; }
    }
    const total = alloc.reduce((a, b) => a + b, 0);
    surplus += Math.max(0, cap - total);
    if (surplus <= 0) break;
    const hungry = paths
      .map((p, i) => ({ i, room: byPath.get(p).length - alloc[i], score: scorePath(p) }))
      .filter((x) => x.room > 0)
      .sort((a, b) => b.score - a.score);
    if (!hungry.length) break;
    let gave = 0;
    for (const h of hungry) {
      if (gave >= surplus) break;
      const give = Math.min(h.room, Math.ceil((surplus - gave) / hungry.length) || 1);
      alloc[h.i] += give;
      gave += give;
    }
    if (gave === 0) break;
  }

  const out = [];
  paths.forEach((p, i) => {
    const group = byPath.get(p).slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    out.push(...evenlySpaced(group, alloc[i]));
  });
  return out;
}

/**
 * Level 1: allocate the budget across years, then across paths inside each year.
 *
 * DIVERGENCE FROM WAYTRACE (deliberate, and it fixes a real defect):
 * WayTrace reserves a flat floor of 3 snapshots per year before any path scoring
 * runs. On a domain archived across 15 years with a small budget, 3 x 15 = 45
 * exceeds a 30-snapshot budget, so the floor pass consumes everything and path
 * scoring never executes - measured locally, that dropped /contact entirely from
 * a quick scan. For a contact-extraction actor that is the one page you cannot
 * afford to lose, so we add a pass 0 that guarantees each high-priority path a
 * representative first, and we shrink the per-year floor to fit what is left.
 */
export function sampleSnapshots(snapshots, cap) {
  if (!snapshots.length) return [];
  if (snapshots.length <= cap) return [...snapshots];

  const byPath = new Map();
  for (const s of snapshots) {
    const p = normalizePath(s.original);
    if (!byPath.has(p)) byPath.set(p, []);
    byPath.get(p).push(s);
  }

  const chosen = new Set();

  // Pass 0 - guarantee every contact-bearing path a representative, spending at
  // most half the budget so temporal coverage still gets its share.
  const prioPaths = [...byPath.keys()]
    .filter((p) => scorePath(p) === 3)
    .sort((a, b) => byPath.get(b).length - byPath.get(a).length);
  const prioBudget = Math.min(prioPaths.length, Math.max(1, Math.floor(cap * 0.5)));
  for (const p of prioPaths.slice(0, prioBudget)) {
    const g = byPath.get(p).slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    chosen.add(g[Math.floor(g.length / 2)]);
  }

  const rest = snapshots.filter((s) => !chosen.has(s));
  let remaining = cap - chosen.size;

  if (remaining > 0 && rest.length) {
    const byYear = new Map();
    for (const s of rest) {
      const y = String(s.timestamp || '').slice(0, 4) || 'unknown';
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(s);
    }
    const years = [...byYear.keys()].sort();   // oldest first, so early history is not what gets dropped

    // Shrink the floor so it can never swallow the whole budget.
    const perYear = Math.max(1, Math.min(YEAR_FLOOR, Math.floor(remaining / years.length) || 1));
    const floor = new Map();
    let spent = 0;
    for (const y of years) {
      const take = Math.min(perYear, byYear.get(y).length, Math.max(0, remaining - spent));
      floor.set(y, take);
      spent += take;
    }

    const headroom = years.map((y) => Math.max(0, byYear.get(y).length - floor.get(y)));
    const extra = hamilton(headroom, Math.max(0, remaining - spent));

    years.forEach((y, i) => {
      const budget = floor.get(y) + extra[i];
      if (budget > 0) for (const s of allocateByScore(byYear.get(y), budget)) chosen.add(s);
    });
  }

  return [...chosen]
    .slice(0, cap)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

/** Drop duplicate (path, content-digest) pairs - same bytes at the same path. */
export function dedupeByDigest(snapshots) {
  const seen = new Set();
  const out = [];
  for (const s of snapshots) {
    const key = `${normalizePath(s.original)}|${s.digest || ''}`;
    if (s.digest && seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
