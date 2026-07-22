'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const KEY_FILE = path.join(__dirname, 'serviceAccountKey.json');
const OVERRIDES_JSON = path.join(__dirname, 'overrides.json');
const OUT_DIR = path.join(__dirname, 'baked');
if (!fs.existsSync(KEY_FILE)) { console.error('\n✗ serviceAccountKey.json not found here.'); process.exit(1); }
let admin;
try { admin = require('firebase-admin'); }
catch (e) { console.error('\n✗ firebase-admin not installed. Run: npm install firebase-admin\n'); process.exit(1); }
async function main() {
  admin.initializeApp({ credential: admin.cert(require(KEY_FILE)) });
  const db = require('firebase-admin/firestore').getFirestore();
  console.log('Reading overrides from Firestore (read-only)…');
  const snap = await db.collection('overrides').get();
  const overrides = {};
  snap.forEach(doc => { overrides[doc.id] = doc.data(); });
  const ids = Object.keys(overrides);
  console.log('Fetched ' + ids.length + ' override(s).');
  if (ids.length === 0) { console.log('Nothing to bake.'); process.exit(0); }
  fs.writeFileSync(OVERRIDES_JSON, JSON.stringify(overrides, null, 2));
  console.log('\nBaking into ./baked/ …\n');
  execFileSync('node', ['bake-overrides.js', OVERRIDES_JSON, '.', OUT_DIR], { stdio: 'inherit' });
  console.log('\nReview ./baked/ then push the location files.\n');
  process.exit(0);
}
main().catch(err => { console.error('\n✗ Failed:', err.message || err); process.exit(1); });
