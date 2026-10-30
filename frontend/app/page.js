'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  Play,
  RefreshCw,
  Network,
  Clock3,
  ShieldCheck,
  Zap,
  ArrowRight,
  TrendingDown,
  Cpu,
  Gauge,
  Grid,
  MapPin,
  Layers,
  CheckCircle2,
  AlertTriangle,
  Car
} from 'lucide-react';
import { API, LAB, lab, fmt } from '@/lib/api';
import FuelSavedCard from '@/components/FuelSavedCard';
import RichDropdown from '@/components/RichDropdown';

const RICH_SCENARIOS = [
  {
    value: 'normal',
    label: 'Normal Flow',
    sub: 'Evenly distributed metropolitan baseline traffic',
    badge: 'BENCHMARK',
  },
  {
    value: 'rush-hour',
    label: 'Rush Hour Congestion',
    sub: 'Heavy peak-direction traffic with high ingress rates',
    badge: 'HIGH LOAD',
  },
  {
    value: 'uneven',
    label: 'Uneven Directional Demand',
    sub: 'Strong asymmetric pressure favoring arterial corridors',
    badge: 'ASYMMETRIC',
  },
  {
    value: 'sudden-congestion',
    label: 'Sudden Traffic Spike',
    sub: 'Rapid unpredicted surge testing pheromone responsiveness',
    badge: 'SURGE TEST',
  },
  {
    value: 'road-closure',
    label: 'Road Closure / Incident',
    sub: 'Blocked downstream edge forcing adaptive multi-agent rerouting',
    badge: 'INCIDENT',
  },
];

// [key, label, unit, lower is better]
const METRICS = [
  ['average_time_loss_s', 'Delay per vehicle', 's', true],
  ['average_travel_time_s', 'Travel time per vehicle', 's', true],
  ['max_queue', 'Max queue', 'veh', true],
  ['average_stops', 'Stops per vehicle', '', true],
  ['throughput', 'Vehicles served', 'veh', false],
];

const GRID_ARCHITECTURES = [
  {
    id: 'grid3x3',
    title: '3×3 Grid Network',
    scale: '9 Intersections (J1–J9)',
    description: 'The foundation research benchmark. 9 signalized intersections in a 3-row, 3-column mesh with 150m block lengths. Evaluates primary 4-way green wave coordination between cardinal neighbors.',
    highlight: 'Decentralized J1–J9 agents',
    badge: '9 AGENTS',
    color: '#38bdf8',
  },
  {
    id: 'grid5x5',
    title: '5×5 Arterial Grid',
    scale: '25 Intersections',
    description: 'Models a large urban district with 25 coordinated controllers. Evaluates multi-hop digital pheromone diffusion across 2-hop distances to suppress cascaded spillbacks before they paralyze upstream arterial corridors.',
    highlight: '2-hop pheromone diffusion',
    badge: '25 AGENTS',
    color: '#10b981',
  },
  {
    id: 'grid9x9',
    title: '9×9 Metropolitan Grid',
    scale: '81 Intersections',
    description: 'Metropolitan downtown scale with 81 autonomous agents. Solves the combinatorial explosion problem where centralized controllers fail, proving swarm intelligence scales in constant real-time latency.',
    highlight: 'True emergent coordination',
    badge: '81 AGENTS',
    color: '#8b5cf6',
  },
  {
    id: 'grid5x5_india',
    title: 'Indian Mixed Traffic Grid',
    scale: '25 Indian Nodes (LHD)',
    description: 'Realistic Indian urban conditions with Left-Hand Traffic (LHD), 2 lanes, pedestrian crosswalks, and mixed non-lane-based vehicle fleets (two-wheelers filtering through stopped queues, auto-rickshaws, buses).',
    highlight: 'Sublane motorcycle filtering',
    badge: 'MIXED MODES',
    color: '#f59e0b',
  },
  {
    id: 'osm_ghaziabad',
    title: 'Real-World Signal Map',
    scale: 'Any city · real OSM traffic lights',
    description: 'Every node is a traffic light mapped in OpenStreetMap, linked only by the real roads between signals. Pick any place, watch the swarm mesh run on it, or send the area to the SUMO lab to simulate it.',
    highlight: 'Nodes only where real signals stand',
    badge: 'OSM',
    color: '#f43f5e',
  },
];

