// End-to-end against a real `next start` of the current build, with fake Supabase and upstreams.
// Run `npm run build` first. Never uses production services: all env below points at localhost.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../lib/password.js';
import { MODULES } from '../lib/moduleRegistry.js';
import { seedTables, startFakeSupabase, startRecordingUpstream } from './helpers/fakeServices.mjs';

const PORT = 3977, BASE = `http://localhost:${PORT}`;
const USER = 'admin', PASS = 'a-long-test-password';
const SERVICE_KEY = 'test-service-role-key-do-not-use', GATEWAY = 'test-gateway-secret-do-not-use';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SAME_ORIGIN = { Origin: BASE };
const JSON_HEADERS = { 'Content-Type': 'application/json', ...SAME_ORIGIN };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let supabase, lab, backend, next;
let ipCounter = 0;

before(async () => {
  supabase = await startFakeSupabase(3978, SERVICE_KEY);
  lab = await startRecordingUpstream(3979);
  backend = await startRecordingUpstream(3980);
  next = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      SUPABASE_URL: 'http://127.0.0.1:3978', SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      LAB_URL: 'http://127.0.0.1:3979', BACKEND_URL: 'http://127.0.0.1:3980',
      ADMIN_USERNAME: USER, ADMIN_PASSWORD_HASH: hashPassword(PASS), TSI_GATEWAY_SECRET: GATEWAY,
    },
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/api/site-config`)).ok) return; } catch { /* still starting */ }
    await sleep(500);
  }
  throw new Error('next start did not come up');
});

after(() => { next?.kill(); supabase?.close(); lab?.close(); backend?.close(); });

// The server caches config for 5 s per instance, and an admin write clears it; a direct seed reset does not.
beforeEach(async () => {
  const fresh = seedTables();
  supabase.state.tables.site_modules = fresh.site_modules;
  supabase.state.tables.site_module_sections = fresh.site_module_sections;
  supabase.state.tables.admin_login_attempts = [];
  supabase.state.down = false;
  const cookie = await login();
  await toggleModule(cookie, 'overview', true);
});

const uniqueIp = () => `10.0.0.${++ipCounter}`;

function loginRequest(username, password, ip = uniqueIp()) {
  return fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'X-Forwarded-For': ip },
    body: JSON.stringify({ username, password }),
  });
}

async function login() {
  const res = await loginRequest(USER, PASS);
  assert.equal(res.status, 200);
  return res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
}

const patch = (cookie, url, is_enabled) => fetch(`${BASE}${url}`, {
  method: 'PATCH', headers: { ...JSON_HEADERS, Cookie: cookie }, body: JSON.stringify({ is_enabled }),
});
const toggleModule = (cookie, slug, v) => patch(cookie, `/api/admin/modules/${slug}`, v);
const toggleSection = (cookie, slug, s, v) => patch(cookie, `/api/admin/modules/${slug}/sections/${s}`, v);
const siteConfig = async () => (await fetch(`${BASE}/api/site-config`)).json();
const savedState = () => JSON.stringify([
  supabase.state.tables.site_modules.map(r => [r.slug, r.is_enabled]),
  supabase.state.tables.site_module_sections.map(r => [r.module_id, r.slug, r.is_enabled]),
]);

test('1. /admin shows the login page when unauthenticated', async () => {
  const html = await (await fetch(`${BASE}/admin`)).text();
  assert.match(html, /Sign in/);
  assert.doesNotMatch(html, /Module Control/);
});

test('2. invalid credentials are rejected, then locked out after five failures', async () => {
  assert.equal((await loginRequest(USER, 'wrong')).status, 401);
  assert.equal((await loginRequest('nobody', PASS)).status, 401);
  const res = await loginRequest(USER, 'wrong');
  assert.equal(res.headers.getSetCookie().length, 0);
  const ip = uniqueIp();
  for (let i = 0; i < 5; i++) assert.equal((await loginRequest(USER, 'wrong', ip)).status, 401);
  assert.equal((await loginRequest(USER, PASS, ip)).status, 429, 'correct password is refused while locked');
  assert.equal((await loginRequest(USER, PASS)).status, 200, 'another client is unaffected');
});

test('3. login sets a hardened cookie and opens the dashboard', async () => {
  const res = await loginRequest(USER, PASS);
  const raw = res.headers.getSetCookie()[0];
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Strict/i);
  const token = raw.split(';')[0].split('=')[1];
  assert.ok(!JSON.stringify(supabase.state.tables.admin_sessions).includes(token), 'the raw token is not stored');
  const html = await (await fetch(`${BASE}/admin`, { headers: { Cookie: raw.split(';')[0] } })).text();
  assert.match(html, /Module Control|AdminDashboard/);
});

test('4-5. all eight modules appear once, with their sections under the right module', async () => {
  const body = await (await fetch(`${BASE}/api/admin/modules`, { headers: { Cookie: await login() } })).json();
  assert.deepEqual(body.modules.map(m => m.identifier), ['CORE', 'OSM', 'LIVE', 'DUAL', 'EVAL', 'AI', 'MIX', 'VIVA']);
  for (const m of MODULES) {
    const row = body.modules.find(r => r.slug === m.slug);
    assert.deepEqual(row.sections.map(s => s.slug), m.sections.map(([s]) => s));
  }
});

test('admin APIs refuse anonymous, cross-origin and malformed requests', async () => {
  const cookie = await login();
  const before_ = savedState();
  assert.equal((await fetch(`${BASE}/api/admin/modules`)).status, 401);
  assert.equal((await patch('', '/api/admin/modules/prediction', false)).status, 401);
  assert.equal((await fetch(`${BASE}/api/admin/modules/prediction`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: cookie }, body: '{"is_enabled":false}',
  })).status, 403);
  assert.equal((await fetch(`${BASE}/api/admin/modules/prediction`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{"is_enabled":false}',
  })).status, 403, 'a missing Origin is refused on writes');
  assert.equal((await patch(cookie, '/api/admin/modules/prediction', 'false')).status, 400);
  assert.equal((await patch(cookie, '/api/admin/modules/registration', false)).status, 404);
  assert.equal((await patch(cookie, '/api/admin/modules/prediction/sections/map-legend', false)).status, 404, 'section from another module');
  assert.equal(savedState(), before_);
});

test('6-7. toggles change exactly one row', async () => {
  const cookie = await login();
  const count = () => [...supabase.state.tables.site_modules, ...supabase.state.tables.site_module_sections].filter(r => !r.is_enabled).length;
  assert.equal((await toggleSection(cookie, 'signal-map', 'map-legend', false)).status, 200);
  assert.equal(count(), 1);
  assert.equal((await toggleModule(cookie, 'mixed-traffic', false)).status, 200);
  assert.equal(count(), 2);
  assert.equal((await toggleSection(cookie, 'signal-map', 'map-legend', true)).status, 200);
  assert.equal(count(), 1);
  const m = supabase.state.tables.site_modules.find(r => r.slug === 'mixed-traffic');
  assert.notEqual(m.updated_at, new Date(0).toISOString(), 'updated_at is maintained');
});

test('8-9. parent off hides all sections publicly and preserves saved section states', async () => {
  const cookie = await login();
  await toggleSection(cookie, 'controllers', 'saved-run-charts', false);
  const saved = savedState();
  await toggleModule(cookie, 'controllers', false);
  const off = await siteConfig();
  assert.equal(off.modules.controllers.enabled, false);
  assert.ok(Object.values(off.modules.controllers.sections).every(v => v === false));
  await toggleModule(cookie, 'controllers', true);
  assert.equal(savedState(), saved);
  const on = await siteConfig();
  assert.equal(on.modules.controllers.sections['saved-run-charts'], false);
  assert.equal(on.modules.controllers.sections['saved-run-kpi-table'], true);
});

test('10-11. direct routes are blocked for disabled modules and return when enabled', async () => {
  const cookie = await login();
  for (const m of MODULES.filter(x => x.route && x.route !== '/')) {
    assert.doesNotMatch(await (await fetch(BASE + m.route)).text(), /currently unavailable/, `${m.slug} on`);
    await toggleModule(cookie, m.slug, false);
    assert.match(await (await fetch(BASE + m.route)).text(), /currently unavailable/, `${m.slug} off`);
    await toggleModule(cookie, m.slug, true);
    assert.doesNotMatch(await (await fetch(BASE + m.route)).text(), /currently unavailable/, `${m.slug} back`);
  }
});

test('/ redirects to the first enabled module, and shows unavailable when all are off', async () => {
  const cookie = await login();
  await toggleModule(cookie, 'overview', false);
  const res = await fetch(`${BASE}/`, { redirect: 'manual' });
  assert.equal(res.status, 307);
  assert.equal(new URL(res.headers.get('location'), BASE).pathname, '/ghaziabad');
  for (const m of MODULES) await toggleModule(cookie, m.slug, false);
  assert.match(await (await fetch(`${BASE}/`)).text(), /currently unavailable/);
});

test('Signal Map snapshots follow the module', async () => {
  const cookie = await login();
  assert.equal((await fetch(`${BASE}/osm/delhi.json`)).status, 200);
  await toggleModule(cookie, 'signal-map', false);
  assert.equal((await fetch(`${BASE}/osm/delhi.json`)).status, 403);
});

test('12. APIs enforce the rules before anything reaches the upstream', async () => {
  const cookie = await login();
  lab.hits.length = 0;
  await toggleSection(cookie, 'live-lab', 'stop-all', false);
  const stop = await fetch(`${BASE}/api/lab/api/lab/stop-all`, { method: 'POST' });
  assert.equal(stop.status, 403);
  assert.equal((await stop.json()).error, 'module_disabled');
  await toggleModule(cookie, 'live-lab', false);
  const job = await fetch(`${BASE}/api/lab/api/lab/jobs`, { method: 'POST', body: '{"kind":"experiment"}' });
  assert.equal(job.status, 403);
  assert.equal(lab.hits.length, 0, 'blocked calls never left the proxy');

  const demo = await fetch(`${BASE}/api/lab/api/lab/jobs`, { method: 'POST', body: '{"kind":"demo"}' });
  assert.equal(demo.status, 200, 'Before / After still works');
  assert.equal(lab.hits.at(-1).url, '/api/lab/jobs');
  assert.equal(lab.hits.at(-1).gateway, GATEWAY, 'the proxy identifies itself to the lab');

  assert.equal((await fetch(`${BASE}/api/proxy/actuator/env`)).status, 403);
  assert.equal((await fetch(`${BASE}/api/proxy/api/health`)).status, 200);
  assert.equal(backend.hits.at(-1).gateway, GATEWAY);
});

test('13. settings survive reads and new sessions', async () => {
  const cookie = await login();
  await toggleSection(cookie, 'prediction', 'kpi-cards', false);
  const fresh = await login();
  const body = await (await fetch(`${BASE}/api/admin/modules`, { headers: { Cookie: fresh } })).json();
  assert.equal(body.modules.find(m => m.slug === 'prediction').sections.find(s => s.slug === 'kpi-cards').is_enabled, false);
  assert.equal((await siteConfig()).modules.prediction.sections['kpi-cards'], false);
});

test('14. logout revokes the session on the server', async () => {
  const cookie = await login();
  assert.equal((await fetch(`${BASE}/api/admin/modules`, { headers: { Cookie: cookie } })).status, 200);
  const res = await fetch(`${BASE}/api/admin/logout`, { method: 'POST', headers: { ...SAME_ORIGIN, Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal((await fetch(`${BASE}/api/admin/modules`, { headers: { Cookie: cookie } })).status, 401, 'old cookie replayed');
  assert.match(await (await fetch(`${BASE}/admin`, { headers: { Cookie: cookie } })).text(), /Sign in/);
});

test('an expired session is refused', async () => {
  const cookie = await login();
  supabase.state.tables.admin_sessions.forEach(s => { s.expires_at = new Date(Date.now() - 1000).toISOString(); });
  assert.equal((await fetch(`${BASE}/api/admin/modules`, { headers: { Cookie: cookie } })).status, 401);
});

test('a database outage locks admin but keeps the public site on its last known config', async () => {
  const cookie = await login();
  await toggleModule(cookie, 'prediction', false);
  await siteConfig();
  supabase.state.down = true;
  await sleep(5200);
  assert.equal((await fetch(`${BASE}/api/admin/modules`, { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await loginRequest(USER, PASS)).status, 503);
  assert.equal((await siteConfig()).modules.prediction.enabled, false);
  assert.equal((await siteConfig()).modules.overview.enabled, true);
  supabase.state.down = false;
});

test('public config exposes flags only', async () => {
  const text = JSON.stringify(await siteConfig());
  for (const secret of ['updated_at', 'token', 'hash', SERVICE_KEY]) assert.ok(!text.includes(secret), secret);
});

test('no secret or secret variable reaches the browser bundle', () => {
  const dir = join(ROOT, '.next', 'static');
  const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'latin1');
    for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_PASSWORD_HASH', 'TSI_GATEWAY_SECRET', 'ADMIN_USERNAME', 'scryptSync']) {
      assert.ok(!text.includes(name), `${name} found in ${file}`);
    }
  }
});
