import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ALL_ENABLED, MODULES, buildEffectiveConfig, firstEnabledRoute } from '../lib/moduleRegistry.js';
import { checkBackendRequest, checkLabRequest } from '../lib/labGuard.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { DEFAULT_THEME, THEMES, normalizeTheme } from '../lib/themes.js';
import { seedTables } from './helpers/fakeServices.mjs';

const sql = readFileSync(new URL('../../db/migrations/001_admin_panel.sql', import.meta.url), 'utf8');
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

test('the exact eight modules exist once, in sidebar order', () => {
  assert.deepEqual(MODULES.map(m => [m.name, m.identifier]), [
    ['Overview', 'CORE'], ['Signal Map', 'OSM'], ['Live Lab', 'LIVE'], ['Before / After', 'DUAL'],
    ['Controllers', 'EVAL'], ['Prediction', 'AI'], ['Mixed Traffic', 'MIX'], ['How It Works', 'VIVA'],
  ]);
  assert.equal(MODULES.flatMap(m => m.sections).length, 64);
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
  assert.equal(firstEnabledRoute(configWithout('overview', 'signal-map', 'live-lab', 'before-after', 'controllers', 'prediction', 'mixed-traffic')), null);
});

test('every endpoint the UI calls is allowed when everything is on', () => {
  for (const [method, path] of [
    ['GET', 'health'], ['GET', 'options'], ['GET', 'osm-areas'], ['POST', 'osm-areas'], ['GET', 'jobs'], ['GET', 'jobs/abc123'], ['GET', 'jobs/abc123/live'],
    ['POST', 'jobs/abc123/stop'], ['POST', 'stop-all'], ['GET', 'jobs/abc123/replay'], ['GET', 'jobs/abc123/result'], ['GET', 'jobs/abc123/calls'],
    ['GET', 'jobs/abc123/messages'], ['GET', 'runs'], ['GET', 'runs/comparison'], ['GET', 'runs/replay'], ['GET', 'runs/calls'], ['GET', 'reports'],
    ['GET', 'reports/eval-v1'], ['GET', 'swarm/mesh/state'], ['POST', 'swarm/mesh/step'],
  ]) {
    assert.equal(checkLabRequest(ALL_ENABLED, method, lab(path)).allowed, true, `${method} ${path}`);
    assert.equal(checkLabRequest(ALL_ENABLED, method, lab(`api/lab/${path}`)).allowed, true, `${method} api/lab/${path}`);
  }
});

test('shared endpoints stay open while any owner remains, and close with the last', () => {
  assert.equal(checkLabRequest(configWithout('live-lab'), 'GET', lab('options')).allowed, true);
  assert.equal(checkLabRequest(configWithout('before-after'), 'GET', lab('options')).allowed, true);
  assert.equal(checkLabRequest(configWithout('live-lab', 'before-after'), 'GET', lab('options')).allowed, false);
  assert.equal(checkLabRequest(configWithout('controllers'), 'GET', lab('runs')).allowed, true);
  assert.equal(checkLabRequest(configWithout('controllers', 'overview'), 'GET', lab('runs')).allowed, false);
});

test('single-owner endpoints follow their section', () => {
  assert.equal(checkLabRequest(configWithout('live-lab/stop-all'), 'POST', lab('stop-all')).error, 'module_disabled');
  assert.equal(checkLabRequest(configWithout('before-after/replay'), 'GET', lab('jobs/a/replay')).allowed, false);
  assert.equal(checkLabRequest(configWithout('live-lab/swarm-calls'), 'GET', lab('jobs/a/calls')).allowed, false);
  assert.equal(checkLabRequest(configWithout('controllers/evaluation-ci-chart', 'controllers/evaluation-paired-tests'), 'GET', lab('reports')).allowed, false);
  assert.equal(checkLabRequest(onlyOn('controllers/evaluation-ci-chart'), 'GET', lab('reports/x')).allowed, true);
});

test('job creation is decided by its kind', () => {
  const demo = JSON.stringify({ kind: 'demo' }), exp = JSON.stringify({ kind: 'experiment' });
  const noLive = configWithout('live-lab');
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
