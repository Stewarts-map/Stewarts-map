#!/usr/bin/env node
// enrich-features.js — add OSM-verified feature flags to an EXISTING *-locations.js.
// Supersedes enrich-wheelchair.js (which only did accessibility).
//
// Writes a compact  "osm": { accessible:1, changing:1, gas:1, evCharging:1, wifi:1 }  object
// onto each matched record — only the flags OSM actually confirms, only when true. These map
// 1:1 to the app's feature keys, so the popup can show them as "verified" badges alongside
// community-confirmed ones. Existing ids/names/addresses/hours are never touched, and any
// osm value already present is preserved (curation wins over a re-pull).
//
// Usage:
//   node enrich-features.js <chain-locations.js> <fresh.geojson> [matchMeters=150]

const fs = require('fs');
const [,, locPath, geoPath, metersArg] = process.argv;
if(!locPath || !geoPath){
  console.error('Usage: node enrich-features.js <chain-locations.js> <fresh.geojson> [matchMeters=150]');
  process.exit(1);
}
const MATCH_METERS = Number(metersArg) || 150;

const src = fs.readFileSync(locPath, 'utf8');
const start = src.indexOf('['), end = src.lastIndexOf(']');
const header = src.slice(0, start);
const locations = JSON.parse(src.slice(start, end + 1));

const geo = JSON.parse(fs.readFileSync(geoPath, 'utf8'));

function featurePoint(f){
  const g = f.geometry; if(!g) return null;
  if(g.type === 'Point') return { lat: g.coordinates[1], lng: g.coordinates[0] };
  const flat = [];
  (function walk(c){ if(typeof c[0] === 'number') flat.push(c); else c.forEach(walk); })(g.coordinates);
  if(!flat.length) return null;
  return { lat: flat.reduce((s,p)=>s+p[1],0)/flat.length, lng: flat.reduce((s,p)=>s+p[0],0)/flat.length };
}

// OSM tags -> the app's feature keys. Only high-confidence mappings; anything OSM can't
// reliably express (indoor seating, hand-drying method, single vs multiple stalls) is left
// to community confirmation.
function derive(p){
  const f = {};
  if(p.wheelchair === 'yes' || p.wheelchair === 'designated'
     || p['toilets:wheelchair'] === 'yes' || p['toilets:wheelchair'] === 'designated') f.accessible = 1;
  if(p.wheelchair === 'no' || p['toilets:wheelchair'] === 'no') f.accessibleNo = 1;   // explicit "not accessible" — drives the filter, never shown as a badge
  if(p.changing_table === 'yes') f.changing = 1;
  if(p.amenity === 'fuel' || Object.keys(p).some(k => k.startsWith('fuel:'))) f.gas = 1;
  if(p['fuel:electricity'] === 'yes' || p.amenity === 'charging_station') f.evCharging = 1;
  if(p.compressed_air === 'yes') f.airPump = 1;
  if(p.shower === 'yes' || p.shower === 'yes/hot') f.shower = 1;
  if(['wlan','yes','wifi'].includes(p.internet_access)) f.wifi = 1;
  return f;
}

const feats = [];
for(const f of (geo.features || [])){
  const pt = featurePoint(f);
  if(pt) feats.push({ pt, flags: derive(f.properties || {}) });
}

function distM(a, b){
  const dLat = (a.lat - b.lat) * 111000;
  const dLng = (a.lng - b.lng) * 111000 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLng);
}

const tally = { accessible:0, changing:0, gas:0, evCharging:0, airPump:0, shower:0, wifi:0 };
let touched = 0;
for(const loc of locations){
  const here = { lat: Number(loc.lat), lng: Number(loc.lng) };
  if(!Number.isFinite(here.lat) || !Number.isFinite(here.lng)) continue;
  const merged = {};
  for(const f of feats){
    if(distM(here, f.pt) <= MATCH_METERS) Object.assign(merged, f.flags);
  }
  if(!Object.keys(merged).length) continue;
  const existing = loc.osm || {};
  // Curation wins: keep any flag already present, add newly-derived ones.
  const next = { ...merged, ...existing };
  loc.osm = next;
  touched++;
  for(const k of Object.keys(merged)) if(next[k]) tally[k]++;
}

fs.writeFileSync(locPath, header + JSON.stringify(locations) + ';\n');
console.log(`${locPath}: ${locations.length} records | enriched ${touched} | ` +
  Object.entries(tally).map(([k,v]) => `${k}:${v}`).join('  '));
