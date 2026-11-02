'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, BookOpen, Box, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Crosshair, Expand, Maximize, Minus, Network, Pause, Play, Plus, RefreshCw, RotateCcw, Siren, SkipForward, Square, X,
} from 'lucide-react';
import { lab } from '@/lib/api';
import { useThemeTokens } from '@/lib/themeClient';
import { FrameBuffer, signalColor } from '@/components/view3d/frameBuffer';
import { SCENE_TOKENS, hasSceneTokens, toSceneTheme } from '@/components/view3d/sceneTheme';
import { createSimFeed } from '@/components/view3d/simFeed';
import { createTwinScene } from '@/components/view3d/twinScene';
import { COMMAND_TOKENS, createCommandLayers } from './commandLayers';
import { CATEGORIES, EventLog, STORY, categoryOf, statusLabel, storyEvent, storyJunction } from './eventModel';
import { createBrowserDemo, createDemoFeed } from './browserDemo';
import { createFlatScene, vehicleStyle } from './flatScene';
import 'cesium/Build/Cesium/Widgets/CesiumWidget/CesiumWidget.css';
import '@/app/styles/command.css';

const TOKENS = [...SCENE_TOKENS, ...COMMAND_TOKENS];
const LEVELS = ['Free flow', 'Normal', 'Busy', 'Heavy', 'Severe', 'Blocked'];
const LEVEL_CLASS = ['free', 'normal', 'busy', 'heavy', 'severe', 'blocked'];
const TERMINAL = ['completed', 'failed', 'cancelled'];
const LIVE_DELAY_S = 3;
const LIVE_BEHIND_S = 30;
const SPEEDS = [1, 2, 5, 10];
const START_TIMEOUT_MS = 90000;
const UNREACHABLE_TRIES = 3;
const CONTROL_SETTLE_MS = 1500;
// Live playback stays behind the newest frame by enough to keep it smooth between polls at this speed.
const liveDelay = speed => Math.max(LIVE_DELAY_S, speed * 1.5);
const UI_MS = 250;
const EVENT_POLL_MS = 1500;
const STORY_READ_MS = 7000;
const LAYERS = [
  ['vehicles', 'Vehicles'], ['signals', 'Signals'], ['agents', 'Agents'], ['comms', 'Comms'], ['heatmap', 'Congestion'], ['corridor', 'Corridor'],
];
const DEMO = { kind: 'experiment', network: 'demo_city', scenario: 'rush-hour', seed: 42, controllers: ['swarm_hierarchical_priority'], ambulances: 2, max_time: 1800, realtime_factor: 1 };
const BROWSER_DEMO = { demo: true, jobId: 'browser-demo', controller: null };
const TYPE_NAMES = [['car', 'Cars'], ['bus', 'Buses'], ['truck', 'Trucks'], ['bike', 'Bikes'], ['auto', 'Auto-rickshaws'], ['emergency', 'Emergency']];

const KEY_EVENTS = ['congestion', 'central', 'emergency', 'health'];

