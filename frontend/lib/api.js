// API base URLs — proxied through Next.js API routes to avoid CORS
export const API = '/api/proxy';
export const LAB = '/api/lab';

export async function lab(path, opts = {}) {
  const r = await fetch(LAB + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || body.message || body.error || r.statusText);
  return body;
}

// Colour follows the controller (entity), never its position in a list. Validated dark categorical slots.
export const CONTROLLER_ORDER = ['fixed', 'actuated', 'swarm', 'fixed_priority', 'swarm_priority', 'swarm_no_blackboard', 'swarm_no_pheromone', 'swarm_prediction'];
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
export const colorOf = c => SERIES[Math.max(0, CONTROLLER_ORDER.indexOf(c)) % SERIES.length];
// Saved runs store the fixed-time controller under 'baseline/'.
export const DIR_TO_VARIANT = { baseline: 'fixed' };
export const variantOfDir = d => DIR_TO_VARIANT[d] || d;

// Status palette for congestion levels - always shown with the level name, never colour alone.
export const LEVEL_COLORS = { free: '#0ca30c', light: '#fab219', heavy: '#ec835a', severe: '#d03b3b', no_data: '#5b6575' };

// KPI definitions shown in tables (units match simulation/metrics.py and simulation/telemetry.py).
export const KPIS = [
  ['average_time_loss_s', 'Mean delay (SUMO timeLoss)', 's/veh', true],
  ['average_travel_time_s', 'Mean travel time', 's/veh', true],
  ['average_queue', 'Mean network queue', 'veh', true],
  ['max_queue', 'Max network queue', 'veh', true],
  ['average_stops', 'Stops per vehicle', 'stops/veh', true],
  ['vehicles_arrived', 'Arrived vehicles', 'veh', false],
  ['fuel_mg', 'Fuel (all vehicles)', 'mg', true],
  ['co2_mg', 'CO₂ (all vehicles)', 'mg', true],
  ['teleports', 'Teleports', 'count', true],
];
export const fmt = (v, d = 2) => v == null || Number.isNaN(v) ? '—' : (Math.abs(v) >= 1e5 ? Number(v).toExponential(2) : Number(v).toFixed(d));
