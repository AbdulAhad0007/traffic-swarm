// Real signalised junctions for any area, read live from OpenStreetMap through the Overpass API
// (data © OpenStreetMap contributors, ODbL 1.0). A junction exists here only where OSM has mapped
// highway=traffic_signals nodes; nothing is generated, shifted or interpolated. Two junctions are
// linked only when a drivable OSM road connects them, and the link follows that road's geometry.

// Public Overpass servers, tried in this order. z. and lz4. are the two machines behind the
// overpass-api.de balancer, listed directly because the balancer answers 502 while one of them is fine.
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Drivable road classes used for snapping signals and tracing links (no footways / service roads)
export const ROAD_CLASSES = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'road',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
];
const ROAD_RANK = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, motorway_link: 5, trunk_link: 5, primary_link: 5,
  secondary_link: 6, tertiary_link: 6, unclassified: 7, residential: 8, living_street: 9, road: 9,
};
// Same road set as simulation/network/fetch_osm_extract.py so a downloaded .osm imports identically
const EXTRACT_HIGHWAYS = 'trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|'
  + 'trunk_link|primary_link|secondary_link|tertiary_link|footway|pedestrian';

export const LIMITS = {
  maxAreaKm2: 36,       // one scan; keeps Overpass responses to a few MB
  maxJunctions: 160,    // junctions simulated at once (the nearest to the centre are kept)
  clusterM: 45,         // signal heads closer than this belong to one junction
  captureM: 30,         // road nodes this close to a signal head belong to that junction
  snapM: 20,            // a signal not on a drivable road is snapped to one this close, else dropped
  mergeRoadM: 35,       // signal groups whose roads meet within this distance are one junction
  passM: 40,            // a traced link passing this close to another signal is not a direct link
  detourFactor: 1.25,   // drop a link when shorter links already join its ends within this factor
  maxLinkM: 3000,       // longest road link traced between two neighbouring junctions
};

// Quick-pick cities ship with a bundled snapshot at this radius (scripts/osm-snapshot.mjs)
export const SNAPSHOT_RADIUS_M = 1500;

const M_PER_DEG_LAT = 110570;
const mPerDegLon = lat => 111320 * Math.cos((lat * Math.PI) / 180);

export function distM(a, b) {
  return Math.hypot((b.lon - a.lon) * mPerDegLon((a.lat + b.lat) / 2), (b.lat - a.lat) * M_PER_DEG_LAT);
}

// ---------------------------------------------------------------- areas
export function bboxAround(lat, lon, radiusM) {
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLon = radiusM / mPerDegLon(lat);
  return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon };
}

export function bboxAreaKm2(b) {
  const h = (b.north - b.south) * M_PER_DEG_LAT;
  const w = (b.east - b.west) * mPerDegLon((b.north + b.south) / 2);
  return Math.abs(h * w) / 1e6;
}

export const bboxCenter = b => [(b.south + b.north) / 2, (b.west + b.east) / 2];

// Shrinks a box around its centre until it fits within maxKm2
export function clampBbox(b, maxKm2 = LIMITS.maxAreaKm2) {
  const area = bboxAreaKm2(b);
  if (area <= maxKm2) return b;
  const f = Math.sqrt(maxKm2 / area);
  const [lat, lon] = bboxCenter(b);
  const hLat = ((b.north - b.south) / 2) * f;
  const hLon = ((b.east - b.west) / 2) * f;
  return { south: lat - hLat, west: lon - hLon, north: lat + hLat, east: lon + hLon };
}

const fmt = x => x.toFixed(6);
const bboxText = b => `${fmt(b.south)},${fmt(b.west)},${fmt(b.north)},${fmt(b.east)}`;
export const bboxKey = b => [b.south, b.west, b.north, b.east].map(x => x.toFixed(4)).join(',');

// ---------------------------------------------------------------- Overpass
const MAJOR_ROADS = ROAD_CLASSES.filter(c => !['residential', 'living_street', 'road'].includes(c));

// Signals, every major road in the box, and minor roads only where they touch a signal (needed to
// tell a junction from a mid-block crossing). Skipping the bulk of residential streets makes the
// response several times smaller and faster for the server to answer.
export function signalsQuery(b) {
  const bb = bboxText(b);
  return `[out:json][timeout:90];node["highway"="traffic_signals"](${bb})->.sig;`
    + `(way["highway"~"^(${MAJOR_ROADS.join('|')})$"](${bb});way(around.sig:60)["highway"~"^(${ROAD_CLASSES.join('|')})$"];)->.roads;`
    + '.sig out body;.roads out body geom;';
}

