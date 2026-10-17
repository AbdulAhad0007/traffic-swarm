'use client';

import React from 'react';
import { Fuel, Leaf, IndianRupee, TrendingDown, OctagonX, Siren, Timer } from 'lucide-react';
import { FUEL } from '@/lib/swarmMesh';

const n = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));

function Tile({ icon: Icon, color, label, value, unit, sub }) {
  return (
    <div className="impact-tile">
      <div className="impact-tile-label"><Icon size={14} color={color} /> {label}</div>
      <div className="impact-tile-value" style={{ color }}>{value}<span>{unit}</span></div>
      {sub && <div className="impact-tile-sub">{sub}</div>}
    </div>
  );
}

function Bar({ label, fixed, swarm, unit }) {
  const max = Math.max(fixed, swarm, 1e-9);
  return (
    <div className="impact-bar">
      <div className="impact-bar-label">{label}</div>
      <div className="impact-bar-row"><span>Static 30 s</span><div><i style={{ width: `${(fixed / max) * 100}%`, background: '#f43f5e' }} /></div><b>{n(fixed)} {unit}</b></div>
      <div className="impact-bar-row"><span>Swarm</span><div><i style={{ width: `${(swarm / max) * 100}%`, background: '#10b981' }} /></div><b>{n(swarm)} {unit}</b></div>
    </div>
  );
}

/** Live fuel / CO₂ / ₹ / delay telemetry: measured swarm vs static-timer difference on identical demand. */
export default function SwarmImpactPanel({ fuel, emergency, simSeconds, cityName }) {
  if (!fuel) return null;
  const mins = Math.floor(simSeconds / 60);
  return (
    <section className="panel impact-panel">
      <div className="impact-head">
        <div>
          <h3>Real-time fuel saved &amp; CO₂ reduction · {cityName}</h3>
          <p className="muted small">
            Measured over {mins} min {simSeconds % 60} s of simulated traffic. The swarm and static-timer meshes get the same vehicles. Idling rates:
            {' '}{FUEL.car_idle_lph} L/h per car, {FUEL.heavy_idle_lph} L/h per heavy vehicle.
          </p>
        </div>
      </div>
      <div className="impact-grid">
        <Tile icon={Fuel} color="#a855f7" label="Fuel saved" value={n(fuel.liters_fuel_saved, 2)} unit=" L"
          sub={`${n(fuel.idle_seconds_saved / 3600, 1)} engine-hours of idling avoided`} />
        <Tile icon={Leaf} color="#10b981" label="CO₂ prevented" value={n(fuel.co2_kg_prevented, 2)} unit=" kg" sub={`litres × ${FUEL.co2_kg_per_l} kg/L`} />
        <Tile icon={IndianRupee} color="#fbbf24" label="Money saved" value={`₹${n(fuel.rupees_saved, 0)}`} unit="" sub={`litres × ₹${FUEL.inr_per_l}/L`} />
        <Tile icon={TrendingDown} color="#38bdf8" label="Avg delay reduction" value={n(fuel.average_delay_reduction_pct, 1)} unit=" %" sub="idle s per junction passage" />
        <Tile icon={OctagonX} color="#f59e0b" label="Stops avoided" value={n(Math.max(0, fuel.stops_avoided), 0)} unit=""
          sub={`${n(fuel.stops_per_passage.fixed * 100, 0)}% → ${n(fuel.stops_per_passage.swarm * 100, 0)}% of passages stop`} />
        <Tile icon={Siren} color="#f43f5e" label="Ambulance signal delay"
          value={emergency ? `${emergency.swarm.delay_s}s` : '—'} unit=""
          sub={emergency ? `static timer: ${emergency.fixed.delay_s}s${emergency.fixed.done ? '' : ' (still en route)'}` : 'trigger the corridor on the map'} />
      </div>
      <div className="impact-bars">
        <Bar label={<><Timer size={13} /> Idle per stopped vehicle</>} fixed={fuel.avg_idle_per_stopped_vehicle_s.fixed} swarm={fuel.avg_idle_per_stopped_vehicle_s.swarm} unit="s" />
        <Bar label={<><Fuel size={13} /> Fuel burnt idling</>} fixed={fuel.idle_liters.fixed} swarm={fuel.idle_liters.swarm} unit="L" />
      </div>
    </section>
  );
}
