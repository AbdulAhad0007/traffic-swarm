'use client';

import React, { useEffect, useRef } from 'react';
import { X, Radio, Brain, Monitor, Fuel, Siren, MessageSquareQuote, Check, AlertCircle } from 'lucide-react';
import { CONFIG, FUEL } from '@/lib/swarmMesh';
import { useSections } from '@/components/SiteConfigProvider';

const RULES = [
  ['Emergency corridor', 'A locked junction forces Yellow → All-Red → the ambulance axis and holds it until the ambulance has passed.'],
  ['Minimum green', `Never cut a green shorter than ${CONFIG.min_green_s} s (pedestrian and start-up safety).`],
  ['Maximum green / anti-starvation', `Release after ${CONFIG.max_green_s} s of green, or when the other axis has been red for ${CONFIG.max_red_s} s with cars waiting.`],
  ['Platoon hold', 'If an announced platoon reaches this green within 3 s, keep it open so the platoon passes without stopping.'],
  ['Dead-green elimination', 'If the green approach is empty and nobody is announced, end it at once. A 2-car arm is drained in 6–8 s instead of a fixed 30 s.'],
  ['Pre-emptive switch', 'If a platoon of 3 or more vehicles is announced on the red axis within one transition (yellow + all-red + 1 s), switch now so green opens as it arrives.'],
  ['ACO-weighted pressure', 'Otherwise compare (queue + ½ × announced) × pheromone weight per axis, and switch only if the red side is clearly heavier (×1.5 + 3).'],
];

const QA = [
  ['Is this just an animation?',
    'No. Every number on the map comes from a running queue simulation. Two copies of the same city run side by side on the same vehicles: one with swarm agents, one with 30 s fixed timers. Fuel, CO₂, rupees, delay and ambulance delay are the measured differences between them.'],
  ['Where exactly is the intelligence?',
    'Inside each JunctionAgent. No central computer decides anything: a junction only sees its own queues plus the platoon alerts its neighbours send it, and decides its own signal from those.'],
  ['What is sent between junctions?',
    'A small telemetry packet: source, target, platoon size, ETA, approach direction and target speed. It is sent the moment vehicles clear the upstream junction, at least 4 s before the first car arrives.'],
  ['Where do ants and bees come in?',
    'ACO: every served vehicle reinforces a pheromone trail on its axis (τ ← τ + 0.1). It evaporates by 2% every second, so busy corridors gain weight and stale ones fade. PSO (bee/particle swarm) tunes green durations in the SUMO controller (optimizer/app/swarm/engine.py).'],
  ['What keeps it safe?',
    'Yellow and all-red always run their full duration. Minimum and maximum green and maximum red are hard limits. In SUMO, every change also goes through the SafetyGate, which re-checks the live signal state before applying it.'],
  ['What if a message is lost?',
    'The receiver just falls back to local queue control: it behaves like a good actuated signal and never like an unsafe one. The SUMO version has message loss, jitter and latency switches for exactly this test.'],
  ['Is the browser doing the deciding?',
    'In this web demo the agents run in your browser, using the same engine as the backend (simulation/swarm/junction_mesh.py). That engine is checked to give identical results and is also served by /api/lab/swarm/mesh. The browser only hosts the agents; each agent still decides from its own local data and messages. Full SUMO runs use the AdaptiveController with real signal programs.'],
  ['Limitations?',
    'Link travel times are compressed to 10–28 s so platoons are visible on screen. Each approach uses a single saturation flow. Fuel counts idling only (0.6 L/h for cars, 1.8 L/h for heavy vehicles), so acceleration losses are not included.'],
];

