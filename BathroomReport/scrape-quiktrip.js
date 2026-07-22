#!/usr/bin/env node
/**
 * scrape-quiktrip.js
 * ------------------------------------------------------------------
 * Pulls every QuikTrip location from their public Yext store locator
 * (locations.quiktrip.com) and writes a Bathroom Report chain file:
 *
 *     quiktrip-locations.js      ->  window.quiktripLocations = [ ... ]
 *     quiktrip-locations.json    ->  same data, plain JSON (inspection)
 *     quiktrip-report.txt        ->  counts + anything flagged for review
 *
 * Data comes from each store page's schema.org JSON-LD (store hours,
 * address, geo, phone), with regex fallbacks for coordinates (the
 * Mapbox map URL) and phone (the tel: link). It deliberately reads the
 * STORE hours, not the QT Kitchen hours.
 *
 * Requirements: Node 18+ (uses the built-in global fetch). No npm installs.
 *
 * Usage:
 *   node scrape-quiktrip.js                 # full run
 *   node scrape-quiktrip.js --limit 25      # test on first 25 stores
 *   node scrape-quiktrip.js --urls-only     # just list store URLs, no scrape
 *
 * Please be a good citizen: check locations.quiktrip.com/robots.txt and
 * the site's Terms before a full run. Defaults below are intentionally
 * gentle (low concurrency + delay). This collects only factual store
 * data (address, coordinates, hours) — no logos, photos, or copy.
 * ------------------------------------------------------------------
 */

'use strict';
const fs = require('fs');

// ---- config -------------------------------------------------------
const BASE = 'https://locations.quiktrip.com';
const USER_AGENT =
  'BathroomReportBot/1.0 (+community restroom finder; contact: you@example.com)';
const CONCURRENCY = 3;        // simultaneous requests — keep it modest
const DELAY_MS = 250;         // pause between requests per worker
const MAX_RETRIES = 3;        // per URL on 429/5xx/network error
const TIMEOUT_MS = 20000;

const CHAIN_KEY = 'quiktrip';
const CHAIN_NAME = 'QuikTrip';

const argLimit = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? parseInt(process.argv[i + 1], 10) : Infinity;
})();
const URLS_ONLY = process.argv.includes('--urls-only');

// ---- small helpers ------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, attempt = 1) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xml' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
    if (!res.ok) return { ok: false, status: res.status, text: '' };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (err) {
    if (attempt >= MAX_RETRIES) return { ok: false, status: 0, text: '', error: String(err) };
    await sleep(DELAY_MS * attempt * 4); // backoff
    return fetchText(url, attempt + 1);
  }
}

// Run an async mapper over items with a fixed-size worker pool.
async function pool(items, size, worker) {
  const out = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await worker(items[i], i);
      await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return out;
}

// ---- 1. discover every store URL ----------------------------------
// Prefer sitemap.xml (one request). Fall back to crawling the Yext
// directory: index.html -> /{state} -> /{state}/{city} -> store pages.
const STATE_RE = /^[a-z]{2}$/;
const SUBPAGE_LAST = new Set(['breakfast', 'pizza', 'menu']); // non-store leaf pages

function absolute(href) {
  if (!href) return null;
  if (href.startsWith('http')) return href.split('#')[0].split('?')[0];
  if (href.startsWith('/')) return (BASE + href).split('#')[0].split('?')[0];
  return null;
}
function pathSegs(url) {
  try {
    return new URL(url).pathname.replace(/^\/|\/$/g, '').split('/').filter(Boolean);
  } catch {
    return [];
  }
}
function isStoreUrl(url) {
  const s = pathSegs(url);
  return s.length === 3 && STATE_RE.test(s[0]) && !SUBPAGE_LAST.has(s[2]);
}
function extractLinks(html) {
  const out = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const abs = absolute(m[1]);
    if (abs && abs.startsWith(BASE)) out.push(abs);
  }
  return out;
}

