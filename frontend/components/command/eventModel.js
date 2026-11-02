// Journal events on the simulation clock: what is in flight at time T, plain-language text, emergency state and the
// guided story. No Cesium or React here. Everything is derived from recorded events, so pausing or replaying stays exact.
export const PACKET_S = 2.5;   // Display time only: messages reach neighbours within one simulation step.

export const CATEGORIES = [
  ['traffic', 'Incoming traffic'],
  ['proposal', 'Signal responses'],
  ['congestion', 'Congestion alerts'],
  ['central', 'Central coordination'],
  ['signal', 'Signal changes'],
  ['emergency', 'Emergency priority'],
  ['health', 'Agent failures'],
];

const CATEGORY = {
  platoon_alert: 'traffic',
  response: 'proposal',
  spillback_warning: 'congestion', spillback_cleared: 'congestion', regional_report: 'congestion',
  regional_escalation: 'central', regional_clear: 'central', central_decision: 'central',
  applied: 'signal', rejected: 'signal',
  agent_fallback: 'health',
};
export const categoryOf = event => CATEGORY[event.kind] || (event.kind.startsWith('emergency_') ? 'emergency' : null);

const pct = value => `${Math.round(value * 100)}%`;
const seconds = value => `${Math.round(value)}s`;

const RESPONSES = {
  extend: 'will hold its green longer for them', partial_extend: 'will hold its green as long as it safely can', early_switch: 'will change to green early for them',
  no_change: 'needs no change for them', declined: 'cannot change its signal for them right now', defer: 'will answer once its signal has settled', expired: 'could not answer in time',
};
function responseText(p) {
  const code = p.text.match(/->\s*([a-z_]+)/)?.[1];
  const green = p.text.match(/green set to (\d+)s/)?.[1];
  return `${p.from} told ${p.to} it ${RESPONSES[code] ?? 'replied'}${green ? ` (green set to ${green}s)` : ''}.`;
}

// One short sentence per event. Returning null keeps an event out of the narrative.
export function narrate(event) {
  const p = event.payload;
  switch (event.kind) {
    case 'platoon_alert': return `${p.from} told ${p.to} that vehicles are on their way.`;
    case 'response': return responseText(p);
    case 'spillback_warning': return `The road ${event.source} is ${pct(p.used)} full (estimated capacity ${p.estimated_capacity} vehicles).`;
    case 'spillback_cleared': return `The road ${event.source} has room again.`;
    case 'regional_report': return `${p.from} warned coordinator ${p.to}: the road ahead is at ${pct(p.peak_exit_occupancy)} occupancy.`;
    case 'regional_escalation': return `Coordinator ${p.region} asked the central supervisor to review its junctions.`;
    case 'regional_clear': return `Coordinator ${p.region} has recovered, so the review ended.`;
    case 'central_decision': return p.verdict === 'cut_back'
      ? `The central supervisor shortened the green at ${p.to}: ${seconds(p.approved_total_s)} instead of ${seconds(p.proposed_total_s)}.`
      : `The central supervisor approved a ${seconds(p.approved_total_s)} green at ${p.to}.`;
    case 'applied': return p.applied_total_s == null ? null : `The decision validator approved it, and SUMO set the green at ${p.intersection} to ${seconds(p.applied_total_s)}.`;
    case 'rejected': return `The decision validator rejected a signal change at ${p.intersection} (${String(p.reason || 'no reason given').replace(/_/g, ' ')}).`;
    case 'agent_fallback': return `The agent at ${p.intersection || event.source} failed repeatedly and handed back to the normal signal program.`;
    case 'emergency_ambulance_departed': return `Emergency vehicle ${p.vehicle} set off, with ${p.tls_on_route.length} signals on its route.`;
    case 'emergency_requested': return `${p.vehicle} asked ${p.tls} for priority.`;
    case 'emergency_action': return p.applied ? `${p.tls} changed its signal for ${p.vehicle} (${p.action.replace(/_/g, ' ')}).` : null;
    case 'emergency_denied': return `${p.tls} could not give ${p.vehicle} priority (${p.reason.replace(/_/g, ' ')}).`;
    case 'emergency_released': return `${p.vehicle} no longer needs ${p.tls} (${String(p.outcome).replace(/_/g, ' ')}).`;
    case 'emergency_ambulance_lost': return `Emergency vehicle ${p.vehicle} left the simulation before arriving.`;
    default: return null;
  }
}

export class EventLog {
  constructor() { this.clear(); }

  clear() {
    this.events = [];
    this.emergency = [];
    this.lastId = 0;
    this.journal = null;
    this.health = new Map();
  }

  // Ids can only repeat after a reconnect, and arrive out of order only across a retry: both are handled here.
  add(events) {
    let unordered = false;
    for (const event of events) {
      if (event.id <= this.lastId) continue;
      this.lastId = event.id;
      const last = this.events[this.events.length - 1];
      if (last && last.t > event.t) unordered = true;
      this.events.push(event);
      if (event.kind.startsWith('emergency_')) this.emergency.push(event);
      if (event.kind === 'agent_registered') this.health.set(event.source, { mode: event.payload.mode, reason: event.payload.reason, since: event.t });
    }
    if (unordered) this.events.sort((a, b) => a.t - b.t || a.id - b.id);
  }

  // Index just past the last event at or before t.
  indexAt(t) {
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].t <= t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // Messages travelling at time t. Important kinds survive the cap: only routine traffic alerts are dropped when it is reached.
  packetsAt(t, enabled, limit = 40) {
    const out = [];
    for (let i = this.indexAt(t) - 1; i >= 0; i--) {
      const event = this.events[i];
      const age = t - event.t;
      if (age > PACKET_S) break;
      const route = packetRoute(event);
      const category = categoryOf(event);
      if (!route || !enabled[category]) continue;
      if (out.length >= limit && category === 'traffic') continue;
      out.push({ event, route, category, progress: age / PACKET_S });
    }
    return out;
  }