// Road extract in OSM XML for SUMO netconvert (signal nodes carry their tags inside it)
export function extractQuery(b) {
  return `[out:xml][timeout:120];(way["highway"~"^(${EXTRACT_HIGHWAYS})$"](${bboxText(b)}););(._;>;);out body;`;
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

// Signal nodes only: a tiny query that busy servers still answer, so real lights appear first
export function signalsOnlyQuery(b) {
  return `[out:json][timeout:40];node["highway"="traffic_signals"](${bboxText(b)});out body;`;
}

// One round: every mirror, staggered, first good answer wins and cancels the rest
async function overpassRound(query, { as, staggerMs, deadline, signal }) {
  const ctrls = OVERPASS_ENDPOINTS.map(() => new AbortController());
  const cancelAll = () => ctrls.forEach(c => c.abort());
  const timer = setTimeout(cancelAll, Math.max(0, deadline - Date.now()));
  if (signal) signal.addEventListener('abort', cancelAll, { once: true });
  const failures = [];
  try {
    return { body: await Promise.any(OVERPASS_ENDPOINTS.map(async (url, i) => {
      const host = new URL(url).host;
      try {
        if (i) await wait(i * staggerMs, ctrls[i].signal);
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: ctrls[i].signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`);
        const body = as === 'json' ? await res.json() : await res.text();
        // Overpass reports a query timeout inside an HTTP 200 answer
        const remark = as === 'json' ? body.remark : (/<remark>([^<]*)<\/remark>/.exec(body) || [])[1];
        if (remark && /runtime error|timed out|out of memory/i.test(remark)) throw new Error(remark.trim().slice(0, 120));
        ctrls.forEach((c, k) => { if (k !== i) c.abort(); });
        return body;
      } catch (err) {
        failures.push(`${host}: ${err.name === 'AbortError' ? 'no answer in time' : err.message}`);
        throw err;
      }
    })) };
  } catch {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return { failures };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', cancelAll);
  }
}

/**
 * Asks all public Overpass mirrors (the main one gets a short head start) and returns the first good
 * answer. When every mirror fails (they answer 502/504 under load) it waits and tries another round,
 * until `timeoutMs` is used up. `onRetry({ round, failures })` reports each failed round.
 */
export async function overpass(query, { signal, as = 'json', timeoutMs = 180000, staggerMs = 2000, rounds = 4, onRetry } = {}) {
  const deadline = Date.now() + timeoutMs;
  let failures = [];
  for (let round = 1; round <= rounds && Date.now() < deadline; round++) {
    const res = await overpassRound(query, { as, staggerMs, deadline, signal });
    if (res.body !== undefined) return res.body;
    failures = res.failures;
    if (round === rounds || Date.now() + 1000 >= deadline) break;
    if (onRetry) onRetry({ round, failures });
    await wait(Math.min(4000 * round, Math.max(0, deadline - Date.now() - 1000)), signal || new AbortController().signal);
  }
  throw new Error(`OpenStreetMap servers are overloaded right now (${failures.slice(0, 3).join('; ')}). `
    + 'This is the free public Overpass service, not this app. Retry in a minute, or pick a quick-pick city (saved copy).');
}

// ---------------------------------------------------------------- persistent cache
// Overpass answers are kept in IndexedDB for a week, so a place opens instantly the next time.
// Every access is guarded: private windows or blocked storage simply mean no cache.
const DB_NAME = 'tsi-osm';
const STORE = 'overpass';
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheGet(key) {
  try {
    const db = await openDb();
    const hit = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return hit && Date.now() - hit.savedAt < CACHE_TTL_MS ? hit.data : null;
  } catch {
    return null;
  }
}

export async function cachePut(key, data) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ savedAt: Date.now(), data }, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // storage unavailable or full: run without the cache
  }
}

// Keeps only what extractSignalNetwork reads, so snapshots and cache entries stay small
const WAY_TAGS = ['name', 'name:en', 'ref', 'highway', 'lanes', 'maxspeed', 'oneway', 'junction'];
export function trimOverpass(osm) {
  const r = x => Math.round(x * 1e7) / 1e7;
  return {
    osm3s: osm.osm3s ? { timestamp_osm_base: osm.osm3s.timestamp_osm_base } : undefined,
    elements: (osm.elements || []).map(e => (e.type === 'way'
      ? { type: 'way', id: e.id, nodes: e.nodes, geometry: (e.geometry || []).map(g => (g ? { lat: r(g.lat), lon: r(g.lon) } : null)),
        tags: Object.fromEntries(WAY_TAGS.filter(k => e.tags && e.tags[k] != null).map(k => [k, e.tags[k]])) }
      : { type: e.type, id: e.id, lat: e.lat, lon: e.lon, tags: e.tags })),
  };
}

// ---------------------------------------------------------------- spatial hash
class PointGrid {
  constructor(cellM, lat0) {
    this.dLat = cellM / M_PER_DEG_LAT;
    this.dLon = cellM / mPerDegLon(lat0);
    this.cells = new Map();
  }
  key(lat, lon) { return `${Math.floor(lat / this.dLat)}:${Math.floor(lon / this.dLon)}`; }
  add(lat, lon, item) {
    const k = this.key(lat, lon);
    if (!this.cells.has(k)) this.cells.set(k, []);
    this.cells.get(k).push(item);
  }
  near(lat, lon) {
    const r = Math.floor(lat / this.dLat);
    const c = Math.floor(lon / this.dLon);
    const out = [];
    for (let i = -1; i <= 1; i++) for (let k = -1; k <= 1; k++) {
      const cell = this.cells.get(`${r + i}:${c + k}`);
      if (cell) out.push(...cell);
    }
    return out;
  }
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(d, v) {
    const a = this.a;
    a.push([d, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------- road graph
function roadInfo(way) {
  const t = way.tags || {};
  return {
    wayId: way.id,
    name: t.name || t['name:en'] || null,
    ref: t.ref || null,
    highway: t.highway,
    lanes: t.lanes ? Number.parseInt(t.lanes, 10) || null : null,
    maxspeed: t.maxspeed || null,
    oneway: t.oneway === 'yes' || t.oneway === '1' || t.oneway === '-1' || t.junction === 'roundabout',
  };
}

const roadLabel = r => r.name || r.ref || null;

function buildGraph(ways) {
  const coord = new Map();
  const adj = new Map();
  const nodeWays = new Map();
  const roads = [];
  ways.forEach(way => {
    if (!way.geometry || !way.nodes || way.geometry.length !== way.nodes.length) return;
    const ri = roads.push(roadInfo(way)) - 1;
    way.nodes.forEach((id, n) => {
      const g = way.geometry[n];
      if (!g) return;
      coord.set(id, { lat: g.lat, lon: g.lon });
      if (!nodeWays.has(id)) nodeWays.set(id, new Set());
      nodeWays.get(id).add(ri);
      if (n === 0 || !way.geometry[n - 1]) return;
      const prev = way.nodes[n - 1];
      const d = distM(way.geometry[n - 1], g);
      if (!adj.has(prev)) adj.set(prev, []);
      if (!adj.has(id)) adj.set(id, []);
      adj.get(prev).push({ to: id, d, road: ri });
      adj.get(id).push({ to: prev, d, road: ri });
    });
  });
  const degree = id => new Set((adj.get(id) || []).map(e => e.to)).size;
  return { coord, adj, nodeWays, roads, degree };
}

// ---------------------------------------------------------------- the extraction
/**
 * Turns an Overpass response (signal nodes + drivable ways with geometry) into the junction mesh.
 * Returns { junctions, edges, paths, stats }:
 *   junctions[i] — one real signalised junction (OSM node ids, tags, roads, exact position)
 *   edges        — [i, k] pairs joined by an OSM road with no other signal in between
 *   paths        — Map 'i>k' -> [[lat, lon], ...] road geometry of that link (both directions)
 */
export function extractSignalNetwork(osm, { center, includeCrossings = false, maxJunctions = LIMITS.maxJunctions } = {}) {
  const elements = osm.elements || [];
  const signalNodes = elements.filter(e => e.type === 'node' && e.tags && e.tags.highway === 'traffic_signals');
  const ways = elements.filter(e => e.type === 'way');
  const g = buildGraph(ways);
  const lat0 = center ? center[0] : (signalNodes[0] ? signalNodes[0].lat : 0);

  const nodeGrid = new PointGrid(60, lat0);
  g.coord.forEach((c, id) => nodeGrid.add(c.lat, c.lon, id));

  // 1. Anchor every signal head on the drivable road graph
  let offRoad = 0;
  const heads = [];
  signalNodes.forEach(s => {
    let anchor = g.coord.has(s.id) ? s.id : null;
    if (anchor === null) {
      let best = LIMITS.snapM;
      nodeGrid.near(s.lat, s.lon).forEach(id => {
        const d = distM(s, g.coord.get(id));
        if (d < best) { best = d; anchor = id; }
      });
    }
    if (anchor === null) { offRoad += 1; return; }
    heads.push({ id: s.id, lat: s.lat, lon: s.lon, tags: s.tags, anchor, snapped: anchor !== s.id });
  });

  // 2. Signal heads of one crossing (each approach is often mapped separately) form one junction:
  //    heads within clusterM of each other, then groups whose roads meet within mergeRoadM
  const parent = heads.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const headGrid = new PointGrid(LIMITS.clusterM, lat0);
  heads.forEach((h, i) => headGrid.add(h.lat, h.lon, i));
  heads.forEach((h, i) => headGrid.near(h.lat, h.lon).forEach(k => {
    if (k > i && distM(h, heads[k]) <= LIMITS.clusterM) parent[find(i)] = find(k);
  }));
  const groupHeads = () => {
    const m = new Map();
    heads.forEach((h, i) => {
      const r = find(i);
      if (!m.has(r)) m.set(r, { root: i, heads: [] });
      m.get(r).heads.push(h);
    });
    return [...m.values()].map(gr => {
      gr.lat = gr.heads.reduce((s, h) => s + h.lat, 0) / gr.heads.length;
      gr.lon = gr.heads.reduce((s, h) => s + h.lon, 0) / gr.heads.length;
      gr.captured = new Set(gr.heads.map(h => h.anchor));
      gr.heads.forEach(h => nodeGrid.near(h.lat, h.lon).forEach(id => {
        if (distM(h, g.coord.get(id)) <= LIMITS.captureM) gr.captured.add(id);
      }));
      return gr;
    });
  };
  const ownerMap = list => {
    const owner = new Map();
    list.forEach(c => c.captured.forEach(id => {
      const cur = owner.get(id);
      if (!cur || distM(g.coord.get(id), c) < distM(g.coord.get(id), cur)) owner.set(id, c);
    }));
    return owner;
  };
  // Dijkstra along roads from cluster c; stops at (never passes) another cluster's nodes
  const trace = (c, owner, limit, onHit) => {
    const dist = new Map();
    const prev = new Map();
    const heap = new MinHeap();
    c.captured.forEach(id => { if (owner.get(id) === c) { dist.set(id, 0); heap.push(0, id); } });
    const done = new Set();
    while (heap.size) {
      const [d, u] = heap.pop();
      if (done.has(u) || d > limit) continue;
      done.add(u);
      const o = owner.get(u);
      if (o && o !== c) { onHit(o, d, u, prev); continue; }
      (g.adj.get(u) || []).forEach(e => {
        const nd = d + e.d;
        if (nd <= limit && nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prev.set(e.to, { from: u, road: e.road, d: e.d });
          heap.push(nd, e.to);
        }
      });
    }
  };
  let pre = groupHeads();
  const preOwner = ownerMap(pre);
  pre.forEach(c => trace(c, preOwner, LIMITS.mergeRoadM, o => { parent[find(c.root)] = find(o.root); }));
  pre = groupHeads();

  // 3. Describe each cluster from the OSM roads around it
  const clusters = pre.map(({ heads: hs, lat, lon, captured }) => {
    const maxDegree = Math.max(...[...captured].map(g.degree));
    const roadIdx = new Set();
    captured.forEach(id => (g.nodeWays.get(id) || []).forEach(ri => roadIdx.add(ri)));
    const byLabel = new Map();
    [...roadIdx].map(ri => g.roads[ri]).forEach(r => {
      const key = (roadLabel(r) || `way ${r.wayId}`).toLowerCase();
      const cur = byLabel.get(key);
      if (!cur || (ROAD_RANK[r.highway] ?? 9) < (ROAD_RANK[cur.highway] ?? 9)) byLabel.set(key, { ...r, lanes: Math.max(r.lanes || 0, cur?.lanes || 0) || null });
      else if (r.lanes && r.lanes > (cur.lanes || 0)) cur.lanes = r.lanes;
    });
    const roads = [...byLabel.values()].sort((a, b) => (ROAD_RANK[a.highway] ?? 9) - (ROAD_RANK[b.highway] ?? 9));
    // A road crossing has a node where 3+ road segments meet; otherwise it is a mid-block (pedestrian) signal
    const kind = maxDegree >= 3 ? 'junction' : 'crossing';
    const pedestrianTagged = hs.some(h => h.tags.crossing || ['crossing', 'pedestrian_crossing'].includes(h.tags.traffic_signals));
    const named = roads.map(roadLabel).filter(Boolean);
    const ownName = hs.map(h => h.tags.name || h.tags['junction:name']).find(Boolean);
    const name = ownName
      || (named.length >= 2 ? `${named[0]} × ${named[1]}` : named.length === 1 ? `${named[0]} signal` : `Unnamed signal (OSM node ${hs[0].id})`);
    return {
      id: `OSM-${Math.min(...hs.map(h => h.id))}`,
      name,
      corridor: named.slice(0, 3).join(' / ') || 'unnamed road',
      lat, lon,
      kind,
      pedestrianTagged,
      position: hs.length === 1 ? 'exact' : 'centroid',
      signals: hs.map(h => ({ id: h.id, lat: h.lat, lon: h.lon, tags: h.tags, snapped: h.snapped })),
      roads: roads.slice(0, 6),
      lanes: Math.max(0, ...roads.map(r => r.lanes || 0)) || null,
      degree: maxDegree,
      captured,
    };
  });

  const junctionCount = clusters.filter(c => c.kind === 'junction').length;
  const crossingCount = clusters.length - junctionCount;
  let kept = clusters.filter(c => includeCrossings || c.kind === 'junction');
  const ref = center ? { lat: center[0], lon: center[1] } : null;
  const truncated = kept.length > maxJunctions ? kept.length - maxJunctions : 0;
  if (truncated && ref) kept = [...kept].sort((a, b) => distM(ref, a) - distM(ref, b)).slice(0, maxJunctions);
  else if (truncated) kept = kept.slice(0, maxJunctions);
  // Stable order: north to south, then west to east
  kept.sort((a, b) => b.lat - a.lat || a.lon - b.lon);
  const keptSet = new Set(kept);
  const indexOf = new Map(kept.map((c, i) => [c, i]));

  // Every signal cluster (kept or not) blocks a trace, so a link never jumps over a real signal
  const owner = ownerMap(clusters);
  const centroidGrid = new PointGrid(LIMITS.passM, lat0);
  clusters.forEach(c => centroidGrid.add(c.lat, c.lon, c));

  // 4. Trace roads outward from each junction until they reach the next signal
  const best = new Map();
  kept.forEach((c, i) => trace(c, owner, LIMITS.maxLinkM, (o, d, u, prev) => {
    if (!keptSet.has(o)) return;
    const k = indexOf.get(o);
    const key = i < k ? `${i}-${k}` : `${k}-${i}`;
    if (best.has(key) && best.get(key).d <= d) return;
    const pts = [];
    const used = new Map();
    for (let v = u; v !== undefined; v = prev.get(v)?.from) {
      const p = g.coord.get(v);
      pts.push([p.lat, p.lon]);
      const step = prev.get(v);
      if (step) used.set(step.road, (used.get(step.road) || 0) + step.d);
    }
    // A trace that slips past another signal (other carriageway, flyover) is not a direct link
    const passes = pts.some(([la, lo]) => centroidGrid.near(la, lo)
      .some(x => x !== c && x !== o && distM({ lat: la, lon: lo }, x) <= LIMITS.passM));
    if (passes) return;
    pts.push([c.lat, c.lon]);
    pts.reverse();
    pts.push([o.lat, o.lon]);
    const main = [...used.entries()].sort((x, y) => y[1] - x[1])[0];
    const road = main ? g.roads[main[0]] : null;
    best.set(key, { i: Math.min(i, k), k: Math.max(i, k), d, path: i < k ? pts : [...pts].reverse(), road: road ? (roadLabel(road) || road.highway) : null });
  }));

  // 5. Keep a link only if no chain of shorter links already joins its ends about as directly
  const accepted = [];
  const acc = kept.map(() => []);
  const viaShorter = (from, to, limit) => {
    const dist = new Map([[from, 0]]);
    const heap = new MinHeap();
    heap.push(0, from);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (u === to) return true;
      if (d > dist.get(u)) continue;
      acc[u].forEach(([v, w]) => {
        const nd = d + w;
        if (nd <= limit && nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); heap.push(nd, v); }
      });
    }
    return false;
  };
  [...best.values()].sort((a, b) => a.d - b.d).forEach(l => {
    if (viaShorter(l.i, l.k, l.d * LIMITS.detourFactor)) return;
    accepted.push(l);
    acc[l.i].push([l.k, l.d]);
    acc[l.k].push([l.i, l.d]);
  });

  const links = accepted.sort((a, b) => a.i - b.i || a.k - b.k);
  const edges = links.map(l => [l.i, l.k]);
  const paths = new Map();
  const junctions = kept.map(({ captured, ...c }) => ({ ...c, neighbors: [] }));
  links.forEach(l => {
    paths.set(`${l.i}>${l.k}`, l.path);
    paths.set(`${l.k}>${l.i}`, [...l.path].reverse());
    const m = Math.round(l.d);
    junctions[l.i].neighbors.push({ idx: l.k, roadM: m, road: l.road });
    junctions[l.k].neighbors.push({ idx: l.i, roadM: m, road: l.road });
  });
  junctions.forEach(j => j.neighbors.sort((a, b) => a.roadM - b.roadM));

  // The ambulance / platoon-burst origin: the best-connected junction of the largest connected group
  const comp = junctions.map((_, i) => i);
  const root = i => (comp[i] === i ? i : (comp[i] = root(comp[i])));
  edges.forEach(([i, k]) => { comp[root(i)] = root(k); });
  const size = new Map();
  junctions.forEach((_, i) => size.set(root(i), (size.get(root(i)) || 0) + 1));
  const rank = i => [size.get(root(i)), junctions[i].neighbors.length, junctions[i].roads.length, ref ? -distM(ref, junctions[i]) : 0];
  const better = (a, b) => { for (let n = 0; n < a.length; n++) if (a[n] !== b[n]) return a[n] > b[n]; return false; };
  let hero = -1;
  junctions.forEach((_, i) => { if (hero < 0 || better(rank(i), rank(hero))) hero = i; });
  if (hero >= 0) junctions[hero].hero = true;

  return {
    junctions,
    edges,
    paths,
    stats: {
      signalNodes: signalNodes.length,
      offRoad,
      clusters: clusters.length,
      junctionClusters: junctionCount,
      crossingClusters: crossingCount,
      shown: junctions.length,
      truncated,
      links: edges.length,
      isolated: junctions.filter(j => !j.neighbors.length).length,
      roadWays: ways.length,
      osmTimestamp: osm.osm3s ? osm.osm3s.timestamp_osm_base : null,
    },
  };
}

/**
 * Junctions from signal nodes alone (no roads loaded yet): signal heads within clusterM are merged,
 * positions are exact, nothing else is guessed. Same shape as extractSignalNetwork, without links.
 */
export function extractSignalsOnly(osm, { center, maxJunctions = LIMITS.maxJunctions } = {}) {
  const sig = (osm.elements || []).filter(e => e.type === 'node' && e.tags && e.tags.highway === 'traffic_signals');
  const lat0 = center ? center[0] : (sig[0] ? sig[0].lat : 0);
  const parent = sig.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const grid = new PointGrid(LIMITS.clusterM, lat0);
  sig.forEach((h, i) => grid.add(h.lat, h.lon, i));
  sig.forEach((h, i) => grid.near(h.lat, h.lon).forEach(k => {
    if (k > i && distM(h, sig[k]) <= LIMITS.clusterM) parent[find(i)] = find(k);
  }));
  const groups = new Map();
  sig.forEach((h, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(h);
  });
  let junctions = [...groups.values()].map(hs => {
    const ownName = hs.map(h => h.tags.name || h.tags['junction:name']).find(Boolean);
    return {
      id: `OSM-${Math.min(...hs.map(h => h.id))}`,
      name: ownName || `Traffic signal (OSM node ${hs[0].id})`,
      corridor: 'roads loading…',
      lat: hs.reduce((a, h) => a + h.lat, 0) / hs.length,
      lon: hs.reduce((a, h) => a + h.lon, 0) / hs.length,
      kind: 'signal',
      position: hs.length === 1 ? 'exact' : 'centroid',
      signals: hs.map(h => ({ id: h.id, lat: h.lat, lon: h.lon, tags: h.tags, snapped: false })),
      roads: [], lanes: null, degree: null, neighbors: [],
    };
  });
  const ref = center ? { lat: center[0], lon: center[1] } : null;
  const truncated = Math.max(0, junctions.length - maxJunctions);
  if (truncated && ref) junctions = junctions.sort((a, b) => distM(ref, a) - distM(ref, b)).slice(0, maxJunctions);
  junctions.sort((a, b) => b.lat - a.lat || a.lon - b.lon);
  if (junctions.length) {
    const hero = ref ? junctions.reduce((best, j, i) => (distM(ref, j) < distM(ref, junctions[best]) ? i : best), 0) : 0;
    junctions[hero].hero = true;
  }
  return {
    junctions, edges: [], paths: new Map(), partial: true,
    stats: {
      signalNodes: sig.length, offRoad: 0, clusters: groups.size, junctionClusters: groups.size, crossingClusters: 0,
      shown: junctions.length, truncated, links: 0, isolated: junctions.length, roadWays: 0,
      osmTimestamp: osm.osm3s ? osm.osm3s.timestamp_osm_base : null,
    },
  };
}

// ---------------------------------------------------------------- export
export function toGeoJSON(net, meta = {}) {
  const features = net.junctions.map((j, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [j.lon, j.lat] },
    properties: {
      index: i, id: j.id, name: j.name, kind: j.kind, position: j.position, corridor: j.corridor, lanes: j.lanes,
      osm_signal_nodes: j.signals.map(s => s.id), roads: j.roads.map(r => ({ name: r.name, ref: r.ref, highway: r.highway, lanes: r.lanes, maxspeed: r.maxspeed, oneway: r.oneway })),
      neighbors: j.neighbors.map(n => ({ id: net.junctions[n.idx].id, road_m: n.roadM, road: n.road })),
    },
  }));
  net.edges.forEach(([i, k]) => {
    const n = net.junctions[i].neighbors.find(x => x.idx === k);
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: net.paths.get(`${i}>${k}`).map(([la, lo]) => [lo, la]) },
      properties: { from: net.junctions[i].id, to: net.junctions[k].id, road_m: n ? n.roadM : null, road: n ? n.road : null },
    });
  });
  return {
    type: 'FeatureCollection',
    metadata: { ...meta, ...net.stats, license: 'Data © OpenStreetMap contributors, ODbL 1.0', generator: 'traffic-swarm-intelligence osmSignals.js' },
    features,
  };
}

// ---------------------------------------------------------------- finding mapped signals nearby
// Signal positions only (no roads) within radiusM: cheap enough to search a whole city
export function nearbySignalsQuery(lat, lon, radiusM = 15000) {
  return `[out:json][timeout:60];node["highway"="traffic_signals"](around:${Math.round(radiusM)},${lat.toFixed(6)},${lon.toFixed(6)});out skel qt;`;
}

/** The densest cluster of mapped signals: { lat, lon, count, distM } or null. Window = cellM square. */
export function densestSignals(nodes, from, cellM = 1500) {
  if (!nodes.length) return null;
  const lat0 = from.lat;
  const dLat = cellM / M_PER_DEG_LAT;
  const dLon = cellM / mPerDegLon(lat0);
  const cells = new Map();
  // Half-cell offsets so a cluster on a cell border is still counted together
  nodes.forEach(n => [0, 0.5].forEach(o => {
    const key = `${o}:${Math.floor(n.lat / dLat + o)}:${Math.floor(n.lon / dLon + o)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(n);
  }));
  let best = null;
  cells.forEach(list => {
    if (!best || list.length > best.length) best = list;
  });
  const lat = best.reduce((s, n) => s + n.lat, 0) / best.length;
  const lon = best.reduce((s, n) => s + n.lon, 0) / best.length;
  return { lat, lon, count: best.length, distM: Math.round(distM(from, { lat, lon })) };
}
