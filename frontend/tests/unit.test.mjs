import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ALL_ENABLED, MODULES, buildEffectiveConfig, firstEnabledRoute } from '../lib/moduleRegistry.js';
import { checkBackendRequest, checkLabRequest } from '../lib/labGuard.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { DEFAULT_THEME, THEMES, normalizeTheme } from '../lib/themes.js';
import { themeBootScript } from '../lib/themeBoot.js';
import { applyTheme, themeFromCookie } from '../lib/themeClient.js';
import { seedTables } from './helpers/fakeServices.mjs';

const migration = name => readFileSync(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8');
const sql = migration('001_admin_panel.sql') + migration('003_view_3d_module.sql');
const lab = path => path.split('/');

// All on except the given entries ('module' or 'module/section').
function configWithout(...off) {
  const t = seedTables();
  for (const entry of off) {
    const [mod, sec] = entry.split('/');
    const m = t.site_modules.find(r => r.slug === mod);
    if (sec) t.site_module_sections.find(r => r.module_id === m.id && r.slug === sec).is_enabled = false;
    else m.is_enabled = false;
  }
  return buildEffectiveConfig(t.site_modules, t.site_module_sections);
}
const onlyOn = (...keep) => {
  const off = MODULES.flatMap(m => m.sections.map(([s]) => `${m.slug}/${s}`)).filter(e => !keep.includes(e));
  return configWithout(...off);
};

test('normalizeTheme keeps known slugs and falls back to midnight', () => {
  assert.deepEqual(THEMES.map(t => t.slug), ['midnight', 'night-road', 'survey-map']);
  assert.equal(DEFAULT_THEME, 'midnight');
  assert.equal(normalizeTheme('night-road'), 'night-road');
  for (const bad of ['x', null, undefined, '__proto__', 'constructor', 7]) assert.equal(normalizeTheme(bad), 'midnight');
  assert.equal(ALL_ENABLED.theme, 'midnight');
});

function fakeDom(cookie = '') {
  const attrs = {}, appended = [], events = [];
  const document = {
    cookie,
    documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: k => attrs[k] ?? null },
    head: { appendChild: el => appended.push(el) },
    createElement: () => ({}),
    querySelector: sel => appended.find(el => sel.includes(el.href)) || null,
  };
  const window = { dispatchEvent: e => events.push(e.type) };
  return { attrs, appended, events, document, window };
}
const runBoot = (cookie, pathname = '/') => {
  const dom = fakeDom(cookie);
  new Function('document', 'location', themeBootScript)(dom.document, { pathname });
  return dom;
};

test('boot script applies a valid cookie theme and its fonts', () => {
  const { attrs, appended } = runBoot('a=1; tsi-theme=night-road');
  assert.equal(attrs['data-theme'], 'night-road');
  assert.match(appended[0].href, /Saira/);
});

test('boot script ignores a tampered cookie and leaves midnight', () => {
  for (const bad of ['tsi-theme=<script>alert(1)</script>', 'tsi-theme=__proto__', 'tsi-theme=']) {
    const { attrs, appended } = runBoot(bad);
    assert.equal(attrs['data-theme'], undefined);
    assert.equal(appended.length, 0);
  }
});

test('boot script skips /admin paths', () => {
  assert.equal(runBoot('tsi-theme=survey-map', '/admin').attrs['data-theme'], undefined);
});

test('applyTheme announces a change once and not on a repeat call', () => {
  const dom = fakeDom();
  globalThis.document = dom.document;
  globalThis.window = dom.window;
  try {
    applyTheme('survey-map');
    applyTheme('survey-map');
    assert.equal(dom.attrs['data-theme'], 'survey-map');
    assert.deepEqual(dom.events, ['tsi-theme-change']);
    assert.equal(dom.appended.length, 1);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});

test('admin dashboard renders ThemePicker after the module list', () => {
  const src = readFileSync(new URL('../components/admin/AdminDashboard.js', import.meta.url), 'utf8');
  const picker = src.indexOf('<ThemePicker');
  assert.ok(picker > src.indexOf('className="admin-modules"'));
});

test('the junction mesh draws its wave in the wave token and says it is an illustration', () => {
  const src = readFileSync(new URL('../components/JunctionMesh.js', import.meta.url), 'utf8');
  assert.match(src, /mesh-wave/);
  assert.match(src, /[Ii]llustration/);
  const css = readFileSync(new URL('../app/styles/system.css', import.meta.url), 'utf8');
  assert.match(css, /\.mesh-wave[^}]*var\(--wave\)/);
  assert.match(css, /prefers-reduced-motion[\s\S]*mesh-/);
});

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('boot script only skips the admin area itself', () => {
  assert.equal(runBoot('tsi-theme=survey-map', '/admin/x').attrs['data-theme'], undefined);
  assert.equal(runBoot('tsi-theme=survey-map', '/administrator').attrs['data-theme'], 'survey-map');
});

test('themeFromCookie reads a valid theme and rejects anything else', () => {
  assert.equal(themeFromCookie('a=1; tsi-theme=night-road'), 'night-road');
  assert.equal(themeFromCookie('tsi-theme=<script>'), null);
  assert.equal(themeFromCookie(''), null);
});