  recentAt(t, enabled, count = 40) {
    const out = [];
    for (let i = this.indexAt(t) - 1; i >= 0 && out.length < count; i--) {
      const event = this.events[i];
      const category = categoryOf(event);
      if (!category || !enabled[category]) continue;
      const text = narrate(event);
      if (text) out.push({ event, category, text });
    }
    return out;
  }

  // Recent events that mention one junction or road, whatever the active filters are.
  aboutAt(id, t, count = 6) {
    const out = [];
    for (let i = this.indexAt(t) - 1; i >= 0 && out.length < count; i--) {
      const event = this.events[i];
      const p = event.payload;
      if (event.source !== id && p.to !== id && p.from !== id && p.tls !== id && p.intersection !== id) continue;
      const text = narrate(event);
      if (text) out.push({ event, text });
    }
    return out;
  }

  healthAt(id, t) {
    const base = this.health.get(id);
    if (!base) return null;
    const failed = this.events.find(e => e.kind === 'agent_fallback' && e.source === id && e.t <= t);
    if (failed) return { state: 'fallback', detail: failed.payload.reason };
    return base.mode === 'swarm' ? { state: 'active', detail: null } : { state: 'native', detail: base.reason };
  }

  // The emergency situation at time t, rebuilt from events so a replay shows what was true then.
  emergencyAt(t) {
    const vehicles = new Map();
    let priority = null;
    for (const event of this.emergency) {
      if (event.t > t) break;
      const p = event.payload;
      if (event.kind === 'emergency_priority_mode') priority = p.enabled;
      else if (event.kind === 'emergency_ambulance_departed') vehicles.set(p.vehicle, { id: p.vehicle, type: p.vtype, route: p.route || [], tls: p.tls_on_route, passed: new Set(), active: new Map(), arrived: false, lost: false, actions: 0 });
      const vehicle = vehicles.get(p.vehicle);
      if (!vehicle) continue;
      if (event.kind === 'emergency_requested') vehicle.active.set(p.tls, p.target_phase);
      else if (event.kind === 'emergency_action' && p.applied) vehicle.actions += 1;
      else if (event.kind === 'emergency_ambulance_lost') vehicle.lost = true;
      else if (event.kind === 'emergency_released') {
        vehicle.active.delete(p.tls);
        vehicle.passed.add(p.tls);
        if (p.outcome === 'arrived') vehicle.arrived = true;
      }
    }
    const list = [...vehicles.values()].map(v => ({ ...v, next: v.tls.find(tls => !v.passed.has(tls)) ?? null, done: v.arrived || v.lost }));
    return { priority, vehicles: list, active: list.filter(v => !v.done) };
  }
}

export function packetRoute(event) {
  const p = event.payload;
  if (p.from && p.to) return { from: p.from, to: p.to };
  if (event.kind === 'emergency_requested') return { from: p.vehicle, to: p.tls };
  return null;
}

// Status label. LIVE needs fresh data from a run that is still going, and a playing view.
export function statusLabel({ connection, playing, status, behind = 0, behindLimit = 15, hasFrame = true }) {
  if (connection === 'error') return 'ERROR';
  if (connection === 'demo') return playing ? 'DEMO MODE' : 'DEMO PAUSED';
  if (connection === 'connecting' || (connection === 'live' && !hasFrame)) return 'CONNECTING';
  if (connection === 'offline' || connection === 'stale') return 'DISCONNECTED';
  if (!playing) return 'PAUSED';
  return connection === 'live' && status === 'running' && behind <= behindLimit ? 'LIVE' : 'REPLAY';
}

// ------------------------------------------------------------------ guided story
const firstAfter = (log, t, test) => log.events.find(e => e.t >= t && test(e)) ?? null;
const isDecision = e => e.kind === 'central_decision' || (e.kind === 'applied' && e.payload.applied_total_s != null);

export const STORY = [
  { key: 'arrive', title: 'Traffic arrives', text: 'Vehicles are entering the simulated city.', vehicles: true },
  { key: 'detect', title: 'Congestion detected', text: 'A road near this junction is filling up.', find: e => e.kind === 'spillback_warning' || e.kind === 'regional_report' },
  { key: 'talk', title: 'Agents communicate', text: 'The neighbouring junction has been told about incoming vehicles.', find: e => e.kind === 'platoon_alert' },
  { key: 'central', title: 'Central coordination', text: 'The system checked the wider traffic conditions before deciding.', needsHierarchy: true, find: e => e.kind === 'regional_escalation' || e.kind === 'central_decision' },
  { key: 'optimize', title: 'Signal decision', text: 'The signal time was set according to traffic demand.', find: isDecision },
  { key: 'move', title: 'Traffic moves', text: 'SUMO applied the signal. Vehicles proceed on the permitted movement.', find: e => e.kind === 'applied' && e.payload.applied_total_s != null },
  { key: 'measure', title: 'Measuring the effect', text: 'These are measured values for this junction. They show what happened, not whether the decision caused it.', measure: true },
];

// The real event behind a story step, searching from `after`. Null means it has not happened yet.
export function storyEvent(log, step, after) {
  return step.find ? firstAfter(log, after, step.find) : null;
}

export const storyJunction = event => {
  if (!event) return null;
  const p = event.payload;
  return p.intersection || (p.kind === 'regional_escalation' ? null : p.to && !String(p.to).startsWith('R') && p.to !== 'CENTRAL' ? p.to : p.from) || p.upstream || null;
};
