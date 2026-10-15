'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { lab, fmt, KPIS, colorOf } from '@/lib/api';
import Heatmap from '@/components/Heatmap';
import FuelSavedCard from '@/components/FuelSavedCard';
import { useLabOptions, useJobs, JobForm, JobList, useLive, EmergencyPanel, routeInfo } from '@/components/LiveLab';

// Frame of a replay at simulated time t (latest frame at or before t) -> {tls: {...}}.
function frameAt(rp, t) {
  if (!rp?.times?.length) return null;
  let lo = 0, hi = rp.times.length - 1, i = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rp.times[m] <= t) { i = m; lo = m + 1 } else hi = m - 1 }
  const out = {}; rp.tls.forEach((id, k) => out[id] = { queue: rp.queue[i][k], level: rp.level[i][k], occupancy: rp.occupancy[i][k], lanes: null, phase: null });
  return { time: rp.times[i], junctions: out };
}

export default function BeforeAfter() {
  const [opt, err] = useLabOptions(); const [jobs, reload] = useJobs();
  const [sel, setSel] = useState(null);

  useEffect(() => {
    const demoJobs = jobs.filter(j => j.spec.kind === 'demo');
    if (demoJobs.length > 0 && !sel) {
      setSel(demoJobs[0].id);
    }
  }, [jobs, sel]);

  const job = jobs.find(j => j.id === sel); const live = useLive(sel, job?.status);
  const [result, setResult] = useState(null), [replay, setReplay] = useState({}), [t, setT] = useState(0), [mode, setMode] = useState('live');
  const done = job?.status === 'completed';
  useEffect(() => { setResult(null); setReplay({}); setMode('live'); if (!done) return;
    lab(`/api/lab/jobs/${sel}/result`).then(setResult).catch(() => { });
    Promise.all(job.spec.controllers.map(c => lab(`/api/lab/jobs/${sel}/replay?controller=${c}`).then(r => [c, r]))).then(x => setReplay(Object.fromEntries(x))).catch(() => { });
  }, [sel, done]);
  const maxT = useMemo(() => Math.max(0, ...Object.values(replay).map(r => r.times?.[r.times.length - 1] || 0)), [replay]);
  const ctrls = job?.spec?.controllers || [];
  return <>
    <section className="panel"><h2>Before / after demonstration</h2>
      {err ? <div className="error">{err}</div> : <JobForm opt={opt} kind="demo" onCreated={j => { setSel(j.id); reload() }} />}
      <p className="muted small">The scenario is prepared once; each controller then runs in its own SUMO process (own TraCI port, output directory and log). Live views show each run&#39;s own simulated time; replay of a completed demo is aligned by simulated time.</p>
    </section>
    <section className="panel"><h2>Demo jobs</h2><JobList jobs={jobs} selected={sel} onSelect={setSel} filter={j => j.spec.kind === 'demo'} /></section>
    {job && live && <section className="panel">
      <div className="toolbar"><h2>{ctrls[0]} → {ctrls[1]}</h2>
        {done && <div className="tabs"><button className={mode === 'live' ? 'on' : ''} onClick={() => setMode('live')}>Final live state</button><button className={mode === 'replay' ? 'on' : ''} onClick={() => setMode('replay')}>Replay</button></div>}</div>
      <div className="meta"><span>network <b>{job.spec.network}</b></span><span>scenario <b>{job.spec.scenario}</b></span><span>seed <b>{job.spec.seed}</b></span><span>ambulances <b>{job.spec.ambulances}</b></span><span>demand: identical route file</span></div>
      {mode === 'live' ? <div className={'sync ' + (live.time_gap_s > 10 ? 'warn' : '')}>{live.synchronization}{live.time_gap_s != null && ` · simulated times differ by ${fmt(live.time_gap_s, 0)} s`}</div>
        : <div className="sync">Historical replay aligned by simulated time · t = {Math.round(t)} s<input type="range" min="0" max={maxT} step="5" value={t} onChange={e => setT(Number(e.target.value))} /></div>}
      <div className="split">{ctrls.map(c => { const p = live.parts[c]; const fr = mode === 'replay' ? frameAt(replay[c], t) : null; const r = routeInfo(p?.emergency);
        return <div key={c}><Heatmap layout={live.layout} network={job.spec.network} junctions={fr ? fr.junctions : p?.state?.junctions} source={fr ? 'historical_replay' : 'live_simulation'}
          simTime={fr ? fr.time : p?.state?.sim_time_s} title={c} height={300} route={r.route} routeStatus={r.status} />
          <div className="kpis"><span>status <b>{p?.state?.status || 'waiting'}</b></span><span>arrived <b>{p?.state?.vehicles_arrived ?? '—'}</b></span><span>wall <b>{fmt(p?.state?.wall_elapsed_s, 0)} s</b></span></div>
          <EmergencyPanel em={p?.emergency} onSelect={() => { }} /></div> })}</div>
      {result && (
        <>
          <div style={{ marginTop: 18 }}>
            <FuelSavedCard
              baselineFuelMg={result.controllers?.[ctrls[0]]?.fuel_mg}
              swarmFuelMg={result.controllers?.[ctrls[1]]?.fuel_mg}
              baselineCo2Mg={result.controllers?.[ctrls[0]]?.co2_mg}
              swarmCo2Mg={result.controllers?.[ctrls[1]]?.co2_mg}
              title={`${ctrls[1]} vs ${ctrls[0]} Fuel & Emissions Benefit`}
            />
          </div>
          <KpiTable result={result} />
        </>
      )}
    </section>}
  </>;
}