const clock = seconds => {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const isHierarchical = controller => /hierarchical/.test(controller || '');
const allCategories = () => Object.fromEntries(CATEGORIES.map(([key]) => [key, true]));

// Newest running run first; otherwise the newest finished run that can show the whole hierarchy.
export function pickRun(jobs) {
  const hasJournal = j => j.spec.controllers.some(isHierarchical);
  const pick = jobs.find(j => !TERMINAL.includes(j.status) && hasJournal(j)) || jobs.find(j => !TERMINAL.includes(j.status))
    || jobs.find(j => j.status === 'completed' && hasJournal(j)) || jobs.find(j => j.status === 'completed');
  return pick ? { jobId: pick.id, controller: pick.spec.controllers.find(isHierarchical) || pick.spec.controllers[0] } : null;
}

function SignalHead({ color }) {
  return (
    <span className="cc-head" role="img" aria-label={`Signal ${color}`}>
      <i className={color === 'red' ? 'on-red' : ''} /><i className={color === 'amber' ? 'on-amber' : ''} /><i className={color === 'green' ? 'on-green' : ''} />
    </span>
  );
}

function Facts({ rows }) {
  return <dl className="cc-facts">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

function JunctionPanel({ id, network, ui, log, onFocus, onClose }) {
  const signal = network.signals.find(s => s.id === id);
  const state = ui.tl?.[id];
  const lamps = (signal?.lamps || []).map(l => signalColor(state?.[1], l.links));
  const count = name => lamps.filter(c => c === name).length;
  const measured = ui.junctions?.get(id);
  const health = log.healthAt(id, ui.t);
  const head = count('green') ? 'green' : count('amber') ? 'amber' : 'red';
  const neighbours = (network.links || []).filter(l => l.includes(id)).map(l => (l[0] === id ? l[1] : l[0]));
  const about = log.aboutAt(id, ui.t);
  return (
    <>
      <div className="cc-card-head"><h3>Junction {id}</h3><button type="button" className="small icon" aria-label="Close" onClick={onClose}><X size={14} /></button></div>
      <div className="cc-signal"><SignalHead color={head} /><div><b>{head === 'green' ? 'Green: permitted movements may go' : head === 'amber' ? 'Yellow: signal changing' : 'Red: vehicles must stop'}</b><span className="muted small">Phase {state?.[0] ?? '–'}{state?.[2] != null ? ` · changes in ${Math.max(0, Math.round(state[2]))}s at the latest plan` : ''}</span></div></div>
      <Facts rows={[
        ['Approach lanes', lamps.length ? `${count('green')} green · ${count('amber')} yellow · ${count('red')} red` : '–'],
        ['Queue', measured?.[0] != null ? `${measured[0]} vehicles` : 'No data'],
        ['Occupancy', measured?.[1] != null ? `${Math.round(measured[1] * 100)}%` : 'No data'],
        ['Agent', !health ? 'No record for this run' : health.state === 'active' ? 'Active' : health.state === 'native' ? 'Signal program only' : 'Fell back to signal program'],
        ['Neighbours', neighbours.join(', ') || 'None'],
      ]} />
      <h4>Recent activity</h4>
      {about.length ? <ul className="cc-mini">{about.map(({ event, text }) => <li key={event.id}><span>{clock(event.t)}</span> {text}</li>)}</ul> : <p className="muted small">Nothing recorded yet.</p>}
      <button type="button" className="small" onClick={onFocus}><Crosshair size={14} /> Focus camera</button>
    </>
  );
}

function RoadPanel({ index, network, roads, onClose }) {
  const edge = network.edges[index];
  if (!edge) return null;
  const capacity = roads ? Math.max(1, Math.floor((roads.n[index] || 0) / Math.max(roads.u[index] || 0, 1e-9))) : null;
  const estimated = Math.max(1, Math.floor(edge.length * (edge.drive_lanes ?? edge.lanes) / 7.5));
  const used = roads?.u[index] ?? 0;
  const risk = used >= 0.85 ? 'High' : used >= 0.6 ? 'Medium' : 'Low';
  return (
    <>
      <div className="cc-card-head"><h3>Road {edge.name || edge.id}</h3><button type="button" className="small icon" aria-label="Close" onClick={onClose}><X size={14} /></button></div>
      {!roads ? <p className="muted small">This run has no road measurements. Road data is recorded from this version onwards.</p> : (
        <>
          <div className={`cc-level l-${LEVEL_CLASS[roads.l[index]]}`}>{LEVELS[roads.l[index]]}</div>
          <div className="cc-storage" role="img" aria-label={`Storage ${Math.round(used * 100)} percent used`}><i style={{ width: `${Math.min(100, used * 100)}%` }} /></div>
          <p className="muted small">{roads.n[index]} measured vehicles of about {roads.n[index] ? capacity : estimated} estimated capacity</p>
          <Facts rows={[
            ['Queue', `${roads.q[index]} vehicles`],
            ['Occupancy', `${Math.round(roads.o[index] * 100)}%`],
            ['Average speed', `${(roads.v[index] * 3.6).toFixed(0)} km/h`],
            ['Waiting time', `${roads.w[index]} s in total`],
            ['Free storage (estimate)', `${Math.max(0, estimated - roads.n[index])} vehicles`],
            ['Spillback risk', risk],
            ['Last 5 s', `${roads.in[index]} in · ${roads.out[index]} out`],
            ['Road', `${edge.length} m · ${edge.drive_lanes ?? edge.lanes} lanes`],
          ]} />
        </>
      )}
    </>
  );
}

function EmergencyStatus({ emergency, onFocus }) {
  if (!emergency.vehicles.length) return <p className="muted small">No emergency vehicle in this run so far.</p>;
  if (!emergency.active.length) return <p className="muted small">{emergency.vehicles.length} emergency vehicle(s) have finished their trips.</p>;
  return emergency.active.map(v => (
    <div key={v.id} className="cc-emergency">
      <b>{emergency.priority ? 'EMERGENCY PRIORITY ACTIVE' : 'Emergency vehicle: observed only, no priority in this run'}</b>
      <Facts rows={[
        ['Vehicle', v.id], ['Type', v.type || '–'], ['Next junction', v.next ?? 'None on route'],
        ['Route', `${v.passed.size} of ${v.tls.length} junctions passed`],
        ['Priority requests', v.active.size ? [...v.active.keys()].join(', ') : 'None now'],
        ['Signal changes', v.actions],
      ]} />
      {v.next && <button type="button" className="small" onClick={() => onFocus(v.next)}><Crosshair size={14} /> Next junction</button>}
    </div>
  ));
}

function Timeline({ log, ui, filters, setFilters, technical, setTechnical }) {
  const [all, setAll] = useState(false);
  // Routine messages arrive several times a second, so by default the list keeps to what changes the story.
  const shown = all ? filters : Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, v && KEY_EVENTS.includes(k)]));
  const items = log.recentAt(ui?.t ?? 0, shown, 40);
  return (
    <>
      <div className="cc-filters">
        {CATEGORIES.map(([key, label]) => (
          <button type="button" key={key} className={`cc-chip c-${key}`} aria-pressed={filters[key]} onClick={() => setFilters(f => ({ ...f, [key]: !f[key] }))}>{label}</button>
        ))}
        <label className="cc-check"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> Routine messages in this list</label>
        <label className="cc-check"><input type="checkbox" checked={technical} onChange={e => setTechnical(e.target.checked)} /> Technical view</label>
      </div>
      {log.journal === false && <p className="muted small">{isDemo ? 'DEMO MODE has no agents, so there are no agent events. Real events appear in a SUMO run.' : 'This run was recorded before the event journal existed, so it has no agent activity to show. Start a new run to see it.'}</p>}
      <ol className="cc-events">
        {items.map(({ event, category, text }) => (
          <li key={event.id} className={`c-${category}`}>
            <time>{clock(event.t)}</time>
            <span>{text}</span>
            {technical && <code>#{event.id} · step {event.step} · {event.source} · {event.kind}{event.payload.text ? ` · ${event.payload.text}` : ''}</code>}
          </li>
        ))}
        {!items.length && log.journal !== false && <li className="muted small">No events yet at this point in the run.</li>}
      </ol>
    </>
  );
}

