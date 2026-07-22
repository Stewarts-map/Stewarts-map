#!/usr/bin/env node
// build-osm-sidecar.js — preserve the FULL OSM property set from a pull, keyed to your
// location ids, WITHOUT bloating the startup-loaded *-locations.js files.
//
// The main location files stay lean (they load for all 5,500+ pins at once). This sidecar
// is a data reservoir: it is NOT loaded at startup — you read it on demand later when you
// build features like "baby changing table", "ATM inside", "open 24h", store hours, or when
// seeding missing stores. Nothing from the OSM pull is discarded.
//
// Usage:
//   node build-osm-sidecar.js <chain-locations.js> <fresh.geojson> <out.json> [matchMeters=150]
//
// Output shape:
//   {
//     "generatedAt": "...ISO...",
//     "source": "fresh.geojson",
//     "matchMeters": 150,
//     "matched":   { "<locId>": { ...all OSM tags merged for that store... }, ... },
//     "unmatched": [ { "lat":.., "lng":.., ...all OSM tags... }, ... ]   // OSM stores NOT in your file
//   }
//
// "matched" enriches stores you already ship. "unmatched" are real OSM stores your baked
// file is missing — useful later for adding locations (safe: new ids orphan nothing).

const fs = require('fs');

const [,, locPath, geoPath, outPath, metersArg] = process.argv;
if(!locPath || !geoPath || !outPath){
  console.error('Usage: node build-osm-sidecar.js <chain-locations.js> <fresh.geojson> <out.json> [matchMeters=150]');
  process.exit(1);
}
const MATCH_METERS = Number(metersArg) || 150;

// ---- load locations ----
const src = fs.readFileSync(locPath, 'utf8');
const locations = JSON.parse(src.slice(src.indexOf('['), src.lastIndexOf(']') + 1));

// ---- load geojson ----
const geo = JSON.parse(fs.readFileSync(geoPath, 'utf8'));

function featurePoint(f){
  const g = f.geometry; if(!g) return null;
  if(g.type === 'Point') return { lat: g.coordinates[1], lng: g.coordinates[0] };
  const flat = [];
  (function walk(c){ if(typeof c[0] === 'number') flat.push(c); else c.forEach(walk); })(g.coordinates);
  if(!flat.length) return null;
  return { lat: flat.reduce((s,p)=>s+p[1],0)/flat.length, lng: flat.reduce((s,p)=>s+p[0],0)/flat.length };
}

// Keep every tag except the ones that carry no future value / are pure noise.
const DROP = new Set(['brand','brand:wikidata']);
function cleanProps(p){
  const out = {};
  for(const k of Object.keys(p)){ if(!DROP.has(k)) out[k] = p[k]; }
  return out;
}
function tagCount(o){ return Object.keys(o).length; }

const features = [];
for(const f of (geo.features || [])){
  const pt = featurePoint(f);
  if(!pt) continue;
  features.push({ pt, props: cleanProps(f.properties || {}) });
}

function distM(a, b){
  const dLat = (a.lat - b.lat) * 111000;
  const dLng = (a.lng - b.lng) * 111000 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLng);
}

// ---- match each location to nearby OSM features, merge their tags ----
const matched = {};
const claimed = new Set();          // feature indices consumed by a location
for(const loc of locations){
  const here = { lat: Number(loc.lat), lng: Number(loc.lng) };
  if(!Number.isFinite(here.lat) || !Number.isFinite(here.lng)) continue;
  const near = [];
  features.forEach((f, i) => { if(distM(here, f.pt) <= MATCH_METERS){ near.push(i); } });
  if(!near.length) continue;
  // Merge: start from the feature with the most tags, then fill gaps from the others.
  near.sort((a,b) => tagCount(features[b].props) - tagCount(features[a].props));
  const merged = {};
  for(const i of near){
    claimed.add(i);
    for(const [k,v] of Object.entries(features[i].props)){
      if(merged[k] === undefined) merged[k] = v;   // first (richest feature) wins on conflict
    }
  }
  if(tagCount(merged)) matched[loc.id] = merged;
}

// ---- unmatched OSM features = stores you don't have yet ----
const unmatched = [];
features.forEach((f, i) => {
  if(claimed.has(i)) return;
  // Only keep unmatched that look like a real store node (have address or a store ref),
  // so we don't hoard stray building outlines.
  const p = f.props;
  const looksLikeStore = p['addr:street'] || p.ref || p['ref:wawa'] || p.shop || p.amenity;
  if(!looksLikeStore) return;
  unmatched.push({ lat: +f.pt.lat.toFixed(6), lng: +f.pt.lng.toFixed(6), ...p });
});

const payload = {
  generatedAt: new Date().toISOString(),
  source: geoPath.split('/').pop(),
  matchMeters: MATCH_METERS,
  matched,
  unmatched
};
fs.writeFileSync(outPath, JSON.stringify(payload));
console.log(`${outPath}: matched ${Object.keys(matched).length}/${locations.length} of your stores | ${unmatched.length} unmatched OSM stores kept for later | ${features.length} OSM features scanned`);
