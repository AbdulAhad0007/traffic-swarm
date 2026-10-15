'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, LineChart, Line, Legend } from 'recharts';
import { lab, fmt, KPIS, colorOf, variantOfDir } from '@/lib/api';
import { KpiTable } from '@/components/BeforeAfter';

const axis = { stroke: '#8a94a6', fontSize: 12 };
const tip = { contentStyle: { background: '#101722', border: '1px solid #273244', borderRadius: 8, color: '#eef2f7' } };

function useRuns() { const [runs, setRuns] = useState([]); useEffect(() => { lab('/api/lab/runs').then(setRuns).catch(() => { }) }, []); return runs }
function useReports() { const [r, setR] = useState([]); useEffect(() => { lab('/api/lab/reports').then(setR).catch(() => { }) }, []); return r }

// Saved runs keep the fixed-time controller in 'baseline/'; older runs only have baseline + swarm.
function normalise(cmp) {
  if (!cmp) return null;
  if (cmp.controllers) return cmp;
  return { ...cmp, reference_controller: 'fixed', controllers: { fixed: cmp.baseline, swarm: cmp.swarm }, comparisons: { swarm: cmp.comparison } };
}

function SavedRun({ id }) {
  const [cmp, setCmp] = useState(null);
  useEffect(() => { setCmp(null); if (id) lab('/api/lab/runs/comparison?id=' + encodeURIComponent(id)).then(x => setCmp(normalise(x))).catch(() => { }) }, [id]);
  if (!cmp) return <p className="muted">Select a saved run.</p>;
  const ctrls = Object.keys(cmp.controllers);
  return <>
    <div className="meta"><span>scenario <b>{cmp.scenario}</b></span><span>seed <b>{cmp.seed}</b></span><span>network <b>{cmp.metadata?.network?.preset}</b></span><span>route sha256 <b className="mono">{cmp.metadata?.scenario_route_sha256?.slice(0, 12)}…</b></span></div>
    <div className="multiples">{KPIS.slice(0, 6).map(([k, label, unit]) => { const data = ctrls.map(c => ({ c, v: cmp.controllers[c]?.[k] })).filter(d => d.v != null);
      return <div key={k} className="mini"><b>{label}</b> <span className="muted small">{unit}</span>
        <ResponsiveContainer width="100%" height={150}><BarChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}><CartesianGrid stroke="#1c2634" vertical={false} />
          <XAxis dataKey="c" tick={axis} interval={0} angle={-15} textAnchor="end" height={40} /><YAxis tick={axis} width={52} /><Tooltip {...tip} formatter={v => [fmt(v), label]} />
          <Bar dataKey="v" radius={[4, 4, 0, 0]} maxBarSize={36}>{data.map(d => <Cell key={d.c} fill={colorOf(d.c)} />)}</Bar></BarChart></ResponsiveContainer></div> })}</div>
    <KpiTable result={cmp} />
    <details><summary>Controller configurations</summary><pre>{JSON.stringify({ variants: cmp.metadata?.controller_variants, settings: cmp.metadata?.controller_settings,
      actuated: cmp.controllers.actuated?.actuated_config, software: cmp.metadata?.software }, null, 2)}</pre></details>
  </>;
}

function CiChart({ rows }) {
  // Dot = mean, whisker = 95 % CI; one row per controller, labelled directly.
  if (!rows.length) return <p className="muted">No completed cells for this selection.</p>;
  const lo = Math.min(...rows.map(r => r.ci_low ?? r.mean)), hi = Math.max(...rows.map(r => r.ci_high ?? r.mean));
  const pad = (hi - lo) * 0.1 || 1, a = lo - pad, b = hi + pad, W = 640, L = 150, R = 20, x = v => L + (v - a) / (b - a) * (W - L - R), H = 28 * rows.length + 30;
  return <svg viewBox={`0 0 ${W} ${H}`} className="ci">{[0, 0.25, 0.5, 0.75, 1].map(f => { const v = a + f * (b - a); return <g key={f}><line x1={x(v)} x2={x(v)} y1={0} y2={H - 22} className="grid" /><text x={x(v)} y={H - 6} textAnchor="middle" className="tick">{fmt(v, 1)}</text></g> })}
    {rows.map((r, i) => { const y = 20 + i * 28; return <g key={r.controller}><title>{`${r.controller}: mean ${fmt(r.mean)} (95% CI ${fmt(r.ci_low)} – ${fmt(r.ci_high)}), n=${r.n}`}</title>
      <text x={L - 8} y={y + 4} textAnchor="end" className="lab">{r.controller} (n={r.n})</text>
      {r.ci_low != null && <line x1={x(r.ci_low)} x2={x(r.ci_high)} y1={y} y2={y} stroke={colorOf(r.controller)} strokeWidth="2" />}
      <circle cx={x(r.mean)} cy={y} r="5" fill={colorOf(r.controller)} stroke="#0c1119" strokeWidth="2" /></g> })}</svg>;
}

