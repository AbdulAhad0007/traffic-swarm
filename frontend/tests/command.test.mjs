// Live Digital City: everything shown is derived from recorded events and follows the simulation clock.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { THEMES } from '../lib/themes.js';
import { CATEGORIES, EventLog, PACKET_S, STORY, narrate, statusLabel, storyEvent, storyJunction } from '../components/command/eventModel.js';
import { COMMAND_TOKENS, tailOfShape } from '../components/command/commandLayers.js';
import { createBrowserDemo, phaseAt } from '../components/command/browserDemo.js';
import { signalColor } from '../components/view3d/frameBuffer.js';
import { vehicleStyle } from '../components/command/flatScene.js';
import { checkLabRequest } from '../lib/labGuard.js';
import { ALL_ENABLED } from '../lib/moduleRegistry.js';

const on = Object.fromEntries(CATEGORIES.map(([k]) => [k, true]));
const ev = (id, t, kind, payload = {}, source = 'J1') => ({ id, sim: 's', step: t, t, source, kind, payload });
const alert = (id, t) => ev(id, t, 'platoon_alert', { from: 'J1', to: 'J2', text: 'x' });

test('every theme defines every command token', () => {
  const css = readFileSync(new URL('../app/styles/tokens.css', import.meta.url), 'utf8');
  for (const { slug } of THEMES) {
    const block = (css.match(new RegExp(`\\[data-theme='${slug}'\\]\\s*\\{([^}]*)\\}`)) ?? css.match(new RegExp(`:root,\\s*\\[data-theme='${slug}'\\][^{]*\\{([^}]*)\\}`)))[1];
    assert.deepEqual(COMMAND_TOKENS.filter(name => !block.includes(`${name}:`)), [], slug);
  }
});

test('a repeated poll adds nothing, and late events still land in time order', () => {
  const log = new EventLog();
  log.add([alert(1, 10), alert(2, 12)]);
  log.add([alert(1, 10), alert(2, 12)]);
  assert.equal(log.events.length, 2);
  log.add([alert(3, 11)]);
  assert.deepEqual(log.events.map(e => e.id), [1, 3, 2]);
});

test('a packet exists only between its real send time and the display window', () => {
  const log = new EventLog();
  log.add([alert(1, 10)]);
  assert.equal(log.packetsAt(9.9, on).length, 0);
  assert.equal(log.packetsAt(10 + PACKET_S / 2, on)[0].progress, 0.5);
  assert.equal(log.packetsAt(10 + PACKET_S + 0.1, on).length, 0);
});

test('filters and the packet cap keep rare messages visible', () => {
  const log = new EventLog();
  log.add([ev(1, 10, 'central_decision', { from: 'CENTRAL', to: 'J1', verdict: 'approved', approved_total_s: 20 }), ...Array.from({ length: 9 }, (_, i) => alert(i + 2, 10.5))]);
  const capped = log.packetsAt(11, on, 3);
  assert.ok(capped.some(p => p.category === 'central'));
  assert.ok(capped.length <= 4);
  assert.equal(log.packetsAt(11, { ...on, traffic: false }).length, 1);
});

test('the narrative says what the supervisor really decided', () => {
  assert.match(narrate(ev(1, 1, 'central_decision', { verdict: 'cut_back', to: 'J2', approved_total_s: 12, proposed_total_s: 40 })), /shortened.*J2.*12s instead of 40s/);
  assert.match(narrate(ev(1, 1, 'central_decision', { verdict: 'approved', to: 'J2', approved_total_s: 40 })), /approved/);
});

test('agent replies read as plain language', () => {
  const reply = text => narrate(ev(1, 1, 'response', { from: 'J4', to: 'J7', text }));
  assert.equal(reply('Received lookahead alert C1 from J7: 1 veh, ETA 6s -> early_switch (early_switch_on_time, green set to 16s).'), 'J4 told J7 it will change to green early for them (green set to 16s).');
  assert.equal(reply('Received alert -> declined (x).'), 'J4 told J7 it cannot change its signal for them right now.');
});

