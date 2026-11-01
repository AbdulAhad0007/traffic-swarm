// Rendering benchmark for the 3D View. Run `npm run build` first, then: node scripts/bench-view3d.mjs
// Everything is local: fake Supabase, a Next server, and a test-only Lab API that generates vehicles on a grid so counts
// beyond what SUMO reaches can be measured. That generator exists only in this script and is never reachable from the site.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeSupabase } from '../tests/helpers/fakeServices.mjs';

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const COUNTS = (process.env.BENCH_COUNTS || '100,500,1000,2000,5000').split(',').map(Number);
const QUALITIES = (process.env.BENCH_QUALITIES || 'high,medium,low').split(',');
const SECONDS = Number(process.env.BENCH_SECONDS || 8);
const THROTTLE = Number(process.env.BENCH_CPU_THROTTLE || 1);
const [SITE, LAB, DB, DEBUG] = [3120, 3121, 3122, 9335];
const KEY = 'bench-only-key';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const LINES = 21, SPACING = 150;
const SPAN = (LINES - 1) * SPACING;
const edges = [], signals = [];
for (let i = 0; i < LINES; i++) {
  edges.push({ id: `h${i}`, name: null, lanes: 2, length: SPAN, shape: [[0, i * SPACING], [SPAN, i * SPACING]] });
  edges.push({ id: `v${i}`, name: null, lanes: 2, length: SPAN, shape: [[i * SPACING, 0], [i * SPACING, SPAN]] });
}
for (let x = 0; x < LINES; x += 2) for (let y = 0; y < LINES; y += 2) {
  signals.push({ id: `J${x}_${y}`, x: x * SPACING, y: y * SPACING, streets: [], lamps: [
    { at: [x * SPACING - 8, y * SPACING], links: [0] }, { at: [x * SPACING, y * SPACING - 8], links: [1] },
  ] });
}
const network = { version: 1, geo: null, anchor: { lon: 0, lat: 0 }, transform: { cx: SPAN / 2, cy: SPAN / 2, ee: 1, en: 0, ne: 0, nn: 1 },
  bounds: { min_x: 0, max_x: SPAN, min_y: 0, max_y: SPAN }, edges, signals };
const tl = Object.fromEntries(signals.map(s => [s.id, [0, 'Gr']]));

function frame(t, count) {
  const out = { t, ids: [], x: [], y: [], a: [], s: [], w: [], ty: [], e: [], types: ['car'], tl };
  for (let i = 0; i < count; i++) {
    const line = i % (LINES * 2), horizontal = line % 2 === 0, row = (line >> 1) * SPACING;
    const along = (i * 37 + t * 12) % SPAN;
    out.ids.push(`v${i}`);
    out.x.push(horizontal ? along : row);
    out.y.push(horizontal ? row : along);
    out.a.push(horizontal ? 90 : 0);
    out.s.push(12); out.w.push(0); out.ty.push(0); out.e.push(line);
  }
  return out;
}

let vehicleCount = COUNTS[0];
const lab = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const job = { id: 'bench00000000', status: 'running', spec: { network: 'bench', scenario: 'bench', controllers: ['swarm'] } };
  if (url.pathname.endsWith('/network3d')) return json(network);
  if (url.pathname.endsWith('/frames')) {
    const after = Number(url.searchParams.get('after') ?? 0);
    const newest = Math.floor(performance.now() / 1000);
    const frames = [];
    for (let t = Math.max(after + 1, newest - 30); t <= newest && frames.length < 30; t++) frames.push(frame(t, vehicleCount));
    return json({ status: 'running', interval_s: 1, first_t: 0, last_t: newest, frames });
  }
  if (url.pathname.endsWith('/calls')) return json({ summary: null, calls: [] });
  if (url.pathname.endsWith('/jobs')) return json([job]);
  if (url.pathname.endsWith('/options')) return json({ presets: [], scenarios: [] });
  return json(job);
});
await new Promise(r => lab.listen(LAB, r));
await startFakeSupabase(DB, KEY);
const next = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(SITE)], {
  cwd: FRONTEND, stdio: 'ignore',
  env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${DB}`, SUPABASE_SERVICE_ROLE_KEY: KEY, LAB_URL: `http://127.0.0.1:${LAB}`, TSI_GATEWAY_SECRET: '' },
});
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://localhost:${SITE}/api/site-config`)).ok) break; } catch { /* starting */ } await sleep(250); }

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'b3d-'))}`,
  '--window-size=1440,900', '--ignore-gpu-blocklist', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find(t => t.type === 'page'); } catch { /* starting */ } }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0;
const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const run = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result?.value;
await send('Page.enable'); await send('Runtime.enable');
if (THROTTLE > 1) await send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

const renderer = async () => run(`(() => { const g = document.createElement('canvas').getContext('webgl2'); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()`);
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const rows = [];
let gpu = null;
for (const count of COUNTS) {
  vehicleCount = count;
  await send('Page.navigate', { url: `http://localhost:${SITE}/3d-view` });
  for (let i = 0; i < 120; i++) { await sleep(250); if (await run(`document.querySelector('.view3d')?.dataset.status === 'ready' && /\\d/.test(document.querySelector('.view3d-time b')?.innerText || '')`)) break; }
  gpu ??= await renderer();
  await run(`document.querySelector('[aria-label="Performance"]').click(); 1`);
  await sleep(300);
  for (const quality of QUALITIES) {
    await run(`(() => { const s = [...document.querySelectorAll('.view3d-card select')].pop(); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '${quality}'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(1500);
    const m = await run(`new Promise(done => { const times = []; let last = performance.now(); const end = last + ${SECONDS * 1000};
      const tick = now => { times.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else done({ times, drawn: [...document.querySelectorAll('[data-perf] div')].find(d => d.innerText.includes('drawn'))?.querySelector('dd').innerText, heap: Math.round(performance.memory.usedJSHeapSize / 1048576) }); };
      requestAnimationFrame(tick); })`);
    const sorted = [...m.times].sort((a, b) => a - b);
    const seconds = m.times.reduce((a, b) => a + b, 0) / 1000;
    rows.push({ vehicles: count, quality, drawn: m.drawn, avgFps: Math.round(m.times.length / seconds), low1pctFps: Math.round(1000 / percentile(sorted, 0.99)), p99ms: Math.round(percentile(sorted, 0.99)), heapMB: m.heap });
    console.log(JSON.stringify(rows[rows.length - 1]));
  }
}
console.log('renderer:', gpu, 'cpu throttle:', THROTTLE);
console.table(rows);
ws.close(); chrome.kill(); next.kill(); process.exit(0);