function LookaheadDiagram() {
  return (
    <svg viewBox="0 0 660 215" className="explainer-svg" role="img" aria-label="Lookahead platoon timeline between two junctions">
      <defs>
        <linearGradient id="exRoadGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--bg-elevated)" />
          <stop offset="100%" stopColor="var(--bg-surface)" />
        </linearGradient>
        <linearGradient id="exPlatoonGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--status-warn)" />
          <stop offset="100%" stopColor="var(--status-warn)" />
        </linearGradient>
        <filter id="exGlowCyan" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <marker id="exArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,1 L10,5 L0,9 z" fill="var(--accent)" />
        </marker>
      </defs>

      {/* Road asphalt background */}
      <rect x="50" y="78" width="560" height="36" rx="8" fill="url(#exRoadGrad)" stroke="var(--text-dim)" strokeWidth="1.2" />
      {/* Dashed highway center lane marking */}
      <line x1="60" y1="96" x2="600" y2="96" stroke="var(--text-muted)" strokeWidth="2" strokeDasharray="12 10" />

      {/* Inter-junction digital communication wave (drawn behind badge) */}
      <path d="M100,64 C230,16 430,16 560,64" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeDasharray="6 5" markerEnd="url(#exArrow)" filter="url(#exGlowCyan)" />

      {/* Solid Telemetry Packet Pill (opaque background prevents dashes passing through text) */}
      <g transform="translate(210, 10)">
        <rect x="0" y="0" width="240" height="34" rx="17" fill="var(--bg-surface)" stroke="var(--accent)" strokeWidth="1.6" filter="url(#exGlowCyan)" />
        <circle cx="16" cy="17" r="4.5" fill="var(--accent)" />
        <text x="30" y="21" fill="var(--text-primary)" fontSize="11.5" fontWeight="700" fontFamily="var(--font-mono, monospace)">
          alert: <tspan fill="var(--accent)">30 veh</tspan> · <tspan fill="var(--accent-3)">ETA 18s</tspan>
        </text>
      </g>

      {/* Moving platoon of vehicles */}
      {[165, 190, 215, 240, 265].map((x) => (
        <g key={x}>
          <rect x={x} y="88" width="16" height="15" rx="3.5" fill="url(#exPlatoonGrad)" stroke="var(--status-warn)" strokeWidth="1" />
          <rect x={x + 3} y="92" width="6" height="7" rx="1" fill="var(--status-warn)" opacity="0.6" />
        </g>
      ))}
      <rect x="155" y="112" width="135" height="18" rx="4" fill="color-mix(in srgb, var(--status-warn) 15%, transparent)" stroke="color-mix(in srgb, var(--status-warn) 40%, transparent)" />
      <text x="222" y="125" textAnchor="middle" fill="var(--status-warn)" fontSize="10.5" fontWeight="700">
        🚗 Coordinated Platoon
      </text>

      {/* Junction Nodes J1 and J2 */}
      <g transform="translate(85, 96)">
        <circle cx="0" cy="0" r="25" fill="var(--bg-sunken)" stroke="var(--status-ok)" strokeWidth="3" filter="drop-shadow(0 0 8px color-mix(in srgb, var(--status-ok) 50%, transparent))" />
        <text x="0" y="5" textAnchor="middle" fill="var(--text-primary)" fontSize="13" fontWeight="800" fontFamily="var(--font-mono, monospace)">J1</text>
        <text x="0" y="44" textAnchor="middle" fill="var(--status-ok)" fontSize="12" fontWeight="700">Hapur Chungi</text>
        <text x="0" y="58" textAnchor="middle" fill="var(--text-muted)" fontSize="10">Origin Junction</text>
      </g>

      <g transform="translate(575, 96)">
        <circle cx="0" cy="0" r="25" fill="var(--bg-sunken)" stroke="var(--status-warn)" strokeWidth="3" filter="drop-shadow(0 0 8px color-mix(in srgb, var(--status-warn) 50%, transparent))" />
        <text x="0" y="5" textAnchor="middle" fill="var(--text-primary)" fontSize="13" fontWeight="800" fontFamily="var(--font-mono, monospace)">J2</text>
        <text x="0" y="44" textAnchor="middle" fill="var(--status-warn)" fontSize="12" fontWeight="700">Old Bus Stand</text>
        <text x="0" y="58" textAnchor="middle" fill="var(--text-muted)" fontSize="10">Downstream Agent</text>
      </g>

      {/* Timeline bottom bar */}
      <line x1="85" y1="184" x2="575" y2="184" stroke="var(--text-dim)" strokeWidth="2" strokeDasharray="4 4" />
      {[
        { x: 85, t: 't = 0s', desc: 'Cleared J1 → alert sent' },
        { x: 330, t: 't = 1s', desc: 'J2 plans 14s green window' },
        { x: 575, t: 't = 18s', desc: 'Platoon glides on green' }
      ].map(pt => (
        <g key={pt.x} transform={`translate(${pt.x}, 184)`}>
          <circle cx="0" cy="0" r="5" fill="var(--accent)" stroke="var(--bg-sunken)" strokeWidth="2" />
          <text x="0" y="16" textAnchor="middle" fill="var(--accent)" fontSize="11" fontWeight="700" fontFamily="var(--font-mono, monospace)">{pt.t}</text>
          <text x="0" y="27" textAnchor="middle" fill="var(--text-secondary)" fontSize="10">{pt.desc}</text>
        </g>
      ))}
    </svg>
  );
}

