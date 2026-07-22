#!/usr/bin/env node
// add-missing.js — add stores OSM has but your *-locations.js is missing.
//
// SAFE BY DESIGN:
//  * New stores get brand-new ids (prefixed, unique) so no existing rating/tip can be orphaned
//    (only CHANGING an existing id is destructive; we never touch existing records).
//  * Dedupe vs existing: any OSM store within DEDUPE_M of a store you already have is treated as
//    the same store and skipped.
//  * Dedupe vs itself: remaining OSM features are clustered (building + point + canopy collapse)
//    so each real store is added once.
//  * Added records carry "src":"osm" so they're distinguishable from hand-curated ones and can be
//    reviewed/pruned later.
//
// Records are built in your format {n,lat,lng,addr,id[,num][,hrs][,osm]} with enriched features
// and OSM hours where parseable.
//
// Usage:
//   node add-missing.js <chain-locations.js> <fresh.geojson> [--dry] [dedupeM=150] [clusterM=250]
//   --dry  : report only, write nothing.

const fs = require('fs');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const addressedOnly = args.includes('--addressed-only');
const positional = args.filter(a => !a.startsWith('--'));
const [locPath, geoPath, dedupeArg, clusterArg] = positional;
if(!locPath || !geoPath){
  console.error('Usage: node add-missing.js <chain-locations.js> <fresh.geojson> [--dry] [dedupeM=150] [clusterM=250]');
  process.exit(1);
}
const DEDUPE_M  = Number(dedupeArg)  || 150;
const CLUSTER_M = Number(clusterArg) || 250;

// ---- load existing locations ----
const src = fs.readFileSync(locPath, 'utf8');
const startI = src.indexOf('['), endI = src.lastIndexOf(']');
const header = src.slice(0, startI);
const locations = JSON.parse(src.slice(startI, endI + 1));
const existingIds = new Set(locations.map(l => l.id));
const idPrefix = (locPath.split('/').pop().replace(/-locations\.js$/, '')) || 'loc';

// ---- geometry + parsing helpers (shared with the other tools) ----
function ringCentroid(ring){
  let a=0,cx=0,cy=0;
  for(let i=0;i<ring.length-1;i++){
    const [x0,y0]=ring[i], [x1,y1]=ring[i+1];
    const cr=x0*y1-x1*y0; a+=cr; cx+=(x0+x1)*cr; cy+=(y0+y1)*cr;
  }
  if(Math.abs(a)<1e-12){
    const xs=ring.map(p=>p[0]), ys=ring.map(p=>p[1]);
    return [xs.reduce((s,v)=>s+v,0)/xs.length, ys.reduce((s,v)=>s+v,0)/ys.length];
  }
  a*=0.5; return [cx/(6*a), cy/(6*a)];
}
function centroid(g){
  if(!g) return null;
  if(g.type==='Point') return [g.coordinates[0], g.coordinates[1]];
  if(g.type==='Polygon') return ringCentroid(g.coordinates[0]);
  if(g.type==='MultiPolygon'){ const best=g.coordinates.reduce((m,p)=>p[0].length>m[0].length?p:m); return ringCentroid(best[0]); }
  return null;
}
function norm(t){ const [h,m]=t.split(':'); return String(h).padStart(2,'0')+String(m).padStart(2,'0'); }
function parseOsmHours(oh){
  if(!oh) return null;
  let s=String(oh).trim();
  if(s==='24/7') return '24';
  s=s.replace(/\bPH\b|\bSH\b/g,'').replace(/,/g,' ').trim().replace(/^Mo\s*-\s*Su\s+/,'').trim();
  if(/[A-Za-z;]/.test(s)||s.includes('+')||s.includes('off')) return null;
  const m=s.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/); if(!m) return null;
  let o=norm(m[1]), c=norm(m[2]);
  if(o===c) return '24';
  if(o==='0000'&&(c==='2400'||c==='2359')) return '24';
  if((o==='2359'||o==='0000')&&(c==='2400'||c==='0000'||c==='2359')) return '24';
  if(c==='2400') c='0000';
  return `${o}-${c}`;
}
function derive(p){
  const f={};
  if(p.wheelchair==='yes'||p.wheelchair==='designated'||p['toilets:wheelchair']==='yes'||p['toilets:wheelchair']==='designated') f.accessible=1;
  if(p.changing_table==='yes') f.changing=1;
  if(p.amenity==='fuel'||Object.keys(p).some(k=>k.startsWith('fuel:'))) f.gas=1;
  if(p['fuel:electricity']==='yes'||p.amenity==='charging_station') f.evCharging=1;
  if(p.compressed_air==='yes') f.airPump=1;
  if(p.shower==='yes'||p.shower==='yes/hot') f.shower=1;
  if(['wlan','yes','wifi'].includes(p.internet_access)) f.wifi=1;
  return f;
}
function distM(a,b){
  const dLat=(a[1]-b[1])*111000;
  const dLng=(a[0]-b[0])*111000*Math.cos(((a[1]+b[1])/2)*Math.PI/180);
  return Math.hypot(dLat,dLng);
}
function slug(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,''); }