function EvaluationReport({ name }) {
  const [rep, setRep] = useState(null), [f, setF] = useState({});
  useEffect(() => { setRep(null); if (name) lab('/api/lab/reports/' + name).then(r => { setRep(r); const d = r.descriptives?.[0]; if (d) setF({ network: d.network, scenario: d.scenario, metric: 'average_time_loss_s' }) }).catch(() => { }) }, [name]);
  const opts = useMemo(() => { const d = rep?.descriptives || []; const u = k => [...new Set(d.map(x => x[k]))]; return { network: u('network'), scenario: u('scenario'), metric: u('metric') } }, [rep]);
  if (!rep) return <p className="muted">Select a report.</p>;
  if (rep.kind === 'prediction') return <PredictionReport rep={rep} />;
  const rows = (rep.descriptives || []).filter(r => r.network === f.network && r.scenario === f.scenario && r.metric === f.metric);
  const tests = (rep.paired || []).filter(r => r.network === f.network && r.scenario === f.scenario && r.metric === f.metric);
  const m = rep.metrics?.[f.metric] || {};
  return <>
    <div className={'sync ' + (rep.matrix?.completed < rep.matrix?.planned ? 'warn' : '')}>Matrix: {rep.matrix?.completed} of {rep.matrix?.planned} planned runs completed, {rep.matrix?.failed} failed. {rep.matrix?.completed < rep.matrix?.planned ? 'INCOMPLETE - results cover completed cells only.' : ''}</div>
    <div className="form">{['network', 'scenario', 'metric'].map(k => <label key={k}>{k}<select value={f[k] || ''} onChange={e => setF({ ...f, [k]: e.target.value })}>{opts[k].map(o => <option key={o}>{o}</option>)}</select></label>)}</div>
    <p className="muted small"><b>{m.label}</b> ({m.unit}) - {m.definition}</p>
    <CiChart rows={rows} />
    <div className="tablewrap"><table><thead><tr><th>controller vs ref</th><th>pairs</th><th>mean diff</th><th>95 % CI of diff</th><th>change</th><th>test</th><th>p (Holm)</th><th>effect d<sub>z</sub></th><th>verdict</th></tr></thead>
      <tbody>{tests.map(t => <tr key={t.controller}><td>{t.controller} vs {t.reference}</td><td>{t.n_pairs}</td><td>{fmt(t.mean_diff)}</td><td>{fmt(t.diff_ci_low)} … {fmt(t.diff_ci_high)}</td><td>{fmt(t.rel_change_pct, 1)} %</td><td>{t.test}</td><td>{fmt(t.p_adjusted, 4)}</td><td>{fmt(t.effect_size_dz)}</td><td>{t.verdict}</td></tr>)}</tbody></table></div>
    {rep.notes && <ul className="muted small">{rep.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
  </>;
}

function PredictionReport({ rep }) {
  const hs = Object.entries(rep.metrics?.horizons || {}); const series = rep.series || [];
  const models = ['persistence', 'moving_average', 'linear_trend', 'ridge_ar'];
  return <>
    <p className="muted small">Held-out evaluation: trained on runs with seeds {rep.metrics?.split?.train_seeds?.join(', ')}, tested on seeds {rep.metrics?.split?.test_seeds?.join(', ')}. Target: {rep.metrics?.target}. These are historical results, not live predictions.</p>
    <div className="tablewrap"><table><thead><tr><th>horizon</th><th>model</th><th>type</th><th>n</th><th>MAE (veh)</th><th>RMSE (veh)</th><th>class acc.</th><th>macro-F1</th><th>latency µs</th></tr></thead>
      <tbody>{hs.flatMap(([h, hr]) => Object.entries(hr.models).map(([k, m]) => <tr key={h + k}><td>{hr.horizon_s} s</td><td>{k}{hr.best_baseline === k ? ' (best baseline)' : ''}</td><td>{m.learned ? 'learned (ridge AR)' : 'rule baseline'}</td><td>{m.n}</td><td>{fmt(m.mae, 3)}</td><td>{fmt(m.rmse, 3)}</td><td>{fmt(m.class_accuracy, 3)}</td><td>{fmt(m.class_macro_f1, 3)}</td><td>{fmt(m.latency_us_mean, 1)}</td></tr>))}</tbody></table></div>
    {series.length > 0 && <><h3>Predicted vs actual queue · {rep.series_label}</h3>
      <ResponsiveContainer width="100%" height={300}><LineChart data={series}><CartesianGrid stroke="#1c2634" /><XAxis dataKey="time" tick={axis} unit=" s" /><YAxis tick={axis} unit=" veh" width={60} /><Tooltip {...tip} /><Legend />
        <Line dataKey="actual" stroke="#eef2f7" strokeWidth={2} dot={false} />{models.map((m, i) => <Line key={m} dataKey={m} stroke={['#3987e5', '#d95926', '#199e70', '#9085e9'][i]} strokeWidth={2} dot={false} strokeDasharray={i === 0 ? '4 3' : undefined} />)}</LineChart></ResponsiveContainer></>}
  </>;
}

function MixedTraffic({ id }) {
  const [cmp, setCmp] = useState(null);
  useEffect(() => { setCmp(null); if (id) lab('/api/lab/runs/comparison?id=' + encodeURIComponent(id)).then(x => setCmp(normalise(x))).catch(() => { }) }, [id]);
  if (!cmp) return <p className="muted">Select a saved run.</p>;
  const sd = cmp.metadata?.scenario_definition || {}; const shares = sd.mix_shares || {}; const ctrls = Object.keys(cmp.controllers);
  const types = [...new Set(ctrls.flatMap(c => Object.keys(cmp.controllers[c]?.per_vtype || {})))];
  const comp = Object.entries(sd.expected_vehicles_by_type || sd.trips_by_type || {}).map(([k, v]) => ({ k, v }));
  return <>
    <div className="meta"><span>mix <b>{sd.vehicle_mix || 'cars_only (legacy)'}</b></span><span>persons generated <b>{sd.persons ?? 0}</b></span><span>lateral resolution <b>{sd.lateral_resolution ?? 'off'}</b></span></div>
    {comp.length > 0 && <><h3>Generated demand by vehicle type</h3>
      <ResponsiveContainer width="100%" height={200}><BarChart data={comp}><CartesianGrid stroke="#1c2634" vertical={false} /><XAxis dataKey="k" tick={axis} /><YAxis tick={axis} width={50} /><Tooltip {...tip} formatter={v => [fmt(v, 0), 'vehicles']} /><Bar dataKey="v" fill="#3987e5" radius={[4, 4, 0, 0]} maxBarSize={48} /></BarChart></ResponsiveContainer>
      <p className="muted small">Configured shares: {Object.entries(shares).map(([k, v]) => `${k} ${fmt(v * 100, 0)} %`).join(' · ')}. These are scenario assumptions, not observed counts of any real city.</p></>}
    <div className="tablewrap"><table><thead><tr><th>vehicle type</th>{ctrls.map(c => <th key={c} colSpan="3"><i className="dot" style={{ background: colorOf(c) }} />{c}</th>)}
      </tr><tr><th />{ctrls.map(c => <React.Fragment key={c}><th>arrived</th><th>time loss s</th><th>waits</th></React.Fragment>)}</tr></thead>
      <tbody>{types.map(t => <tr key={t}><td>{t}</td>{ctrls.map(c => { const v = cmp.controllers[c]?.per_vtype?.[t] || {}; return <React.Fragment key={c}><td>{v.n ?? '—'}</td><td>{fmt(v.average_time_loss_s, 1)}</td><td>{fmt(v.average_waiting_count, 2)}</td></React.Fragment> })}</tr>)}
        <tr><td>pedestrians</td>{ctrls.map(c => { const p = cmp.controllers[c]?.persons || {}; return <React.Fragment key={c}><td>{p.arrived ?? '—'}</td><td>{fmt(p.average_time_loss_s, 1)}</td><td /></React.Fragment> })}</tr></tbody></table></div>
    <p className="muted small">Limitations: SUMO has no auto-rickshaw class (modelled as a passenger vehicle with Bajaj RE dimensions); motorcycle filtering needs the sublane model; emissions for rickshaws use the passenger model. See docs/IMPLEMENTATION_STATUS.md.</p>
  </>;
}

export default function Results({ view }) {
  const runs = useRuns(), reports = useReports();
  const [runId, setRunId] = useState(''), [repName, setRepName] = useState('');
  useEffect(() => { if (!runId && runs.length) setRunId(runs[0].id) }, [runs]);
  useEffect(() => { if (!repName && reports.length) setRepName(view === 'prediction' ? (reports.find(r => r.includes('prediction')) || '') : (reports.find(r => !r.includes('prediction')) || '')) }, [reports, view]);
  const runPicker = <label>Saved run<select value={runId} onChange={e => setRunId(e.target.value)}>{runs.map(r => <option key={r.id} value={r.id}>{r.id} ({r.controllers.map(variantOfDir).join(', ')})</option>)}</select></label>;
  const repPicker = list => <label>Report<select value={repName} onChange={e => setRepName(e.target.value)}><option value="">—</option>{list.map(r => <option key={r}>{r}</option>)}</select></label>;
  if (view === 'mixed') return <section className="panel"><h2>Indian mixed traffic</h2><div className="form">{runPicker}</div><MixedTraffic id={runId} /></section>;
  if (view === 'prediction') return <section className="panel"><h2>Short-term prediction</h2><div className="form">{repPicker(reports.filter(r => r.includes('prediction')))}</div>{repName ? <EvaluationReport name={repName} /> : <p className="muted">No prediction report yet - run <code>python -m experiments.tools.prediction_report</code>.</p>}</section>;
  return <>
    <section className="panel"><h2>Controller comparison - evaluation report (multi-seed)</h2><div className="form">{repPicker(reports.filter(r => !r.includes('prediction')))}</div>{repName ? <EvaluationReport name={repName} /> : <p className="muted">No evaluation report yet - run <code>python -m experiments.tools.evaluate_matrix</code>.</p>}</section>
    <section className="panel"><h2>Controller comparison - single saved run</h2><div className="form">{runPicker}</div><SavedRun id={runId} /></section>
  </>;
}