function PheromoneDiagram() {
  return (
    <svg viewBox="0 0 660 160" className="explainer-svg" role="img" aria-label="Pheromone-weighted axis pressure">
      <defs>
        <linearGradient id="exPheroNS" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--status-ok)" />
          <stop offset="100%" stopColor="var(--status-ok)" />
        </linearGradient>
        <linearGradient id="exPheroEW" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--accent)" />
          <stop offset="100%" stopColor="var(--accent)" />
        </linearGradient>
      </defs>

      {/* Pheromone Levels Left Side */}
      <g transform="translate(24, 22)">
        <text x="0" y="0" fill="var(--text-secondary)" fontSize="11" fontWeight="700" style={{ letterSpacing: "0.05em" }}>DIGITAL PHEROMONE CONCENTRATION (τ)</text>

        {/* NS Corridor */}
        <rect x="0" y="14" width="280" height="24" rx="6" fill="var(--bg-surface)" stroke="var(--bg-elevated)" />
        <rect x="0" y="14" width="220" height="24" rx="6" fill="url(#exPheroNS)" />
        <text x="10" y="30" fill="color-mix(in srgb, var(--status-ok) 16%, var(--bg-surface))" fontSize="12" fontWeight="800">τ NS: High Density Corridor (82%)</text>

        {/* EW Corridor */}
        <rect x="0" y="46" width="280" height="24" rx="6" fill="var(--bg-surface)" stroke="var(--bg-elevated)" />
        <rect x="0" y="46" width="85" height="24" rx="6" fill="url(#exPheroEW)" />
        <text x="10" y="62" fill="var(--bg-surface)" fontSize="12" fontWeight="800">τ EW: Moderate (28%)</text>

        {/* Update Rule Formula */}
        <rect x="0" y="80" width="280" height="34" rx="6" fill="color-mix(in srgb, var(--text-primary) 3%, transparent)" stroke="color-mix(in srgb, var(--text-primary) 8%, transparent)" />
        <text x="10" y="96" fill="var(--accent)" fontSize="10.5" fontFamily="var(--font-mono, monospace)" fontWeight="600">τ ← (1 − 0.02)·τ + 0.1 · served</text>
        <text x="10" y="108" fill="var(--text-muted)" fontSize="9.5">Evaporates 2%/s · Reinforced per served vehicle</text>
      </g>

      {/* Decision Formulas Right Side */}
      <g transform="translate(340, 22)">
        <text x="0" y="0" fill="var(--text-secondary)" fontSize="11" fontWeight="700" style={{ letterSpacing: "0.05em" }}>DYNAMIC AXIS PRESSURE WEIGHTING</text>

        <g transform="translate(0, 14)">
          <rect x="0" y="0" width="295" height="100" rx="8" fill="color-mix(in srgb, var(--accent-3) 6%, transparent)" stroke="color-mix(in srgb, var(--accent-3) 25%, transparent)" />
          <text x="14" y="24" fill="var(--accent-3-soft)" fontSize="11" fontFamily="var(--font-mono, monospace)">
            w_axis = 0.8 + 0.4 · (τ_axis / Σ τ)
          </text>
          <text x="14" y="46" fill="var(--text-primary)" fontSize="11" fontFamily="var(--font-mono, monospace)">
            P_axis = (queue + ½ · announced) · w_axis
          </text>
          <text x="14" y="68" fill="var(--status-ok)" fontSize="11" fontFamily="var(--font-mono, monospace)" fontWeight="700">
            Switch if: P_red &gt; 1.5 · P_green + 3
          </text>
          <text x="14" y="88" fill="var(--text-secondary)" fontSize="10">
            Busy corridors automatically gain weight for continuous green waves.
          </text>
        </g>
      </g>
    </svg>
  );
}

