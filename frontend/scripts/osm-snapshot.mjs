#!/usr/bin/env node
// Saves a real OpenStreetMap snapshot (signals + roads) for every quick-pick city into public/osm/,
// so the Real-World Signal Map opens those places instantly. The map still offers a live refresh.
//
//   node scripts/osm-snapshot.mjs            (all cities)
//   node scripts/osm-snapshot.mjs delhi noida
//
// Data © OpenStreetMap contributors, ODbL 1.0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_CITIES } from '../lib/cityData.js';
import { bboxAround, bboxKey, signalsQuery, overpass, trimOverpass, extractSignalNetwork, SNAPSHOT_RADIUS_M } from '../lib/osmSignals.js';

// The public Overpass servers reject Node's default user agent
const nodeFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) => nodeFetch(url, { ...opts, headers: { ...(opts.headers || {}), 'User-Agent': 'traffic-swarm-intelligence/1.3 (snapshot script)' } });

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'osm');
fs.mkdirSync(outDir, { recursive: true });
const wanted = process.argv.slice(2);
let failed = 0;

for (const city of SUPPORTED_CITIES.filter(c => !wanted.length || wanted.includes(c.id))) {
  const bbox = bboxAround(city.center[0], city.center[1], SNAPSHOT_RADIUS_M);
  const t0 = Date.now();
  try {
    const osm = trimOverpass(await overpass(signalsQuery(bbox), { timeoutMs: 600000 }));
    const net = extractSignalNetwork(osm, { center: city.center });
    const file = path.join(outDir, `${city.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ key: bboxKey(bbox), radiusM: SNAPSHOT_RADIUS_M, center: city.center, savedAt: new Date().toISOString(), osm }));
    console.log(`${city.id}: ${net.stats.signalNodes} signal nodes -> ${net.stats.shown} junctions, ${net.stats.links} links `
      + `(${(fs.statSync(file).size / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  } catch (err) {
    failed += 1;
    console.error(`${city.id}: FAILED ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
