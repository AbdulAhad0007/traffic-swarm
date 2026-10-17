// Lookahead junction mesh — browser mirror of simulation/swarm/junction_mesh.py (same rules, same
// constants, same PRNG stream). Two meshes run on identical demand: autonomous swarm JunctionAgents
// that call their downstream neighbour ahead of every platoon, and the traditional static 30 s timer.
// Every saving shown on the map is the measured difference between the two, never a fixed number.

export const DIRS = ['NORTHBOUND', 'SOUTHBOUND', 'EASTBOUND', 'WESTBOUND'];
export const AXIS = { NORTHBOUND: 'NS', SOUTHBOUND: 'NS', EASTBOUND: 'EW', WESTBOUND: 'EW' };
const LEFT = { NORTHBOUND: 'WESTBOUND', WESTBOUND: 'SOUTHBOUND', SOUTHBOUND: 'EASTBOUND', EASTBOUND: 'NORTHBOUND' };
const RIGHT = Object.fromEntries(Object.entries(LEFT).map(([k, v]) => [v, k]));
const OTHER = { NS: 'EW', EW: 'NS' };
export const SWARM = 'swarm';
export const FIXED = 'fixed';

export const CONFIG = {
  yellow_s: 3, all_red_s: 2,
  min_green_s: 6, max_green_s: 45, max_red_s: 75,
  fixed_green_s: 30,
  sat_flow_vps: 1.0,
  lookahead_s: 12,
  platoon_min: 3,
  batch_gap_s: 2, batch_max_s: 12,
  comm_latency_s: 1,
  cruise_kmh: 42,
  base_rate_vps: 0.05,
  hero_rate_factor: 1.5,
  burst_every_s: 60, burst_size: 20, burst_rate_vps: 2.0,
  heavy_share: 0.12,
  straight_pct: 60, left_pct: 20,
  log_min_platoon: 5,
  ambulance_speed_factor: 0.7, emergency_lock_eta_s: 15,
  tau_evaporation: 0.02,
};
export const FUEL = { car_idle_lph: 0.6, heavy_idle_lph: 1.8, co2_kg_per_l: 2.31, inr_per_l: 96.72 };
const CLOCK_BASE_S = 10 * 3600 + 14 * 60;

