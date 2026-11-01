'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Crosshair, Gauge, Layers as LayersIcon, Maximize, Minimize, Minus, Pause, Play, Plus, RotateCcw, SkipBack, Video, VideoOff, X,
} from 'lucide-react';
import { lab } from '@/lib/api';
import { useThemeTokens } from '@/lib/themeClient';
import { useSections } from '@/components/SiteConfigProvider';
import { FrameBuffer, signalColor } from './frameBuffer';
import { SCENE_TOKENS, hasSceneTokens } from './sceneTheme';
import { createSimFeed } from './simFeed';
import { createTwinScene } from './twinScene';
import 'cesium/Build/Cesium/Widgets/CesiumWidget/CesiumWidget.css';
import '@/app/styles/view3d.css';

const SPEEDS = [0.5, 1, 2, 4];
const LIVE_DELAY_S = 3;      // Playing slightly behind the newest frame leaves a real sample to interpolate towards.
const UI_REFRESH_MS = 250;
const TERMINAL = ['completed', 'failed', 'cancelled'];
const LAYERS = [
  ['roads', 'Road network', null],
  ['vehicles', 'Vehicles', 'layer-vehicles'],
  ['signals', 'Traffic signals', 'layer-signals'],
  ['density', 'Traffic density', 'layer-density'],
  ['heatmap', 'Congestion heatmap', 'layer-heatmap'],
  ['labels', 'Intersection IDs', 'layer-labels'],
];
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = angle => COMPASS[Math.round(angle / 45) % 8];
const clock = seconds => {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const CONNECTION = { connecting: 'Connecting', live: 'Live simulation', recording: 'Recorded run', offline: 'Lab API unreachable' };

function RunPanel({ jobs, jobId, controller, onSelect, labError, options, on }) {
  const [form, setForm] = useState({ network: '', scenario: 'normal' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const job = jobs.find(j => j.id === jobId);
  const presets = (options?.presets || []).filter(p => p.runnable_from_ui);
  const network = form.network || presets[0]?.name || '';

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await lab('/api/lab/jobs', {
        method: 'POST',
        body: JSON.stringify({ kind: 'experiment', network, scenario: form.scenario, seed: 42, controllers: ['swarm'], max_time: 900, realtime_factor: 1 }),
      });
      onSelect(created.id, 'swarm');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!on('run-selector')) return null;
  return (
    <div className="view3d-card">
      <h3>Simulation run</h3>
      {labError && <p className="view3d-note danger">{labError}</p>}
      <label>
        Run
        <select value={jobId || ''} onChange={e => { const j = jobs.find(x => x.id === e.target.value); if (j) onSelect(j.id, j.spec.controllers[0]); }}>
          <option value="" disabled>{jobs.length ? 'Choose a run' : 'No runs yet'}</option>
          {jobs.map(j => <option key={j.id} value={j.id}>{j.spec.network} · {j.spec.scenario} · {j.status}</option>)}
        </select>
      </label>
      {job && job.spec.controllers.length > 1 && (
        <label>
          Controller
          <select value={controller || ''} onChange={e => onSelect(job.id, e.target.value)}>
            {job.spec.controllers.map(c => <option key={c}>{c}</option>)}
          </select>
        </label>
      )}
      {options && (
        <details>
          <summary>Start a new simulation</summary>
          <label>
            Network
            <select value={network} onChange={e => setForm(f => ({ ...f, network: e.target.value }))}>
              {presets.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </label>
          <label>
            Scenario
            <select value={form.scenario} onChange={e => setForm(f => ({ ...f, scenario: e.target.value }))}>
              {options.scenarios.map(s => <option key={s}>{s}</option>)}
            </select>
          </label>
          <button type="button" className="small" disabled={busy || !network} onClick={start}><Play size={14} /> {busy ? 'Starting…' : 'Start swarm run (15 min)'}</button>
          {error && <p className="view3d-note danger">{error}</p>}
        </details>
      )}
    </div>
  );
}

function VehicleCard({ info, following, onFollow, onClose, gone }) {
  return (
    <div className="view3d-card">
      <div className="view3d-card-head"><h3>Vehicle</h3><button type="button" className="small icon" aria-label="Close" onClick={onClose}><X size={14} /></button></div>
      {gone ? <p className="muted small">This vehicle has left the simulation.</p> : (
        <dl className="view3d-facts">
          <div><dt>ID</dt><dd>{info?.id ?? '–'}</dd></div>
          <div><dt>Type</dt><dd>{info?.type ?? '–'}</dd></div>
          <div><dt>Speed</dt><dd>{info ? `${(info.speed * 3.6).toFixed(1)} km/h` : '–'}</dd></div>
          <div><dt>Direction</dt><dd>{info ? `${compass(info.angle)} (${Math.round(info.angle)}°)` : '–'}</dd></div>
          <div><dt>Waiting</dt><dd>{info ? `${info.waiting} s` : '–'}</dd></div>
        </dl>
      )}
      {!gone && <button type="button" className="small" onClick={onFollow}>{following ? <VideoOff size={14} /> : <Video size={14} />} {following ? 'Stop following' : 'Follow vehicle'}</button>}
    </div>
  );
}

function JunctionCard({ id, signal, measure, measuredAt, frameSignal, calls, onFocus, onClose }) {
  const lamps = (signal?.lamps || []).map(l => signalColor(frameSignal?.[1], l.links));
  const count = name => lamps.filter(c => c === name).length;
  const involved = calls?.calls?.filter(c => JSON.stringify(c).includes(`"${id}"`)).length;
  return (
    <div className="view3d-card">
      <div className="view3d-card-head"><h3>Intersection</h3><button type="button" className="small icon" aria-label="Close" onClick={onClose}><X size={14} /></button></div>
      <dl className="view3d-facts">
        <div><dt>ID</dt><dd>{id}</dd></div>
        {signal?.streets?.length > 0 && <div><dt>Streets</dt><dd>{signal.streets.join(', ')}</dd></div>}
        <div><dt>Signal phase</dt><dd>{frameSignal ? frameSignal[0] : '–'}</dd></div>
        <div><dt>Approach lanes</dt><dd>{lamps.length ? `${count('green')} green · ${count('amber')} amber · ${count('red')} red` : '–'}</dd></div>
        <div><dt>Queue</dt><dd>{measure?.[0] ?? 'No data'}{measure?.[0] != null ? ' veh' : ''}</dd></div>
        <div><dt>Occupancy</dt><dd>{measure?.[1] != null ? `${Math.round(measure[1] * 100)}%` : 'No data'}</dd></div>
        <div><dt>Congestion</dt><dd>{measure?.[2]?.replace('_', ' ') ?? 'No data'}</dd></div>
        <div><dt>Measured at</dt><dd>{measuredAt != null ? clock(measuredAt) : '–'}</dd></div>
        <div><dt>Green-wave calls</dt><dd>{involved === undefined ? 'Not recorded for this run' : involved}</dd></div>
      </dl>
      <button type="button" className="small" onClick={onFocus}><Crosshair size={14} /> Focus camera</button>
    </div>
  );
}

export default function View3D() {
  const { on } = useSections('view-3d');
  const rootRef = useRef(null);
  const containerRef = useRef(null);
  const sceneRef = useRef(null);
  const feedRef = useRef(null);
  const bufferRef = useRef(new FrameBuffer());
  const tokensRef = useRef(null);
  const clockRef = useRef({ t: null, speed: 1, playing: true, manifest: null, started: false, position: null });
  const layersRef = useRef(Object.fromEntries(LAYERS.map(([k]) => [k, true])));

  const [jobs, setJobs] = useState([]);
  const [options, setOptions] = useState(null);
  const [labError, setLabError] = useState(null);
  const [run, setRun] = useState({ jobId: null, controller: null });
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [geo, setGeo] = useState(null);
  const [connection, setConnection] = useState('connecting');
  const [ui, setUi] = useState(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [layers, setLayers] = useState(layersRef.current);
  const [selection, setSelection] = useState(null);
  const [following, setFollowing] = useState(false);
  const [quality, setQuality] = useState('auto');
  const [showPerf, setShowPerf] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [calls, setCalls] = useState(null);
  const tokens = useThemeTokens(SCENE_TOKENS);

  // Run list. Choose a running job first, otherwise the newest finished one.
  useEffect(() => {
    let active = true;
    const load = () => {
      if (document.hidden) return;
      lab('/api/lab/jobs?limit=20')
        .then(list => {
          if (!active) return;
          setJobs(list);
          setLabError(null);
          setRun(current => {
            if (current.jobId) return current;
            const pick = list.find(j => !TERMINAL.includes(j.status)) || list.find(j => j.status === 'completed');
            return pick ? { jobId: pick.id, controller: pick.spec.controllers[0] } : current;
          });
        })
        .catch(err => { if (active) setLabError(`Could not reach the simulation service: ${err.message}`); });
    };
    load();
    const t = setInterval(load, 10000);
    lab('/api/lab/options').then(o => { if (active) setOptions(o); }).catch(() => { });
    return () => { active = false; clearInterval(t); };
  }, []);

  // One scene per run. Effects also clean up when Next hides this route, so leaving always frees the GPU.
  useEffect(() => {
    if (!run.jobId) return undefined;
    let cancelled = false, raf = 0, refresh = 0;
    const buffer = bufferRef.current;
    const clockState = clockRef.current;
    buffer.clear();
    Object.assign(clockState, { t: null, manifest: null, started: false });
    setStatus('loading');
    setError(null);
    setSelection(null);
    setFollowing(false);
    setConnection('connecting');
    setUi(null);
    window.CESIUM_BASE_URL = '/cesium/';
    const q = `controller=${encodeURIComponent(run.controller)}`;

    // A job still preparing has no geometry yet, and the Lab API may be restarting: keep trying until the run has ended.
    const loadNetwork = async () => {
      while (!cancelled) {
        try {
          return await lab(`/api/lab/jobs/${run.jobId}/network3d?${q}`);
        } catch (err) {
          const job = await lab(`/api/lab/jobs/${run.jobId}`).catch(() => null);
          if (job && TERMINAL.includes(job.status)) throw err;
          if (!cancelled) setStatus('waiting');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      return null;
    };

    Promise.all([import('cesium'), loadNetwork()])
      .then(([Cesium, network]) => {
        if (cancelled) return;
        setGeo(network.geo ? 'real' : 'synthetic');
        const scene = createTwinScene(Cesium, containerRef.current, network, {
          onPick: picked => { setSelection(picked); setFollowing(false); clockRef.current.dirty = true; },
          onRenderError: err => { setError(err?.message || 'The 3D renderer stopped.'); setStatus('error'); },
        });
        sceneRef.current = scene;
        if (tokensRef.current) scene.applyTheme(tokensRef.current);
        Object.entries(layersRef.current).forEach(([k, v]) => scene.setLayer(k, v));
        scene.setAllowed(allowedLayers());
        setStatus('ready');

        feedRef.current = createSimFeed({
          jobId: run.jobId,
          controller: run.controller,
          buffer,
          getPlayhead: () => clockState.t,
          onManifest: m => { clockState.manifest = m; },
          onConnection: value => setConnection(value),
        });

        let last = performance.now(), lastDrawn = null;
        const tick = now => {
          raf = requestAnimationFrame(tick);
          const dt = Math.min((now - last) / 1000, 0.25);
          last = now;
          if (buffer.newest === null) return;
          const m = clockState.manifest;
          if (!clockState.started) {
            clockState.started = true;
            clockState.t = m?.status === 'running' ? Math.max(buffer.oldest, buffer.newest - LIVE_DELAY_S) : buffer.oldest;
          }
          if (clockState.playing) {
            const limit = m?.status === 'running' ? buffer.newest - LIVE_DELAY_S : buffer.newest;
            clockState.t = Math.min(Math.max(clockState.t + dt * clockState.speed, clockState.t), Math.max(limit, clockState.t));
          }
          if (clockState.t !== lastDrawn || clockState.dirty) {
            lastDrawn = clockState.t;
            clockState.dirty = false;
            scene.update(buffer, clockState.t);
            buffer.trimBefore(clockState.t);
          }
        };
        raf = requestAnimationFrame(tick);

        refresh = setInterval(() => {
          if (document.hidden || !sceneRef.current) return;
          const pair = buffer.bracket(clockState.t ?? 0);
          setUi({
            t: clockState.t,
            behind: clockState.manifest && clockState.t !== null ? Math.max(0, clockState.manifest.last_t - clockState.t) : 0,
            first: clockState.manifest?.first_t,
            last: clockState.manifest?.last_t,
            status: clockState.manifest?.status,
            stats: scene.stats(),
            vehicle: scene.vehicleInfo(),
            vehicleGone: scene.vehicleGone(),
            junctions: buffer.junctions,
            measuredAt: buffer.junctionTime,
            tl: pair ? pair[0].tl : null,
          });
        }, UI_REFRESH_MS);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err?.message || 'This browser could not start 3D rendering.');
        setStatus('error');
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearInterval(refresh);
      feedRef.current?.destroy();
      feedRef.current = null;
      sceneRef.current?.destroy();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.jobId, run.controller]);

  const allowedLayers = useCallback(() => Object.fromEntries(LAYERS.map(([k, , section]) => [k, section ? on(section) : true])), [on]);

  useEffect(() => { sceneRef.current?.setAllowed(allowedLayers()); }, [allowedLayers]);

  useEffect(() => {
    if (!hasSceneTokens(tokens)) return;
    tokensRef.current = tokens;
    sceneRef.current?.applyTheme(tokens);
  }, [tokens]);

  useEffect(() => {
    const change = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);

  useEffect(() => {
    if (selection?.kind !== 'junction' || !run.jobId || !on('intersection-inspector')) return undefined;
    let active = true;
    lab(`/api/lab/jobs/${run.jobId}/calls?limit=1000`).then(c => { if (active) setCalls(c.summary || c.calls?.length ? c : null); }).catch(() => { if (active) setCalls(null); });
    return () => { active = false; };
  }, [selection, run.jobId, on]);

  const togglePlaying = () => {
    const next = !playing;
    clockRef.current.playing = next;
    setPlaying(next);
  };
  const changeSpeed = value => { clockRef.current.speed = value; setSpeed(value); };
  const restart = () => {
    const c = clockRef.current;
    const first = c.manifest?.first_t;
    if (first === undefined || first === null) return;
    c.t = first;
    c.dirty = true;
    feedRef.current?.seek(first);
  };
  const jumpToLatest = () => {
    const c = clockRef.current;
    const last = c.manifest?.last_t;
    if (last === undefined || last === null) return;
    c.t = Math.max(0, last - LIVE_DELAY_S);
    c.dirty = true;
    feedRef.current?.seek(c.t);
  };
  const setLayer = (name, value) => {
    layersRef.current = { ...layersRef.current, [name]: value };
    setLayers(layersRef.current);
    sceneRef.current?.setLayer(name, value);
  };
  const close = () => { sceneRef.current?.select(null, null); setSelection(null); setFollowing(false); };
  const toggleFollow = () => {
    const next = !following;
    sceneRef.current?.setFollow(next);
    setFollowing(next);
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else rootRef.current?.requestFullscreen?.();
  };
  const changeQuality = value => { setQuality(value); sceneRef.current?.setQuality(value); };

  const noRecording = status === 'error' && /no vehicle data/i.test(error || '');
  const showScene = status === 'ready';
  const selectable = selection?.kind === 'vehicle' ? on('vehicle-inspector') : on('intersection-inspector');
  const stats = ui?.stats;

  return (
    <section ref={rootRef} className={`view3d ${fullscreen ? 'is-fullscreen' : ''}`} data-status={status} data-connection={connection} data-theme-tokens={tokens['--scene-ground'] || ''}>
      <div ref={containerRef} className="view3d-canvas" />

      <div className="view3d-top">
        <div className="view3d-time">
          <b>{ui?.t != null ? clock(ui.t) : '--:--:--'}</b>
          <span className="muted small">Simulation time</span>
          <span className={`view3d-dot c-${connection}`}>{CONNECTION[connection]}</span>
          {geo === 'synthetic' && showScene && <span className="view3d-note">Synthetic network: no real-world location</span>}
        </div>
        <div className="view3d-tools">
          <button type="button" className="small icon" aria-label="Zoom in" title="Zoom in" onClick={() => sceneRef.current?.zoom(1)}><Plus size={15} /></button>
          <button type="button" className="small icon" aria-label="Zoom out" title="Zoom out" onClick={() => sceneRef.current?.zoom(-1)}><Minus size={15} /></button>
          <button type="button" className="small icon" aria-label="Reset camera" title="Reset camera" onClick={() => sceneRef.current?.resetCamera()}><RotateCcw size={15} /></button>
          <button type="button" className="small icon" aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} title="Fullscreen" onClick={toggleFullscreen}>{fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}</button>
          {on('performance-hud') && <button type="button" className="small icon" aria-label="Performance" aria-pressed={showPerf} title="Performance" onClick={() => setShowPerf(v => !v)}><Gauge size={15} /></button>}
        </div>
      </div>

      <aside className="view3d-side">
        <RunPanel jobs={jobs} jobId={run.jobId} controller={run.controller} options={options} labError={labError} on={on}
          onSelect={(jobId, controller) => setRun({ jobId, controller })} />
        <details className="view3d-card" open>
          <summary><LayersIcon size={14} /> Layers</summary>
          {LAYERS.filter(([, , section]) => !section || on(section)).map(([key, label]) => (
            <label key={key} className="view3d-check"><input type="checkbox" checked={layers[key]} onChange={e => setLayer(key, e.target.checked)} /> {label}</label>
          ))}
          <p className="view3d-legend">
            <i className="heat-low" /> Low <i className="heat-mid" /> Medium <i className="heat-high" /> High
          </p>
        </details>
        {showPerf && on('performance-hud') && (
          <div className="view3d-card">
            <h3>Performance</h3>
            <dl className="view3d-facts" data-perf>
              <div><dt>FPS</dt><dd>{stats ? stats.fps : '–'}</dd></div>
              <div><dt>Vehicles drawn</dt><dd>{stats ? `${stats.drawn} of ${stats.total}` : '–'}</dd></div>
              <div><dt>Active intersections</dt><dd>{stats ? stats.intersections : '–'}</dd></div>
              <div><dt>Quality</dt><dd>{stats ? `${stats.label}${stats.auto ? ' (auto)' : ''}` : '–'}</dd></div>
              <div><dt>Connection</dt><dd>{CONNECTION[connection]}</dd></div>
            </dl>
            <label>
              Rendering quality
              <select value={quality} onChange={e => changeQuality(e.target.value)}>
                <option value="auto">Automatic</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
          </div>
        )}
        {selection && selectable && selection.kind === 'vehicle' && (
          <VehicleCard info={ui?.vehicle?.id === selection.id ? ui.vehicle : null} gone={!!ui?.vehicleGone}
            following={following} onFollow={toggleFollow} onClose={close} />
        )}
        {selection && selectable && selection.kind === 'junction' && (
          <JunctionCard id={selection.id} signal={sceneRef.current?.junctionInfo(selection.id)} measure={ui?.junctions?.get(selection.id)} measuredAt={ui?.measuredAt}
            frameSignal={ui?.tl?.[selection.id]} calls={calls} onClose={close} onFocus={() => sceneRef.current?.focusJunction(selection.id)} />
        )}
      </aside>

      {on('playback-controls') && showScene && (
        <div className="view3d-playback">
          <button type="button" className="small" onClick={togglePlaying}>{playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play'}</button>
          <button type="button" className="small" onClick={restart} title="Go back to the start of the recording"><SkipBack size={14} /> Reset</button>
          <label className="view3d-speed">Speed
            <select value={speed} onChange={e => changeSpeed(Number(e.target.value))}>
              {SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}
            </select>
          </label>
          {ui?.status === 'running' && ui.behind > LIVE_DELAY_S + 2 && <button type="button" className="small" onClick={jumpToLatest}>Jump to latest</button>}
          <span className="muted small">Controls this view only. SUMO keeps running.</span>
        </div>
      )}

      {status === 'idle' && !labError && <div className="view3d-message"><b>No simulation run yet</b><span className="muted">Start one from the panel, or from Live Lab.</span></div>}
      {status === 'idle' && labError && (
        <div className="view3d-message" role="alert"><AlertTriangle size={22} color="var(--status-danger)" /><b>Simulation service unavailable</b><span className="muted">3D View only shows real SUMO data, so there is nothing to display until it is reachable.</span></div>
      )}
      {status === 'loading' && <div className="view3d-message">Loading 3D scene…</div>}
      {status === 'waiting' && <div className="view3d-message"><b>Waiting for the simulation</b><span className="muted">SUMO is preparing this run. The scene opens when its first data arrives.</span></div>}
      {status === 'error' && (
        <div className="view3d-message" role="alert">
          <AlertTriangle size={22} color="var(--status-danger)" />
          <b>{noRecording ? 'No vehicle data for this run' : '3D View could not start'}</b>
          <span className="muted">{noRecording ? 'This run was recorded before 3D View existed, or has not started yet. Choose another run or start a new one.' : error}</span>
        </div>
      )}
      {showScene && connection !== 'offline' && ui?.t == null && <div className="view3d-message">Waiting for the first simulation frame…</div>}
      {showScene && connection === 'offline' && <div className="view3d-banner" role="alert">Lab API unreachable. Showing the last received frame; retrying.</div>}
    </section>
  );
}
