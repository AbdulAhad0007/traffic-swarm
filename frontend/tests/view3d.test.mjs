// 3D View: scene tokens in every theme, frame interpolation, signal colors and adaptive quality.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { THEMES } from '../lib/themes.js';
import { SCENE_TOKENS, hasSceneTokens, toSceneTheme } from '../components/view3d/sceneTheme.js';
import { FrameBuffer, lerpAngle, signalColor } from '../components/view3d/frameBuffer.js';
import { QualityController } from '../components/view3d/quality.js';

const css = readFileSync(new URL('../app/styles/tokens.css', import.meta.url), 'utf8');

function themeBlock(slug) {
  const block = css.match(new RegExp(`\\[data-theme='${slug}'\\]\\s*\\{([^}]*)\\}`))
    ?? css.match(new RegExp(`:root,\\s*\\[data-theme='${slug}'\\][^{]*\\{([^}]*)\\}`));
  return block?.[1] ?? '';
}

for (const { slug } of THEMES) {
  test(`${slug} defines every scene token`, () => {
    const block = themeBlock(slug);
    const missing = SCENE_TOKENS.filter(name => !new RegExp(`${name}:`).test(block));
    assert.deepEqual(missing, []);
  });
}

test('the three themes give the scene three different looks', () => {
  const values = THEMES.map(({ slug }) => themeBlock(slug).match(/--scene-ground:\s*([^;]+);/)?.[1]);
  assert.equal(new Set(values).size, THEMES.length);
});

test('tokens convert to scene values through the supplied color class', () => {
  const tokens = Object.fromEntries(SCENE_TOKENS.map(name => [name, name]));
  assert.equal(hasSceneTokens(tokens), true);
  assert.equal(hasSceneTokens({ ...tokens, '--scene-bg': '' }), false);
  const theme = toSceneTheme({ ...tokens, '--scene-basemap-alpha': '0.5', '--scene-atmosphere': '0' }, { fromCssColorString: value => value });
  assert.equal(theme.ground, '--scene-ground');
  assert.equal(theme.basemapAlpha, 0.5);
  assert.equal(theme.atmosphere, false);
  assert.equal(theme.signals.amber, '--signal-amber');
  assert.equal(theme.heat.length, 3);
});

const frame = (t, vehicles, extra = {}) => ({
  t, ids: vehicles.map(v => v[0]), x: vehicles.map(v => v[1]), y: vehicles.map(v => v[2]), a: vehicles.map(v => v[3] ?? 0),
  s: vehicles.map(() => 5), w: vehicles.map(() => 0), ty: vehicles.map(() => 0), e: vehicles.map(() => 0), types: ['car'], tl: {}, ...extra,
});
const sample = (buffer, t) => {
  const out = new Map();
  const result = buffer.sample(t, (id, x, y, angle) => out.set(id, { x, y, angle }));
  return { out, result };
};

test('positions interpolate between two real samples', () => {
  const b = new FrameBuffer();
  b.add([frame(10, [['a', 0, 0]]), frame(11, [['a', 10, 20]])]);
  assert.deepEqual(sample(b, 10.5).out.get('a'), { x: 5, y: 10, angle: 0 });
});

test('headings take the short way round', () => {
  assert.equal(lerpAngle(350, 10, 0.5), 0);
  assert.equal(lerpAngle(10, 350, 0.5), 0);
});

test('past the last sample a vehicle holds position and nothing is extrapolated', () => {
  const b = new FrameBuffer();
  b.add([frame(10, [['a', 0, 0]]), frame(11, [['a', 10, 0]])]);
  const { out, result } = sample(b, 50);
  assert.equal(out.get('a').x, 10);
  assert.equal(result.atEnd, true);
});

test('a teleported vehicle snaps instead of sliding', () => {
  const b = new FrameBuffer();
  b.add([frame(10, [['a', 0, 0]]), frame(11, [['a', 500, 0]])]);
  assert.equal(sample(b, 10.25).out.get('a').x, 0);
  assert.equal(sample(b, 10.75).out.get('a').x, 500);
});

test('vehicles appear and disappear at the midpoint between samples', () => {
  const b = new FrameBuffer();
  b.add([frame(10, [['gone', 0, 0]]), frame(11, [['new', 5, 5]])]);
  assert.ok(sample(b, 10.25).out.has('gone'));
  assert.ok(sample(b, 10.75).out.has('new'));
  assert.ok(!sample(b, 10.75).out.has('gone'));
});

test('duplicate frames are ignored, and trimming keeps what playback needs', () => {
  const b = new FrameBuffer();
  b.add([frame(1, []), frame(2, []), frame(2, [])]);
  assert.equal(b.frames.length, 2);
  b.add(Array.from({ length: 30 }, (_, i) => frame(i + 3, [])));
  b.trimBefore(20);
  assert.ok(b.oldest <= 15 && b.bracket(20)[0].t === 20);
});

test('junction measurements come only from recorded samples', () => {
  const b = new FrameBuffer();
  b.add([frame(5, [], { j: { t: 5, v: { J1: [3, 0.2, 'light'] } } }), frame(6, []), frame(10, [], { j: { t: 10, v: { J1: [9, 0.5, 'heavy'] } } })]);
  b.updateJunctions(7);
  assert.deepEqual(b.junctions.get('J1'), [3, 0.2, 'light']);
  assert.equal(b.junctionTime, 5);
  b.updateJunctions(10);
  assert.equal(b.junctions.get('J1')[2], 'heavy');
});

test('a lane lamp shows its most permissive link', () => {
  assert.equal(signalColor('rGy', [0, 1]), 'green');
  assert.equal(signalColor('ryr', [0, 1]), 'amber');
  assert.equal(signalColor('rrG', [0, 1]), 'red');
  assert.equal(signalColor(undefined, [0]), 'red');
});

test('quality drops on sustained slow frames and does not return to a level that failed', () => {
  const q = new QualityController('high');
  assert.equal(q.observe(20, 1), null);
  assert.equal(q.observe(20, 1), null);
  assert.equal(q.observe(20, 1), 'medium');
  for (let i = 0; i < 40; i++) assert.equal(q.observe(60, 1), null);
  assert.equal(q.level, 'medium');
  q.observe(20, 3);
  assert.equal(q.level, 'low');
  for (let i = 0; i < 25; i++) q.observe(60, 1);
  assert.equal(q.level, 'medium', 'low recovers to the highest level that held');
});

test('a brief slow spell changes nothing', () => {
  const q = new QualityController('high');
  q.observe(20, 2);
  q.observe(50, 1);
  assert.equal(q.observe(20, 2), null);
  assert.equal(q.level, 'high');
});