// ---------------------------------------------------------------- deterministic helpers
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(a, b) {
  let x = (Math.imul(a, 0x9e3779b1) + Math.imul(b, 0x85ebca77)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

export function clock(t) {
  const s = Math.floor(CLOCK_BASE_S + t) % 86400;
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

export const shortName = name => name.split('/')[0].split('·')[0].trim();

export const idleLiters = (carIdleS, heavyIdleS) =>
  (carIdleS * FUEL.car_idle_lph) / 3600 + (heavyIdleS * FUEL.heavy_idle_lph) / 3600;

export function fuelTelemetry(fixed, swarm) {
  const carSaved = fixed.car_idle_s - swarm.car_idle_s;
  const heavySaved = fixed.heavy_idle_s - swarm.heavy_idle_s;
  const liters = idleLiters(carSaved, heavySaved);
  const per = s => (s.passages ? s.idle_s / s.passages : 0);
  const perStop = s => (s.stops ? s.stopped_idle_s / s.stops : 0);
  const stopRate = s => (s.passages ? s.stops / s.passages : 0);
  const base = per(fixed);
  return {
    idle_seconds_saved: carSaved + heavySaved,
    liters_fuel_saved: liters,
    co2_kg_prevented: liters * FUEL.co2_kg_per_l,
    rupees_saved: liters * FUEL.inr_per_l,
    average_delay_reduction_pct: base > 0 ? (1 - per(swarm) / base) * 100 : 0,
    stops_avoided: Math.round((stopRate(fixed) - stopRate(swarm)) * swarm.passages),
    stops_per_passage: { fixed: stopRate(fixed), swarm: stopRate(swarm) },
    avg_idle_per_passage_s: { fixed: base, swarm: per(swarm) },
    avg_idle_per_stopped_vehicle_s: { fixed: perStop(fixed), swarm: perStop(swarm) },
    idle_liters: { fixed: idleLiters(fixed.car_idle_s, fixed.heavy_idle_s), swarm: idleLiters(swarm.car_idle_s, swarm.heavy_idle_s) },
  };
}

const newStats = () => ({ passages: 0, stops: 0, idle_s: 0, stopped_idle_s: 0, car_idle_s: 0, heavy_idle_s: 0, arrived: 0, exited: 0 });

// ---------------------------------------------------------------- topology
function travelDirection(a, b) {
  const dx = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
  const dy = b.lat - a.lat;
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? 'NORTHBOUND' : 'SOUTHBOUND';
  return dx > 0 ? 'EASTBOUND' : 'WESTBOUND';
}

function distM(a, b) {
  const kx = 111320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * 110570);
}

export function buildLinks(junctions, edges) {
  const pairs = [...edges.map(([i, k]) => [i, k]), ...edges.map(([i, k]) => [k, i])];
  const dists = pairs.map(([i, k]) => distM(junctions[i], junctions[k]));
  const lo = dists.length ? Math.min(...dists) : 0;
  const hi = dists.length ? Math.max(...dists) : 0;
  return pairs.map(([i, k], n) => ({
    id: n, from: i, to: k, dir: travelDirection(junctions[i], junctions[k]),
    travel_s: hi - lo < 1e-6 ? 16 : Math.round(10 + (18 * (dists[n] - lo)) / (hi - lo)),
    length_m: Math.round(dists[n]),
  }));
}

export function heroIndex(junctions) {
  const i = junctions.findIndex(j => /hapur/i.test(j.name));
  if (i >= 0) return i;
  return junctions.reduce((best, j, k) => (j.lon > junctions[best].lon ? k : best), 0);
}

export function emergencyRoute(junctions, links, start) {
  let far = 0;
  junctions.forEach((j, i) => { if (distM(junctions[start], j) > distM(junctions[start], junctions[far])) far = i; });
  const prev = new Map([[start, null]]);
  const frontier = [start];
  while (frontier.length) {
    const u = frontier.shift();
    links.forEach(l => {
      if (l.from === u && !prev.has(l.to)) { prev.set(l.to, u); frontier.push(l.to); }
    });
  }
  if (!prev.has(far)) return [start];
  const path = [];
  for (let u = far; u !== null; u = prev.get(u)) path.push(u);
  return path.reverse();
}

// ---------------------------------------------------------------- demand (shared by both meshes)
class Demand {
  constructor(junctions, links, seed, cfg) {
    this.cfg = cfg;
    this.rnd = mulberry32(seed);
    this.nextId = 1;
    const incoming = new Set(links.map(l => `${l.to}|${l.dir}`));
    this.hero = heroIndex(junctions);
    this.sources = [];
    junctions.forEach((_, j) => DIRS.forEach(d => { if (!incoming.has(`${j}|${d}`)) this.sources.push([j, d]); }));
    const heroArms = this.sources.filter(([j]) => j === this.hero).map(([, d]) => d);
    this.heroArm = heroArms.length ? heroArms[0] : null;
    this.burstLeft = 0;
  }

  arrivals(t) {
    const c = this.cfg;
    const wave = 1 + 0.3 * Math.sin(t / 120);
    const out = [];
    this.sources.forEach(([j, d]) => {
      const rate = c.base_rate_vps * wave * (j === this.hero ? c.hero_rate_factor : 1);
      if (this.rnd() < rate) out.push(this.veh(j, d));
    });
    if (this.heroArm !== null) {
      if (t % c.burst_every_s === 5) this.burstLeft = c.burst_size;
      const whole = Math.floor(c.burst_rate_vps);
      const n = Math.min(this.burstLeft, whole + (this.rnd() < c.burst_rate_vps - whole ? 1 : 0));
      for (let i = 0; i < n; i++) out.push(this.veh(this.hero, this.heroArm));
      this.burstLeft -= n;
    }
    return out;
  }

  veh(j, d) {
    const vid = this.nextId++;
    return [j, d, vid, hash2(vid, 7919) % 100 < this.cfg.heavy_share * 100];
  }
}

// ---------------------------------------------------------------- agents
class JunctionAgent {
  constructor(mesh, idx, info, mode) {
    this.mesh = mesh; this.idx = idx; this.mode = mode;
    this.id = info.id; this.name = info.name; this.short = shortName(info.name);
    this.arms = Object.fromEntries(DIRS.map(d => [d, []]));
    this.acc = Object.fromEntries(DIRS.map(d => [d, 0]));
    this.out = {};
    this.axis = 'NS'; this.state = 'G'; this.stateT = 0; this.nextAxis = 'EW';
    this.greenStart = 0;
    this.redSince = { NS: 0, EW: 0 };
    this.lastGreen = { NS: null, EW: null };
    this.offset = (idx * 17) % 70;
    this.inbox = [];
    this.tau = { NS: 1, EW: 1 };
    this.lock = null;
    this.batch = null;
    this.servedHist = new Array(60).fill(0);
    this.stats = newStats();
    this.lastLog = {};
    this.lastReason = null;
  }

  // ------------------------------------------------------------ communication
  sendPlatoonAlert(targetId, count, eta, { direction, tailEta, alert }) {
    const m = this.mesh;
    const target = m.byId[targetId];
    Object.assign(alert, {
      source_junction: `${this.short} (${this.id})`, target_junction: `${target.short} (${target.id})`,
      platoon_size: count, estimated_arrival_sec: Math.round(eta), approaching_direction: direction,
      target_speed_kmh: m.cfg.cruise_kmh, sent_at: m.t, head_at: m.t + eta, tail_at: m.t + tailEta,
    });
    m.channel.push([m.t + m.cfg.comm_latency_s, alert]);
    m.packetFeed.push({ key: `p${alert.id}`, from: this.idx, to: target.idx, size: count, sentAt: m.t, kind: 'platoon' });
    return alert;
  }

  receive(alert, now) {
    const c = this.mesh.cfg;
    const win = Math.max(c.min_green_s, Math.min(c.max_green_s, Math.ceil(alert.tail_at - alert.head_at) + 3));
    alert.window_s = win;
    alert.received_at = now;
    this.inbox.push(alert);
    if (alert.platoon_size >= c.log_min_platoon) {
      const axis = AXIS[alert.approaching_direction];
      const plan = this.state === 'G' && this.axis === axis
        ? `holding ${axis} green`
        : `${axis} green scheduled to open at T+${Math.max(0, Math.round(alert.head_at - now))}s`;
      this.mesh.log(this, 'alert', `Received lookahead alert from ${this.mesh.agents[alert.from].short}: ` +
        `${alert.platoon_size} veh ${alert.approaching_direction}, ETA ${Math.round(alert.head_at - now)}s. ` +
        `Pre-allocated ${win}s green wave (${plan}).`);
    }
  }

  // ------------------------------------------------------------ observation
  queue(axis = null) {
    let n = 0;
    DIRS.forEach(d => { if (axis === null || AXIS[d] === axis) n += this.arms[d].length; });
    return n;
  }

  incoming(axis, now, horizon) {
    let n = 0;
    this.inbox.forEach(a => {
      if (AXIS[a.approaching_direction] === axis && a.head_at <= now + horizon && a.arrived < a.platoon_size) {
        n += a.platoon_size - a.arrived;
      }
    });
    return n;
  }

  nextPlatoon(axis, now) {
    let best = null;
    this.inbox.forEach(a => {
      if (AXIS[a.approaching_direction] === axis && a.arrived < a.platoon_size && a.head_at >= now - 1 &&
          (best === null || a.head_at < best.head_at)) best = a;
    });
    return best;
  }

  // ------------------------------------------------------------ decision
  decide(now) {
    const c = this.mesh.cfg;
    const g = this.axis;
    const o = OTHER[g];
    const elapsed = now - this.greenStart;
    if (this.lock !== null) return [g !== this.lock, 'emergency_corridor'];
    if (elapsed < c.min_green_s) return [false, 'min_green'];
    const qg = this.queue(g);
    const qo = this.queue(o);
    const incG = this.incoming(g, now, c.lookahead_s);
    const incO = this.incoming(o, now, 8);
    if (elapsed >= c.max_green_s && (qo > 0 || incO > 0)) return [true, 'max_green'];
    if (now - this.redSince[o] >= c.max_red_s && qo > 0) return [true, 'anti_starvation'];
    const arrivingG = this.incoming(g, now, 3);
    if (arrivingG > 0 && qo < 2 * (qg + arrivingG) + 10) return [false, 'platoon_hold'];
    if (qg === 0 && arrivingG === 0) {
      if (qo > 0 || this.incoming(o, now, 6) > 0) return [true, 'empty_green'];
      return [false, 'rest_in_green'];
    }
    const nxt = this.nextPlatoon(o, now);
    const transition = c.yellow_s + c.all_red_s + 1;
    if (nxt !== null && nxt.platoon_size >= c.platoon_min && nxt.head_at - now <= transition &&
        qg <= Math.max(2, nxt.platoon_size / 2)) return [true, 'preempt_platoon'];
    const totalTau = this.tau[g] + this.tau[o];
    const wg = 0.8 + (0.4 * this.tau[g]) / totalTau;
    const wo = 0.8 + (0.4 * this.tau[o]) / totalTau;
    const pg = (qg + 0.5 * incG) * wg;
    const po = (qo + 0.5 * incO) * wo;
    if (po > 1.5 * pg + 3) return [true, 'pressure'];
    return [false, 'hold'];
  }

  // ------------------------------------------------------------ signal state machine
  control(now) {
    const c = this.mesh.cfg;
    if (this.mode === FIXED) { this.fixed(now); return; }
    if (this.state === 'Y' && now - this.stateT >= c.yellow_s) {
      this.state = 'R'; this.stateT = now;
    } else if (this.state === 'R' && now - this.stateT >= c.all_red_s) {
      this.axis = this.lock || this.nextAxis;
      this.state = 'G'; this.stateT = now; this.greenStart = now;
    } else if (this.state === 'G') {
      const [sw, reason] = this.decide(now);
      this.lastReason = reason;
      if (sw) {
        this.logSwitch(now, reason);
        this.lastGreen[this.axis] = now - this.greenStart;
        this.redSince[this.axis] = now;
        this.nextAxis = OTHER[this.axis];
        this.state = 'Y'; this.stateT = now;
      }
    }
  }

  fixed(now) {
    const c = this.mesh.cfg;
    const half = c.fixed_green_s + c.yellow_s + c.all_red_s;
    const pos = (now + this.offset) % (2 * half);
    const axis = pos < half ? 'NS' : 'EW';
    const p = pos % half;
    const state = p < c.fixed_green_s ? 'G' : p < c.fixed_green_s + c.yellow_s ? 'Y' : 'R';
    if (state === 'G' && (this.state !== 'G' || this.axis !== axis)) this.greenStart = now;
    if (state === 'Y' && this.state === 'G') { this.lastGreen[axis] = c.fixed_green_s; this.redSince[axis] = now; }
    this.axis = axis; this.state = state; this.nextAxis = OTHER[axis];
  }

  logSwitch(now, reason) {
    const c = this.mesh.cfg;
    const g = this.axis;
    const o = OTHER[g];
    if (reason === 'empty_green' && this.queue(o) >= 4 && now - (this.lastLog[reason] ?? -99) >= 20) {
      this.lastLog[reason] = now;
      this.mesh.log(this, 'drain', `${g} approach empty after ${now - this.greenStart}s - ending dead green, ` +
        `surplus time shifted to ${o} (${this.queue(o)} veh waiting).`);
    } else if (reason === 'preempt_platoon' && now - (this.lastLog[reason] ?? -99) >= 10) {
      this.lastLog[reason] = now;
      const nxt = this.nextPlatoon(o, now);
      this.mesh.log(this, 'preempt', `Pre-emptive switch: ${o} green opens in ${c.yellow_s + c.all_red_s}s ` +
        `for ${nxt.platoon_size}-veh platoon from ${this.mesh.agents[nxt.from].short}.`);
    }
  }

  // ------------------------------------------------------------ discharge
  discharge(now) {
    const c = this.mesh.cfg;
    let served = 0;
    DIRS.forEach(d => {
      const q = this.arms[d];
      if (this.state === 'G' && AXIS[d] === this.axis) {
        this.acc[d] += c.sat_flow_vps;
        const n = Math.min(Math.floor(this.acc[d]), q.length);
        this.acc[d] -= n;
        if (!q.length || n === q.length) this.acc[d] = Math.min(this.acc[d], 1.0);
        const released = q.splice(0, n);
        released.forEach(v => this.release(v, now));
        served += n;
        if (n) this.tau[this.axis] += 0.1 * n;
      } else {
        this.acc[d] = 0;
      }
      q.forEach(v => {
        v.wait += 1;
        this.stats.idle_s += 1;
        if (v.heavy) this.stats.heavy_idle_s += 1; else this.stats.car_idle_s += 1;
      });
    });
    this.servedHist.push(served);
    this.servedHist.shift();
    ['NS', 'EW'].forEach(a => { this.tau[a] = Math.max(0.1, this.tau[a] * (1 - c.tau_evaporation)); });
  }

  release(v, now) {
    const m = this.mesh;
    const c = m.cfg;
    const st = this.stats;
    st.passages += 1;
    if (v.wait > 0) { st.stops += 1; st.stopped_idle_s += v.wait; }
    if (v.alert !== null) m.platoonPassed(v, now);
    const roll = hash2(v.id, this.idx + 1) % 100;
    const turn = roll < c.straight_pct ? 'straight' : roll < c.straight_pct + c.left_pct ? 'left' : 'right';
    const newDir = turn === 'straight' ? v.dir : (turn === 'left' ? LEFT : RIGHT)[v.dir];
    const link = this.out[newDir];
    v.wait = 0; v.alert = null;
    if (!link) {
      st.exited += 1;
      if (m.mode === SWARM) this.batchAdd(null, turn, v, now);
      return;
    }
    v.dir = newDir;
    const arrive = now + link.travel_s;
    m.transit.push({ arrive, id: v.id, to: link.to, v, link: link.id, depart: now });
    if (m.mode === SWARM) this.batchAdd(link, turn, v, now, arrive);
  }

  batchAdd(link, turn, v, now, arrive) {
    const c = this.mesh.cfg;
    if (this.batch === null) {
      this.batch = { first: now, last: now, deadline: now + c.batch_max_s, links: new Map(), turns: { straight: 0, left: 0, right: 0, exit: 0 } };
    }
    const b = this.batch;
    b.last = now;
    b.turns[link === null ? 'exit' : turn] += 1;
    if (link === null) return;
    let entry = b.links.get(link.id);
    if (!entry) {
      entry = { link, arrivals: [], alert: this.mesh.newAlert(this.idx, link) };
      b.links.set(link.id, entry);
      b.deadline = Math.min(b.deadline, now + Math.max(2, link.travel_s - 4));
    }
    entry.arrivals.push(arrive);
    entry.alert.vehicles += 1;
    entry.alert.rate_sum += (v.heavy ? FUEL.heavy_idle_lph : FUEL.car_idle_lph) / 3600;
    v.alert = entry.alert.id;
  }

  flush(now) {
    const b = this.batch;
    const c = this.mesh.cfg;
    if (b === null || (now - b.last < c.batch_gap_s && now < b.deadline)) return;
    this.batch = null;
    const sent = [];
    b.links.forEach(entry => {
      const arr = entry.arrivals;
      const target = this.mesh.agents[entry.link.to];
      sent.push(this.sendPlatoonAlert(target.id, arr.length, Math.min(...arr) - now, {
        direction: entry.link.dir, tailEta: Math.max(...arr) - now, alert: entry.alert,
      }));
    });
    const t = b.turns;
    const total = t.straight + t.left + t.right + t.exit;
    if (total >= c.log_min_platoon && sent.length) {
      const split = `${t.straight} straight / ${t.left} left / ${t.right} right` + (t.exit ? ` / ${t.exit} exit` : '');
      const calls = [...sent].sort((x, y) => y.platoon_size - x.platoon_size)
        .map(a => `${a.platoon_size} veh to ${this.mesh.agents[a.to].short} (ETA ${a.estimated_arrival_sec}s)`).join(', ');
      this.mesh.log(this, 'platoon', `Platoon detected: ${total} veh (${split}). Broadcasting ${calls}.`);
    }
  }
}

// ---------------------------------------------------------------- mesh
class JunctionMesh {
  constructor(junctions, links, mode, cfg) {
    this.mode = mode; this.cfg = cfg; this.t = 0;
    this.junctions = junctions; this.links = links;
    this.agents = junctions.map((j, i) => new JunctionAgent(this, i, j, mode));
    this.byId = Object.fromEntries(this.agents.map(a => [a.id, a]));
    links.forEach(l => { if (!this.agents[l.from].out[l.dir]) this.agents[l.from].out[l.dir] = l; });
    this.linkByPair = new Map(links.map(l => [`${l.from}>${l.to}`, l]));
    this.transit = [];
    this.channel = [];
    this.alerts = new Map();
    this.nAlerts = 0;
    this.messages = [];
    this.seq = 0;
    this.reference = null;
    this.ambulance = null;
    this.packetFeed = [];
  }

  log(agent, kind, text) {
    if (this.mode !== SWARM) return;
    this.seq += 1;
    const who = agent === null ? 'EMERGENCY' : `${agent.id} ${agent.short}`;
    this.messages.push({ seq: this.seq, t: this.t, clock: clock(this.t), junction: agent === null ? null : agent.id, who, kind, text,
      line: `[${clock(this.t)}] [${who}] ${text}` });
    if (this.messages.length > 500) this.messages.shift();
  }

  newAlert(src, link) {
    this.nAlerts += 1;
    const alert = { id: this.nAlerts, from: src, to: link.to, link: link.id, vehicles: 0, rate_sum: 0, arrived: 0, passed: 0,
      stops: 0, idle_s: 0, closed: false, sent_at: null, platoon_size: 0, approaching_direction: link.dir, head_at: Infinity, tail_at: Infinity };
    this.alerts.set(alert.id, alert);
    return alert;
  }

  platoonPassed(v, now) {
    const a = this.alerts.get(v.alert);
    if (!a) return;
    a.passed += 1;
    a.idle_s += v.wait;
    if (v.wait > 0) a.stops += 1;
    if (a.passed >= a.vehicles && a.sent_at !== null) this.close(a, now);
  }

  close(a) {
    a.closed = true;
    this.alerts.delete(a.id);
    const rx = this.agents[a.to];
    rx.inbox = rx.inbox.filter(x => x.id !== a.id);
    if (a.vehicles < this.cfg.log_min_platoon) return;
    const ref = this.reference ? this.reference.agents[a.to].stats : null;
    const base = ref && ref.passages ? ref.idle_s / ref.passages : 0;
    const avoided = Math.max(0, base - a.idle_s / a.vehicles);
    const liters = avoided * a.rate_sum;
    this.log(rx, 'clear', `Platoon from ${this.agents[a.from].short} cleared: ${a.vehicles} veh, ${a.stops} stops. ` +
      `Idling avoided: ${avoided.toFixed(0)}s/veh vs static timer. Fuel saved: ${liters.toFixed(3)} L.`);
  }

  deliver(now) {
    const keep = [];
    this.channel.forEach(([at, alert]) => {
      if (at <= now) { if (!alert.closed) this.agents[alert.to].receive(alert, now); } else keep.push([at, alert]);
    });
    this.channel = keep;
    this.agents.forEach(a => {
      a.inbox.filter(x => now > x.tail_at + 90).forEach(x => this.close(x, now));
    });
  }

  // ------------------------------------------------------------ emergency
  startAmbulance(route, now) {
    this.ambulance = { route, k: 0, arriveAt: now + 6, delay: 0, done: false, start: now, locked: new Set(), posLink: null, depart: now };
    if (this.mode === SWARM) {
      this.log(null, 'emergency', `Ambulance detected. Corridor override broadcast to ${route.length} junctions: ` +
        `${route.map(i => this.agents[i].short).join(' -> ')}.`);
      route.slice(1).forEach((to, k) => {
        this.packetFeed.push({ key: `e${now}-${k}`, from: route[k], to, size: 0, sentAt: now + k * 0.6, kind: 'emergency' });
      });
    }
  }

  ambAxis(k) {
    const r = this.ambulance.route;
    if (k + 1 < r.length) return AXIS[this.link(r[k], r[k + 1]).dir];
    return k > 0 ? AXIS[this.link(r[k - 1], r[k]).dir] : 'NS';
  }

  link(i, k) { return this.linkByPair.get(`${i}>${k}`); }

  emergency(now) {
    const amb = this.ambulance;
    if (!amb || amb.done) return;
    const { route } = amb;
    const c = this.cfg;
    if (this.mode === SWARM) {
      let eta = amb.arriveAt - now;
      for (let k = amb.k; k < route.length; k++) {
        if (k > amb.k) eta += Math.round(this.link(route[k - 1], route[k]).travel_s * c.ambulance_speed_factor);
        const agent = this.agents[route[k]];
        if (eta <= c.emergency_lock_eta_s && !amb.locked.has(k)) {
          amb.locked.add(k);
          agent.lock = this.ambAxis(k);
          const action = agent.state === 'G' && agent.axis === agent.lock
            ? `holding ${agent.lock} green` : `${agent.axis} -> All-Red -> ${agent.lock} green`;
          this.log(agent, 'emergency', `Emergency override (ambulance ETA ${Math.max(0, eta)}s): ${action}; cross traffic held red.`);
        }
      }
    }
    if (now < amb.arriveAt) return;
    const k = amb.k;
    const agent = this.agents[route[k]];
    if (agent.state === 'G' && agent.axis === this.ambAxis(k)) {
      agent.lock = null;
      if (this.mode === SWARM) this.log(agent, 'emergency', `Ambulance passed (cumulative signal delay ${amb.delay}s). Corridor lock released.`);
      amb.k += 1;
      if (amb.k >= route.length) { amb.done = true; amb.end = now; return; }
      const link = this.link(route[k], route[k + 1]);
      amb.posLink = link.id; amb.depart = now;
      amb.arriveAt = now + Math.round(link.travel_s * c.ambulance_speed_factor);
    } else {
      amb.delay += 1;
    }
  }

  // ------------------------------------------------------------ step
  step(arrivals) {
    this.t += 1;
    const now = this.t;
    arrivals.forEach(([j, d, vid, heavy]) => {
      this.enqueue(j, { id: vid, heavy, dir: d, wait: 0, alert: null });
      this.agents[j].stats.arrived += 1;
    });
    const due = [];
    const keep = [];
    this.transit.forEach(x => (x.arrive <= now ? due : keep).push(x));
    this.transit = keep;
    due.sort((a, b) => a.arrive - b.arrive || a.id - b.id).forEach(x => this.enqueue(x.to, x.v));
    if (this.mode === SWARM) this.deliver(now);
    this.emergency(now);
    this.agents.forEach(a => a.control(now));
    this.agents.forEach(a => a.discharge(now));
    if (this.mode === SWARM) this.agents.forEach(a => a.flush(now));
  }

  enqueue(j, v) {
    this.agents[j].arms[v.dir].push(v);
    if (v.alert !== null) {
      const a = this.alerts.get(v.alert);
      if (a) a.arrived += 1;
    }
  }

  queueTotal() { return this.agents.reduce((s, a) => s + a.queue(), 0); }

  totals() {
    const out = newStats();
    this.agents.forEach(a => Object.keys(out).forEach(k => { out[k] += a.stats[k]; }));
    return out;
  }
}

// ---------------------------------------------------------------- the paired demo
export class LookaheadDemo {
  constructor(junctions, edges, { seed = 42, cfg = {} } = {}) {
    this.cfg = { ...CONFIG, ...cfg };
    this.junctions = junctions;
    this.links = buildLinks(junctions, edges);
    this.demand = new Demand(junctions, this.links, seed, this.cfg);
    this.meshes = { [SWARM]: new JunctionMesh(junctions, this.links, SWARM, this.cfg), [FIXED]: new JunctionMesh(junctions, this.links, FIXED, this.cfg) };
    this.meshes[SWARM].reference = this.meshes[FIXED];
    this.route = null;
  }

  get t() { return this.meshes[SWARM].t; }

  step(seconds = 1) {
    for (let i = 0; i < seconds; i++) {
      const arrivals = this.demand.arrivals(this.t + 1);
      Object.values(this.meshes).forEach(m => m.step(arrivals));
    }
  }

  emergencyActive() {
    return Object.values(this.meshes).some(m => m.ambulance && !m.ambulance.done);
  }

  triggerEmergency() {
    this.route = emergencyRoute(this.junctions, this.links, this.demand.hero);
    if (this.route.length < 2) return null;
    Object.values(this.meshes).forEach(m => m.startAmbulance(this.route, m.t));
    return this.route;
  }

  emergency() {
    const out = { route: this.route };
    for (const [mode, m] of Object.entries(this.meshes)) {
      const amb = m.ambulance;
      if (!amb) return null;
      out[mode] = { done: amb.done, delay_s: amb.delay, at: amb.k, travel_s: (amb.end ?? m.t) - amb.start };
    }
    return out;
  }

  fuel() { return fuelTelemetry(this.meshes[FIXED].totals(), this.meshes[SWARM].totals()); }

  junctionFuelSaved(i) {
    const f = this.meshes[FIXED].agents[i].stats;
    const s = this.meshes[SWARM].agents[i].stats;
    return idleLiters(f.car_idle_s - s.car_idle_s, f.heavy_idle_s - s.heavy_idle_s);
  }

  junctionView(mode, i) {
    const m = this.meshes[mode];
    const a = m.agents[i];
    const now = m.t;
    const incoming = a.inbox.filter(x => x.arrived < x.platoon_size).sort((x, y) => x.head_at - y.head_at).slice(0, 3)
      .map(x => ({ from: m.agents[x.from].short, size: x.platoon_size - x.arrived, eta: Math.max(0, Math.round(x.head_at - now)), dir: x.approaching_direction, window: x.window_s }));
    return {
      queue: a.queue(), queueNS: a.queue('NS'), queueEW: a.queue('EW'),
      axis: a.axis, state: a.state,
      phase: a.state === 'G' ? `${a.axis} Green` : a.state === 'Y' ? `${a.axis} Yellow` : 'All-Red Clearance',
      greenElapsed: a.state === 'G' ? now - a.greenStart : 0,
      lastGreen: a.lastGreen, decision: a.lastReason, lock: a.lock, tau: a.tau,
      carsPerMin: a.servedHist.reduce((s, x) => s + x, 0),
      incoming, fuelSaved: this.junctionFuelSaved(i), stats: a.stats,
    };
  }

  // Vehicles on links, grouped per (link, departure bucket) for drawing: [{link, from, to, frac, count}]
  transitGroups(mode, frac = 0) {
    const m = this.meshes[mode];
    const groups = new Map();
    m.transit.forEach(x => {
      const key = `${x.link}|${Math.floor(x.depart / 3)}`;
      let g = groups.get(key);
      if (!g) { g = { key, link: x.link, depart: x.depart, arrive: x.arrive, count: 0 }; groups.set(key, g); }
      g.count += 1;
    });
    const now = m.t + frac;
    return [...groups.values()].map(g => {
      const l = this.links[g.link];
      return { ...g, from: l.from, to: l.to, frac: Math.min(1, Math.max(0, (now - g.depart) / (g.arrive - g.depart))) };
    });
  }

  ambulancePosition(mode, frac = 0) {
    const m = this.meshes[mode];
    const amb = m.ambulance;
    if (!amb || amb.done) return null;
    const now = m.t + frac;
    if (amb.posLink === null) {
      const j = this.junctions[amb.route[0]];
      return { lat: j.lat, lon: j.lon, waiting: now >= amb.arriveAt, delay: amb.delay };
    }
    const l = this.links[amb.posLink];
    const a = this.junctions[l.from];
    const b = this.junctions[l.to];
    const f = Math.min(1, Math.max(0, (now - amb.depart) / Math.max(1, amb.arriveAt - amb.depart)));
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, waiting: f >= 1, delay: amb.delay };
  }

  drainPackets() {
    const m = this.meshes[SWARM];
    const out = m.packetFeed;
    m.packetFeed = [];
    return out;
  }
}
