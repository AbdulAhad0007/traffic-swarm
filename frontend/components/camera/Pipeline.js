'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { num, when } from './feed';

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const HISTORY = 40;
const MAX_VEHICLES = 40;
const LIVE_MS = 1500;
const RATE_WINDOW_MS = 30000;
const LAMP = { RUNNING: 'green', CONNECTING: 'amber', DEGRADED: 'amber', DISCONNECTED: 'red', ERROR: 'red' };
const UNIT = {
  camera: 'frames/s', frigate: 'checks/s', go2rtc: 'frames/s', restream: 'frames/s', decode: 'frames/s', extract: 'frames/s', yolo: 'frames/s', tracking: 'frames/s',
  analytics: 'updates/s', agent: 'states/s', coordination: 'plans/s', safety: 'plans/s', signal: 'plans/s',
};
const ABOUT = {
  camera: 'The video source. It counts as working only when frames from it reach this service.',
  frigate: 'Manages cameras and recording. Traffic passes this junction without stopping when no camera is managed by Frigate.',
  go2rtc: 'Connects to the camera and offers its stream to readers, so the camera itself has only one connection.',
  restream: 'The RTSP address this service reads. It is separate from the camera address and carries no camera password.',
  decode: 'Turns the compressed stream into pictures. A frame counts here each time one is decoded.',
  extract: 'Picks frames for analysis at the camera\'s processing rate. When processing falls behind, older frames are dropped.',
  yolo: 'Finds cars, motorcycles, buses, trucks and bicycles in each picked frame.',
  tracking: 'Follows each vehicle across frames with ByteTrack, so one vehicle is counted once.',
  analytics: 'Turns tracks into queues, occupancy, arrivals and waiting times for each drawn lane.',
  agent: 'Each junction\'s agent receives traffic numbers, never video, and asks for a signal plan.',
  coordination: 'Neighbouring junctions share pressure. A congested region is reviewed by the central supervisor.',
  safety: 'Checks every plan against minimum green, maximum green, yellow and all-red rules. It can refuse any plan.',
  signal: 'Approved plans go to SUMO in simulation mode. In shadow mode they stay recommendations.',
};

// Animate a dot between two elements in a container. Used by the swarm panel, for a real message only.
export function firePacket(container, from, to, dataClass, duration = 650) {
  if (!container || !from || !to || reduceMotion()) return;
  const box = container.getBoundingClientRect();
  const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
  const dot = document.createElement('span');
  dot.className = `lcm-packet lcm-packet-${String(dataClass || 'none').toLowerCase()}`;
  container.appendChild(dot);
  const x = r => r.left + r.width / 2 - box.left, y = r => r.top + r.height / 2 - box.top;
  const run = dot.animate([
    { transform: `translate(${x(a)}px, ${y(a)}px) scale(.7)`, opacity: 0.2 },
    { transform: `translate(${(x(a) + x(b)) / 2}px, ${(y(a) + y(b)) / 2}px) scale(1)`, opacity: 1, offset: 0.5 },
    { transform: `translate(${x(b)}px, ${y(b)}px) scale(.7)`, opacity: 0.2 },
  ], { duration, easing: 'ease-in-out' });
  run.onfinish = run.oncancel = () => dot.remove();
}

const columnsFor = width => (width >= 1040 ? 5 : width >= 760 ? 4 : width >= 540 ? 3 : width >= 380 ? 2 : 1);

// Rows run in turn left to right and right to left, so the road can snake through the stages in order.
function placement(index, cols) {
  const row = Math.floor(index / cols), col = index % cols;
  return { gridRow: row + 1, gridColumn: (row % 2 === 0 ? col : cols - 1 - col) + 1 };
}

// Each edge is drawn from one junction to the next. Tails join into one path for a trip over several junctions.
function roadTail(a, b, ltr, width) {
  if (Math.abs(a.y - b.y) < 4) return `L ${b.x} ${b.y}`;
  if (Math.abs(a.x - b.x) < 4 && a.x < 40) return `L ${b.x} ${b.y}`;
  const dir = ltr ? 1 : -1, x = ltr ? width - 13 : 13, r = Math.min(16, Math.abs(b.y - a.y) / 2);
  return `L ${x - dir * r} ${a.y} Q ${x} ${a.y} ${x} ${a.y + r} L ${x} ${b.y - r} Q ${x} ${b.y} ${x - dir * r} ${b.y} L ${b.x} ${b.y}`;
}

function Spark({ values }) {
  const peak = Math.max(...values, 0.001);
  const points = values.map((v, i) => `${(i / Math.max(1, HISTORY - 1)) * 100},${22 - (v / peak) * 19}`).join(' ');
  return <svg className="lcm-stop-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">{values.length > 1 && <polyline points={points} />}</svg>;
}

function rateLabel(rate, unit) {
  if (rate >= 1) return [rate.toFixed(rate >= 10 ? 0 : 1), unit];
  if (rate > 0) return [(rate * 60).toFixed(0), unit.replace('/s', '/min')];
  return ['0', unit];
}

