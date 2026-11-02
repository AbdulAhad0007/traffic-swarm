'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Plug, Save, Trash2, Undo2, X } from 'lucide-react';
import { useFrames } from './CameraTile';
import { DataClass, StatusPill, cameraApi, num, usePolled, when } from './feed';

const TOOLS = [
  { key: 'north', label: 'North lane', kind: 'approach' }, { key: 'south', label: 'South lane', kind: 'approach' },
  { key: 'east', label: 'East lane', kind: 'approach' }, { key: 'west', label: 'West lane', kind: 'approach' },
  { key: 'stop', label: 'Stop line', kind: 'stop', points: 2 },
  { key: 'detection', label: 'Downstream zone', kind: 'detection' }, { key: 'counting', label: 'Counting zone', kind: 'counting' }, { key: 'turning', label: 'Turning zone', kind: 'turning' },
  { key: 'calibration', label: 'Calibration line', kind: 'calibration', points: 2 },
];
const TOKENS = { north: '--accent', south: '--msg-signal', east: '--msg-proposal', west: '--road-heavy', detection: '--status-danger', counting: '--msg-congestion', turning: '--msg-central', calibration: '--text-primary' };
const blank = { approaches: {}, detection_zones: [], counting_zones: [], turning_zones: [], calibration: null };

function ZoneEditor({ camera, onSaved }) {
  const video = useRef(null);
  const overlay = useRef(null);
  const [zones, setZones] = useState({ ...blank, ...(camera.zones || {}) });
  const [tool, setTool] = useState('north');
  const [stopFor, setStopFor] = useState('north');
  const [points, setPoints] = useState([]);
  const [distance, setDistance] = useState(camera.zones?.calibration?.distance_m ?? '');
  const [message, setMessage] = useState(null);
  const current = TOOLS.find(t => t.key === tool);

  const onFrame = (bitmap, w, h) => {
    const c = video.current;
    if (!c) { bitmap.close(); return; }
    if (c.width !== w) { c.width = w; c.height = h; overlay.current.width = w; overlay.current.height = h; draw(); }
    c.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
  };
  const { restricted, hasFrame } = useFrames(camera.id, camera.status === 'CONNECTED', onFrame);

  const draw = () => {
    const c = overlay.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    const style = getComputedStyle(c);
    const color = name => style.getPropertyValue(name).trim();
    const shape = (pts, token, label, closed = true) => {
      if (!pts?.length) return;
      ctx.strokeStyle = ctx.fillStyle = color(token);
      ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * c.width, y * c.height) : ctx.moveTo(x * c.width, y * c.height)));
      if (closed) { ctx.closePath(); ctx.globalAlpha = 0.16; ctx.fill(); ctx.globalAlpha = 1; }
      ctx.stroke();
      ctx.font = `12px ${color('--font-main')}`;
      ctx.fillText(label, pts[0][0] * c.width + 4, pts[0][1] * c.height - 4);
    };
    ctx.clearRect(0, 0, c.width, c.height);
    for (const [name, a] of Object.entries(zones.approaches)) {
      shape(a.polygon, TOKENS[name], name);
      if (a.stop_line) shape(a.stop_line, TOKENS[name], 'stop', false);
    }
    zones.detection_zones.forEach(z => shape(z.polygon, TOKENS.detection, z.name));
    zones.counting_zones.forEach(z => shape(z.polygon, TOKENS.counting, z.name));
    zones.turning_zones.forEach(z => shape(z.polygon, TOKENS.turning, z.name));
    if (zones.calibration) shape([zones.calibration.a, zones.calibration.b], TOKENS.calibration, `${zones.calibration.distance_m} m`, false);
    if (points.length) {
      shape(points, TOKENS[tool] || '--accent', current.label, false);
      points.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x * c.width, y * c.height, 4, 0, Math.PI * 2); ctx.fill(); });
    }
  };
  useEffect(draw);

  const commit = pts => {
    const list = pts || points;
    setMessage(null);
    if (current.kind === 'approach') {
      if (list.length < 3) return setMessage('A lane needs at least 3 points.');
      setZones(z => ({ ...z, approaches: { ...z.approaches, [tool]: { polygon: list, stop_line: z.approaches[tool]?.stop_line || null } } }));
    } else if (current.kind === 'stop') {
      if (!zones.approaches[stopFor]) return setMessage(`Draw the ${stopFor} lane first.`);
      setZones(z => ({ ...z, approaches: { ...z.approaches, [stopFor]: { ...z.approaches[stopFor], stop_line: list } } }));
    } else if (current.kind === 'calibration') {
      const d = Number(distance);
      if (!(d > 0)) return setMessage('Enter the real distance of this line in metres first.');
      setZones(z => ({ ...z, calibration: { a: list[0], b: list[1], distance_m: d } }));
    } else {
      if (list.length < 3) return setMessage('A zone needs at least 3 points.');
      const group = `${current.kind}_zones`;
      setZones(z => ({ ...z, [group]: [...z[group], { name: `${current.label} ${z[group].length + 1}`, polygon: list, ...(current.kind === 'detection' ? { role: 'downstream' } : {}) }] }));
    }
    setPoints([]);
    return undefined;
  };

  const click = e => {
    const r = e.currentTarget.getBoundingClientRect();
    const p = [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))].map(v => Number(v.toFixed(4)));
    const next = [...points, p];
    if (current.points && next.length === current.points) commit(next);
    else setPoints(next);
  };

  const save = () => cameraApi(`cameras/${camera.id}`, { method: 'PATCH', body: { zones } }).then(() => { setMessage('Saved. Measurements restart with these zones.'); onSaved?.(); }).catch(err => setMessage(err.message));

  return (
    <div className="lcm-editor">
      <div className="lcm-editor-tools">
        <select value={tool} onChange={e => { setTool(e.target.value); setPoints([]); }} aria-label="What to draw">{TOOLS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select>
        {tool === 'stop' && <select value={stopFor} onChange={e => setStopFor(e.target.value)} aria-label="Stop line for">{['north', 'south', 'east', 'west'].map(a => <option key={a}>{a}</option>)}</select>}
        {tool === 'calibration' && <input type="number" min="0.1" step="0.1" placeholder="Metres" value={distance} onChange={e => setDistance(e.target.value)} aria-label="Real distance in metres" />}
        {!current.points && <button type="button" className="small" disabled={!points.length} onClick={() => commit()}>Finish shape</button>}
        <button type="button" className="small icon" disabled={!points.length} aria-label="Remove last point" onClick={() => setPoints(p => p.slice(0, -1))}><Undo2 size={14} /></button>
        <button type="button" className="small" onClick={() => { setZones(blank); setPoints([]); }}><Trash2 size={13} /> Clear all</button>
        <button type="button" className="small primary" onClick={save}><Save size={13} /> Save zones</button>
      </div>
      <div className="lcm-editor-stage" onClick={click}>
        <canvas ref={video} className="lcm-canvas" width={960} height={540} />
        <canvas ref={overlay} className="lcm-canvas lcm-overlay" width={960} height={540} />
        {!hasFrame && <div className="lcm-novideo"><b>{restricted ? 'Video restricted' : 'No frame from this camera'}</b><span>Zones can be drawn while the camera is connected, so they match its view.</span></div>}
      </div>
      <p className="muted">Click to add points. North and south lanes form one phase group; east and west form the other. {message && <b>{message}</b>}</p>
    </div>
  );
}