test('emergency state at any time comes from events up to that time', () => {
  const log = new EventLog();
  log.add([
    ev(1, 0, 'emergency_priority_mode', { enabled: true }, 'emergency'),
    ev(2, 10, 'emergency_ambulance_departed', { vehicle: 'amb', vtype: 'emergency', route: ['a', 'b'], tls_on_route: ['J1', 'J2'] }, 'amb'),
    ev(3, 12, 'emergency_requested', { vehicle: 'amb', tls: 'J1', target_phase: 0 }, 'amb'),
    ev(4, 20, 'emergency_released', { vehicle: 'amb', tls: 'J1', outcome: 'served' }, 'amb'),
    ev(5, 30, 'emergency_released', { vehicle: 'amb', tls: 'J2', outcome: 'arrived' }, 'amb'),
  ]);
  assert.equal(log.emergencyAt(5).vehicles.length, 0);
  assert.equal(log.emergencyAt(15).active[0].next, 'J1');
  assert.deepEqual([...log.emergencyAt(15).active[0].active.keys()], ['J1']);
  assert.equal(log.emergencyAt(25).active[0].next, 'J2');
  assert.equal(log.emergencyAt(35).active.length, 0);
  assert.equal(log.emergencyAt(35).priority, true);
});

test('an agent that fell back is not reported as healthy', () => {
  const log = new EventLog();
  log.add([ev(1, 0, 'agent_registered', { mode: 'swarm' }), ev(2, 50, 'agent_fallback', { intersection: 'J1', reason: 'optimizer_error' })]);
  assert.equal(log.healthAt('J1', 10).state, 'active');
  assert.equal(log.healthAt('J1', 60).state, 'fallback');
  assert.equal(log.healthAt('J9', 60), null);
});

test('LIVE needs a running run with fresh data', () => {
  assert.equal(statusLabel({ connection: 'live', playing: true, status: 'running' }), 'LIVE');
  assert.equal(statusLabel({ connection: 'stale', playing: true, status: 'running' }), 'DISCONNECTED');
  assert.equal(statusLabel({ connection: 'offline', playing: true, status: 'running' }), 'DISCONNECTED');
  assert.equal(statusLabel({ connection: 'recording', playing: true, status: 'interrupted' }), 'REPLAY');
  assert.equal(statusLabel({ connection: 'live', playing: false, status: 'running' }), 'PAUSED');
  assert.equal(statusLabel({ connection: 'connecting', playing: true }), 'CONNECTING');
  assert.equal(statusLabel({ connection: 'live', playing: true, status: 'running', behind: 60 }), 'REPLAY', 'watching the past is not live');
});

test('a story step waits for its real event and never finds one from before the previous step', () => {
  const log = new EventLog();
  const talk = STORY.find(s => s.key === 'talk');
  assert.equal(storyEvent(log, talk, 0), null);
  log.add([alert(1, 10), alert(2, 20)]);
  assert.equal(storyEvent(log, talk, 15).id, 2);
  assert.equal(storyEvent(log, talk, 21), null);
});

test('the story focuses a junction, not a coordinator', () => {
  assert.equal(storyJunction(ev(1, 1, 'regional_report', { from: 'J3', to: 'R2' })), 'J3');
  assert.equal(storyJunction(ev(1, 1, 'central_decision', { from: 'CENTRAL', to: 'J4' })), 'J4');
  assert.equal(storyJunction(ev(1, 1, 'applied', { intersection: 'J5' })), 'J5');
  assert.equal(storyJunction(null), null);
});

test('storage fills back from the stop line', () => {
  const shape = [[0, 0], [100, 0]];
  assert.deepEqual(tailOfShape(shape, 0.25), [[75, 0], [100, 0]]);
  assert.deepEqual(tailOfShape(shape, 1).at(0), [0, 0]);
  assert.deepEqual(tailOfShape([[0, 0], [50, 0], [50, 50]], 0.75), [[25, 0], [50, 0], [50, 50]]);
});

