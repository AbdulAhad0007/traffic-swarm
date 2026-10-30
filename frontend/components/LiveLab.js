'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Play, Square, OctagonX, Siren, MapPin, Search, RefreshCw, Globe2 } from 'lucide-react';
import { lab, fmt, colorOf } from '@/lib/api';
import Heatmap from '@/components/Heatmap';
import FuelSavedCard from '@/components/FuelSavedCard';
import SwarmCallsPanel from '@/components/SwarmCallsPanel';

export function useLabOptions() {
  const [opt, setOpt] = useState(null), [err, setErr] = useState('');
  useEffect(() => { lab('/api/lab/options').then(setOpt).catch(e => setErr('Lab service unreachable: ' + e.message)) }, []);
  return [opt, err];
}

export function useJobs() {
  const [jobs, setJobs] = useState([]);
  const load = useCallback(() => lab('/api/lab/jobs?limit=30').then(setJobs).catch(() => { }), []);
  useEffect(() => { load(); const t = setInterval(load, 2500); return () => clearInterval(t) }, [load]);
  return [jobs, load];
}

// Real-world areas (OpenStreetMap extracts) the lab can simulate; polls quickly while one is downloading
export function useAreas() {
  const [areas, setAreas] = useState([]);
  const load = useCallback(() => lab('/api/lab/osm-areas').then(setAreas).catch(() => { }), []);
  const busy = areas.some(a => a.status === 'downloading');
  useEffect(() => { load(); const t = setInterval(load, busy ? 3000 : 20000); return () => clearInterval(t) }, [load, busy]);
  return [areas, load];
}

const AREA_PREFIX = 'area:';
const AREA_RADII = [[400, '0.4 km radius (≈0.6 km²)'], [700, '0.7 km radius (≈2 km²)'], [950, '0.95 km radius (≈3.6 km²)']];

function bboxAround(lat, lon, r) {
  const dLat = r / 110570, dLon = r / (111320 * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon };
}