async function fromSitemap() {
  const seen = new Set();
  const stores = new Set();
  const queue = [`${BASE}/sitemap.xml`];
  while (queue.length) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    const { ok, text } = await fetchText(sm);
    if (!ok) continue;
    const locs = [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((x) => x[1]);
    for (const u of locs) {
      if (/\.xml($|\?)/i.test(u)) queue.push(u);          // nested sitemap
      else if (u.startsWith(BASE) && isStoreUrl(u)) stores.add(u.split('#')[0].split('?')[0]);
    }
    await sleep(DELAY_MS);
  }
  return [...stores];
}

async function fromDirectoryCrawl() {
  const stores = new Set();
  const root = await fetchText(`${BASE}/index.html`);
  if (!root.ok) return [];
  const states = extractLinks(root.text).filter((u) => {
    const s = pathSegs(u);
    return s.length === 1 && STATE_RE.test(s[0]);
  });
  const cities = new Set();
  await pool([...new Set(states)], CONCURRENCY, async (stateUrl) => {
    const r = await fetchText(stateUrl);
    if (!r.ok) return;
    extractLinks(r.text).forEach((u) => {
      const s = pathSegs(u);
      if (s.length === 2 && STATE_RE.test(s[0])) cities.add(u);
      if (isStoreUrl(u)) stores.add(u); // some state pages link stores directly
    });
  });
  await pool([...cities], CONCURRENCY, async (cityUrl) => {
    const r = await fetchText(cityUrl);
    if (!r.ok) return;
    extractLinks(r.text).forEach((u) => { if (isStoreUrl(u)) stores.add(u); });
  });
  return [...stores];
}

async function discoverStoreUrls() {
  let urls = await fromSitemap();
  if (urls.length < 50) {
    console.log(`sitemap gave ${urls.length} URLs; falling back to directory crawl…`);
    const crawled = await fromDirectoryCrawl();
    urls = [...new Set([...urls, ...crawled])];
  }
  return urls.sort();
}

// ---- 2. parse one store page --------------------------------------
function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      (Array.isArray(parsed) ? parsed : parsed['@graph'] ? parsed['@graph'] : [parsed]).forEach(
        (o) => blocks.push(o)
      );
    } catch {
      /* ignore malformed block */
    }
  }
  return blocks;
}
const STORE_TYPES = /store|conveniencestore|gasstation|localbusiness|foodestablishment|restaurant|organization/i;
function pickStoreNode(nodes) {
  // prefer a node that has BOTH an address and geo coordinates
  return (
    nodes.find((n) => n && typeof n['@type'] === 'string' && STORE_TYPES.test(n['@type']) && n.address && n.geo) ||
    nodes.find((n) => n && Array.isArray(n['@type']) && n['@type'].some((t) => STORE_TYPES.test(t)) && n.address && n.geo) ||
    nodes.find((n) => n && n.address && n.geo) ||
    null
  );
}