function Summary({ stages, cameras }) {
  const live = cameras.filter(c => c.status === 'CONNECTED');
  const running = stages.filter(s => s.status === 'RUNNING' || s.status === 'DEGRADED').length;
  if (!cameras.length) return <p className="lcm-road-summary">No camera is feeding the road yet, so nothing is moving.</p>;
  if (!live.length) return <p className="lcm-road-summary">No video is arriving. {cameras.length === 1 ? 'The camera is' : `All ${cameras.length} cameras are`} offline or stopped.</p>;
  const fps = live.reduce((t, c) => t + c.fps, 0), processed = live.reduce((t, c) => t + c.processing_fps, 0);
  const latencies = live.map(c => c.latency_ms).filter(v => v != null);
  const latency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  const slowest = stages.filter(s => s.latency_ms != null && s.status !== 'IDLE').sort((a, b) => b.latency_ms - a.latency_ms)[0];
  return (
    <p className="lcm-road-summary" aria-live="off">
      <b>{fps.toFixed(0)} frames</b> a second enter the road and <b>{processed.toFixed(1)}</b> reach the model.
      {latency != null && <> A frame takes <b>{num(latency)} ms</b>{slowest ? <>, most of it at {slowest.name}</> : null}.</>}
      {' '}<b>{running} of {stages.length}</b> stages are working.
    </p>
  );
}