test('public pages restore the cookie theme on mount and the admin pins the whole page', () => {
  assert.ok(source('../components/SiteConfigProvider.js').includes('applyTheme(themeFromCookie(document.cookie))'));
  assert.ok(source('../app/admin/layout.js').includes('<AdminThemePin />'));
});

test('the map canvas waits for resolved colors before drawing', () => {
  assert.ok(source('../components/OsmSignalMap.js').includes("if (!C['--accent']) return;"));
});

test('every heat level has its own color', () => {
  for (const file of ['../components/WorldHeatmap.js', '../components/CityGrid3D.js']) {
    const text = source(file);
    const start = text.indexOf('HEAT = [') + 'HEAT = ['.length;
    const heat = text.slice(start, text.indexOf(']', start)).split(',').map(v => v.trim());
    assert.equal(heat.length, 4, file);
    assert.equal(new Set(heat).size, heat.length, file);
  }
});

test('the 3D scene keeps a real-world palette on the light theme', () => {
  assert.ok(source('../app/styles/tokens.css').includes("[data-theme='survey-map'] .dt-scene"));
  assert.ok(source('../components/DigitalTwin3D.js').includes('dt-scene'));
});

test('the admin area is pinned to the midnight theme', () => {
  const src = readFileSync(new URL('../app/admin/layout.js', import.meta.url), 'utf8');
  assert.match(src, /data-theme="midnight"/);
});

test('the exact nine modules exist once, in sidebar order', () => {
  assert.deepEqual(MODULES.map(m => [m.name, m.identifier]), [
    ['Overview', 'CORE'], ['Signal Map', 'OSM'], ['Live Lab', 'LIVE'], ['Before / After', 'DUAL'],
    ['Controllers', 'EVAL'], ['Prediction', 'AI'], ['Mixed Traffic', 'MIX'], ['How It Works', 'VIVA'], ['3D View', '3DV'],
  ]);
  assert.equal(MODULES.flatMap(m => m.sections).length, 74);
});

test('the migration seeds every registered module and section under the right module', () => {
  for (const m of MODULES) {
    assert.ok(sql.includes(`('${m.name}', '${m.slug}', '${m.identifier}',`), m.slug);
    for (const [slug, name] of m.sections) assert.ok(sql.includes(`('${m.slug}', '${name.replace(/'/g, "''")}', '${slug}',`), `${m.slug}/${slug}`);
  }
  assert.ok(!/update\s+public\.site_/i.test(sql), 'the seed must never overwrite saved toggles');
  assert.ok(/on conflict \(module_id, slug\) do nothing/.test(sql));
});

test('a section is unavailable under a disabled parent, and returns with its saved state', () => {
  const off = configWithout('live-lab', 'live-lab/stop-all');
  assert.equal(off.modules['live-lab'].enabled, false);
  assert.ok(Object.values(off.modules['live-lab'].sections).every(v => v === false));
  const back = configWithout('live-lab/stop-all');
  assert.equal(back.modules['live-lab'].sections['stop-all'], false);
  assert.equal(back.modules['live-lab'].sections['jobs-table'], true);
});

test('one section off leaves every other section on', () => {
  const c = configWithout('prediction/kpi-cards');
  const flat = Object.entries(c.modules).flatMap(([m, v]) => Object.entries(v.sections).map(([s, on]) => [`${m}/${s}`, on]));
  assert.deepEqual(flat.filter(([, on]) => !on).map(([k]) => k), ['prediction/kpi-cards']);
});

test('landing route falls through to the first enabled module', () => {
  assert.equal(firstEnabledRoute(configWithout('overview')), '/ghaziabad');
  assert.equal(firstEnabledRoute(configWithout('overview', 'signal-map', 'live-lab', 'before-after', 'controllers', 'prediction', 'mixed-traffic', 'view-3d')), null);
});

test('every endpoint the UI calls is allowed when everything is on', () => {
  for (const [method, path] of [
    ['GET', 'health'], ['GET', 'options'], ['GET', 'osm-areas'], ['POST', 'osm-areas'], ['GET', 'jobs'], ['GET', 'jobs/abc123'], ['GET', 'jobs/abc123/live'],
    ['POST', 'jobs/abc123/stop'], ['POST', 'stop-all'], ['GET', 'jobs/abc123/replay'], ['GET', 'jobs/abc123/result'], ['GET', 'jobs/abc123/calls'],
    ['GET', 'jobs/abc123/messages'], ['GET', 'runs'], ['GET', 'runs/comparison'], ['GET', 'runs/replay'], ['GET', 'runs/calls'], ['GET', 'reports'],
    ['GET', 'reports/eval-v1'], ['GET', 'jobs/abc123/network3d'], ['GET', 'jobs/abc123/frames'], ['GET', 'swarm/mesh/state'], ['POST', 'swarm/mesh/step'],
  ]) {
    assert.equal(checkLabRequest(ALL_ENABLED, method, lab(path)).allowed, true, `${method} ${path}`);
    assert.equal(checkLabRequest(ALL_ENABLED, method, lab(`api/lab/${path}`)).allowed, true, `${method} api/lab/${path}`);
  }
});

