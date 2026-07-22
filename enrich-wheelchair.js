#!/usr/bin/env node
// enrich-wheelchair.js — add OSM accessibility data to an EXISTING *-locations.js
// without rebaking it. Existing ids, names, addresses, hours, and store numbers are
// never touched (so ratings/tips keyed by id stay attached, and hand-curated data
// survives). The only change: records gain `"wheelchair":"yes"` when a fresh OSM
// GeoJSON feature tagged wheelchair=yes (or toilets:wheelchair=yes/designated)
// sits within MATCH_METERS of the record's coordinates.
//
// Usage:
//   node enrich-wheelchair.js <chain-locations.js> <fresh.geojson> [matchMeters=150]
//
// Get the GeoJSON from Overpass Turbo (Export → GeoJSON) with the chain's QID:
//   [out:json][timeout:120];
//   nwr["brand:wikidata"="Q_CHAIN_ID"](24.5,-125.0,49.5,-66.9);
//   out center;
//
// Existing wheelchair values in the locations file are never overwritten —
// curated data always wins over a re-pull.

const fs = require('fs');

const [,, locPath, geoPath, metersArg] = process.argv;
if(!locPath || !geoPath){
  console.error('Usage: node enrich-wheelchair.js <chain-locations.js> <fresh.geojson> [matchMeters=150]');
  process.exit(1);
}
const MATCH_METERS = Number(metersArg) || 150;

// ---- load the locations file (window.xyzLocations = [...] format) ----
const src = fs.readFileSync(locPath, 'utf8');
const start = src.indexOf('['), end = src.lastIndexOf(']');
if(start < 0 || end < 0){ console.error('Could not find the locations array in ' + locPath); process.exit(1); }
const header = src.slice(0, start);
const locations = JSON.parse(src.slice(start, end + 1));

// ---- load geojson, keep only accessibility-positive features with a usable point ----
const geo = JSON.parse(fs.readFileSync(geoPath, 'utf8'));

function featurePoint(f){
  const g = f.geometry;
  if(!g) return null;
  if(g.type === 'Point') return { lat: g.coordinates[1], lng: g.coordinates[0] };
  // For polygons, a simple vertex average is plenty for a proximity match
  const flat = [];
  (function walk(c){ if(typeof c[0] === 'number') flat.push(c); else c.forEach(walk); })(g.coordinates);
  if(!flat.length) return null;
  return {
    lat: flat.reduce((s,p)=>s+p[1],0)/flat.length,
    lng: flat.reduce((s,p)=>s+p[0],0)/flat.length
  };
}

const accessible = [];
for(const f of (geo.features || [])){
  const p = f.properties || {};
  const yes = p.wheelchair === 'yes' || ['yes','designated'].includes(p['toilets:wheelchair']);
  if(!yes) continue;
  const pt = featurePoint(f);
  if(pt) accessible.push(pt);
}

function distM(a, b){
  const dLat = (a.lat - b.lat) * 111000;
  const dLng = (a.lng - b.lng) * 111000 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLng);
}

// ---- match & enrich ----
let added = 0, alreadyHad = 0;
for(const loc of locations){
  if(loc.wheelchair !== undefined){ alreadyHad++; continue; }   // curated value wins
  const here = { lat: Number(loc.lat), lng: Number(loc.lng) };
  if(!Number.isFinite(here.lat) || !Number.isFinite(here.lng)) continue;
  if(accessible.some(pt => distM(here, pt) <= MATCH_METERS)){
    loc.wheelchair = 'yes';
    added++;
  }
}

fs.writeFileSync(locPath, header + JSON.stringify(locations) + ';\n');
console.log(`${locPath}: ${locations.length} records | accessible OSM features: ${accessible.length} | added wheelchair:"yes" to ${added} | left ${alreadyHad} existing values untouched`);