export default function Inspector({ cameraId, admin, onClose }) {
  const { data: camera, refresh, error } = usePolled(`cameras/${cameraId}`, 1500);
  const { data: stats } = usePolled(`cameras/${cameraId}/frame-stats`, 2000);
  const [notice, setNotice] = useState(null);
  const [tab, setTab] = useState('status');
  const [fps, setFps] = useState('');
  const act = (path, label, options = { method: 'POST' }) => {
    setNotice(`${label}…`);
    return cameraApi(path, options).then(r => { setNotice(r?.ok === false ? `${label} failed: ${r.detail}` : r?.ok ? `${label} passed: ${r.width}×${r.height} in ${r.elapsed_ms} ms` : `${label} done.`); refresh(); return r; }).catch(e => setNotice(`${label} failed: ${e.message}`));
  };
  if (!camera) return <aside className="panel lcm-inspector"><p className="muted">{error || 'Loading…'}</p></aside>;
  return (
    <aside className="panel lcm-inspector" aria-label={`Inspector for ${camera.camera_name}`}>
      <div className="lcm-row-between">
        <div><h2>{camera.camera_name}</h2><p className="muted">{camera.id} · {camera.location || camera.intersection_id} <DataClass value={camera.data_class} /></p></div>
        <button type="button" className="small icon" aria-label="Close inspector" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="lcm-tabs" role="tablist">
        {[['status', 'Status'], ['frames', 'Frames'], ...(admin ? [['zones', 'Lanes and zones'], ['settings', 'Settings']] : [])].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`small ${tab === k ? 'primary' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {notice && <p className="lcm-note">{notice}</p>}
      {tab === 'status' && <>
        <dl className="lcm-facts lcm-facts-wide">
          <div><dt>Connection</dt><dd><StatusPill status={camera.status} /></dd></div>
          <div><dt>Source</dt><dd className="lcm-break">{admin ? camera.connection : camera.protocol}</dd></div>
          <div><dt>Frame age</dt><dd>{camera.last_frame_age_s != null ? `${camera.last_frame_age_s}s` : '—'}</dd></div>
          <div><dt>Processing latency</dt><dd>{camera.latency_ms != null ? `${num(camera.latency_ms)} ms` : '—'}</dd></div>
          <div><dt>Connection attempts</dt><dd>{camera.attempts ?? '—'}</dd></div>
          <div><dt>Model</dt><dd>{camera.detector ? `${camera.detector.model} on ${camera.detector.device}` : '—'}</dd></div>
        </dl>
        {camera.pipeline && <ul className="lcm-stagelist">{camera.pipeline.map(s => <li key={s.key}><span>{s.key === 'yolo' ? 'YOLO inference' : s.key === 'extract' ? 'Frame extraction' : s.key === 'restream' ? 'RTSP restream' : s.key === 'go2rtc' ? 'go2rtc stream' : s.key === 'frigate' ? 'Frigate' : 'Camera'}</span><StatusPill status={s.status} />{s.note && <small>{s.note}</small>}</li>)}</ul>}
        {admin && <div className="toolbar">
          <button type="button" className="small" onClick={() => act(`cameras/${camera.id}/reconnect`, 'Reconnect')}><Plug size={13} /> Reconnect</button>
          <button type="button" className="small" onClick={() => act(`cameras/${camera.id}/test`, 'Connection test')}>Test connection</button>
          <button type="button" className="small" onClick={() => act(`cameras/${camera.id}/${camera.enabled ? 'stop' : 'start'}`, camera.enabled ? 'Stop' : 'Start')}>{camera.enabled ? 'Stop' : 'Start'}</button>
          <button type="button" className="small danger" onClick={() => act(`cameras/${camera.id}`, 'Remove', { method: 'DELETE' }).then(onClose)}><Trash2 size={13} /> Remove</button>
        </div>}
        {camera.errors?.length > 0 && <>
          <h3>Errors</h3>
          <ul className="lcm-loglines">{camera.errors.slice().reverse().map((e, i) => <li key={i} className="is-error"><time>{when(e.at)}</time> {e.message}</li>)}</ul>
        </>}
      </>}
      {tab === 'frames' && <>
        <dl className="lcm-facts lcm-facts-wide">
          <div><dt>Received</dt><dd>{camera.frames.received.toLocaleString()}</dd></div>
          <div><dt>Extracted</dt><dd>{camera.frames.extracted.toLocaleString()}</dd></div>
          <div><dt>Processed</dt><dd>{camera.frames.processed.toLocaleString()}</dd></div>
          <div><dt>Dropped</dt><dd>{camera.frames.dropped.toLocaleString()}</dd></div>
          <div><dt>Stream FPS</dt><dd>{num(camera.fps, 1)}</dd></div>
          <div><dt>Processing FPS</dt><dd>{num(camera.processing_fps, 1)}</dd></div>
          <div><dt>Average latency</dt><dd>{camera.latency_ms != null ? `${num(camera.latency_ms)} ms` : '—'}</dd></div>
          <div><dt>Latest frame</dt><dd>{when(camera.last_frame)}</dd></div>
        </dl>
        <h3>Recently processed</h3>
        <div className="lcm-scroll">
          <table className="lcm-table">
            <thead><tr><th>Frame</th><th>Received</th><th>Source time</th><th>Took</th><th>Status</th></tr></thead>
            <tbody>{(stats?.recent || []).slice(-15).reverse().map(f => <tr key={f.frame_number}><td>{f.frame_number}</td><td>{when(f.received)}</td><td>{f.source_ts_ms != null ? `${(f.source_ts_ms / 1000).toFixed(2)}s` : 'None sent'}</td><td>{f.processing_ms} ms</td><td>{f.status}</td></tr>)}</tbody>
          </table>
        </div>
      </>}
      {tab === 'zones' && admin && <ZoneEditor key={camera.id} camera={camera} onSaved={refresh} />}
      {tab === 'settings' && admin && <>
        <form className="lcm-inline-form" onSubmit={e => { e.preventDefault(); act(`cameras/${camera.id}`, 'Update', { method: 'PATCH', body: { config: { processing_fps: Number(fps) } } }); }}>
          <label>Processing FPS <input type="number" min="0.2" max="30" step="0.1" placeholder={String(camera.config.processing_fps)} value={fps} onChange={e => setFps(e.target.value)} required /></label>
          <button type="submit" className="small">Apply</button>
        </form>
        <div className="toolbar">
          <button type="button" className="small" onClick={() => act(`cameras/${camera.id}`, 'Update', { method: 'PATCH', body: { config: { detection_enabled: !camera.config.detection_enabled } } })}>Detection: {camera.config.detection_enabled ? 'on' : 'off'}</button>
          {['go2rtc', 'rtsp'].includes(camera.source_type) && <button type="button" className="small" onClick={() => act(`cameras/${camera.id}`, 'Update', { method: 'PATCH', body: { data_class: camera.data_class === 'LIVE' ? 'TEST' : 'LIVE' } })}>{camera.data_class === 'LIVE' ? 'Mark as test source' : 'Confirm this is a real roadside camera (LIVE)'}</button>}
        </div>
      </>}
    </aside>
  );
}
