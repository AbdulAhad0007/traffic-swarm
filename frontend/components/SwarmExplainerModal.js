'use client';

import React, { useEffect, useRef } from 'react';
import { X, Radio, Brain, Monitor, Fuel, Siren, MessageSquareQuote } from 'lucide-react';
import { CONFIG, FUEL } from '@/lib/swarmMesh';

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
    <svg viewBox="0 0 640 210" className="explainer-svg" role="img" aria-label="Lookahead platoon timeline between two junctions">
      <defs>
        <marker id="exArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--accent-cyan)" />
        </marker>
      </defs>
      <line x1="80" y1="95" x2="560" y2="95" stroke="#334155" strokeWidth="14" strokeLinecap="round" />
      <line x1="80" y1="95" x2="560" y2="95" stroke="#475569" strokeWidth="1.5" strokeDasharray="10 10" />
      {[80, 560].map((x, i) => (
        <g key={x}>
          <circle cx={x} cy="95" r="26" fill="#0b1220" stroke={i === 0 ? '#10b981' : '#f59e0b'} strokeWidth="3" />
          <text x={x} y="100" textAnchor="middle" fill="#f8fafc" fontSize="14" fontWeight="700">{i === 0 ? 'J1' : 'J2'}</text>
          <text x={x} y="145" textAnchor="middle" fill="#94a3b8" fontSize="12">{i === 0 ? 'Hapur Chungi' : 'Old Bus Stand'}</text>
        </g>
      ))}
      <path d="M110,60 C220,20 420,20 530,60" fill="none" stroke="var(--accent-cyan)" strokeWidth="2" strokeDasharray="5 5" markerEnd="url(#exArrow)" />
      <rect x="230" y="14" width="180" height="30" rx="8" fill="rgba(56,189,248,0.12)" stroke="rgba(56,189,248,0.5)" />
      <text x="320" y="34" textAnchor="middle" fill="#7dd3fc" fontSize="12" fontWeight="600">alert: 30 veh · ETA 18 s</text>
      {[150, 170, 190, 210, 230].map(x => <rect key={x} x={x} y="89" width="12" height="12" rx="3" fill="#fbbf24" />)}
      <text x="190" y="125" textAnchor="middle" fill="#fbbf24" fontSize="12">platoon</text>
      <g fontSize="11" fill="#cbd5e1">
        <text x="80" y="178">t=0 cleared J1 → alert sent</text>
        <text x="250" y="178">t=1 J2 receives, plans 14 s green</text>
        <text x="455" y="178">t=18 arrives on green</text>
      </g>
      <line x1="80" y1="190" x2="560" y2="190" stroke="#334155" />
      {[80, 250, 520].map(x => <circle key={x} cx={x} cy="190" r="4" fill="var(--accent-cyan)" />)}
    </svg>
  );
}

function PheromoneDiagram() {
  return (
    <svg viewBox="0 0 640 150" className="explainer-svg" role="img" aria-label="Pheromone-weighted axis pressure">
      <g transform="translate(20,20)">
        <text x="0" y="0" fill="#94a3b8" fontSize="12">pheromone per axis</text>
        <rect x="0" y="14" width="250" height="20" rx="6" fill="#1e293b" />
        <rect x="0" y="14" width="190" height="20" rx="6" fill="rgba(16,185,129,0.75)" />
        <text x="8" y="29" fill="#022c22" fontSize="12" fontWeight="700">τ NS (busy corridor)</text>
        <rect x="0" y="44" width="250" height="20" rx="6" fill="#1e293b" />
        <rect x="0" y="44" width="70" height="20" rx="6" fill="rgba(56,189,248,0.75)" />
        <text x="8" y="59" fill="#082f49" fontSize="12" fontWeight="700">τ EW</text>
        <text x="0" y="96" fill="#cbd5e1" fontSize="12">τ ← (1 − 0.02)·τ + 0.1 · served vehicles   (every second)</text>
      </g>
      <g transform="translate(320,30)" fontSize="12" fill="#cbd5e1">
        <text x="0" y="0">w_axis = 0.8 + 0.4 · τ_axis / Σ τ</text>
        <text x="0" y="26">P_axis = (queue + ½ · announced) · w_axis</text>
        <text x="0" y="52">switch if P_red &gt; 1.5 · P_green + 3</text>
        <text x="0" y="84" fill="#94a3b8">Busy corridors get a little more weight, so</text>
        <text x="0" y="100" fill="#94a3b8">green waves line up along them.</text>
      </g>
    </svg>
  );
}