export default function CommandCenter() {
  const rootRef = useRef(null);
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const layersRef = useRef(null);
  const feedRef = useRef(null);
  const bufferRef = useRef(new FrameBuffer());
  const logRef = useRef(new EventLog());
  const clockRef = useRef({ t: null, speed: 1, playing: true, manifest: null, started: false, dirty: false });
  const tokensRef = useRef(null);
  const visibleRef = useRef(Object.fromEntries(LAYERS.map(([k]) => [k, true])));
  const filtersRef = useRef(allCategories());
  const selectionRef = useRef(null);

  const [jobs, setJobs] = useState([]);
  const [labError, setLabError] = useState(null);
  const [run, setRun] = useState(null);
  const [userPicked, setUserPicked] = useState(false);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [network, setNetwork] = useState(null);
  const [connection, setConnection] = useState('connecting');
  const [ui, setUi] = useState(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [visible, setVisible] = useState(visibleRef.current);
  const [filters, setFilters] = useState(filtersRef.current);
  const [selection, setSelection] = useState(null);
  const [panels, setPanels] = useState({ left: true, right: true, bottom: false });
  const [technical, setTechnical] = useState(false);
  const [mode, setMode] = useState('2d');
  const [progress, setProgress] = useState(null);
  const [reload, setReload] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [story, setStory] = useState(null);
  const tokens = useThemeTokens(TOKENS);

  const runRef = useRef(null);
  const controlSentRef = useRef(0);
  runRef.current = run;
  filtersRef.current = filters;
  selectionRef.current = selection;
  const hierarchy = isHierarchical(run?.controller);

  // Run list. Follows the newest suitable run until the user chooses one.
  useEffect(() => {
    let active = true;
    const load = () => {
      if (document.hidden) return;
      lab('/api/lab/jobs?limit=30').then(list => {
        if (!active) return;
        setJobs(list);
        setLabError(null);
        setRun(current => (current && (userPicked || current.demo || current.jobId === pickRun(list)?.jobId) ? current : pickRun(list) ?? current));
      }).catch(err => {
        if (!active) return;
        setLabError(err.message);
        if (!runRef.current?.demo) setConnection('offline');
      });
    };
    load();
    const timer = setInterval(load, 8000);
    return () => { active = false; clearInterval(timer); };
  }, [userPicked, reload]);

  // The canvas fills the whole section. Traffic is framed in the part the panels do not cover.
  const measureInsets = useCallback(() => {
    const root = rootRef.current;
    if (!root) return { top: 0, right: 0, bottom: 0, left: 0 };
    const box = root.getBoundingClientRect();
    const rect = name => {
      const el = root.querySelector(name);
      return el && getComputedStyle(el).position === 'absolute' ? el.getBoundingClientRect() : null;
    };
    const top = rect('.cc-top'), left = rect('.cc-left'), bottom = rect('.cc-bottom');
    return { top: top ? top.bottom - box.top + 4 : 0, left: left ? left.right - box.left + 4 : 0, bottom: bottom ? box.bottom - bottom.top + 4 : 0, right: 8 };
  }, []);

  useEffect(() => { sceneRef.current?.refit?.(); clockRef.current.dirty = true; }, [panels.left, panels.bottom]);

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const pushTheme = useCallback(() => {
    const all = tokensRef.current;
    if (!all || !sceneRef.current) return;
    sceneRef.current.applyTheme(all);
    if (layersRef.current && window.Cesium3D) layersRef.current.applyTheme(all, toSceneTheme(all, window.Cesium3D.Color));
  }, []);

  useEffect(() => {
    if (!hasSceneTokens(tokens) || !tokens['--road-free']) return;
    tokensRef.current = tokens;
    pushTheme();
  }, [tokens, pushTheme]);

  // One scene and one set of feeds per run. Leaving always frees the GPU.
  useEffect(() => {
    if (!run) return undefined;
    let cancelled = false, raf = 0, refresh = 0, eventTimer = 0;
    const buffer = bufferRef.current;
    const log = logRef.current;
    const clockState = clockRef.current;
    buffer.clear();
    log.clear();
    Object.assign(clockState, { t: null, manifest: null, started: false, dirty: false });
    Object.assign(clockState, { playing: true, speed: 1 });
    setPlaying(true); setSpeed(1); setProgress(null);
    setStatus('loading'); setError(null); setSelection(null); setConnection('connecting'); setUi(null); setNetwork(null); setStory(null);
    const demo = run.demo ? createBrowserDemo() : null;
    window.CESIUM_BASE_URL = '/cesium/';
    const q = `controller=${encodeURIComponent(run.controller)}`;

    // Every way out of this wait is explicit: the network arrives, the run fails, the service is gone, or time runs out.
    const loadNetwork = async () => {
      if (demo) return demo.network;
      const started = Date.now();
      let unreachable = 0;
      while (!cancelled) {
        try {
          return await lab(`/api/lab/jobs/${run.jobId}/network3d?${q}`);
        } catch {
          const job = await lab(`/api/lab/jobs/${run.jobId}`).catch(() => null);
          if (!job) {
            unreachable += 1;
            if (unreachable >= UNREACHABLE_TRIES) throw new Error('The simulation service stopped responding.');
          } else {
            unreachable = 0;
            if (TERMINAL.includes(job.status)) {
              const detail = Object.values(job.errors || {}).find(e => e?.error)?.error || job.error;
              throw new Error(job.status === 'completed' ? 'This run recorded no vehicle data.' : `The run ${job.status}${detail ? `: ${detail}` : '.'}`);
            }
            if (Date.now() - started > START_TIMEOUT_MS) throw new Error(`SUMO did not produce a network within ${START_TIMEOUT_MS / 1000} seconds (job status: ${job.status}).`);
            if (!cancelled) setProgress(job.status);
          }
          if (!cancelled) setStatus('waiting');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      return null;
    };

    const pollEvents = async () => {
      if (cancelled) return;
      let next = EVENT_POLL_MS;
      if (!document.hidden) {
        try {
          const data = await lab(`/api/lab/jobs/${run.jobId}/events?${q}&after=${log.lastId}&limit=1000`);
          if (cancelled) return;
          log.journal = data.journal;
          log.add(data.events);
          if (data.events.length >= 1000) next = 50;
          else if (TERMINAL.includes(data.job_status)) next = 15000;
        } catch { next = EVENT_POLL_MS * 3; }
      }
      eventTimer = setTimeout(pollEvents, next);
    };

    const build = async net => {
      if (mode === '2d' || run.demo) {
        return { scene: createFlatScene(canvasRef.current, net, { onPick: picked => setSelection(picked), insets: measureInsets, hierarchy: isHierarchical(run.controller) }), layers: null };
      }
      const Cesium = await import('cesium');
      if (cancelled) return null;
      window.Cesium3D = Cesium;
      const scene = createTwinScene(Cesium, canvasRef.current, net, {
        framing: { range: 3.1, pitch: -62, south: 0.28 },
        onPick: picked => setSelection(picked?.kind === 'central' || picked?.kind === 'vehicle' ? null : picked),
        onRenderError: err => { setError(err?.message || 'The 3D renderer stopped.'); setMode('2d'); },
      });
      // Road and junction levels are drawn by the command layers here, from the road measurements.
      scene.setLayer('density', false);
      scene.setLayer('heatmap', false);
      scene.setLayer('labels', false);
      return { scene, layers: createCommandLayers(Cesium, scene, net, { hierarchy: isHierarchical(run.controller) }) };
    };

    loadNetwork().then(async net => {
      if (cancelled || !net) return;
      let built;
      try {
        built = await build(net);
      } catch (err) {
        if (!cancelled) { setStatus('loading'); setError(err?.message || 'WebGL is unavailable.'); setMode('2d'); }
        return;
      }
      if (cancelled || !built) { built?.scene.destroy(); return; }
      sceneRef.current = built.scene;
      layersRef.current = built.layers;
      setNetwork(net);
      pushTheme();
      Object.entries(visibleRef.current).forEach(([k, v]) => { built.scene.setLayer(k, v); built.layers?.setLayer(k, v); });
      setStatus('ready');
      const onManifest = m => {
        clockState.manifest = m;
        // Pause and speed live in the simulation, so another tab or a reload sees the same state.
        if (m.status !== 'running' || Date.now() - controlSentRef.current < CONTROL_SETTLE_MS) return;
        if (m.control?.paused !== undefined && clockState.playing === m.control.paused) { clockState.playing = !m.control.paused; setPlaying(!m.control.paused); }
        if (m.control?.speed && clockState.speed !== m.control.speed) { clockState.speed = m.control.speed; setSpeed(m.control.speed); }
      };
      if (demo) {
        log.journal = false;
        feedRef.current = createDemoFeed({ demo, buffer, getPlayhead: () => clockState.t, onManifest, onConnection: setConnection });
      } else {
        pollEvents();
        feedRef.current = createSimFeed({ jobId: run.jobId, controller: run.controller, buffer, getPlayhead: () => clockState.t, onManifest, onConnection: setConnection });
      }

      let last = performance.now(), drawn = null;
      const tick = now => {
        raf = requestAnimationFrame(tick);
        // A throttled window draws rarely but its clock must still keep up. Only a long gap (a hidden tab) is cut short.
        const dt = Math.min((now - last) / 1000, 2);
        last = now;
        if (buffer.newest === null || document.hidden) return;
        const m = clockState.manifest;
        const running = m?.status === 'running';
        if (!clockState.started) {
          clockState.started = true;
          // Opened partway through a live run: go to the present, not the first batch of recorded frames.
          if (running && m.last_t - buffer.newest > liveDelay(clockState.speed)) {
            clockState.t = m.last_t - liveDelay(clockState.speed);
            feedRef.current?.seek(clockState.t);
            return;
          }
          clockState.t = running ? Math.max(buffer.oldest, buffer.newest - liveDelay(clockState.speed)) : buffer.oldest;
        }
        if (clockState.playing) {
          const limit = running ? buffer.newest - liveDelay(clockState.speed) : buffer.newest;
          // Live: ease towards the target delay, so arriving batches of frames never show as stop-and-go motion.
          // A larger gap is someone looking back on purpose, so it is left alone until they choose Go to live.
          const gap = limit - clockState.t;
          const rate = !running || gap > LIVE_BEHIND_S ? clockState.speed : Math.max(clockState.speed * 0.4, clockState.speed + gap / 3);
          clockState.t = Math.min(clockState.t + dt * rate, Math.max(limit, clockState.t));
        }
        if (clockState.t === drawn && !clockState.dirty) return;
        drawn = clockState.t;
        clockState.dirty = false;
        const sampled = built.scene.update(buffer, clockState.t, log, filtersRef.current);
        built.layers?.update(buffer, clockState.t, log, filtersRef.current, sampled?.frame);
        buffer.trimBefore(clockState.t);
      };
      raf = requestAnimationFrame(tick);

      refresh = setInterval(() => {
        if (document.hidden) return;
        const pair = buffer.bracket(clockState.t ?? 0);
        const stats = built.scene.stats();
        const frame = pair?.[0];
        const byType = {};
        frame?.ty?.forEach(i => { const kind = vehicleStyle(frame.types[i]).kind; byType[kind] = (byType[kind] || 0) + 1; });
        const speedSum = frame?.s?.reduce((sum, v) => sum + v, 0) ?? 0;
        const heads = { green: 0, amber: 0, red: 0 };
        for (const s of net.signals) for (const lamp of s.lamps || []) heads[signalColor(frame?.tl?.[s.id]?.[1], lamp.links)] += 1;
        setUi({
          byType, heads, speed: frame?.ids?.length ? speedSum / frame.ids.length : null, paused: !!clockState.manifest?.control?.paused,
          t: clockState.t, status: clockState.manifest?.status, stats, tl: frame?.tl, junctions: buffer.junctions, roads: buffer.roads,
          vehicles: frame?.ids?.length ?? 0, stopped: frame?.s?.filter(v => v < 0.1).length ?? 0,
          last: clockState.manifest?.last_t, emergency: log.emergencyAt(clockState.t ?? 0), events: log.lastId,
        });
      }, UI_MS);
    }).catch(err => {
      if (cancelled) return;
      setError(err?.message || 'Could not load this run.');
      setStatus('error');
      setConnection('error');
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearInterval(refresh);
      clearTimeout(eventTimer);
      feedRef.current?.destroy();
      feedRef.current = null;
      layersRef.current?.destroy();
      layersRef.current = null;
      sceneRef.current?.destroy();
      sceneRef.current = null;
    };
  }, [run, mode, pushTheme, measureInsets]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !network) return;
    scene.select?.(null, null);
    layersRef.current?.setSelected(selection);
    clockRef.current.dirty = true;
    if (selection?.kind === 'junction') scene.focusJunction(selection.id);
    if (selection?.kind === 'region') { const c = layersRef.current?.regionCenter(selection.id); if (c) scene.focusPoint(c.x, c.y, 260); }
    if (selection?.kind !== undefined) setPanels(p => ({ ...p, right: true }));
  }, [selection, network]);

  const setLayer = (name, value) => {
    visibleRef.current = { ...visibleRef.current, [name]: value };
    setVisible(visibleRef.current);
    sceneRef.current?.setLayer(name, value);
    layersRef.current?.setLayer(name, value);
    clockRef.current.dirty = true;
  };
  // A running SUMO job is really paused or re-paced. A finished recording only needs the local clock.
  const sendControl = body => {
    if (!run || run.demo || clockRef.current.manifest?.status !== 'running') return;
    controlSentRef.current = Date.now();
    lab(`/api/lab/jobs/${run.jobId}/control`, { method: 'POST', body: JSON.stringify(body) }).then(() => setError(null)).catch(err => setError(`Could not reach the simulation: ${err.message}`));
  };
  const togglePlaying = () => { const next = !playing; clockRef.current.playing = next; setPlaying(next); sendControl({ paused: !next }); };
  const changeSpeed = value => { clockRef.current.speed = value; setSpeed(value); sendControl({ speed: value }); };
  const stopRun = () => {
    if (!run || run.demo) return;
    lab(`/api/lab/jobs/${run.jobId}/stop`, { method: 'POST' }).catch(err => setError(err.message));
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else rootRef.current?.requestFullscreen?.().catch(err => setError(`Fullscreen is not available here: ${err.message}`));
  };
  const startBrowserDemo = () => { setUserPicked(true); setLabError(null); setRun({ ...BROWSER_DEMO }); };
  const retry = () => { setLabError(null); setError(null); setStatus(run ? 'loading' : 'idle'); setReload(n => n + 1); if (run) setRun({ ...run }); };
  const seekTo = useCallback(t => {
    const c = clockRef.current;
    c.t = t;
    c.dirty = true;
    feedRef.current?.seek(t);
  }, []);
  const startDemo = async () => {
    setDemoBusy(true);
    setError(null);
    try {
      // One demo at a time: rejoin the one in progress instead of starting a second SUMO.
      const list = await lab('/api/lab/jobs?limit=30');
      const running = list.find(j => !TERMINAL.includes(j.status) && j.spec.network === DEMO.network && j.spec.controllers.includes(DEMO.controllers[0]));
      const job = running ?? await lab('/api/lab/jobs', { method: 'POST', body: JSON.stringify(DEMO) });
      setLabError(null);
      setUserPicked(true);
      setJobs(current => (current.some(j => j.id === job.id) ? current : [job, ...current]));
      setRun({ jobId: job.id, controller: DEMO.controllers[0] });
    } catch (err) {
      setError(err.message);
      setStatus('error');
      setConnection('error');
    } finally {
      setDemoBusy(false);
    }
  };

  // ------------------------------------------------------------------ guided story
  const log = logRef.current;
  const storyStep = story ? STORY[story.index] : null;
  const storyHit = useMemo(() => {
    if (!story || !storyStep?.find) return null;
    return storyEvent(log, storyStep, story.after);
    // Re-evaluated as events arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story, storyStep, ui?.events]);
  const storyBlocked = storyStep?.needsHierarchy && !hierarchy;
  const storyReady = !!story && (storyStep.vehicles ? (ui?.vehicles ?? 0) > 0 : storyStep.measure ? true : !!storyHit);
  const storySeen = storyReady && (!storyHit || (ui?.t ?? 0) >= storyHit.t);

  useEffect(() => {
    if (!storyHit || !story || story.shown === storyHit.id) return;
    // On a recording the story moves the view to the real event; live, the event is already at or ahead of the playhead.
    const c = clockRef.current;
    if (c.manifest?.status !== 'running' && storyHit.t > (c.t ?? 0) + 1) seekTo(Math.max(0, storyHit.t - 2));
    const junction = storyJunction(storyHit);
    if (junction) setSelection({ kind: 'junction', id: junction });
    setStory(s => (s ? { ...s, shown: storyHit.id } : s));
  }, [storyHit, story, seekTo]);

  const nextStep = useCallback(() => {
    setStory(s => {
      if (!s) return s;
      if (s.index >= STORY.length - 1) return null;
      const after = storyHit ? storyHit.t : s.after;
      return { ...s, index: s.index + 1, after, shown: null };
    });
  }, [storyHit]);

  useEffect(() => {
    if (!story || story.paused || !storySeen || story.index >= STORY.length - 1) return undefined;
    const timer = setTimeout(nextStep, STORY_READ_MS);
    return () => clearTimeout(timer);
  }, [story, storySeen, nextStep]);

  useEffect(() => {
    if (storyBlocked) { setStory(s => (s ? { ...s, paused: true } : s)); }
  }, [storyBlocked]);

  // ------------------------------------------------------------------ render
  const behind = ui?.last != null && ui?.t != null ? ui.last - ui.t : 0;
  const label = statusLabel({ connection, playing: playing && !ui?.paused, status: ui?.status, behind, behindLimit: Math.max(LIVE_BEHIND_S, liveDelay(speed) * 2), hasFrame: ui?.t != null });
  const isDemo = !!run?.demo;
  const runJob = jobs.find(j => j.id === run?.jobId);
  const emergency = ui?.emergency ?? { priority: null, vehicles: [], active: [] };
  const roads = ui?.roads;
  const levelCounts = useMemo(() => {
    const counts = [0, 0, 0, 0, 0, 0];
    roads?.l?.forEach(l => { counts[l] += 1; });
    return counts;
  }, [roads]);
  const measuredJunction = storyJunction(storyHit) || selection?.id;
  const measured = ui?.junctions?.get(measuredJunction);
  const showScene = status === 'ready';
  const regions = network?.regions ? Object.entries(network.regions) : [];

  return (
    <section ref={rootRef} className="cc" data-status={status} data-label={label} data-connection={connection}>
      <div ref={canvasRef} className="cc-canvas" />

      <header className="cc-top">
        <div className="cc-brand"><b>Live simulation</b><span className="muted small">{isDemo ? 'Browser traffic model, not SUMO' : runJob ? `${runJob.spec.network} · ${runJob.spec.scenario}` : 'Live digital city'}</span></div>
        <span className={`cc-status s-${label.split(' ')[0].toLowerCase()}`} data-testid="status"><i className="cc-pulse" />{label}</span>
        {label === 'PAUSED' && ui?.status === 'running' && <span className="muted small">SUMO is paused.</span>}
        <span className="cc-stat"><b>{ui?.t != null ? clock(ui.t) : '--:--:--'}</b><span>Simulation time</span></span>
        <span className="cc-stat"><b>{ui?.vehicles ?? '–'}</b><span>Vehicles</span></span>
        <span className="cc-stat"><b>{network?.signals.length ?? '–'}</b><span>{isDemo ? 'Signals' : 'Agents'}</span></span>
        <span className="cc-stat" data-perf><b>{ui?.stats?.fps ?? '–'}</b><span>FPS</span></span>
        <div className="cc-spacer" />
        <select aria-label="Simulation run" value={isDemo ? '' : run?.jobId ?? ''} onChange={e => {
          const j = jobs.find(x => x.id === e.target.value);
          if (j) { setUserPicked(true); setRun({ jobId: j.id, controller: j.spec.controllers.find(isHierarchical) || j.spec.controllers[0] }); }
        }}>
          <option value="" disabled>{jobs.length ? 'Choose a run' : 'No runs yet'}</option>
          {jobs.map(j => <option key={j.id} value={j.id}>{j.spec.network} · {j.spec.scenario} · {j.spec.controllers.at(-1)} · {j.status}</option>)}
        </select>
        <button type="button" className="small" disabled={demoBusy} onClick={startDemo} title="Starts a real SUMO run: 12 junctions, 2-lane roads, mixed vehicles, rush-hour demand, 2 emergency vehicles"><Play size={14} /> {demoBusy ? 'Starting…' : 'Run demo scenario'}</button>
        {!isDemo && ui?.status === 'running' && <button type="button" className="small" onClick={stopRun} title="Stops this SUMO run"><Square size={14} /> Stop</button>}
        <button type="button" className="small primary" disabled={!showScene || isDemo} onClick={() => { setStory(story ? null : { index: 0, after: 0, paused: false, shown: null }); }}><BookOpen size={14} /> {story ? 'Exit walkthrough' : 'Start walkthrough'}</button>
      </header>

      <aside className={`cc-left ${panels.left ? '' : 'closed'}`}>
        <button type="button" className="small icon cc-collapse" aria-label={panels.left ? 'Collapse left panel' : 'Open left panel'} onClick={() => setPanels(p => ({ ...p, left: !p.left }))}>{panels.left ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}</button>
        {panels.left && (
          <div className="cc-scroll">
            <h3><Network size={14} /> Network status</h3>
            <Facts rows={[
              ['Moving', ui ? `${Math.max(0, ui.vehicles - ui.stopped)} vehicles` : '–'],
              ['Stopped', ui ? `${ui.stopped} vehicles` : '–'],
              ['Average speed', ui?.speed != null ? `${(ui.speed * 3.6).toFixed(0)} km/h` : '–'],
              ['Signals', ui?.heads ? <span className="cc-heads"><i className="on-green" />{ui.heads.green}<i className="on-amber" />{ui.heads.amber}<i className="on-red" />{ui.heads.red}</span> : '–'],
              ['Coordination', isDemo ? 'None (fixed timers)' : hierarchy ? 'Agents + central' : 'Neighbours only'],
            ]} />
            {ui?.byType && <ul className="cc-types" aria-label="Vehicles by type">{TYPE_NAMES.filter(([k]) => ui.byType[k]).map(([k, name]) => <li key={k} className={`t-${k}`}><i />{name}<b>{ui.byType[k]}</b></li>)}</ul>}
            <ul className="cc-levels" aria-label="Roads by congestion level">
              {LEVELS.map((name, i) => <li key={name} className={`l-${LEVEL_CLASS[i]}`}><i />{name}<b>{roads ? levelCounts[i] : '–'}</b></li>)}
            </ul>
            {!hierarchy && !isDemo && showScene && <p className="muted small">This run has no regional or central coordinators. Use the demo scenario to see them.</p>}
            <h3><Siren size={14} /> Emergency</h3>
            <EmergencyStatus emergency={emergency} onFocus={id => setSelection({ kind: 'junction', id })} />
            {hierarchy && regions.length > 0 && <>
              <h3>Regions</h3>
              <ul className="cc-list">{regions.map(([id, members]) => <li key={id}><button type="button" className="link" onClick={() => setSelection({ kind: 'region', id })}>Coordinator {id}</button> <span className="muted small">{members.length} junctions</span></li>)}</ul>
            </>}
            <h3>Junctions</h3>
            <div className="cc-junctions">{network?.signals.map(s => <button key={s.id} type="button" className={`cc-j ${selection?.id === s.id ? 'on' : ''}`} onClick={() => setSelection({ kind: 'junction', id: s.id })}>{s.id}</button>)}</div>
          </div>
        )}
      </aside>

      {selection && panels.right && network && (
        <aside className="cc-right">
          <div className="cc-scroll">
            {selection.kind === 'junction' && ui && <JunctionPanel id={selection.id} network={network} ui={ui} log={log} onClose={() => setSelection(null)} onFocus={() => sceneRef.current?.focusJunction(selection.id)} />}
            {selection.kind === 'road' && <RoadPanel index={selection.index ?? network.edges.findIndex(e => e.id === selection.id)} network={network} roads={roads} onClose={() => setSelection(null)} />}
            {selection.kind === 'region' && <>
              <div className="cc-card-head"><h3>Coordinator {selection.id}</h3><button type="button" className="small icon" aria-label="Close" onClick={() => setSelection(null)}><X size={14} /></button></div>
              <p className="muted small">Watches the roads leaving these junctions and asks the central supervisor for a review when one is nearly full.</p>
              <div className="cc-junctions">{network.regions?.[selection.id]?.map(id => <button key={id} type="button" className="cc-j" onClick={() => setSelection({ kind: 'junction', id })}>{id}</button>)}</div>
              <h4>Recent activity</h4>
              <ul className="cc-mini">{log.aboutAt(selection.id, ui?.t ?? 0).map(({ event, text }) => <li key={event.id}><span>{clock(event.t)}</span> {text}</li>)}</ul>
            </>}
          </div>
        </aside>
      )}

      <div className={`cc-bottom ${panels.bottom ? '' : 'closed'}`}>
        <div className="cc-transport">
          <button type="button" className="small" onClick={togglePlaying}>{playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play'}</button>
          <label className="cc-check">Speed <select aria-label="Simulation speed" value={speed} onChange={e => changeSpeed(Number(e.target.value))}>{SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}</select></label>
          {ui?.status === 'running' && behind > LIVE_BEHIND_S && <button type="button" className="small" onClick={() => seekTo(ui.last - LIVE_DELAY_S)}><SkipForward size={14} /> Go to live</button>}
      <div className="cc-tools" role="toolbar" aria-label="Camera and layers">
        <button type="button" className="small icon" aria-label="Zoom in" title="Zoom in" onClick={() => sceneRef.current?.zoom(1)}><Plus size={15} /></button>
        <button type="button" className="small icon" aria-label="Zoom out" title="Zoom out" onClick={() => sceneRef.current?.zoom(-1)}><Minus size={15} /></button>
        <button type="button" className="small icon" aria-label="Fit whole network" title="Fit whole network" onClick={() => sceneRef.current?.resetCamera()}><Maximize size={15} /></button>
        <button type="button" className="small icon" aria-label="Reset camera" title="Reset camera" onClick={() => { setSelection(null); sceneRef.current?.resetCamera(); }}><RotateCcw size={15} /></button>
        <button type="button" className="small icon" aria-pressed={fullscreen} aria-label="Fullscreen" title="Fullscreen" onClick={toggleFullscreen}><Expand size={15} /></button>
        <button type="button" className="small icon" disabled={isDemo} aria-pressed={mode === '3d'} aria-label="Switch between 3D and top-down" title={mode === '3d' ? 'Use the top-down view' : 'Use the 3D view'} onClick={() => setMode(m => (m === '3d' ? '2d' : '3d'))}><Box size={15} /></button>
        <span className="cc-tool-sep" />
        {LAYERS.map(([key, name]) => <label key={key} className="cc-check"><input type="checkbox" checked={visible[key]} onChange={e => setLayer(key, e.target.checked)} /> {name}</label>)}
      </div>
          <div className="cc-spacer" />
          <h3>Live events</h3>
          <button type="button" className="small icon" aria-label={panels.bottom ? 'Collapse events' : 'Open events'} onClick={() => setPanels(p => ({ ...p, bottom: !p.bottom }))}>{panels.bottom ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>
        </div>
        {panels.bottom && <div className="cc-scroll"><Timeline log={log} ui={ui} filters={filters} setFilters={setFilters} technical={technical} setTechnical={setTechnical} /></div>}
      </div>

      {story && (
        <div className="cc-story" role="dialog" aria-label="Guided walkthrough">
          <span className="cc-story-step">Step {story.index + 1} of {STORY.length}</span>
          <h3>{storyStep.title}</h3>
          {storyBlocked ? <p>This run has no central supervisor. Run the demo scenario to see this step.</p>
            : storyReady ? <p>{storyStep.text}</p>
              : <p className="muted">Waiting for this to happen in the simulation…</p>}
          {storyStep.measure && (
            <Facts rows={[
              ['Junction', measuredJunction ?? '–'], ['Queue now', measured?.[0] != null ? `${measured[0]} vehicles` : 'No data'], ['Occupancy now', measured?.[1] != null ? `${Math.round(measured[1] * 100)}%` : 'No data'],
              ['Network', `${ui?.stopped ?? '–'} stopped of ${ui?.vehicles ?? '–'} vehicles`],
            ]} />
          )}
          {storyHit && storySeen && <p className="muted small">{clock(storyHit.t)} · from event #{storyHit.id} ({categoryOf(storyHit)})</p>}
          <div className="cc-story-actions">
            <button type="button" className="small" onClick={() => setStory(s => ({ ...s, paused: !s.paused }))}>{story.paused ? <Play size={14} /> : <Pause size={14} />} {story.paused ? 'Resume' : 'Pause'}</button>
            <button type="button" className="small" disabled={!storyReady && !storyBlocked} onClick={nextStep}><SkipForward size={14} /> {story.index === STORY.length - 1 ? 'Finish' : 'Next event'}</button>
            <button type="button" className="small" onClick={() => setStory(null)}><Square size={14} /> Exit</button>
          </div>
        </div>
      )}

      {status === 'idle' && !labError && !run && <div className="cc-message"><b>No simulation run yet</b><span className="muted">Run the demo scenario to start real SUMO traffic.</span><div className="cc-actions"><button type="button" className="small primary" disabled={demoBusy} onClick={startDemo}><Play size={14} /> Run demo scenario</button></div></div>}
      {labError && !network && status !== 'error' && status !== 'waiting' && !isDemo && <div className="cc-message" role="alert"><AlertTriangle size={22} /><b>Simulation service unavailable</b><span className="muted">{labError}</span><div className="cc-actions"><button type="button" className="small primary" onClick={retry}><RefreshCw size={14} /> Retry</button><button type="button" className="small" onClick={startBrowserDemo}><Play size={14} /> Open DEMO MODE</button></div></div>}
      {demoBusy && <div className="cc-message" role="status"><b>Starting SUMO…</b><span className="muted">Preparing roads, demand and signal agents.</span></div>}
      {status === 'loading' && !labError && !demoBusy && <div className="cc-message">Loading the city…</div>}
      {status === 'waiting' && !demoBusy && <div className="cc-message"><b>Waiting for the simulation</b><span className="muted">SUMO is preparing this run{progress ? ` (job status: ${progress})` : ''}.</span></div>}
      {status === 'error' && <div className="cc-message" role="alert"><AlertTriangle size={22} /><b>The simulation could not start</b><span className="muted">{error}</span><div className="cc-actions"><button type="button" className="small primary" onClick={run ? retry : startDemo}><RefreshCw size={14} /> Retry</button><button type="button" className="small" disabled={demoBusy} onClick={startDemo}><Play size={14} /> New demo run</button><button type="button" className="small" onClick={startBrowserDemo}><Play size={14} /> Open DEMO MODE</button></div></div>}
      {isDemo && showScene && <div className="cc-banner cc-demo-note" role="status"><b>DEMO MODE:</b> a traffic model running in this browser. This is not SUMO data. <button type="button" className="link" onClick={startDemo}>Try the real simulation</button></div>}
      {showScene && !isDemo && (connection === 'offline' || connection === 'stale') && <div className="cc-banner" role="alert">{connection === 'offline' ? 'Lab API unreachable. Showing the last received frame; retrying.' : 'No new data from the simulation. Showing the last received frame.'}</div>}
      {error && status !== 'error' && <div className="cc-banner" role="alert">{mode === '2d' && /WebGL|3D|render/i.test(error) ? `3D is unavailable here (${error}). Showing the top-down view.` : error}</div>}
    </section>
  );
}