export default function SwarmExplainerModal({ open: requested, onClose }) {
  const { on, moduleOn } = useSections('how-it-works');
  const open = requested && moduleOn('how-it-works');
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = e => { if (e.key === 'Escape') onCloseRef.current(); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!open) return null;

  return (
    <div className="explainer-backdrop" onClick={onClose}>
      <div className="explainer-modal" role="dialog" aria-modal="true" aria-labelledby="explainer-title" onClick={e => e.stopPropagation()}>
        <header className="explainer-head">
          <div className="explainer-head-left">
            <span className="explainer-eyebrow">
              <Brain size={14} color="var(--accent)" />
              HOW IT WORKS · CONCEPT &amp; ALGORITHM STORY
            </span>
            <h2 id="explainer-title">
              How Swarm Intelligence Works
            </h2>
          </div>
          <button ref={closeRef} className="explainer-close" onClick={onClose} aria-label="Close explainer" title="Close (Esc)">
            <X size={20} strokeWidth={2.5} />
          </button>
        </header>

        <div className="explainer-body">
          {/* Compare Cards */}
          {on('compare-cards') && <section className="explainer-compare">
            <div className="explainer-card muted-card">
              <div className="card-badge-row">
                <span className="card-badge red">STATIC BASELINE</span>
              </div>
              <h3><Monitor size={17} color="var(--status-danger)" /> Traditional Fixed Timer</h3>
              <ul className="explainer-list">
                <li><b>Fixed 30s cycle:</b> 30 seconds green per direction, every cycle, regardless of traffic backlog.</li>
                <li><b>Dead-green waste:</b> Green continues running over empty pavement while cross-streets build up long queues.</li>
                <li><b>Zero communication:</b> Junctions operate blind in silos; platoons leaving one green inevitably slam into red lights downstream.</li>
                <li><b>Heavy fuel burn:</b> Every unnecessary halt causes 20–45s of engine idling and high stop-and-go emissions.</li>
              </ul>
            </div>

            <div className="explainer-card accent-card">
              <div className="card-badge-row">
                <span className="card-badge green">DISTRIBUTED MULTI-AGENT</span>
              </div>
              <h3><Brain size={17} color="var(--status-ok)" /> Swarm JunctionAgents</h3>
              <ul className="explainer-list">
                <li><b>Autonomous agents:</b> Each intersection is a self-governing agent with zero central point of failure.</li>
                <li><b>Lookahead sensory horizon:</b> Monitors local queue pressure and listens to arrival alerts broadcast by neighbors.</li>
                <li><b>Green wave sync:</b> Pre-emptively clears traffic lights as announced vehicle platoons approach, letting traffic glide smoothly.</li>
                <li><b>Dead-green truncation:</b> Automatically cuts empty greens within 6 seconds to donate green time to congested approaches.</li>
              </ul>
            </div>
          </section>}

          {/* Lookahead Platooning Section */}
          {on('lookahead') && <section>
            <h3 className="explainer-h"><Radio size={16} color="var(--accent)" /> Lookahead Platooning (The &quot;Hapur Chungi&quot; Idea)</h3>
            <LookaheadDiagram />
            
            <div className="explainer-packet-card">
              <div className="packet-head">
                <span className="packet-badge">📡 INTER-AGENT TELEMETRY PACKET</span>
                <span className="packet-timing">Sent ≥ 4s prior to vehicle arrival</span>
              </div>
              <p className="explainer-p" style={{ margin: '0 0 10px' }}>
                When J1 releases 50 cars, it counts where they turn (e.g. 30 straight, 10 left, 10 right) and immediately broadcasts an anticipatory packet downstream:
              </p>
              <pre className="packet-code">
                <code>{`{
  "source": "J1_Hapur_Chungi",
  "target": "J2_Old_Bus_Stand",
  "platoon_size": 30,
  "estimated_arrival_sec": 18,
  "approaching_direction": "NS",
  "target_speed_kmh": 42
}`}</code>
              </pre>
              <p className="explainer-p" style={{ margin: '8px 0 0', fontSize: '12px', color: 'var(--text-secondary)' }}>
                💡 <b>J2 receives this before vehicles physically arrive</b> and coordinates an adaptive green window tailored to the platoon spread plus a 3-second safety clearance.
              </p>
            </div>
          </section>}

          {/* Architecture Flow */}
          {on('architecture-flow') && <section>
            <h3 className="explainer-h"><Monitor size={16} color="var(--accent-3)" /> Display vs. Decentralized Decision Making</h3>
            <div className="explainer-flow">
              <div>
                <b>Local Sensors</b>
                <span>Radar &amp; induction loops measure queue per lane approach</span>
              </div>
              <span className="flow-arrow">→</span>
              <div className="flow-agent">
                <b>JunctionAgent ×N</b>
                <span>Decentralized rules + ACO pheromones + neighbor platoon inbox</span>
              </div>
              <span className="flow-arrow">⇄</span>
              <div>
                <b>Mesh Channel</b>
                <span>send_platoon_alert(target, count, eta, direction)</span>
              </div>
              <span className="flow-arrow">→</span>
              <div>
                <b>Map / Dashboard</b>
                <span>Only <i>displays</i> agent telemetry; never centralizes control</span>
              </div>
            </div>
            <p className="explainer-p">
              The dashboard never acts as a central brain. It simply visualizes what individual agents have decided. Each agent decides strictly from its own local detectors and incoming neighbor packets.
            </p>
          </section>}

          {/* ACO Pheromone Corridor Weighting */}
          {on('aco-weighting') && <section>
            <h3 className="explainer-h"><Brain size={16} color="var(--status-ok)" /> ACO Pheromone Corridor Weighting</h3>
            <PheromoneDiagram />
            <ol className="explainer-rules">
              {RULES.map(([t, d]) => (
                <li key={t}>
                  <b>{t}:</b> {d}
                </li>
              ))}
            </ol>
          </section>}

          {/* Fuel & Ambulance Impact */}
          {(on('fuel-savings') || on('ambulance-wave')) && <section className="explainer-compare">
            {on('fuel-savings') && <div className="explainer-card">
              <h3><Fuel size={16} color="var(--accent-3-soft)" /> Fuel, CO₂ &amp; Economic Savings</h3>
              <ul className="explainer-list">
                <li><b>Idling baseline:</b> {FUEL.car_idle_lph} L/h per passenger car, {FUEL.heavy_idle_lph} L/h per heavy commercial vehicle.</li>
                <li><code>litres = Σ idle_seconds_saved × rate / 3600</code></li>
                <li><code>CO₂ kg = litres × {FUEL.co2_kg_per_l}</code> · <code>₹ saved = litres × ₹{FUEL.inr_per_l}</code></li>
                <li><b>Delay improvement:</b> Measured as <code>1 − (swarm_idle / fixed_idle)</code> on identical traffic demand.</li>
              </ul>
            </div>}
            {on('ambulance-wave') && <div className="explainer-card">
              <h3><Siren size={16} color="var(--status-danger)" /> Ambulance Emergency Green Wave</h3>
              <ul className="explainer-list">
                <li><b>Early corridor preemption:</b> Broadcast along the whole corridor immediately upon siren detection.</li>
                <li><b>Pre-arrival phase locking:</b> Intersections transition safely (Yellow → All-Red → Corridor Green) 15s before arrival.</li>
                <li><b>Hard safety hold:</b> Conflicting traffic remains red until ambulance transit is confirmed, then releases gracefully.</li>
                <li><b>Measured impact:</b> Zero halting delay along primary response routes.</li>
              </ul>
            </div>}
          </section>}

          {/* FAQ / Evaluator Answers */}
          {on('evaluator-qa') && <section>
            <h3 className="explainer-h"><MessageSquareQuote size={16} color="var(--accent)" /> Ready Answers for Project Evaluators &amp; Defense</h3>
            <dl className="explainer-qa">
              {QA.map(([q, a]) => (
                <div key={q}>
                  <dt>{q}</dt>
                  <dd>{a}</dd>
                </div>
              ))}
            </dl>
          </section>}
        </div>
      </div>
    </div>
  );
}