test('shared endpoints stay open while any owner remains, and close with the last', () => {
  assert.equal(checkLabRequest(configWithout('live-lab'), 'GET', lab('options')).allowed, true);
  assert.equal(checkLabRequest(configWithout('before-after'), 'GET', lab('options')).allowed, true);
  assert.equal(checkLabRequest(configWithout('live-lab', 'before-after', 'view-3d'), 'GET', lab('options')).allowed, false);
  assert.equal(checkLabRequest(configWithout('controllers'), 'GET', lab('runs')).allowed, true);
  assert.equal(checkLabRequest(configWithout('controllers', 'overview'), 'GET', lab('runs')).allowed, false);
});

test('single-owner endpoints follow their section', () => {
  assert.equal(checkLabRequest(configWithout('live-lab/stop-all'), 'POST', lab('stop-all')).error, 'module_disabled');
  assert.equal(checkLabRequest(configWithout('before-after/replay'), 'GET', lab('jobs/a/replay')).allowed, false);
  assert.equal(checkLabRequest(configWithout('live-lab/swarm-calls', 'view-3d/intersection-inspector'), 'GET', lab('jobs/a/calls')).allowed, false);
  assert.equal(checkLabRequest(configWithout('controllers/evaluation-ci-chart', 'controllers/evaluation-paired-tests'), 'GET', lab('reports')).allowed, false);
  assert.equal(checkLabRequest(onlyOn('controllers/evaluation-ci-chart'), 'GET', lab('reports/x')).allowed, true);
});

test('3D View data follows its module, and it can start experiments only through its run selector', () => {
  const off = configWithout('view-3d');
  for (const path of ['jobs/abc123/network3d', 'jobs/abc123/frames']) {
    assert.equal(checkLabRequest(off, 'GET', lab(path)).allowed, false, path);
    assert.equal(checkLabRequest(configWithout('live-lab'), 'GET', lab(path)).allowed, true, path);
  }
  const exp = JSON.stringify({ kind: 'experiment' });
  assert.equal(checkLabRequest(configWithout('live-lab'), 'POST', lab('jobs'), exp).allowed, true);
  assert.equal(checkLabRequest(configWithout('live-lab', 'view-3d/run-selector'), 'POST', lab('jobs'), exp).allowed, false);
});

test('the 3D View migration starts the module off', () => {
  assert.match(migration('003_view_3d_module.sql'), /\('3D View', 'view-3d', '3DV', false, 9\)/);
});

test('job creation is decided by its kind', () => {
  const demo = JSON.stringify({ kind: 'demo' }), exp = JSON.stringify({ kind: 'experiment' });
  const noLive = configWithout('live-lab', 'view-3d');
  assert.equal(checkLabRequest(noLive, 'POST', lab('jobs'), exp).allowed, false);
  assert.equal(checkLabRequest(noLive, 'POST', lab('jobs'), demo).allowed, true);
  assert.equal(checkLabRequest(noLive, 'POST', lab('jobs'), '{}').allowed, false, 'the lab treats a missing kind as an experiment');
  assert.equal(checkLabRequest(noLive, 'POST', lab('jobs'), 'not json').allowed, false);
  assert.equal(checkLabRequest(configWithout('before-after'), 'POST', lab('jobs'), demo).allowed, true, 'Overview quick run also uses demo');
  assert.equal(checkLabRequest(configWithout('before-after', 'overview'), 'POST', lab('jobs'), demo).allowed, false);
});

test('unknown paths and methods are refused, including traversal', () => {
  assert.equal(checkLabRequest(ALL_ENABLED, 'GET', lab('secrets')).error, 'endpoint_not_allowed');
  assert.equal(checkLabRequest(ALL_ENABLED, 'GET', ['jobs', '..', '..', 'x']).allowed, false);
  assert.equal(checkLabRequest(ALL_ENABLED, 'GET', lab('stop-all')).allowed, false);
  assert.equal(checkBackendRequest(ALL_ENABLED, 'GET', lab('actuator/env')).allowed, false);
  assert.equal(checkBackendRequest(ALL_ENABLED, 'GET', lab('api/experiments')).allowed, true);
  assert.equal(checkBackendRequest(configWithout('overview'), 'GET', lab('api/experiments')).allowed, false);
  assert.equal(checkBackendRequest(configWithout('overview'), 'GET', lab('api/health')).allowed, true);
});

test('health is open even with every module off', () => {
  const off = configWithout(...MODULES.map(m => m.slug));
  assert.equal(checkLabRequest(off, 'GET', lab('health')).allowed, true);
});

test('password hashes verify, reject wrong input, and contain no $', () => {
  const h = hashPassword('correct horse battery');
  assert.ok(!h.includes('$'));
  assert.equal(verifyPassword('correct horse battery', h), true);
  assert.equal(verifyPassword('wrong', h), false);
  assert.equal(verifyPassword('x', ''), false);
  assert.equal(verifyPassword('x', 'scrypt:bad'), false);
  assert.notEqual(h, hashPassword('correct horse battery'));
});
