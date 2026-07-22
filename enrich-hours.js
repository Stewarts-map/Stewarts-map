#!/usr/bin/env node
// enrich-hours.js — fill MISSING store hours from OSM opening_hours.
//
// Only fills records that currently have no hrs and no per-day hours map — hand-curated or
// previously-baked hours are never overwritten. Converts the confidently-parseable subset of
// OSM opening_hours into the app's hrs format ("24" | "HHMM-HHMM"); anything ambiguous
// (per-day differences, holidays with offsets, "off", comments) is skipped and left for
// community/manual entry. Filled records are marked "hrsSrc":"osm" for later auditing.
//
// Usage:
//   node enrich-hours.js <chain-locations.js> <fresh.geojson> [matchMeters=150]

const fs = require('fs');
const [,, locPath, geoPath, metersArg] = process.argv;
if(!locPath || !geoPath){
  console.error('Usage: node enrich-hours.js <chain-locations.js> <fresh.geojson> [matchMeters=150]');
  process.exit(1);
}
const MATCH_METERS = Number(metersArg) || 150;

function norm(t){ const [h,m] = t.split(':'); return String(h).padStart(2,'0')+String(m).padStart(2,'0'); }

// OSM opening_hours -> app hrs string, or null if not confidently parseable.
function parseOsmHours(oh){
  let s = String(oh).trim();
  if(s === '24/7') return '24';
  s = s.replace(/\bPH\b|\bSH\b/g, '').replace(/,/g, ' ').trim();   // drop holiday tokens
  s = s.replace(/^Mo\s*-\s*Su\s+/, '').trim();                     // drop all-week prefix
  if(/[A-Za-z;]/.test(s) || s.includes('+') || s.includes('off')) return null;  // too complex
  const m = s.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if(!m) return null;
  let o = norm(m[1]), c = norm(m[2]);
  if(o === c) return '24';                                         // 00:00-00:00 etc.
  if(o === '0000' && (c === '2400' || c === '2359')) return '24';
  if((o === '2359' || o === '0000') && (c === '2400' || c === '0000' || c === '2359')) return '24';
  if(c === '2400') c = '0000';
  return `${o}-${c}`;
}

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
const hourFeats = [];
for(const f of (geo.features || [])){
  const oh = (f.properties || {}).opening_hours;
  if(!oh) continue;
  const hrs = parseOsmHours(oh);
  if(!hrs) continue;
  const pt = featurePoint(f);
  if(pt) hourFeats.push({ pt, hrs });
}

function distM(a, b){
  const dLat = (a.lat - b.lat) * 111000;
  const dLng = (a.lng - b.lng) * 111000 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLng);
}

let filled = 0, skippedConflict = 0;
for(const loc of locations){
  if(loc.hrs || (loc.hours && typeof loc.hours === 'object' && Object.keys(loc.hours).length)) continue; // never overwrite
  const here = { lat: Number(loc.lat), lng: Number(loc.lng) };
  if(!Number.isFinite(here.lat) || !Number.isFinite(here.lng)) continue;
  // nearest OSM feature that has parseable hours
  let best = null, bestD = Infinity;
  for(const f of hourFeats){
    const dd = distM(here, f.pt);
    if(dd <= MATCH_METERS && dd < bestD){ bestD = dd; best = f; }
  }
  if(!best){ continue; }
  loc.hrs = best.hrs;
  loc.hrsSrc = 'osm';
  filled++;
}

fs.writeFileSync(locPath, header + JSON.stringify(locations) + ';\n');
const stillMissing = locations.filter(l => !l.hrs && !(l.hours && Object.keys(l.hours||{}).length)).length;
console.log(`${locPath}: filled hours on ${filled} records from OSM | ${stillMissing} still missing | ${hourFeats.length} OSM features had usable hours`);