export default function SwarmExplainerModal({ open, onClose }) {
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
          <div>
            <span className="explainer-eyebrow">Concept &amp; algorithm story</span>
            <h2 id="explainer-title">How swarm intelligence works</h2>
          </div>
          <button ref={closeRef} className="explainer-close" onClick={onClose} aria-label="Close explainer"><X size={18} /></button>
        </header>

        <div className="explainer-body">
          <section className="explainer-compare">
            <div className="explainer-card muted-card">
              <h3><Monitor size={16} /> Traditional fixed timer</h3>
              <ul>
                <li>30 s green per direction, every cycle, whatever the traffic.</li>
                <li>Green runs over empty road while the cross street queues.</li>
                <li>Junctions don&apos;t talk to each other, so a platoon that just got a green hits the next red.</li>
                <li>Every stop means 20–45 s of idling engines.</li>
              </ul>
            </div>
            <div className="explainer-card accent-card">
              <h3><Brain size={16} /> Swarm JunctionAgents</h3>
              <ul>
                <li>Each signal is an autonomous agent. There is no central controller.</li>
                <li>It sees its own queues and hears its neighbours&apos; platoon alerts.</li>
                <li>It opens green as an announced platoon arrives, so cars glide through.</li>
                <li>It ends dead greens after 6 s and gives the time to the busy side.</li>
              </ul>
            </div>
          </section>

          <section>
            <h3 className="explainer-h"><Radio size={16} /> Lookahead platooning (the &quot;Hapur Chungi&quot; idea)</h3>
            <LookaheadDiagram />
            <p className="explainer-p">
              When J1 releases 50 cars, it counts where they turn (for example 30 straight, 10 left, 10 right). It then sends each
              downstream junction a packet: <code>{'{source, target, platoon_size: 30, estimated_arrival_sec: 18, approaching_direction, target_speed_kmh: 42}'}</code>.
              J2 gets this before the cars do and schedules a green window from the platoon&apos;s spread, plus 3 s.
            </p>
          </section>

          <section>
            <h3 className="explainer-h"><Monitor size={16} /> Display vs. decision making</h3>
            <div className="explainer-flow">
              <div><b>Sensors</b><span>queue per approach</span></div>
              <span className="flow-arrow">→</span>
              <div className="flow-agent"><b>JunctionAgent ×N</b><span>local rules + inbox of neighbour alerts</span></div>
              <span className="flow-arrow">⇄</span>
              <div><b>Neighbour channel</b><span>send_platoon_alert(target, count, eta)</span></div>
              <span className="flow-arrow">→</span>
              <div><b>Map / terminal</b><span>only <i>displays</i> agent state</span></div>
            </div>
            <p className="explainer-p">
              The map never makes a decision. It draws what each agent decided and the messages they exchanged.
              Each agent decides using only its own queues and its inbox. That is what makes the system distributed.
            </p>
          </section>

          <section>
            <h3 className="explainer-h"><Brain size={16} /> ACO pheromone corridor weighting</h3>
            <PheromoneDiagram />
            <ol className="explainer-rules">
              {RULES.map(([t, d]) => <li key={t}><b>{t}.</b> {d}</li>)}
            </ol>
          </section>

          <section className="explainer-compare">
            <div className="explainer-card">
              <h3><Fuel size={16} /> Fuel, CO₂ &amp; money</h3>
              <ul>
                <li>Idling rate: {FUEL.car_idle_lph} L/h per car, {FUEL.heavy_idle_lph} L/h per heavy vehicle.</li>
                <li><code>litres = Σ idle_seconds_saved × rate / 3600</code></li>
                <li><code>CO₂ kg = litres × {FUEL.co2_kg_per_l}</code>, <code>₹ = litres × {FUEL.inr_per_l}</code></li>
                <li>Delay reduction = 1 − (swarm idle per passage ÷ fixed idle per passage).</li>
              </ul>
            </div>
            <div className="explainer-card">
              <h3><Siren size={16} /> Ambulance green wave</h3>
              <ul>
                <li>The override is broadcast along the whole corridor as soon as the ambulance is detected.</li>
                <li>Each junction locks 15 s before the ambulance arrives: Yellow → All-Red → corridor green.</li>
                <li>Cross traffic stays red until the ambulance passes. Then the lock is released.</li>
                <li>Its signal delay is measured against the same trip under fixed timers.</li>
              </ul>
            </div>
          </section>

          <section>
            <h3 className="explainer-h"><MessageSquareQuote size={16} /> Ready answers for evaluators</h3>
            <dl className="explainer-qa">
              {QA.map(([q, a]) => (
                <div key={q}><dt>{q}</dt><dd>{a}</dd></div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