export default function ExperimentsPage() {
  const [labHealth, setLabHealth] = useState('checking');
  const [backendHealth, setBackendHealth] = useState('checking');
  const [experiments, setExperiments] = useState([]);
  const [labRuns, setLabRuns] = useState([]);
  const [scenario, setScenario] = useState('normal');
  const [running, setRunning] = useState(false);
  const [selectedId, setSelectedId] = useState('normal/seed-42');
  const [selectedComparison, setSelectedComparison] = useState(null);
  const [error, setError] = useState('');
  const [activeGridTab, setActiveGridTab] = useState('grid3x3');

  // Check health and load runs from both Python Lab API and Spring Boot
  const load = useCallback(async () => {
    // 1. Check Python Lab API
    try {
      const lh = await lab('/api/lab/health');
      setLabHealth(lh.status === 'UP' ? 'ONLINE' : 'OFFLINE');
    } catch {
      setLabHealth('OFFLINE');
    }

    // 2. Check Java Backend
    try {
      const bh = await fetch(API + '/api/health');
      setBackendHealth(bh.ok ? 'ONLINE' : 'STANDBY');
      if (bh.ok) {
        const e = await fetch(API + '/api/experiments?limit=20');
        if (e.ok) setExperiments(await e.json());
      }
    } catch {
      setBackendHealth('STANDBY');
    }

    // 3. Load recorded simulation runs from Lab API
    try {
      const runs = await lab('/api/lab/runs');
      if (Array.isArray(runs)) {
        setLabRuns(runs);
        const hasNormal = runs.find(r => r.id === 'normal/seed-42');
        if (hasNormal && !selectedId) {
          setSelectedId('normal/seed-42');
        }
      }
    } catch (err) {
      console.warn('Could not load lab runs', err);
    }
  }, [selectedId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [load]);

  // Load comparison data when selectedId changes
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    lab('/api/lab/runs/comparison?id=' + encodeURIComponent(selectedId))
      .then(res => {
        if (active) setSelectedComparison(res);
      })
      .catch(() => {
        if (active) setSelectedComparison(null);
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  const chartData = useMemo(() => {
    if (!selectedComparison?.comparisons?.swarm) return [];
    const cmp = selectedComparison.comparisons.swarm;
    return METRICS.map(([key, label, unit, lowerBetter]) => {
      const x = cmp[key];
      if (x?.baseline == null || x?.swarm == null) return null;
      const base = Number(x.baseline);
      const swarm = Number(x.swarm);
      const change = base ? ((swarm - base) / Math.abs(base)) * 100 : 0;
      return { key, label, unit, lowerBetter, base, swarm, change, better: lowerBetter ? swarm < base : swarm > base };
    }).filter(Boolean);
  }, [selectedComparison]);

  const kpiHighlights = useMemo(() => {
    if (!selectedComparison?.comparisons?.swarm) return null;
    const cmp = selectedComparison.comparisons.swarm;
    return {
      delayImp: cmp.average_time_loss_s?.change_pct != null ? -cmp.average_time_loss_s.change_pct : null,
      queueImp: cmp.max_queue?.change_pct != null ? -cmp.max_queue.change_pct : null,
      co2Imp: cmp.co2_mg?.change_pct != null ? -cmp.co2_mg.change_pct : null,
      stopsImp: cmp.average_stops?.change_pct != null ? -cmp.average_stops.change_pct : null,
      fuelBase: cmp.fuel_mg?.baseline ?? selectedComparison.baseline?.fuel_mg,
      fuelSwarm: cmp.fuel_mg?.swarm ?? selectedComparison.swarm?.fuel_mg,
      co2Base: cmp.co2_mg?.baseline ?? selectedComparison.baseline?.co2_mg,
      co2Swarm: cmp.co2_mg?.swarm ?? selectedComparison.swarm?.co2_mg,
    };
  }, [selectedComparison]);

  const startQuickLabRun = async () => {
    setRunning(true);
    setError('');
    try {
      const spec = {
        kind: 'demo',
        network: 'grid3x3_legacy',
        scenario: scenario,
        seed: 42,
        controllers: ['fixed', 'swarm'],
        max_time: 200,
        realtime_factor: null,
      };
      await lab('/api/lab/jobs', {
        method: 'POST',
        body: JSON.stringify(spec),
      });
      await load();
      window.location.href = '/live';
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      {/* Overview Module Main Header */}
      <header className="app-main-header">
        <div>
          <span className="eyebrow">
            <span className="dot-pulse" />
            AI SWARM INTELLIGENCE CORE · SUMO MICROSCOPIC SIMULATOR
          </span>
          <h1>Traffic Swarm Intelligence Lab</h1>
          <p>Hybrid PSO + ACO Optimization · Multi-Agent Blackboard Coordination · Microscopic Real-Time SUMO Simulation</p>
        </div>
        <div className="header-meta-box">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="badge live">● SIMULATION READY</span>
            <span className="status" style={{ fontSize: 11 }}>v1.3.2-eval</span>
          </div>
          <span className="muted" style={{ fontSize: 12 }}>3×3 · 5×5 · 9×9 grids · any OpenStreetMap area</span>
        </div>
      </header>

      {/* Top Telemetry Cards */}
      <section className="grid telemetry-top-grid">
        <div className="card">
          <Activity size={22} />
          <div>
            <b>Simulation Engine</b>
            <p className="muted" style={{ margin: 0, fontSize: 11 }}>SUMO 1.27 + TraCI</p>
          </div>
          <span style={{ color: labHealth === 'ONLINE' ? '#10b981' : '#f43f5e' }}>
            ● {labHealth}
          </span>
        </div>

        <div className="card">
          <Cpu size={22} />
          <div>
            <b>Swarm Optimizer</b>
            <p className="muted" style={{ margin: 0, fontSize: 11 }}>Hybrid PSO + ACO</p>
          </div>
          <span style={{ color: '#38bdf8' }}>PORT 8001 UP</span>
        </div>

        <div className="card">
          <ShieldCheck size={22} />
          <div>
            <b>Safety Gate</b>
            <p className="muted" style={{ margin: 0, fontSize: 11 }}>Min-green & clearance</p>
          </div>
          <span style={{ color: '#10b981' }}>HARD GATED</span>
        </div>
      </section>

      {/* KPI Improvements Showcase Pill */}
      {kpiHighlights && (
        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
            gap: 14,
            marginBottom: 24,
          }}
        >
          <div className="mini" style={{ borderLeft: '3px solid #10b981' }}>
            <span className="muted" style={{ fontSize: 11 }}>MEAN DELAY REDUCTION</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <TrendingDown size={22} color="#10b981" />
              <b style={{ fontSize: 24, color: '#10b981', fontFamily: 'var(--font-display)' }}>
                {fmt(kpiHighlights.delayImp, 1)}%
              </b>
            </div>
            <span className="muted" style={{ fontSize: 11 }}>vs Fixed-time baseline</span>
          </div>

          <div className="mini" style={{ borderLeft: '3px solid #38bdf8' }}>
            <span className="muted" style={{ fontSize: 11 }}>QUEUE LENGTH REDUCTION</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <TrendingDown size={22} color="#38bdf8" />
              <b style={{ fontSize: 24, color: '#38bdf8', fontFamily: 'var(--font-display)' }}>
                {fmt(kpiHighlights.queueImp, 1)}%
              </b>
            </div>
            <span className="muted" style={{ fontSize: 11 }}>Less network backlog</span>
          </div>

          <div className="mini" style={{ borderLeft: '3px solid #f59e0b' }}>
            <span className="muted" style={{ fontSize: 11 }}>CO₂ EMISSIONS SAVINGS</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <Zap size={22} color="#f59e0b" />
              <b style={{ fontSize: 24, color: '#f59e0b', fontFamily: 'var(--font-display)' }}>
                {fmt(kpiHighlights.co2Imp, 1)}%
              </b>
            </div>
            <span className="muted" style={{ fontSize: 11 }}>Reduced idling stop/starts</span>
          </div>

          <div className="mini" style={{ borderLeft: '3px solid #8b5cf6' }}>
            <span className="muted" style={{ fontSize: 11 }}>STOPS PER VEHICLE</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <Gauge size={22} color="#8b5cf6" />
              <b style={{ fontSize: 24, color: '#8b5cf6', fontFamily: 'var(--font-display)' }}>
                {fmt(kpiHighlights.stopsImp, 1)}%
              </b>
            </div>
            <span className="muted" style={{ fontSize: 11 }}>Smoother green waves</span>
          </div>
        </section>
      )}

      {/* Quick Interactive Command Panel */}
      <section className="panel">
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 14 }}>
          <div>
            <h2>Simulation Command Center</h2>
            <p className="muted">
              Launch real-time microscopic SUMO simulation with Swarm Intelligence controllers.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' }}>
            {/* Rich Responsive Dropdown */}
            <div style={{ minWidth: 'min(260px, 100%)' }}>
              <RichDropdown
                options={RICH_SCENARIOS}
                value={scenario}
                onChange={setScenario}
                icon={Layers}
              />
            </div>
            <button
              disabled={running || labHealth !== 'ONLINE'}
              onClick={startQuickLabRun}
              style={{ whiteSpace: 'nowrap' }}
            >
              <Play size={15} color="#38bdf8" />
              {running ? 'Launching...' : 'Run Live Simulation'}
            </button>
            <button onClick={load} title="Refresh telemetry" aria-label="Refresh telemetry">
              <RefreshCw size={15} /> Refresh
            </button>
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        {/* Feature Navigation Cards */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))',
            gap: 14,
            marginTop: 18,
          }}
        >
          <Link href="/ghaziabad" className="mini feature-card-highlight" style={{ cursor: 'pointer', textDecoration: 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <b style={{ color: '#f43f5e', display: 'flex', alignItems: 'center', gap: 6 }}>
                <MapPin size={16} /> Real-World Signal Map
              </b>
              <span className="badge live" style={{ fontSize: 10 }}>OSM</span>
            </div>
            <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              Any city: real OpenStreetMap traffic signals, linked by real roads, with live swarm signal control.
            </p>
          </Link>

          <Link href="/live" className="mini" style={{ cursor: 'pointer', textDecoration: 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <b style={{ color: '#38bdf8' }}>Live Heatmap & Control</b>
              <ArrowRight size={16} color="#38bdf8" />
            </div>
            <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              Watch signalized junctions adapt phase timings dynamically as queues form.
            </p>
          </Link>

          <Link href="/demo" className="mini" style={{ cursor: 'pointer', textDecoration: 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <b style={{ color: '#10b981' }}>Side-by-Side Dual Demo</b>
              <ArrowRight size={16} color="#10b981" />
            </div>
            <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              Synchronized visual replay comparing Fixed-Time baseline against Swarm Intelligence.
            </p>
          </Link>

          <Link href="/controllers" className="mini" style={{ cursor: 'pointer', textDecoration: 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <b style={{ color: '#f59e0b' }}>Controller Comparison</b>
              <ArrowRight size={16} color="#f59e0b" />
            </div>
            <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              Statistical multi-seed evaluation across Actuated, Swarm, and Priority modes.
            </p>
          </Link>
        </div>
      </section>

      {/* Grid Architecture & Topological Science Section */}
      <section className="panel">
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Grid size={18} color="#38bdf8" />
              <h2>Grid Architectures & What They Mean</h2>
            </div>
            <p className="muted">
              How the multi-agent swarm scales from 9 intersections to 81 metropolitan nodes without centralized computational bottlenecks.
            </p>
          </div>
        </div>

        {/* Grid Selector Tabs */}
        <div className="grid-arch-tabs">
          {GRID_ARCHITECTURES.map(g => (
            <button
              key={g.id}
              className={`grid-tab-btn ${activeGridTab === g.id ? 'active' : ''}`}
              onClick={() => setActiveGridTab(g.id)}
            >
              <span className="dot" style={{ background: g.color }} />
              <b>{g.title.split(' ')[0]}</b>
              <span className="tab-badge">{g.badge}</span>
            </button>
          ))}
        </div>

        {/* Selected Grid Architecture Card */}
        {(() => {
          const sel = GRID_ARCHITECTURES.find(g => g.id === activeGridTab) || GRID_ARCHITECTURES[0];
          return (
            <div className="grid-arch-card" style={{ borderLeft: `4px solid ${sel.color}` }}>
              <div className="grid-card-top">
                <div>
                  <h3 style={{ margin: 0, color: '#f8fafc' }}>{sel.title}</h3>
                  <span className="scale-pill" style={{ color: sel.color }}>
                    {sel.scale}
                  </span>
                </div>
                <span className="badge" style={{ background: 'rgba(255,255,255,0.06)', color: '#f8fafc' }}>
                  {sel.highlight}
                </span>
              </div>
              <p className="grid-card-desc">{sel.description}</p>

              <div className="grid-mechanics-grid">
                <div className="mech-box">
                  <span className="muted small">DECENTRALIZED AGENTS</span>
                  <b>{sel.badge}</b>
                  <p className="small muted">Parallel PSO velocity updates every 5 seconds</p>
                </div>
                <div className="mech-box">
                  <span className="muted small">BLACKBOARD SHARING</span>
                  <b>Digital Pheromone τ</b>
                  <p className="small muted">Local neighbor queue pressure & green-wave bias</p>
                </div>
                <div className="mech-box">
                  <span className="muted small">COLLISION AVOIDANCE</span>
                  <b className="text-emerald">Zero Collisions</b>
                  <p className="small muted">Krauss IDM car-following + 10s min-green gate</p>
                </div>
              </div>
            </div>
          );
        })()}
      </section>

      {/* Selected Experiment KPI Chart */}
      {selectedComparison && (
        <section className="panel">
          <div className="toolbar">
            <div>
              <h2>Measured Benchmark: {selectedId}</h2>
              <p className="muted">
                Direct comparison between Fixed-Time Baseline (Blue) and Swarm Intelligence (Green) under identical traffic demands.
              </p>
            </div>
            <span className="status" style={{ color: '#10b981', marginLeft: 'auto' }}>
              SUMO VERIFIED · REAL RUN
            </span>
          </div>

          {chartData.length > 0 ? (
            // Each metric on its own scale: one shared axis hid every metric except throughput
            <div className="kpi-compare">
              {chartData.map(m => {
                const max = Math.max(m.base, m.swarm, 1e-9);
                const num = v => `${v >= 100 ? v.toFixed(0) : v.toFixed(2)}${m.unit ? ` ${m.unit}` : ''}`;
                return (
                  <div key={m.key} className="kpi-compare-row">
                    <div className="kpi-compare-head">
                      <span>{m.label}</span>
                      <b className={m.better ? 'good' : m.change === 0 ? '' : 'bad'}>
                        {m.change > 0 ? '+' : ''}{m.change.toFixed(1)}%
                      </b>
                      <small>{m.lowerBetter ? 'lower is better' : 'higher is better'}</small>
                    </div>
                    <div className="kpi-compare-bar"><span>Fixed-time</span><div><i style={{ width: `${(m.base / max) * 100}%`, background: '#38bdf8' }} /></div><b>{num(m.base)}</b></div>
                    <div className="kpi-compare-bar"><span>Swarm</span><div><i style={{ width: `${(m.swarm / max) * 100}%`, background: '#10b981' }} /></div><b>{num(m.swarm)}</b></div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted">Loading comparison data...</p>
          )}

          {/* Real-time Fuel Saved & Emissions Showcase */}
          <div style={{ marginTop: 20 }}>
            <FuelSavedCard
              baselineFuelMg={kpiHighlights?.fuelBase}
              swarmFuelMg={kpiHighlights?.fuelSwarm}
              baselineCo2Mg={kpiHighlights?.co2Base}
              swarmCo2Mg={kpiHighlights?.co2Swarm}
            />
          </div>

          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: 'pointer', color: '#94a3b8', fontSize: 13 }}>
              View Raw Telemetry JSON
            </summary>
            <pre style={{ marginTop: 8 }}>
              {JSON.stringify(selectedComparison.comparisons?.swarm || selectedComparison, null, 2)}
            </pre>
          </details>
        </section>
      )}

      {/* Experiment Artifacts & Comparison Section */}
      <section className="panel">
        <div className="toolbar">
          <h2>Measured Simulation Artifacts</h2>
          <span className="badge live">● 100% REAL SUMO TELEMETRY</span>
        </div>
        <p className="muted">
          Click any recorded experiment run to inspect measured metrics and comparative performance.
        </p>

        {labRuns.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>No experiment runs recorded yet.</p>
        ) : (
          <div className="table" style={{ marginTop: 14 }}>
            {labRuns.slice(0, 8).map(r => {
              const isSelected = r.id === selectedId;
              const hasBaselineAndSwarm =
                r.controllers?.includes('baseline') && r.controllers?.includes('swarm');
              return (
                <button
                  className={'row ' + (isSelected ? 'active' : '')}
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                >
                  <span style={{ fontWeight: 600, color: '#f8fafc' }}>
                    <Network size={15} color="#38bdf8" />
                    {r.id}
                  </span>
                  <span>
                    <Clock3 size={14} color="#94a3b8" />
                    {r.controllers?.join(' vs ') || 'eval run'}
                  </span>
                  <span>
                    {hasBaselineAndSwarm ? (
                      <span className="badge live" style={{ padding: '2px 8px', fontSize: 10 }}>
                        READY FOR REVIEW
                      </span>
                    ) : (
                      <span className="status" style={{ fontSize: 11 }}>
                        RAW ARTIFACT
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