const DAY_KEYS = { monday: 'monday', tuesday: 'tuesday', wednesday: 'wednesday', thursday: 'thursday', friday: 'friday', saturday: 'saturday', sunday: 'sunday' };
function normDay(d) {
  if (!d) return null;
  const s = String(d).toLowerCase().replace(/^https?:\/\/schema\.org\//, '');
  return DAY_KEYS[s] || null;
}
const hhmm = (t) => (typeof t === 'string' && /^\d{1,2}:\d{2}/.test(t) ? t.slice(0, 5).replace(':', '').padStart(4, '0') : null);

// Turn schema.org openingHoursSpecification into { day: "HHMM-HHMM"|"24"|"closed" }
function parseHours(spec) {
  const days = {};
  const arr = Array.isArray(spec) ? spec : spec ? [spec] : [];
  for (const s of arr) {
    const dows = Array.isArray(s.dayOfWeek) ? s.dayOfWeek : [s.dayOfWeek];
    for (const dow of dows) {
      const day = normDay(dow);
      if (!day) continue;
      const o = hhmm(s.opens);
      const c = hhmm(s.closes);
      if (o === null || c === null) continue;
      if (o === '0000' && (c === '0000' || c === '2359' || c === '2400')) days[day] = '24';
      else days[day] = `${o}-${c}`;
    }
  }
  return days;
}
// Collapse per-day hours to the single `hrs` string the app uses.
// "24" if all 7 days are 24h; a uniform window if all 7 identical; else "" (unknown).
function collapseHrs(days) {
  const keys = Object.keys(days);
  if (keys.length < 7) return { hrs: '', complete: false };
  const vals = new Set(Object.values(days));
  if (vals.size === 1) {
    const v = [...vals][0];
    return { hrs: v, complete: v !== '' };
  }
  return { hrs: '', complete: false }; // genuinely varies by day -> keep full detail in meta only
}

function reFirst(re, s) { const m = re.exec(s); return m ? m[1] : null; }

function parseStore(html, url) {
  const nodes = jsonLdBlocks(html);
  const node = pickStoreNode(nodes) || {};
  const addr = node.address || {};

  // coordinates: JSON-LD geo first, then the Mapbox map URL (lng,lat)
  let lat = node.geo && node.geo.latitude != null ? Number(node.geo.latitude) : null;
  let lng = node.geo && node.geo.longitude != null ? Number(node.geo.longitude) : null;
  if (lat === null || lng === null || Number.isNaN(lat) || Number.isNaN(lng)) {
    const mb = /pin-[^(]*\((-?\d+\.\d+),(-?\d+\.\d+)\)/.exec(html); // Mapbox is (lng,lat)
    if (mb) { lng = Number(mb[1]); lat = Number(mb[2]); }
  }

  // phone: JSON-LD then tel: link
  let phone = node.telephone || reFirst(/tel:\+?1?(\d{10})/i, html);
  if (phone) phone = String(phone).replace(/[^\d]/g, '').replace(/^1(\d{10})$/, '$1');

  // store number: JSON-LD branchCode/@id, else "STORE #NNN" on the page
  const storeNum =
    (node.branchCode && String(node.branchCode).replace(/\D/g, '')) ||
    reFirst(/STORE\s*#\s*(\d+)/i, html) ||
    reFirst(/QuikTrip\s*#\s*(\d+)/i, html) ||
    null;

  const days = parseHours(node.openingHoursSpecification);
  const { hrs, complete } = collapseHrs(days);

  const cid = reFirst(/maps\.google\.com\/maps\?cid=(\d+)/i, html);

  const rec = {
    name: node.name || CHAIN_NAME,
    lat: lat != null && !Number.isNaN(lat) ? lat : null,
    lng: lng != null && !Number.isNaN(lng) ? lng : null,
    street: addr.streetAddress || null,
    city: addr.addressLocality || null,
    state: addr.addressRegion || null,
    zip: addr.postalCode || null,
    country: addr.addressCountry || 'US',
    phone: phone || null,
    storeNum,
    days,
    hrs,
    hoursComplete: complete,
    cid,
    url,
  };
  return rec;
}

// validate coords are sane and not obviously reversed for US data
function coordProblem(r) {
  if (r.lat === null || r.lng === null) return 'missing-coords';
  if (r.lat < -90 || r.lat > 90 || r.lng < -180 || r.lng > 180) return 'out-of-range';
  // US (incl. AK/HI): lat ~17..72, lng ~ -180..-64. Flag likely lat/lng swap.
  if (r.lat < 0 || r.lng > 0 || r.lat > 72 || r.lng < -180) return 'suspect-reversed';
  return null;
}

// ---- 3. map to Bathroom Report chain-file schema ------------------
function toAppRecord(r) {
  const id = r.storeNum ? `${CHAIN_KEY}-${r.storeNum}` : `${CHAIN_KEY}-${pathSegs(r.url).join('-')}`;
  const missing = [];
  if (!r.hoursComplete) missing.push('hours_verified');
  if (!r.street || !r.city || !r.state || !r.zip) missing.push('address_complete');

  return {
    n: CHAIN_NAME,
    lat: r.lat != null ? r.lat.toFixed(6) : '', // string, 6 dp — matches existing chain files
    lng: r.lng != null ? r.lng.toFixed(6) : '',
    addr: r.street || '',
    phone: r.phone || '',
    id,
    hrs: r.hrs, // "24" | "HHMM-HHMM" | "" (unknown)
    meta: {
      chain: CHAIN_NAME,
      city: r.city || '',
      state: r.state || '',
      zip: r.zip || '',
      country: r.country || 'US',
      website: r.url,
      hours_full: r.days,                 // structured per-day store hours (never kitchen)
      hours_source: r.hoursComplete ? 'official_store_locator' : '',
      store_ref: r.storeNum || '',
      osm_id: null,
      google_cid: r.cid || null,
      amenities: {},                      // not scraped; app sources amenities from community votes
      addr_complete: !!(r.street && r.city && r.state && r.zip),
      missing,
    },
  };
}

// ---- main ---------------------------------------------------------
(async function main() {
  console.log('Discovering store URLs…');
  const urls = await discoverStoreUrls();
  console.log(`Found ${urls.length} store URLs.`);
  if (URLS_ONLY) {
    fs.writeFileSync('quiktrip-urls.txt', urls.join('\n'));
    console.log('Wrote quiktrip-urls.txt');
    return;
  }
  const targets = urls.slice(0, argLimit);
  console.log(`Scraping ${targets.length} stores (concurrency ${CONCURRENCY})…`);

  const parsed = [];
  const failures = [];
  let done = 0;
  await pool(targets, CONCURRENCY, async (url) => {
    const { ok, text, status } = await fetchText(url);
    done++;
    if (done % 50 === 0) console.log(`  …${done}/${targets.length}`);
    if (!ok || !text) { failures.push({ url, status }); return; }
    try { parsed.push(parseStore(text, url)); }
    catch (e) { failures.push({ url, status: 'parse-error:' + e.message }); }
  });

  // de-dupe by store id, keep first
  const seen = new Set();
  const records = [];
  const flagged = [];
  for (const r of parsed) {
    const problem = coordProblem(r);
    if (problem) flagged.push({ url: r.url, problem, lat: r.lat, lng: r.lng });
    const app = toAppRecord(r);
    if (seen.has(app.id)) continue;
    seen.add(app.id);
    records.push(app);
  }
  records.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  // write chain file (one record per line, matching the other *-locations.js files)
  const body = records.map((r) => JSON.stringify(r)).join(',\n');
  fs.writeFileSync('quiktrip-locations.js', `window.quiktripLocations = [\n${body}\n];\n`);
  fs.writeFileSync('quiktrip-locations.json', JSON.stringify(records, null, 2));

  const non24 = records.filter((r) => r.hrs !== '24');
  const noHours = records.filter((r) => r.hrs === '');
  const report = [
    `QuikTrip scrape — ${new Date().toISOString()}`,
    `Store URLs discovered : ${urls.length}`,
    `Scraped OK            : ${parsed.length}`,
    `Unique records written: ${records.length}`,
    `Fetch/parse failures  : ${failures.length}`,
    `Coordinate flags      : ${flagged.length}`,
    `Not 24h (review)      : ${non24.length}`,
    `Hours unknown/varies  : ${noHours.length}`,
    '',
    '--- coordinate flags ---',
    ...flagged.map((f) => `${f.problem}\t${f.lat},${f.lng}\t${f.url}`),
    '',
    '--- non-24h stores (verify store vs kitchen) ---',
    ...non24.map((r) => `${r.id}\t${r.hrs || '(unknown)'}\t${r.meta.website}`),
    '',
    '--- failures ---',
    ...failures.map((f) => `${f.status}\t${f.url}`),
  ].join('\n');
  fs.writeFileSync('quiktrip-report.txt', report);

  console.log('\nDone.');
  console.log(`  quiktrip-locations.js   (${records.length} records)`);
  console.log(`  quiktrip-locations.json`);
  console.log(`  quiktrip-report.txt     (${failures.length} failures, ${flagged.length} coord flags, ${non24.length} non-24h)`);
  if (flagged.length || failures.length || non24.length)
    console.log('  ^ review the report before shipping the data file.');
})().catch((e) => { console.error(e); process.exit(1); });