export default function Pipeline({ stages, cameras = [], serverTime, subscribe }) {
  const road = useRef(null);
  const nodes = useRef({});
  const liveEdges = useRef({});
  const timers = useRef({});
  const inflight = useRef(0);
  const geoRef = useRef(null);
  const orderRef = useRef({});
  const samples = useRef({});
  const [cols, setCols] = useState(5);
  const [geo, setGeo] = useState(null);
  const [open, setOpen] = useState(null);
  const [rates, setRates] = useState({});
  const keys = (stages || []).map(s => s.key).join();

  useEffect(() => {
    if (!stages) return;
    // The server's clock: a late update must not read as a burst of traffic.
    const now = Date.parse(serverTime) || Date.now(), next = {};
    for (const s of stages) {
      const old = samples.current[s.key];
      if (old && now <= old.at) { next[s.key] = old.shown; continue; }
      const instant = old ? Math.max(0, s.count - old.count) / ((now - old.at) / 1000) : 0;
      const history = [...(old?.history || []), instant].slice(-HISTORY);
      // The number covers the last half minute, so a plan every few seconds does not flicker between 0 and a spike.
      const window = [...(old?.window || []), { at: now, count: s.count }].filter(p => now - p.at <= RATE_WINDOW_MS);
      const span = (now - window[0].at) / 1000;
      const shown = { rate: span > 0 ? Math.max(0, s.count - window[0].count) / span : 0, history };
      samples.current[s.key] = { count: s.count, at: now, history, window, shown };
      next[s.key] = shown;
    }
    setRates(next);
  }, [stages, serverTime]);

  // Geometry is measured when the layout changes, never per event, so moving vehicles costs no layout work.
  useLayoutEffect(() => {
    const el = road.current;
    if (!el) return undefined;
    const measure = () => {
      const width = el.clientWidth;
      const wanted = columnsFor(width);
      setCols(wanted);
      const box = el.getBoundingClientRect();
      const list = keys.split(',').filter(Boolean);
      const single = wanted === 1;
      const points = list.map(k => {
        const r = nodes.current[k]?.getBoundingClientRect();
        if (!r) return null;
        return single ? { x: 20, y: Math.round(r.top + r.height / 2 - box.top) } : { x: Math.round(r.left + r.width / 2 - box.left), y: Math.round(r.top - box.top - 22) };
      });
      if (points.some(p => !p)) return;
      const tails = points.slice(1).map((b, i) => roadTail(points[i], b, Math.floor(i / wanted) % 2 === 0, width));
      const next = { width, height: el.clientHeight, points, tails, list };
      orderRef.current = Object.fromEntries(list.map((k, i) => [k, i]));
      if (JSON.stringify(next) !== JSON.stringify(geoRef.current)) { geoRef.current = next; setGeo(next); }
    };
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [keys, cols]);

  useEffect(() => subscribe(({ events }) => {
    if (!events || document.hidden) return;
    const g = geoRef.current;
    if (!g) return;
    for (const e of events) {
      if (!e.stage || !e.to_stage) continue;
      const from = orderRef.current[e.stage], to = orderRef.current[e.to_stage];
      if (from === undefined || to === undefined || to <= from) continue;
      for (let i = from; i < to; i++) {
        const edge = liveEdges.current[i];
        edge?.classList.add('is-live');
        clearTimeout(timers.current[i]);
        timers.current[i] = setTimeout(() => edge?.classList.remove('is-live'), LIVE_MS);
      }
      if (reduceMotion() || inflight.current >= MAX_VEHICLES || !road.current) continue;
      const start = g.points[from];
      const vehicle = document.createElement('span');
      vehicle.className = `lcm-vehicle lcm-vehicle-${String(e.data_class || 'none').toLowerCase()}`;
      vehicle.style.offsetPath = `path('M ${start.x} ${start.y} ${g.tails.slice(from, to).join(' ')}')`;
      road.current.appendChild(vehicle);
      inflight.current += 1;
      const run = vehicle.animate([{ offsetDistance: '0%', opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.9 }, { offsetDistance: '100%', opacity: 0 }], { duration: 700 * (to - from), easing: 'linear' });
      run.onfinish = run.oncancel = () => { vehicle.remove(); inflight.current -= 1; };
    }
  }), [subscribe]);

  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);

  const list = stages || [];
  const selected = list.find(s => s.key === open);
  const whole = geo ? `M ${geo.points[0].x} ${geo.points[0].y} ${geo.tails.join(' ')}` : '';
  return (
    <section className="panel lcm-section lcm-road-section">
      <header className="lcm-section-head">
        <div><h2>Processing pipeline</h2><p className="muted">Each vehicle on this road is a real event from the backend. If nothing is happening, nothing moves.</p></div>
        <ul className="lcm-legend" aria-label="Vehicle colours">
          <li><i className="lcm-packet-live" /> Live camera</li>
          <li><i className="lcm-packet-test" /> Test source</li>
          <li><i className="lcm-packet-replay" /> Replay</li>
        </ul>
      </header>
      <Summary stages={list} cameras={cameras} />
      <div ref={road} className={`lcm-road ${cols === 1 ? 'is-single' : ''}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {geo && (
          <svg className="lcm-road-svg" width={geo.width} height={geo.height} aria-hidden="true">
            <path className="lcm-road-casing" d={whole} />
            <path className="lcm-road-centre" d={whole} />
            {geo.tails.map((tail, i) => {
              const start = geo.points[i];
              const d = `M ${start.x} ${start.y} ${tail}`;
              const target = list[i + 1];
              return (
                <g key={i}>
                  {(target?.status === 'DISCONNECTED' || target?.status === 'ERROR') && <path className="lcm-road-broken" d={d} />}
                  <path ref={el => { liveEdges.current[i] = el; }} className="lcm-road-live" d={d} />
                </g>
              );
            })}
            {geo.points.map((p, i) => <circle key={i} className={`lcm-junction lcm-junction-${(list[i]?.status || 'idle').toLowerCase()}`} cx={p.x} cy={p.y} r="8" />)}
          </svg>
        )}
        {list.map((s, i) => {
          const lamp = LAMP[s.status];
          const info = rates[s.key];
          const [value, unit] = rateLabel(info?.rate || 0, UNIT[s.key] || 'items/s');
          const problem = s.errors > 0 ? `${s.errors.toLocaleString()} errors` : null;
          return (
            <button type="button" key={s.key} ref={el => { nodes.current[s.key] = el; }} style={placement(i, cols)} className={`lcm-stop ${open === s.key ? 'is-open' : ''}`} aria-expanded={open === s.key} onClick={() => setOpen(open === s.key ? null : s.key)}>
              <span className="lcm-signal" role="img" aria-label={`Status ${s.status.toLowerCase()}`}>
                <i className={lamp === 'red' ? 'on-red' : ''} /><i className={lamp === 'amber' ? 'on-amber' : ''} /><i className={lamp === 'green' ? 'on-green' : ''} />
              </span>
              <span className="lcm-stop-name">{i + 1}. {s.name}<small>{s.status.charAt(0) + s.status.slice(1).toLowerCase()}</small></span>
              <span className="lcm-stop-rate">{value}<small>{unit}</small></span>
              <Spark values={info?.history || []} />
              <span className={`lcm-stop-meta ${problem ? 'is-bad' : ''}`}>{problem || s.note || (s.latency_ms != null ? `${num(s.latency_ms, 1)} ms each` : `Last active ${when(s.last_activity)}`)}</span>
            </button>
          );
        })}
      </div>
      {selected && (
        <div className="lcm-node-detail">
          <div className="lcm-row-between"><b>{selected.name}</b><button type="button" className="small icon" aria-label="Close" onClick={() => setOpen(null)}><X size={14} /></button></div>
          <p>{ABOUT[selected.key]}</p>
          <dl className="lcm-facts">
            <div><dt>Status</dt><dd>{selected.status}</dd></div>
            <div><dt>Processed</dt><dd>{selected.count.toLocaleString()}</dd></div>
            <div><dt>Errors</dt><dd>{selected.errors}</dd></div>
            <div><dt>Latency</dt><dd>{selected.latency_ms != null ? `${num(selected.latency_ms, 1)} ms` : 'Not measured'}</dd></div>
            <div><dt>Last activity</dt><dd>{when(selected.last_activity)}</dd></div>
            <div><dt>Note</dt><dd>{selected.note || '—'}</dd></div>
          </dl>
          {selected.last_error && <p className="error">{selected.last_error}</p>}
          <ul className="lcm-loglines">
            {selected.logs.length === 0 && <li className="muted">No log entries yet.</li>}
            {selected.logs.slice().reverse().map((l, i) => <li key={i} className={l.level === 'error' ? 'is-error' : ''}><time>{when(l.ts)}</time> {l.message}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