export function AreasPanel({ areas, reload, onUse }) {
  const [q, setQ] = useState(''), [radius, setRadius] = useState(700), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const add = async e => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true); setErr('');
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`);
      const place = (await res.json())[0];
      if (!place) throw new Error(`No place called "${q}" found on OpenStreetMap`);
      const name = place.display_name.split(',').slice(0, 2).join(',').trim();
      await lab('/api/lab/osm-areas', { method: 'POST', body: JSON.stringify({ name, bbox: bboxAround(+place.lat, +place.lon, radius) }) });
      setQ(''); reload();
    } catch (ex) { setErr(ex.message) } finally { setBusy(false) }
  };
  return <div className="areas-panel">
    <div className="areas-head"><h3><Globe2 size={16} /> Real-world areas</h3>
      <span className="muted small">Download any place from OpenStreetMap and simulate its real traffic lights in SUMO.</span></div>
    <form className="areas-add" onSubmit={add}>
      <div className="areas-search"><Search size={15} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Place to simulate, e.g. Silk Board Bengaluru, ITO Delhi" /></div>
      <select value={radius} onChange={e => setRadius(Number(e.target.value))} aria-label="Area size">{AREA_RADII.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <button disabled={busy}><MapPin size={15} />{busy ? 'Adding…' : 'Add area'}</button>
    </form>
    {err && <div className="error">{err}</div>}
    {areas.length > 0 && <div className="areas-list">{areas.map(a => <div key={a.id} className={'area-chip s-' + a.status}>
      <div><b>{a.name}</b><span>{a.area_km2} km²{a.status === 'ready' ? ` · ${a.traffic_signal_nodes} OSM signal nodes` : ''}</span></div>
      {a.status === 'downloading' && <span className="area-state"><RefreshCw size={13} className="spin" /> downloading…</span>}
      {a.status === 'failed' && <span className="area-state" title={a.error}>download failed</span>}
      {a.status === 'ready' && <button type="button" className="small" onClick={() => onUse(a)} disabled={!a.traffic_signal_nodes}
        title={a.traffic_signal_nodes ? 'Select this area in the form above' : 'No traffic lights are mapped here'}>Use</button>}
    </div>)}</div>}
  </div>;
}

export function JobForm({ opt, kind, onCreated, areas = [], network: forcedNetwork }) {
  const [f, setF] = useState({ network: 'grid3x3', scenario: 'normal', seed: 42, controllers: kind === 'demo' ? ['fixed', 'swarm'] : ['fixed', 'actuated', 'swarm'], ambulances: 0, realtime_factor: kind === 'demo' ? 20 : '', max_time: 3600 });
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  useEffect(() => { if (forcedNetwork) setF(x => ({ ...x, network: forcedNetwork })) }, [forcedNetwork]);
  const area = f.network.startsWith(AREA_PREFIX) ? f.network.slice(AREA_PREFIX.length) : null;
  const submit = async () => { setBusy(true); setErr(''); try { const body = { ...f, kind, ...(area ? { network: 'osm_user', osm_area: area } : {}), seed: Number(f.seed), ambulances: Number(f.ambulances), max_time: Number(f.max_time), realtime_factor: f.realtime_factor === '' ? null : Number(f.realtime_factor) }; onCreated(await lab('/api/lab/jobs', { method: 'POST', body: JSON.stringify(body) })) } catch (e) { setErr(e.message) } finally { setBusy(false) } };
  if (!opt) return null;
  const variants = Object.keys(opt.controllers);
  return <div className="form">
    <label>Network<select value={f.network} onChange={e => set('network', e.target.value)}>
      {areas.some(a => a.status === 'ready') && <optgroup label="Real-world areas (OpenStreetMap)">
        {areas.filter(a => a.status === 'ready').map(a => <option key={a.id} value={AREA_PREFIX + a.id}>{a.name} · {a.traffic_signal_nodes} signals</option>)}
      </optgroup>}
      <optgroup label="Bundled OpenStreetMap extracts">
        {opt.presets.filter(p => p.runnable_from_ui && p.type === 'osm').map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
      </optgroup>
      <optgroup label="Synthetic grids (no real location)">
        {opt.presets.filter(p => p.runnable_from_ui && p.type !== 'osm').map(p => <option key={p.name} value={p.name}>{p.name}{p.rows ? ` (${p.rows}×${p.cols})` : ''}</option>)}
      </optgroup>
    </select></label>
    <label>Scenario<select value={f.scenario} onChange={e => set('scenario', e.target.value)}>{opt.scenarios.map(s => <option key={s}>{s}</option>)}</select></label>
    <label>Seed<input type="number" min="0" value={f.seed} onChange={e => set('seed', e.target.value)} /></label>
    <label>Ambulances<input type="number" min="0" max="10" value={f.ambulances} onChange={e => set('ambulances', e.target.value)} /></label>
    <label title="Simulated seconds per wall-clock second; empty = as fast as possible">Pace (sim s / s)<input type="number" min="1" max="500" placeholder="max speed" value={f.realtime_factor} onChange={e => set('realtime_factor', e.target.value)} /></label>
    {kind === 'demo' ? <>
      <label>Before<select value={f.controllers[0]} onChange={e => set('controllers', [e.target.value, f.controllers[1]])}>{variants.map(v => <option key={v}>{v}</option>)}</select></label>
      <label>After<select value={f.controllers[1]} onChange={e => set('controllers', [f.controllers[0], e.target.value])}>{variants.map(v => <option key={v}>{v}</option>)}</select></label>
    </> : <fieldset><legend>Controllers (first = reference)</legend>{variants.map(v => <label key={v} className="check"><input type="checkbox" checked={f.controllers.includes(v)} onChange={e => set('controllers', e.target.checked ? [...f.controllers, v] : f.controllers.filter(x => x !== v))} />{v}</label>)}</fieldset>}
    <button disabled={busy} onClick={submit}><Play size={16} />{busy ? 'Starting…' : kind === 'demo' ? 'Start before/after' : 'Start experiment'}</button>
    {err && <div className="error">{err}</div>}
  </div>;
}

export function JobList({ jobs, selected, onSelect, filter, areas = [] }) {
  const netName = spec => (spec.osm_area ? (areas.find(a => a.id === spec.osm_area)?.name || spec.osm_area) : spec.network);
  const stop = id => lab(`/api/lab/jobs/${id}/stop`, { method: 'POST' }).catch(() => { });
  const list = jobs.filter(filter || (() => true));
  return <div className="table">{list.length === 0 && <p className="muted">No jobs yet. Start one with the form above.</p>}
    {list.map(j => <div key={j.id} className={'row ' + (j.id === selected ? 'active' : '')} onClick={() => onSelect(j.id)}>
      <span className="mono">{j.id}</span><span>{netName(j.spec)} · {j.spec.scenario} · seed {j.spec.seed}</span><span>{j.spec.controllers.join(' vs ')}</span>
      <span className={'status s-' + j.status}>{j.status}</span>
      {!['completed', 'failed', 'cancelled'].includes(j.status) && <button className="small" onClick={e => { e.stopPropagation(); stop(j.id) }}><Square size={13} /> Stop</button>}
    </div>)}</div>;
}

export function useLive(jobId, status) {
  const [live, setLive] = useState(null);
  useEffect(() => { if (!jobId) return; let on = true; const get = () => lab(`/api/lab/jobs/${jobId}/live`).then(x => on && setLive(x)).catch(() => { }); get();
    const t = setInterval(get, ['completed', 'failed', 'cancelled'].includes(status) ? 15000 : 2000); return () => { on = false; clearInterval(t) } }, [jobId, status]);
  return live;
}

// Measured comparison of a finished experiment job (null while it runs)
export function useResult(jobId, status) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    setResult(null);
    if (!jobId || status !== 'completed') return;
    lab(`/api/lab/jobs/${jobId}/result`).then(setResult).catch(() => { });
  }, [jobId, status]);
  return result;
}

export function EmergencyPanel({ em, selected, onSelect }) {
  if (!em || !em.ambulances?.length) return null;
  return <div className="emergency"><h3><Siren size={16} /> Emergency vehicles <span className="muted small">{em.priority_enabled ? 'priority ON' : 'priority OFF (tracking only)'}</span></h3>
    {em.ambulances.map(a => { const last = a.requests.filter(r => r.status !== 'released').slice(-1)[0];
      return <div key={a.id} className={'amb ' + (selected === a.id ? 'active' : '')} onClick={() => onSelect(a.id)}>
        <b>{a.id}</b><span>{a.arrival_s != null ? `arrived · travel time ${fmt(a.travel_time_s, 0)} s` : a.lost ? 'left network (lost)' : `en route · ${fmt(a.elapsed_s, 0)} s`}</span>
        <span>{a.stops} stops</span><span>{last ? `${last.tls}: ${last.status}` : a.arrival_s != null ? 'all requests released' : 'no active request'}</span>
      </div> })}
    <p className="muted small">Simulation prototype only - not certified for real emergency traffic systems. Priority only re-times green phases within min/max green; clearance intervals are never shortened.</p>
  </div>;
}

export function routeInfo(em, ambId) {
  const a = em?.ambulances?.find(x => x.id === ambId) || em?.ambulances?.find(x => x.arrival_s == null) || em?.ambulances?.[0];
  if (!a) return { route: [], status: {} };
  const status = {}; for (const r of a.requests) status[r.tls] = r.status === 'released' ? (r.outcome || 'released') : r.status;
  return { route: a.tls_on_route, status };
}

export default function LiveLab() {
  const [opt, err] = useLabOptions(); const [jobs, reload] = useJobs(); const [areas, reloadAreas] = useAreas();
  const [sel, setSel] = useState(null), [ctl, setCtl] = useState(null), [amb, setAmb] = useState(null);
  const [useNetwork, setUseNetwork] = useState(null);

  useEffect(() => {
    if (jobs.length > 0 && !sel) {
      setSel(jobs[0].id);
    }
  }, [jobs, sel]);

  const job = jobs.find(j => j.id === sel); const live = useLive(sel, job?.status);
  const parts = live ? Object.keys(live.parts) : []; const c = ctl && parts.includes(ctl) ? ctl : parts[0];
  const part = live?.parts?.[c]; const r = routeInfo(part?.emergency, amb);
  const result = useResult(sel, job?.status);
  const refCtl = result?.reference_controller || parts[0];
  const cmps = result?.comparisons || {};
  const cmpCtl = c && c !== refCtl && cmps[c] ? c : (cmps.swarm ? 'swarm' : Object.keys(cmps)[0]);
  const cmp = cmpCtl ? cmps[cmpCtl] : null;
  const stopAll = () => lab('/api/lab/stop-all', { method: 'POST' }).then(reload).catch(() => { });
  return <>
    <section className="panel"><div className="toolbar"><h2>Live simulation lab</h2><button className="danger" onClick={stopAll}><OctagonX size={16} /> Stop all running</button></div>
      {err ? <div className="error">{err}. Start it with <code>uvicorn experiments.lab.api:app --port 8090</code>.</div> : <>
        <JobForm opt={opt} kind="experiment" areas={areas} network={useNetwork} onCreated={j => { setSel(j.id); reload() }} />
        <AreasPanel areas={areas} reload={reloadAreas} onUse={a => setUseNetwork(AREA_PREFIX + a.id)} />
      </>}
      <p className="muted small">Every controller in a job runs on the identical network, demand and seed. Controllers in an experiment job run one after another; the heatmap follows the one that is running.</p>
    </section>
    {live && <section className="panel"><div className="toolbar"><h2>Network state</h2>
      <div className="tabs">{parts.map(p => <button key={p} className={p === c ? 'on' : ''} onClick={() => setCtl(p)}><i className="dot" style={{ background: colorOf(p) }} />{p}</button>)}</div></div>
      <Heatmap layout={live.layout} network={job?.spec?.network} junctions={part?.state?.junctions} source={part?.state?.source || 'live_simulation'} simTime={part?.state?.sim_time_s}
        updated={part?.state?.updated_utc} route={r.route} routeStatus={r.status} title={`${c} · ${part?.state?.status || 'waiting'}`} />
      <EmergencyPanel em={part?.emergency} selected={amb} onSelect={setAmb} />
      <div style={{ marginTop: 18 }}>
        <FuelSavedCard
          baselineFuelMg={cmp?.fuel_mg?.baseline}
          swarmFuelMg={cmp?.fuel_mg?.swarm}
          baselineCo2Mg={cmp?.co2_mg?.baseline}
          swarmCo2Mg={cmp?.co2_mg?.swarm}
          baselineLabel={refCtl}
          compareLabel={cmpCtl}
          title={cmp ? `Fuel & emissions · ${cmpCtl} vs ${refCtl}` : 'Fuel & emissions'}
          pendingText={job?.status === 'completed'
            ? 'This job has no second controller to compare fuel against.'
            : 'Measured fuel and CO₂ for each controller appear when the job finishes.'}
        />
      </div>
      <SwarmCallsPanel jobId={sel} isLive={!['completed', 'failed', 'cancelled'].includes(job?.status)} />
    </section>}
    <section className="panel"><div className="toolbar"><h2>Jobs</h2><span className="muted small">{jobs.length} recent · click one to view it above</span></div>
      <div className="jobs-scroll"><JobList jobs={jobs} selected={sel} onSelect={setSel} areas={areas} /></div></section>
  </>;
}
