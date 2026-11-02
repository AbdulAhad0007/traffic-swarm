'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CheckCircle2, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { cameraApi, DataClass, StatusPill, VEHICLES, VEHICLE_TOKEN, num, usePolled, when } from './feed';
import { firePacket } from './Pipeline';

const chartTip = { background: 'var(--bg-elevated)', border: '1px solid var(--line-strong)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 12 };
const tick = { fill: 'var(--text-muted)', fontSize: 11 };
const LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'SEVERE'];

export function Toggle({ label, checked, onChange }) {
  return <label className="lcm-toggle"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /> {label}</label>;
}

// ---------------------------------------------------------------- detection
export function DetectionPanel({ cameras, selected, subscribe, layers, setLayers }) {
  const [latest, setLatest] = useState({});
  useEffect(() => subscribe(m => { if (m.detections) setLatest(old => ({ ...old, ...m.detections })); }), [subscribe]);
  const camera = cameras.find(c => c.id === selected) || cameras.find(c => c.status === 'CONNECTED') || cameras[0];
  const d = camera?.status === 'CONNECTED' ? latest[camera.id] : null;
  const objects = d?.objects || [];
  const counts = Object.fromEntries(VEHICLES.map(v => [v, objects.filter(o => o.cls === v).length]));
  const mean = objects.length ? objects.reduce((a, o) => a + o.conf, 0) / objects.length : null;
  const peak = Math.max(1, ...Object.values(counts));
  return (
    <section className="panel lcm-section">
      <header className="lcm-section-head">
        <div><h2>AI detection</h2><p className="muted">{camera ? `${camera.camera_name}, ${camera.detection_status.toLowerCase()}` : 'No camera'}. Boxes appear only for frames the model processed.</p></div>
        <div className="lcm-toggles">
          <Toggle label="Boxes" checked={layers.boxes} onChange={v => setLayers(l => ({ ...l, boxes: v }))} />
          <Toggle label="Labels" checked={layers.labels} onChange={v => setLayers(l => ({ ...l, labels: v }))} />
          <Toggle label="Tracking IDs" checked={layers.ids} onChange={v => setLayers(l => ({ ...l, ids: v }))} />
          <Toggle label="Trails" checked={layers.trails} onChange={v => setLayers(l => ({ ...l, trails: v }))} />
        </div>
      </header>
      <dl className="lcm-facts lcm-facts-wide">
        <div><dt>In this frame</dt><dd>{d ? objects.length : '—'}</dd></div>
        <div><dt>Unique tracked</dt><dd>{camera?.unique_tracks ?? '—'}</dd></div>
        <div><dt>Mean confidence</dt><dd>{mean != null ? `${Math.round(mean * 100)}%` : '—'}</dd></div>
        <div><dt>Inference FPS</dt><dd>{num(camera?.processing_fps, 1)}</dd></div>
        <div><dt>YOLO latency</dt><dd>{camera?.inference_ms != null ? `${num(camera.inference_ms)} ms` : '—'}</dd></div>
      </dl>
      <div className="lcm-two">
        <div>
          <h3>Vehicle classes</h3>
          {VEHICLES.map(v => (
            <div className="lcm-bar" key={v} title={`${v}: ${counts[v]}`}>
              <span>{v}</span>
              <div><i style={{ width: `${(counts[v] / peak) * 100}%`, background: `var(${VEHICLE_TOKEN[v]})` }} /></div>
              <b>{d ? counts[v] : '—'}</b>
            </div>
          ))}
        </div>
        <div>
          <h3>Tracks in this frame</h3>
          <div className="lcm-scroll">
            <table className="lcm-table">
              <thead><tr><th>ID</th><th>Class</th><th>Confidence</th></tr></thead>
              <tbody>
                {objects.length === 0 && <tr><td colSpan={3} className="muted">{d ? 'No vehicles in this frame.' : 'No detections: the camera or model is not running.'}</td></tr>}
                {objects.map((o, i) => <tr key={o.track_id ?? `u${i}`}><td>{o.track_id != null ? `#${o.track_id}` : 'new'}</td><td>{o.cls}</td><td>{Math.round(o.conf * 100)}%</td></tr>)}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- traffic
export function TrafficPanel({ camera }) {
  const { data } = usePolled(camera ? `cameras/${camera.id}/analytics` : null, 2000);
  const current = data?.current;
  const history = useMemo(() => (data?.history || []).map(h => ({ ...h, label: when(h.t) })), [data]);
  const approaches = current ? Object.entries(current.approaches) : [];
  const axes = ['NS', 'EW'].map(axis => ({ axis, ...approaches.filter(([, a]) => a.axis === axis).reduce((t, [, a]) => ({ vehicles: t.vehicles + a.vehicles, queue: t.queue + a.queue_vehicles }), { vehicles: 0, queue: 0 }) }));
  const peak = Math.max(1, ...axes.map(a => a.vehicles));
  const recent = history.slice(-60);
  const names = approaches.map(([n]) => n);
  return (
    <section className="panel lcm-section">
      <header className="lcm-section-head">
        <div>
          <h2>Traffic intelligence</h2>
          <p className="muted">{camera ? `${camera.camera_name}. ` : ''}{!current ? 'Waiting for tracked vehicles.' : current.calibrated ? 'Metres and speeds are estimates from one calibration distance.' : 'Not calibrated: queues are in vehicles, and speeds in metres per second are not available.'}</p>
        </div>
        {current?.congestion_level && <span className={`lcm-level lcm-level-${current.congestion_level.toLowerCase()}`}>{current.congestion_level} congestion</span>}
      </header>
      {current && !current.zones_configured && <p className="lcm-note">No lanes are drawn for this camera, so queues, occupancy and signal proposals are unavailable. An administrator can draw them in the camera inspector.</p>}
      <dl className="lcm-facts lcm-facts-wide">
        <div><dt>Vehicles</dt><dd>{current?.vehicle_count ?? '—'}</dd></div>
        <div><dt>Moving / stopped</dt><dd>{current ? `${current.moving} / ${current.stopped}` : '—'}</dd></div>
        <div><dt>Queue</dt><dd>{current?.queue_vehicles != null ? `${current.queue_vehicles} veh${current.queue_length_m != null ? `, ~${current.queue_length_m} m` : ''}` : '—'}</dd></div>
        <div><dt>Mean speed</dt><dd>{current?.average_speed_mps != null ? `~${current.average_speed_mps} m/s` : current?.relative_speed_px_s != null ? `${current.relative_speed_px_s} px/s` : '—'}</dd></div>
        <div><dt>Occupancy</dt><dd>{current?.lane_occupancy != null ? `${Math.round(current.lane_occupancy * 100)}%` : '—'}</dd></div>
        <div><dt>Downstream capacity</dt><dd>{current?.downstream_capacity != null ? `${Math.round(current.downstream_capacity * 100)}%` : 'Not measured'}</dd></div>
      </dl>
      <div className="lcm-two">
        <figure className="lcm-chart">
          <figcaption>Vehicle count and queue</figcaption>
          <ResponsiveContainer width="100%" height={190}>
            <LineChart data={history}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="label" tick={tick} minTickGap={50} stroke="var(--line-strong)" />
              <YAxis tick={tick} allowDecimals={false} width={30} stroke="var(--line-strong)" />
              <Tooltip contentStyle={chartTip} />
              <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }} />
              <Line type="monotone" dataKey="vehicles" name="Vehicles" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="queue" name="Queue" stroke="var(--road-heavy)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </figure>
        <figure className="lcm-chart">
          <figcaption>Moving and stopped vehicles</figcaption>
          <ResponsiveContainer width="100%" height={190}>
            <LineChart data={history}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="label" tick={tick} minTickGap={50} stroke="var(--line-strong)" />
              <YAxis tick={tick} allowDecimals={false} width={30} stroke="var(--line-strong)" />
              <Tooltip contentStyle={chartTip} />
              <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }} />
              <Line type="monotone" dataKey="moving" name="Moving" stroke="var(--msg-signal)" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="stopped" name="Stopped" stroke="var(--msg-proposal)" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </figure>
      </div>
      <div className="lcm-two">
        <div>
          <h3>Lane occupancy, last {recent.length} updates</h3>
          {names.length === 0 && <p className="muted">Draw lanes to see this.</p>}
          {names.map(n => (
            <div className="lcm-heat" key={n}>
              <span>{n}</span>
              <div>{recent.map((h, i) => {
                const v = h.approaches?.[n]?.occupancy ?? 0;
                return <i key={i} title={`${h.label}: ${Math.round(v * 100)}%`} style={{ background: `color-mix(in srgb, var(--status-danger) ${Math.round(Math.min(1, v) * 100)}%, var(--bg-sunken))` }} />;
              })}</div>
            </div>
          ))}
          <h3>Congestion timeline</h3>
          <div className="lcm-heat"><span>Level</span><div>{recent.map((h, i) => <i key={i} title={`${h.label}: ${h.congestion || 'unknown'}`} className={h.congestion ? `lcm-level-cell-${h.congestion.toLowerCase()}` : ''} />)}</div></div>
          <ul className="lcm-legend">{LEVELS.map(l => <li key={l}><i className={`lcm-level-cell-${l.toLowerCase()}`} /> {l}</li>)}</ul>
        </div>
        <div>
          <h3>Traffic by direction</h3>
          {axes.map(a => (
            <div className="lcm-bar" key={a.axis} title={`${a.axis}: ${a.vehicles} vehicles, ${a.queue} queued`}>
              <span>{a.axis === 'NS' ? 'North-South' : 'East-West'}</span>
              <div><i style={{ width: `${(a.vehicles / peak) * 100}%`, background: a.axis === 'NS' ? 'var(--accent)' : 'var(--msg-proposal)' }} /></div>
              <b>{current ? `${a.vehicles} (${a.queue} queued)` : '—'}</b>
            </div>
          ))}
          <h3>Lanes</h3>
          <div className="lcm-scroll">
            <table className="lcm-table">
              <thead><tr><th>Lane</th><th>Veh</th><th>Queue</th><th>In/min</th><th>Out/min</th><th>Wait</th><th>Spillback</th></tr></thead>
              <tbody>
                {approaches.length === 0 && <tr><td colSpan={7} className="muted">No lanes configured.</td></tr>}
                {approaches.map(([n, a]) => <tr key={n}><td>{n}</td><td>{a.vehicles}</td><td>{a.queue_vehicles}</td><td>{a.arrivals_per_min}</td><td>{a.departures_per_min}</td><td>{a.mean_wait_s}s</td><td>{a.spillback_risk}</td></tr>)}
              </tbody>
            </table>
          </div>
          {current && Object.keys(current.turning || {}).length > 0 && <p className="muted">Turning estimates: {Object.entries(current.turning).map(([k, v]) => `${k}: ${v}`).join(', ')}</p>}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- swarm
