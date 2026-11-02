'use client';

import React, { useState } from 'react';
import { Plus, RefreshCw, Save, Upload } from 'lucide-react';
import { StatusPill, cameraApi, usePolled, when } from './feed';

function ServiceForm({ name, title, info, refresh }) {
  const isFrigate = name === 'frigate';
  const [form, setForm] = useState({});
  const [message, setMessage] = useState(null);
  const value = key => form[key] ?? info?.[key] ?? '';
  const set = key => e => setForm(f => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const body = () => ({ url: value('url'), ...(isFrigate ? { verify_tls: form.verify_tls ?? info?.verify_tls ?? true, token: form.token, username: form.username, password: form.password } : { rtsp_url: value('rtsp_url'), username: form.username, password: form.password }) });
  const run = (path, label, payload) => {
    setMessage(`${label}…`);
    cameraApi(path, { method: 'POST', body: payload })
      .then(r => { setMessage(`${label}: ${r.state}${r.version ? `, version ${r.version}` : ''}${r.detail ? `. ${r.detail}` : ''}`); setForm({}); refresh(); })
      .catch(err => setMessage(`${label} failed: ${err.message}`));
  };
  const saved = info?.credentials || {};
  return (
    <form className="lcm-service" onSubmit={e => { e.preventDefault(); run(`infra/${name}`, 'Save', body()); }} autoComplete="off">
      <div className="lcm-row-between"><h3>{title}</h3><StatusPill status={info?.state || 'UNKNOWN'} /></div>
      <label>Server address<input value={value('url')} onChange={set('url')} placeholder={isFrigate ? 'http://frigate:5000' : 'http://go2rtc:1984'} required /></label>
      {!isFrigate && <label>Restream base<input value={value('rtsp_url')} onChange={set('rtsp_url')} placeholder="rtsp://go2rtc:8554" /></label>}
      {isFrigate && <label>API token{saved.token ? ' (saved)' : ''}<input type="password" value={form.token || ''} onChange={set('token')} autoComplete="new-password" /></label>}
      <label>Username{saved.username ? ' (saved)' : ''}<input value={form.username || ''} onChange={set('username')} autoComplete="off" /></label>
      <label>Password{saved.password ? ' (saved)' : ''}<input type="password" value={form.password || ''} onChange={set('password')} autoComplete="new-password" /></label>
      {isFrigate && <label className="lcm-toggle"><input type="checkbox" checked={form.verify_tls ?? info?.verify_tls ?? true} onChange={set('verify_tls')} /> Verify TLS certificate</label>}
      {info && !info.vault_writable && <p className="muted">Credentials can be saved here once TSI_CAMERA_SECRET_KEY is set on the camera service. Environment variables also work.</p>}
      <div className="toolbar">
        <button type="submit" className="small primary"><Save size={13} /> Save</button>
        <button type="button" className="small" onClick={() => run(`infra/${name}/test`, 'Test', body())}>Test connection</button>
        <button type="button" className="small" onClick={() => run(`infra/${name}/reconnect`, 'Reconnect', {})}><RefreshCw size={13} /> Reconnect</button>
      </div>
      {message && <p className="lcm-note">{message}</p>}
      {info?.detail && <p className="muted">{info.detail}</p>}
      {isFrigate && info?.cameras && Object.keys(info.cameras).length > 0 && <p className="muted">Frigate cameras: {Object.values(info.cameras).map(c => `${c.name}${c.recording ? ' (recording)' : ''}`).join(', ')}</p>}
      {isFrigate && info?.events?.length > 0 && <p className="muted">Latest event: {info.events[0].label} on {info.events[0].camera}.</p>}
      {!isFrigate && info?.streams && Object.keys(info.streams).length > 0 && <p className="muted">Streams: {Object.keys(info.streams).join(', ')}</p>}
      <details><summary>Connection log</summary><ul className="lcm-loglines">{(info?.log || []).slice().reverse().map((l, i) => <li key={i}><time>{when(l.ts)}</time> {l.state}: {l.detail}</li>)}</ul></details>
    </form>
  );
}

const SOURCE_HELP = {
  go2rtc: ['Stream', 'Name of a stream in go2rtc'],
  rtsp: ['Address', 'rtsp://user:password@host:554/stream'],
  webcam: ['Device number', '0'],
  usb: ['Device number', '1'],
  file: ['Uploaded video', ''],
};

function AddCamera({ streams, files, refreshFiles, flags, done }) {
  const [form, setForm] = useState({ id: '', camera_name: '', location: '', intersection_id: '', source_type: 'go2rtc', source: '', data_class: 'TEST' });
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }));
  const kind = form.source_type;
  const device = kind === 'webcam' || kind === 'usb';
  const submit = e => {
    e.preventDefault();
    setMessage(null);
    cameraApi('cameras', { method: 'POST', body: { ...form, id: form.id || undefined, source: device ? Number(form.source) : form.source } })
      .then(c => { setMessage(`${c.id} added as ${c.data_class}.`); setForm(f => ({ ...f, id: '', camera_name: '', source: '' })); done(c.id); })
      .catch(err => setMessage(err.message));
  };
  const upload = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setMessage('Uploading…');
    cameraApi(`test-sources?name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file })
      .then(r => { setForm(f => ({ ...f, source: r.file })); setMessage('Uploaded. It will run as REPLAY.'); refreshFiles(); })
      .catch(err => setMessage(err.message)).finally(() => setBusy(false));
  };
  return (
    <form className="lcm-service" onSubmit={submit} autoComplete="off">
      <h3>Register a camera</h3>
      <label>Name<input value={form.camera_name} onChange={set('camera_name')} required /></label>
      <label>Camera ID (optional)<input value={form.id} onChange={set('id')} pattern="[A-Za-z0-9_\-]{1,40}" /></label>
      <label>Location<input value={form.location} onChange={set('location')} /></label>
      <label>Intersection ID<input value={form.intersection_id} onChange={set('intersection_id')} placeholder="JUNCTION_01" required /></label>
      <label>Source
        <select value={kind} onChange={e => setForm(f => ({ ...f, source_type: e.target.value, source: '' }))}>
          <option value="go2rtc">go2rtc stream</option><option value="rtsp">RTSP address</option><option value="webcam" disabled={!flags['test-mode']}>Laptop webcam (test)</option>
          <option value="usb" disabled={!flags['test-mode']}>USB camera (test)</option><option value="file" disabled={!flags['test-mode']}>Video file (replay)</option>
        </select>
      </label>
      {kind === 'go2rtc' && streams.length > 0 ? (
        <label>{SOURCE_HELP[kind][0]}<select value={form.source} onChange={set('source')} required><option value="">Choose</option>{streams.map(s => <option key={s}>{s}</option>)}</select></label>
      ) : kind === 'file' ? (
        <>
          <label>Uploaded video<select value={form.source} onChange={set('source')} required><option value="">Choose</option>{files.map(f => <option key={f}>{f}</option>)}</select></label>
          <label className="lcm-upload"><Upload size={13} /> Upload a video you are authorized to use<input type="file" accept="video/*,.mkv" disabled={busy} onChange={upload} /></label>
        </>
      ) : (
        <label>{SOURCE_HELP[kind][0]}<input type={device ? 'number' : kind === 'rtsp' ? 'password' : 'text'} min={device ? 0 : undefined} value={form.source} onChange={set('source')} placeholder={SOURCE_HELP[kind][1]} required autoComplete="new-password" /></label>
      )}
      {(kind === 'go2rtc' || kind === 'rtsp') && (
        <label>This source is
          <select value={form.data_class} onChange={set('data_class')}><option value="TEST">An authorized test source</option><option value="LIVE">A real roadside camera (LIVE)</option><option value="REPLAY">Recorded video (REPLAY)</option></select>
        </label>
      )}
      <button type="submit" className="small primary" disabled={!flags['camera-management']}><Plus size={13} /> Add camera</button>
      {!flags['camera-management'] && <p className="muted">Camera management is turned off in the admin panel.</p>}
      {message && <p className="lcm-note">{message}</p>}
    </form>
  );
}

export default function AdminTools({ flags, onAdded, database }) {
  const { data: infra, refresh } = usePolled('infra', 5000);
  const { data: sources, refresh: refreshFiles } = usePolled('test-sources', 15000);
  return (
    <section className="panel lcm-section">
      <header className="lcm-section-head"><div><h2>Camera setup</h2><p className="muted">Administrators only. Passwords and tokens stay on the server and are never shown again.</p></div></header>
      {database?.note && <p className="lcm-note">Saving to a local database: {database.note}</p>}
      <div className="lcm-three">
        <AddCamera streams={Object.keys(infra?.go2rtc?.streams || {})} files={sources?.files || []} refreshFiles={refreshFiles} flags={flags} done={onAdded} />
        <ServiceForm name="go2rtc" title="go2rtc" info={infra?.go2rtc} refresh={refresh} />
        <ServiceForm name="frigate" title="Frigate NVR" info={infra?.frigate} refresh={refresh} />
      </div>
    </section>
  );
}