// ---- collect candidate store features from the geojson ----
const cands = [];
for(const f of (JSON.parse(fs.readFileSync(geoPath,'utf8')).features||[])){
  const p=f.properties||{};
  if('proposed' in p || 'disused:shop' in p || 'disused:amenity' in p) continue;
  const looksLikeStore = p['addr:street']||p.ref||p.shop||p.amenity;
  if(!looksLikeStore) continue;
  const c=centroid(f.geometry); if(!c) continue;
  cands.push({ lng:c[0], lat:c[1], p, isPoint:f.geometry.type==='Point' });
}

// existing store coords for dedupe
const existingPts = locations.map(l=>[Number(l.lng), Number(l.lat)]).filter(p=>Number.isFinite(p[0])&&Number.isFinite(p[1]));

// drop candidates near an existing store (already have it)
const newCands = cands.filter(c => !existingPts.some(ep => distM([c.lng,c.lat], ep) <= DEDUPE_M));

// cluster the remainder among themselves
const used = new Array(newCands.length).fill(false);
const clusters = [];
for(let i=0;i<newCands.length;i++){
  if(used[i]) continue;
  const grp=[i]; used[i]=true;
  for(let j=i+1;j<newCands.length;j++){
    if(used[j]) continue;
    if(distM([newCands[i].lng,newCands[i].lat],[newCands[j].lng,newCands[j].lat]) <= CLUSTER_M){ used[j]=true; grp.push(j); }
  }
  clusters.push(grp);
}

// build a record per cluster
function pickAddrProps(grp){
  let best=null,score=-1;
  for(const i of grp){ const p=newCands[i].p; const s=['addr:housenumber','addr:street','addr:city','addr:state','addr:postcode'].filter(k=>p[k]).length; if(s>score){score=s;best=p;} }
  return best||newCands[grp[0]].p;
}
function firstOf(grp,...keys){ for(const i of grp){ const p=newCands[i].p; for(const k of keys){ if(p[k]) return p[k]; } } return null; }
function pointCoord(grp){ for(const i of grp){ if(newCands[i].isPoint) return [newCands[i].lng,newCands[i].lat]; } return [newCands[grp[0]].lng,newCands[grp[0]].lat]; }
function mergedFlags(grp){ const f={}; for(const i of grp){ Object.assign(f, derive(newCands[i].p)); } return f; }
function mergedHours(grp){ for(const i of grp){ const h=parseOsmHours(newCands[i].p.opening_hours); if(h) return h; } return null; }

const added=[]; const seenIds=new Set(existingIds); let bare=0;
for(const grp of clusters){
  const ap=pickAddrProps(grp);
  const [lng,lat]=pointCoord(grp);
  const hn=ap['addr:housenumber'], st=ap['addr:street'], city=ap['addr:city'], state=ap['addr:state'], pc=ap['addr:postcode'];
  const ref=firstOf(grp,'ref');
  let n, isBare=false;
  if(city&&state) n=`${city}, ${state}`;
  else if(city) n=city;
  else if(st) n=st;
  else { n=firstOf(grp,'name','brand')||idPrefix; bare++; isBare=true; }
  const parts=[];
  if(hn&&st) parts.push(`${hn} ${st}`); else if(st) parts.push(st);
  const csz=[city?city+',':null,state,pc].filter(Boolean).join(' ');
  if(csz) parts.push(csz);
  const addr = parts.length ? parts.join(', ') : n;

  let base;
  if(ref) base=`${idPrefix}-osm-${slug(ref)}`;
  else if(city&&state) base=`${idPrefix}-osm-${slug(state)}-${slug(city)}`;
  else base=`${idPrefix}-osm-${String(lat.toFixed(4)+lng.toFixed(4)).replace(/[.\-]/g,'')}`;
  let id=base,k=2; while(seenIds.has(id)){ id=`${base}-${k++}`; } seenIds.add(id);

  const rec={ n, lat:+lat.toFixed(6), lng:+lng.toFixed(6), addr, id, src:'osm' };
  if(ref) rec.num=String(ref);
  const hrs=mergedHours(grp); if(hrs) rec.hrs=hrs;
  const osm=mergedFlags(grp); if(Object.keys(osm).length) rec.osm=osm;
  if(addressedOnly && isBare) continue;   // skip nameless points in addressed-only mode
  added.push(rec);
}

// report
const withAddr = added.filter(r => r.addr !== r.n || /\d/.test(r.addr)).length;
console.log(`${locPath}`);
console.log(`  existing: ${locations.length} | OSM store features: ${cands.length} | not near an existing store: ${newCands.length} -> ${clusters.length} clusters`);
console.log(`  WOULD ADD: ${added.length}  (with usable address: ${withAddr} | bare "${idPrefix}" points: ${bare})`);
console.log(`  with hours: ${added.filter(r=>r.hrs).length} | with features: ${added.filter(r=>r.osm).length}`);

if(dry){ console.log('  [dry run — nothing written]'); process.exit(0); }

const out = locations.concat(added);
fs.writeFileSync(locPath, header + JSON.stringify(out) + ';\n');
console.log(`  WROTE: ${out.length} total records (${added.length} added)`);