test('the status never claims LIVE without a real frame, and errors and demo mode have their own labels', () => {
  assert.equal(statusLabel({ connection: 'live', playing: true, status: 'running', hasFrame: false }), 'CONNECTING');
  assert.equal(statusLabel({ connection: 'error', playing: true, status: 'running' }), 'ERROR');
  assert.equal(statusLabel({ connection: 'demo', playing: true, status: 'running' }), 'DEMO MODE');
  assert.equal(statusLabel({ connection: 'demo', playing: false, status: 'running' }), 'DEMO PAUSED');
  assert.equal(statusLabel({ connection: 'live', playing: true, status: 'running', behind: 20, behindLimit: 30 }), 'LIVE');
});

test('each vehicle class has its own size on screen', () => {
  assert.equal(vehicleStyle('bus_in').kind, 'bus');
  assert.equal(vehicleStyle('truck_in').kind, 'truck');
  assert.equal(vehicleStyle('motorcycle_in').kind, 'bike');
  assert.equal(vehicleStyle('car_in').kind, 'car');
  assert.equal(vehicleStyle('ambulance').kind, 'emergency');
  assert.ok(vehicleStyle('bus_in').length > vehicleStyle('car_in').length);
});

test('the overview may pause and re-pace its run, and control follows the section toggle', () => {
  const path = ['api', 'lab', 'jobs', 'abc', 'control'];
  assert.equal(checkLabRequest(ALL_ENABLED, 'POST', path, '{}').allowed, true);
  const off = structuredClone(ALL_ENABLED);
  off.modules.overview.sections['live-city'] = false;
  assert.equal(checkLabRequest(off, 'POST', path, '{}').allowed, false);
});

test('DEMO MODE: vehicles hold at a red stop line, flow on green and never overlap in a lane', () => {
  const demo = createBrowserDemo();
  const { network } = demo;
  let moving = 0, stopped = 0, vehiclesSeen = 0;
  const frames = [];
  for (let i = 0; i < 300; i++) { const f = demo.nextFrame(); frames.push(f); vehiclesSeen = Math.max(vehiclesSeen, f.ids.length); }
  assert.ok(vehiclesSeen > 60, `only ${vehiclesSeen} vehicles`);
  for (const frame of frames.slice(60)) {
    const lanes = new Map();
    frame.ids.forEach((id, i) => {
      if (frame.s[i] > 1) moving += 1; else stopped += 1;
      const edge = network.edges[frame.e[i]];
      if (!edge) return;
      const along = (frame.x[i] - edge.lane_shapes[0][0][0]) * edge.ux + (frame.y[i] - edge.lane_shapes[0][0][1]) * edge.uy;
      if (edge.to && signalColor(frame.tl[edge.to][1], [edge.approach]) === 'red') assert.ok(along <= edge.length + 0.2, `${id} passed a red signal at t=${frame.t}`);
      const key = `${frame.e[i]}/${Math.round((frame.x[i] * edge.uy - frame.y[i] * edge.ux) * 10)}`;
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push([along, vehicleStyle(frame.types[frame.ty[i]]).length]);
    });
    for (const list of lanes.values()) {
      list.sort((a, b) => b[0] - a[0]);
      for (let k = 1; k < list.length; k++) assert.ok(list[k - 1][0] - list[k - 1][1] >= list[k][0] - 0.5, `overlap at t=${frame.t}`);
    }
  }
  assert.ok(moving > 0 && stopped > 0, `moving ${moving}, stopped ${stopped}`);
  assert.equal(frames[0].types.every(name => /_demo$/.test(name)), true, 'demo vehicles cannot be mistaken for SUMO types');
});

test('DEMO MODE: phases run red, green and yellow, and junctions are out of step', () => {
  const seen = new Set();
  for (let t = 0; t < 60; t++) seen.add(phaseAt(t).state[0]);
  assert.deepEqual([...seen].sort(), ['G', 'r', 'y']);
  assert.notEqual(phaseAt(10, 0).state, phaseAt(10, 22).state);
});