export function KpiTable({ result }) {
  const ctrls = Object.keys(result.controllers || {}); const ref = result.reference_controller || ctrls[0];
  return <div className="tablewrap"><table><thead><tr><th>KPI</th><th>unit</th>{ctrls.map(c => <th key={c}><i className="dot" style={{ background: colorOf(c) }} />{c}</th>)}{ctrls.filter(c => c !== ref).map(c => <th key={'d' + c}>{c} vs {ref}</th>)}</tr></thead>
    <tbody>{KPIS.map(([k, label, unit, lower]) => <tr key={k}><td>{label}</td><td className="muted">{unit}</td>{ctrls.map(c => <td key={c}>{fmt(result.controllers[c]?.[k])}</td>)}
      {ctrls.filter(c => c !== ref).map(c => { const v = result.comparisons?.[c]?.[k]?.change_pct; return <td key={'d' + c}>{v == null ? '—' : `${v > 0 ? '+' : ''}${fmt(v, 1)} %`}{v != null && v !== 0 && <span className="muted small">{(v < 0) === lower ? ' better' : ' worse'}</span>}</td> })}</tr>)}
      <tr><td>Decision latency (swarm tick)</td><td className="muted">ms mean / p95</td>{ctrls.map(c => { const l = result.controllers[c]?.decision_tick_latency_ms; return <td key={c}>{l ? `${fmt(l.mean, 1)} / ${fmt(l.p95, 1)}` : 'n/a (inside SUMO)'}</td> })}{ctrls.filter(c => c !== ref).map(c => <td key={'d' + c} />)}</tr>
      <tr><td>Signal-safety violations</td><td className="muted">count</td>{ctrls.map(c => <td key={c}>{result.controllers[c]?.safety_audit?.total_violations ?? '—'}</td>)}{ctrls.filter(c => c !== ref).map(c => <td key={'d' + c} />)}</tr>
      <tr><td>Ambulance mean travel time</td><td className="muted">s</td>{ctrls.map(c => <td key={c}>{fmt(result.controllers[c]?.emergency?.mean_travel_time_s, 1)}</td>)}{ctrls.filter(c => c !== ref).map(c => <td key={'d' + c} />)}</tr>
    </tbody></table><p className="muted small">Single run: one scenario and seed. Differences are not statistically tested here - use the evaluation report for multi-seed results.</p></div>;
}
