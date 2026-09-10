#!/usr/bin/env node
/**
 * Push the Store listing metadata from this repo to Apify.
 *
 * `apify push` deploys code but never updates title, description, SEO fields,
 * categories, permissions or the example input on an existing Actor - so those
 * drift the moment anyone edits them in Console. This script makes GitHub the
 * source of truth for the LISTING too: it runs after every deploy in CI, reads
 *   .actor/actor.json  -> title, description, categories
 *   .actor/store.json  -> seoTitle, seoDescription, exampleRunInput,
 *                         actorPermissionLevel, (optional, first-time) pricing
 * validates them against the portfolio shipping rules, and PUTs only when
 * something differs from what is live.
 *
 * Pricing is special: Apify allows one pricing change per 30 days, so it is
 * applied ONLY when `pricing.apply` is true AND the Actor has no pricing yet.
 * After that first set, change pricing in Console; this script leaves it alone.
 *
 * Usage: APIFY_TOKEN=... node scripts/store-metadata.mjs [--dry-run]
 */
import { readFileSync } from 'node:fs';

const API = 'https://api.apify.com/v2';
const token = process.env.APIFY_TOKEN;
const dryRun = process.argv.includes('--dry-run');
if (!token) { console.error('APIFY_TOKEN is not set'); process.exit(1); }

const actor = JSON.parse(readFileSync('.actor/actor.json', 'utf8'));
const store = JSON.parse(readFileSync('.actor/store.json', 'utf8'));

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(json.error || json).slice(0, 400)}`);
  return json.data;
}

/* ------------------------------------------------ portfolio shipping rules -- */
const LIMITS = { title: 63, description: 300, seoTitle: 60, seoDescription: 200 };
const BANNED_CHARS = /[—–]/;                       // em dash, en dash
const BANNED_WORDS = /\b(leverage|robust|seamlessly|effortlessly|cutting-edge|streamline|empower|unleash)\b/i;

const desired = {
  title: actor.title,
  description: actor.description,
  categories: actor.categories || [],
  seoTitle: store.seoTitle,
  seoDescription: store.seoDescription,
  actorPermissionLevel: store.actorPermissionLevel,
  exampleRunInput: store.exampleRunInput
    ? { body: JSON.stringify(store.exampleRunInput), contentType: 'application/json; charset=utf-8' }
    : undefined,
};

const problems = [];
for (const [k, max] of Object.entries(LIMITS)) {
  const v = desired[k];
  if (typeof v !== 'string' || !v.trim()) problems.push(`${k} is missing`);
  else if (v.length > max) problems.push(`${k} is ${v.length} chars, limit ${max}`);
}
for (const k of ['title', 'description', 'seoTitle', 'seoDescription']) {
  const v = desired[k] || '';
  if (BANNED_CHARS.test(v)) problems.push(`${k} contains an em/en dash - use "-" or "|"`);
  const w = v.match(BANNED_WORDS); if (w) problems.push(`${k} uses banned word "${w[0]}"`);
}
if (desired.categories.length > 3) problems.push(`categories has ${desired.categories.length} entries, limit 3`);
if (problems.length) { console.error('Listing rules violated:\n  - ' + problems.join('\n  - ')); process.exit(1); }

/* ------------------------------------------------------------ diff + apply -- */
const me = await api('GET', '/users/me');
const actorId = `${me.username}~${actor.name}`;
const live = await api('GET', `/acts/${actorId}`);

const changes = {};
for (const [k, v] of Object.entries(desired)) {
  if (v === undefined) continue;
  const liveV = k === 'exampleRunInput' ? live.exampleRunInput : live[k];
  if (JSON.stringify(v) !== JSON.stringify(liveV)) changes[k] = v;
}

if (store.pricing?.apply) {
  if ((live.pricingInfos || []).length) console.log('pricing: already set on the platform - not touched (30-day change limit; edit in Console)');
  else changes.pricingInfos = store.pricing.pricingInfos;
}

console.log(`actor: ${actorId} (${live.id}) | live title: "${live.title}"`);
if (!Object.keys(changes).length) { console.log('listing metadata already matches the repo - nothing to do'); process.exit(0); }
for (const [k, v] of Object.entries(changes)) {
  const show = (x) => (typeof x === 'string' ? `"${x}"` : JSON.stringify(x));
  console.log(`  ${k}: ${show(live[k])} -> ${show(v)}`);
}
if (dryRun) { console.log('dry run - no PUT sent'); process.exit(0); }

await api('PUT', `/acts/${actorId}`, changes);
const after = await api('GET', `/acts/${actorId}`);
const failed = Object.keys(changes).filter((k) => k !== 'pricingInfos' && JSON.stringify(after[k]) !== JSON.stringify(changes[k]));
if (failed.length) { console.error(`PUT accepted but these fields did not stick: ${failed.join(', ')}`); process.exit(1); }
console.log(`updated ${Object.keys(changes).length} field(s): ${Object.keys(changes).join(', ')}`);
console.log(`store: https://apify.com/${me.username}/${actor.name}`);