const MESSAGE_KINDS = new Set(['traffic_state', 'congestion_alert', 'signal_plan_request', 'signal_plan_proposal', 'plan_accepted', 'plan_rejected', 'central_decision', 'regional_escalation', 'regional_clear', 'agent_disconnected', 'agent_reconnected', 'heartbeat']);

export function SwarmPanel({ events, subscribe }) {
  const { data } = usePolled('agents', 1500);
  const wrap = useRef(null);
  const nodes = useRef({});
  const [selected, setSelected] = useState(null);
  const [hideBeats, setHideBeats] = useState(true);
  const [paused, setPaused] = useState(false);

  useEffect(() => subscribe(({ events: fresh }) => {
    for (const e of fresh || []) {
      if (e.kind !== 'agent_message' || document.hidden) continue;
      const { from, to, type } = e.data;
      if (type === 'heartbeat') continue;
      firePacket(wrap.current, nodes.current[from], nodes.current[to], e.data_class, 800);
    }
  }), [subscribe]);

  // The list holds still under the pointer or keyboard focus, so a message can be selected while new ones arrive.
  const held = useRef(null);
  const newest = events.filter(e => e.kind === 'agent_message' && MESSAGE_KINDS.has(e.data.type) && !(hideBeats && e.data.type === 'heartbeat')).slice(-40).reverse();
  const messages = paused && held.current ? held.current : newest;
  held.current = messages;
  const put = id => el => { nodes.current[id] = el; };
  return (
    <section className="panel lcm-section">
      <header className="lcm-section-head">
        <div><h2>Swarm intelligence</h2><p className="muted">Agents receive structured traffic state, never video. A packet here is a message that was actually sent.</p></div>
        {data && <div className="lcm-chips"><span>{data.counts.messages} messages</span><span>{data.counts.alerts} alerts</span><span>{data.counts.proposals} proposals</span><span>{data.counts.accepted} accepted</span><span>{data.counts.rejected} rejected</span></div>}
      </header>
      <div className="lcm-swarm" ref={wrap}>
        <div className="lcm-tier"><div ref={put('CENTRAL')} className={`lcm-agent is-central ${data?.central?.reviewing?.length ? 'is-alert' : ''}`}><b>Central Supervisor</b><small>{data?.central?.reviewing?.length ? `Reviewing ${data.central.reviewing.join(', ')}` : 'No region escalated'}</small></div></div>
        <div className="lcm-tier">{(data?.regions || []).map(r => <div key={r.id} ref={put(r.id)} className={`lcm-agent ${r.escalated ? 'is-alert' : ''}`}><b>Region {r.id}</b><small>{r.junctions.length} junctions{r.escalated ? ', escalated' : ''}</small></div>)}</div>
        <div className="lcm-tier">
          {(data?.agents || []).length === 0 && <p className="muted">No intersection agents. Register a camera to create one.</p>}
          {(data?.agents || []).map(a => (
            <div key={a.id} ref={put(a.id)} className={`lcm-agent lcm-node-${a.status.toLowerCase()}`}>
              <b>{a.id}</b><StatusPill status={a.status} />
              <small>{a.camera_id || 'No camera yet'}</small>
              <small>Heartbeat {when(a.last_heartbeat)}</small>
              {a.state && <small>{a.state.vehicle_count} veh · {a.state.congestion_level || 'no lanes'}</small>}
            </div>
          ))}
        </div>
        <div className="lcm-tier" aria-hidden="true">
          <div ref={put('SAFETY')} className="lcm-agent is-safety"><b>Safety Validator</b><small>Every plan passes here</small></div>
        </div>
        {(data?.agents || []).map(a => a.camera_id && <span key={a.camera_id} ref={put(a.camera_id)} className="lcm-anchor" />)}
      </div>
      <div className="lcm-two">
        <div>
          <div className="lcm-row-between"><h3>Messages</h3><Toggle label="Hide heartbeats" checked={hideBeats} onChange={setHideBeats} /></div>
          <ul className="lcm-messages" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
            {messages.length === 0 && <li className="muted">No messages yet. They begin once a camera is running with lanes drawn.</li>}
            {messages.map(e => (
              <li key={e.seq}><button type="button" className={selected?.seq === e.seq ? 'is-open' : ''} onClick={() => setSelected(e)}>
                <time>{when(e.ts)}</time><b>{e.data.type.replace(/_/g, ' ')}</b><span>{e.data.from} → {e.data.to}</span>
              </button></li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Selected message</h3>
          {selected ? <>
            <p className="muted">{selected.message}. Sent {new Date(selected.ts).toLocaleString()}. <DataClass value={selected.data_class} /></p>
            <pre className="lcm-json">{JSON.stringify(selected.data, null, 2)}</pre>
          </> : <p className="muted">Select a message to see its type, timestamp and contents.</p>}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- signal
const FLOW = ['Traffic analytics', 'Intersection agent', 'Coordination', 'Proposal', 'Safety validator', 'Approved plan', 'Signal controller'];
const MODE_TEXT = {
  SIMULATION: 'Approved plans are applied to the SUMO simulation through TraCI. No physical signal is involved.',
  SHADOW: 'Plans are computed and validated as recommendations. Nothing is sent to any signal.',
};

function signalMode(mode) {
  return mode === 'SIMULATION' ? 'SUMO simulation' : mode === 'SHADOW' ? 'Virtual signal' : mode;
}

export function SignalPanel({ admin }) {
  const { data, refresh } = usePolled('signal', 1500);
  const { data: decisions } = usePolled('signal/decisions?limit=25', 2500);
  const [error, setError] = useState(null);
  const mode = data?.mode;
  const change = next => {
    setError(null);
    cameraApi('signal/mode', { method: 'POST', body: { mode: next } }).then(refresh).catch(e => setError(e.message));
  };
  return (
    <section className="panel lcm-section">
      <header className="lcm-section-head">
        <div><h2>Signal optimization</h2><p className="muted">{MODE_TEXT[mode] || 'Loading.'}</p></div>
        <div className="lcm-modes" role="group" aria-label="Signal mode">
          {['SIMULATION', 'SHADOW'].map(m => <button key={m} type="button" className={`small ${mode === m ? 'primary' : ''}`} aria-pressed={mode === m} disabled={!admin} onClick={() => change(m)}>{m === 'SIMULATION' ? 'Simulation' : 'Shadow'}</button>)}
          <button type="button" className="small" disabled title={data?.real_controller?.detail}>Real controller (unavailable)</button>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      {data?.simulation?.error && <p className="error">{data.simulation.error}</p>}
      {data?.enabled === false && <p className="lcm-note">Signal optimization is turned off in the admin panel.</p>}
      <ol className="lcm-chain">{FLOW.map(f => <li key={f}>{f}</li>)}</ol>
      {mode === 'SIMULATION' && data?.simulation?.running && (
        <p className="muted">SUMO time {num(data.simulation.sim_time)}s · {data.simulation.applied} plans applied · independent audit found {data.simulation.safety_audit?.total ?? 0} signal violations.</p>
      )}
      <div className="lcm-junctions">
        {(data?.junctions || []).length === 0 && <p className="muted">No junctions yet.</p>}
        {(data?.junctions || []).map(j => (
          <article key={j.intersection_id} className="lcm-junction">
            <b>{j.intersection_id}{j.tls ? ` → SUMO ${j.tls}` : ''}</b>
            <dl className="lcm-facts">
              <div><dt>{signalMode(mode)} phase</dt><dd>{j.current ? (j.current.in_clearance ? 'Clearance' : j.current.axis || 'Other') : '—'}</dd></div>
              <div><dt>AI proposes</dt><dd>{j.proposal ? `${j.proposal.axis} ${num(j.proposal.green_s)}s` : '—'}</dd></div>
              <div><dt>Safety</dt><dd>{j.decision ? j.decision.status : '—'}</dd></div>
            </dl>
            {j.proposal && <p className="muted">{j.proposal.reason}</p>}
            {j.decision?.reasons?.map((r, i) => <p key={i} className="lcm-reason">{j.decision.status === 'REJECTED' ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />} {r}</p>)}
          </article>
        ))}
      </div>
      <h3>Decision history</h3>
      <div className="lcm-scroll">
        <table className="lcm-table">
          <thead><tr><th>Time</th><th>Junction</th><th>Mode</th><th>Proposed</th><th>Approved</th><th>Safety</th><th>Source</th><th>Applied</th></tr></thead>
          <tbody>
            {!decisions?.length && <tr><td colSpan={8} className="muted">No decisions yet.</td></tr>}
            {(decisions || []).slice().reverse().map((d, i) => (
              <tr key={`${d.timestamp}-${i}`} title={d.decision_reason}>
                <td>{when(d.timestamp)}</td><td>{d.intersection_id}</td><td>{d.mode}</td><td>{d.proposed_phase}</td><td>{d.approved_phase || '—'}</td>
                <td className="lcm-cell-icon">{d.validation_status === 'REJECTED' ? <XCircle size={13} color="var(--status-danger)" /> : <CheckCircle2 size={13} color="var(--status-ok)" />} {d.validation_status}</td>
                <td>{d.source}</td><td>{d.details?.outcome?.applied ? 'In SUMO' : d.mode === 'SHADOW' ? 'No (shadow)' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- logs
const LOG_GROUPS = { all: () => true, camera: e => e.kind === 'log' && (e.stage === 'camera' || e.stage === 'decode'), infra: e => e.kind === 'log' && ['frigate', 'go2rtc'].includes(e.stage), detect: e => e.stage === 'yolo' && e.kind === 'log', agents: e => e.kind === 'agent_message' && e.data.type !== 'heartbeat', signals: e => e.kind === 'signal' };

export function LogsPanel({ events }) {
  const [group, setGroup] = useState('all');
  const rows = events.filter(e => e.kind !== 'flow' && !(e.kind === 'agent_message' && e.data.type === 'heartbeat') && LOG_GROUPS[group](e)).slice(-150).reverse();
  return (
    <section className="panel lcm-section">
      <header className="lcm-section-head">
        <h2>System logs</h2>
        <select value={group} onChange={e => setGroup(e.target.value)} aria-label="Filter logs">
          <option value="all">Everything</option><option value="camera">Camera connection and frames</option><option value="infra">Frigate and go2rtc</option>
          <option value="detect">Detection</option><option value="agents">Agent messages</option><option value="signals">Signal decisions</option>
        </select>
      </header>
      <ul className="lcm-loglines lcm-loglines-tall">
        {rows.length === 0 && <li className="muted">Nothing logged yet.</li>}
        {rows.map(e => <li key={e.seq} className={`is-${e.level}`}><time>{when(e.ts)}</time> {e.message}</li>)}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- topology
export function Topology({ selected, onSelect }) {
  const { data } = usePolled('topology', 3000);
  const [open, setOpen] = useState(null);
  const stream = data?.streams?.find(s => s.name === open);
  return (
    <section className="panel lcm-section">
      <header className="lcm-section-head"><div><h2>Stream topology</h2><p className="muted">go2rtc is {String(data?.go2rtc_state || 'unknown').toLowerCase().replace('_', ' ')}. Select a stream for details.</p></div></header>
      <div className="lcm-topology">
        {(data?.links || []).length === 0 && <p className="muted">No cameras registered.</p>}
        {(data?.links || []).map(l => (
          <div className="lcm-topo-row" key={l.camera_id}>
            <button type="button" className={`small ${selected === l.camera_id ? 'primary' : ''}`} onClick={() => onSelect(l.camera_id)}>{l.camera_name}</button>
            <span className="lcm-topo-line" />
            {l.stream ? <button type="button" className="small" onClick={() => setOpen(open === l.stream ? null : l.stream)}>go2rtc: {l.stream}<StatusPill status={l.stream_state} /></button> : <span className="lcm-topo-tag">Direct source</span>}
            <span className="lcm-topo-line" />
            {l.stream ? <><span className="lcm-topo-tag">Restream</span><span className="lcm-topo-line" /></> : null}
            <span className="lcm-topo-tag">Ingestion <StatusPill status={l.ingest_state} /> {num(l.fps, 1)} fps</span>
          </div>
        ))}
        {(data?.unassigned || []).length > 0 && <p className="muted">Streams with no camera: {data.unassigned.join(', ')}</p>}
      </div>
      {stream && (
        <dl className="lcm-facts">
          <div><dt>Stream</dt><dd>{stream.name}</dd></div><div><dt>State</dt><dd>{stream.state}</dd></div><div><dt>Sources</dt><dd>{stream.producers}</dd></div><div><dt>Readers</dt><dd>{stream.consumers}</dd></div>
          {stream.sources && <div><dt>Source</dt><dd className="lcm-break">{stream.sources.join(', ') || 'None connected'}</dd></div>}
        </dl>
      )}
    </section>
  );
}
