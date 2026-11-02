// DEMO MODE: a small traffic model that runs in the browser when the SUMO service cannot be reached.
// It is not SUMO and its numbers are not measurements. The Command Center labels it DEMO MODE, gives it its own
// run and never loads recorded data alongside it. It writes the same frame format as the recorder, so the same scene draws it.
const LANE_W = 3.2;
const JUNCTION_HALF = 9.6;
const STEP_S = 0.25;
const FRAME_EVERY = 4;       // steps per frame: one frame per simulated second
const ROAD_EVERY_S = 5;
const SPACING_M = 7.5;
const V_MAX = 13.9;
const ACCEL = 2.4, BRAKE = 3.5, MIN_GAP = 2.5, HEADWAY = 1.2;
const PHASES = [['GrGr', 24], ['yryr', 3], ['rrrr', 1], ['rGrG', 24], ['ryry', 3], ['rrrr', 1]];
const CYCLE = PHASES.reduce((sum, [, s]) => sum + s, 0);
const DIRS = [[0, -1], [-1, 0], [0, 1], [1, 0]];      // travel direction of traffic arriving from N, E, S, W
const TYPES = [['car_demo', 4.6, 0.68], ['bike_demo', 2.2, 0.14], ['truck_demo', 7.1, 0.1], ['bus_demo', 12, 0.08]];
const TYPE_NAMES = TYPES.map(t => t[0]);

export function phaseAt(t, offset = 0) {
  let at = ((t + offset) % CYCLE + CYCLE) % CYCLE;
  for (let i = 0; i < PHASES.length; i++) {
    if (at < PHASES[i][1]) return { index: i, state: PHASES[i][0], remaining: PHASES[i][1] - at };
    at -= PHASES[i][1];
  }
  return { index: 0, state: PHASES[0][0], remaining: PHASES[0][1] };
}

function buildNetwork({ rows, cols, block, fringe }) {
  const edges = [], signals = [], links = [];
  const id = (c, r) => `D${c}_${r}`;
  const point = (c, r) => [c * block, r * block];
  // From a to b. Lane 0 is the kerb lane; traffic keeps to the right.
  const addRoad = (name, ax, ay, bx, by, trimA, trimB, from, to, approach) => {
    const length = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / length, uy = (by - ay) / length, rx = uy, ry = -ux;
    const shape = (offset) => [[ax + ux * trimA + rx * offset, ay + uy * trimA + ry * offset], [bx - ux * trimB + rx * offset, by - uy * trimB + ry * offset]];
    edges.push({
      id: name, name: null, lanes: 2, drive_lanes: 2, lane_ids: [`${name}_0`, `${name}_1`], speed: V_MAX, length: length - trimA - trimB,
      shape: shape(LANE_W), lane_shapes: [shape(LANE_W * 1.5), shape(LANE_W * 0.5)], ux, uy, from, to, approach,
    });
  };
  const approachOf = (ux, uy) => DIRS.findIndex(([x, y]) => Math.abs(x - ux) < 0.01 && Math.abs(y - uy) < 0.01);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const [x, y] = point(c, r);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr;
        const inside = nc >= 0 && nc < cols && nr >= 0 && nr < rows;
        const [nx, ny] = inside ? point(nc, nr) : [x + dc * fringe, y + dr * fringe];
        const approach = approachOf(dc, dr);
        if (inside) addRoad(`${id(c, r)}__${id(nc, nr)}`, x, y, nx, ny, JUNCTION_HALF, JUNCTION_HALF, id(c, r), id(nc, nr), approach);
        else {
          addRoad(`out_${id(c, r)}_${dc}_${dr}`, x, y, nx, ny, JUNCTION_HALF, 0, id(c, r), null, approach);
          addRoad(`in_${id(c, r)}_${dc}_${dr}`, nx, ny, x, y, 0, JUNCTION_HALF, null, id(c, r), approachOf(-dc, -dr));
        }
        if (inside && (dc > 0 || dr > 0)) links.push([id(c, r), id(nc, nr)]);
      }
    }
  }
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const signalId = id(c, r);
      const lamps = [];
      for (const edge of edges) {
        if (edge.to !== signalId) continue;
        for (const lane of edge.lane_shapes) lamps.push({ at: lane[1], links: [edge.approach] });
      }
      signals.push({ id: signalId, x: c * block, y: r * block, streets: [], lamps });
    }
  }
  const max = [(cols - 1) * block + fringe, (rows - 1) * block + fringe];
  return {
    version: 2, geo: null, demo: true,
    bounds: { min_x: -fringe, max_x: max[0], min_y: -fringe, max_y: max[1] },
    edges, signals, links, regions: {},
  };
}

function bezierLength(a, m, z) {
  let total = 0, px = a[0], py = a[1];
  for (let i = 1; i <= 8; i++) {
    const [x, y] = bezier(a, m, z, i / 8);
    total += Math.hypot(x - px, y - py);
    px = x; py = y;
  }
  return total;
}
function bezier(a, m, z, f) {
  const g = 1 - f;
  return [g * g * a[0] + 2 * g * f * m[0] + f * f * z[0], g * g * a[1] + 2 * g * f * m[1] + f * f * z[1]];
}

export function createBrowserDemo({ rows = 3, cols = 4, block = 110, fringe = 70, seed = 7, spawnEveryS = 5 } = {}) {
  let random = seed >>> 0;
  const rand = () => { random = (random * 1664525 + 1013904223) >>> 0; return random / 4294967296; };
  const network = buildNetwork({ rows, cols, block, fringe });
  const { edges, signals } = network;
  const offsets = new Map(signals.map((s, i) => [s.id, (i * 11) % CYCLE]));
  const lanes = edges.map(() => [[], []]);      // Vehicles per lane, front first.
  const outOf = new Map();
  edges.forEach((edge, i) => { if (edge.from) { if (!outOf.has(edge.from)) outOf.set(edge.from, []); outOf.get(edge.from).push(i); } });
  const entries = edges.map((e, i) => (e.from === null ? i : -1)).filter(i => i >= 0);
  const nextSpawn = new Map(entries.map((i, k) => [i, k * 0.4]));
  const crossing = [];
  let t = 0, stepCount = 0, serial = 0, nextRoad = 0;
  const entered = edges.map(() => 0), left = edges.map(() => 0);

  const turnOf = (edge, next) => {
    const cross = edge.ux * next.uy - edge.uy * next.ux, dot = edge.ux * next.ux + edge.uy * next.uy;
    if (dot > 0.5) return 'straight';
    return cross > 0 ? 'left' : cross < 0 ? 'right' : 'uturn';
  };

  const chooseNext = edgeIndex => {
    const edge = edges[edgeIndex];
    if (!edge.to) return null;
    const options = outOf.get(edge.to).filter(i => turnOf(edge, edges[i]) !== 'uturn');
    const roll = rand();
    const pick = name => options.filter(i => turnOf(edge, edges[i]) === name);
    const wanted = roll < 0.68 ? pick('straight') : roll < 0.87 ? pick('right') : pick('left');
    const list = wanted.length ? wanted : options;
    return list[Math.floor(rand() * list.length)];
  };
  const laneFor = (edgeIndex, next) => {
    const turn = next === null ? 'straight' : turnOf(edges[edgeIndex], edges[next]);
    return turn === 'right' ? 0 : turn === 'left' ? 1 : rand() < 0.5 ? 0 : 1;
  };

  const spawn = edgeIndex => {
    const next = chooseNext(edgeIndex);
    const lane = laneFor(edgeIndex, next);
    const queue = lanes[edgeIndex][lane];
    const tail = queue[queue.length - 1];
    if (tail && tail.s - tail.length < 12) return;
    let roll = rand(), type = TYPES[0];
    for (const candidate of TYPES) { if (roll < candidate[2]) { type = candidate; break; } roll -= candidate[2]; }
    queue.push({ id: `demo.${++serial}`, typeIndex: TYPE_NAMES.indexOf(type[0]), length: type[1], s: 0, v: 8, wait: 0, edge: edgeIndex, lane, next, x: 0, y: 0, angle: 0, curve: null });
    entered[edgeIndex] += 1;
  };

  const idm = (v, gap, leaderV, limit) => {
    const desired = MIN_GAP + Math.max(0, v * HEADWAY + v * (v - leaderV) / (2 * Math.sqrt(ACCEL * BRAKE)));
    const free = 1 - (v / limit) ** 4;
    return ACCEL * (free - (gap < Infinity ? (desired / Math.max(gap, 0.1)) ** 2 : 0));
  };

  const permits = (edge, now) => {
    const state = phaseAt(now, offsets.get(edge.to)).state[edge.approach];
    return state;
  };

  const startCrossing = (vehicle, edge, laneShape) => {
    const next = edges[vehicle.next];
    const nextOfNext = chooseNext(vehicle.next);
    const nextLane = laneFor(vehicle.next, nextOfNext);
    const from = laneShape[1], to = next.lane_shapes[nextLane][0];
    const middle = turnOf(edge, next) === 'straight'
      ? [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
      : [from[0] + edge.ux * Math.abs(edge.ux ? to[0] - from[0] : to[1] - from[1]), from[1] + edge.uy * Math.abs(edge.ux ? to[0] - from[0] : to[1] - from[1])];
    vehicle.curve = { from, middle, to, length: bezierLength(from, middle, to), s: vehicle.s - edge.length, nextLane, nextOfNext, edge: vehicle.edge, lane: vehicle.lane };
    left[vehicle.edge] += 1;
    crossing.push(vehicle);
  };

  const place = vehicle => {
    if (vehicle.curve) {
      const { from, middle, to, length, s } = vehicle.curve;
      const f = Math.min(1, s / length);
      const [x, y] = bezier(from, middle, to, f);
      const [ax, ay] = bezier(from, middle, to, Math.max(0, f - 0.04));
      const [bx, by] = bezier(from, middle, to, Math.min(1, f + 0.04));
      vehicle.x = x; vehicle.y = y;
      vehicle.angle = (Math.atan2(bx - ax, by - ay) * 180 / Math.PI + 360) % 360;
      return;
    }
    const edge = edges[vehicle.edge];
    const [a] = edge.lane_shapes[vehicle.lane];
    vehicle.x = a[0] + edge.ux * vehicle.s;
    vehicle.y = a[1] + edge.uy * vehicle.s;
    vehicle.angle = (Math.atan2(edge.ux, edge.uy) * 180 / Math.PI + 360) % 360;
  };

  const stepOnce = () => {
    t += STEP_S;
    for (const edgeIndex of entries) {
      if (t >= nextSpawn.get(edgeIndex)) {
        spawn(edgeIndex);
        nextSpawn.set(edgeIndex, t + spawnEveryS * (0.6 + rand() * 0.8));
      }
    }
    for (let e = 0; e < edges.length; e++) {
      const edge = edges[e];
      for (let l = 0; l < 2; l++) {
        const queue = lanes[e][l];
        for (let i = 0; i < queue.length; i++) {
          const vehicle = queue[i];
          let gap = Infinity, leaderV = V_MAX;
          if (i > 0) {
            gap = queue[i - 1].s - queue[i - 1].length - vehicle.s;
            leaderV = queue[i - 1].v;
          } else if (edge.to) {
            const toLine = edge.length - vehicle.s;
            const state = permits(edge, t);
            const canClear = state === 'y' && vehicle.v * vehicle.v / (2 * BRAKE) > toLine;
            const target = vehicle.next === null ? null : lanes[vehicle.next];
            const room = target ? Math.min(...target.map(q => { const tail = q[q.length - 1]; return tail ? tail.s - tail.length : Infinity; })) : Infinity;
            if ((state !== 'G' && !canClear) || room < vehicle.length + 3) { gap = toLine; leaderV = 0; }
            // The vehicle ahead may already be crossing the junction from this lane.
            for (const ahead of crossing) {
              if (ahead.curve.edge !== e || ahead.curve.lane !== l) continue;
              const toRear = toLine + ahead.curve.s - ahead.length;
              if (toRear < gap) { gap = toRear; leaderV = ahead.v; }
            }
          }
          const accel = Math.max(-BRAKE * 2, idm(vehicle.v, gap, leaderV, V_MAX));
          vehicle.v = Math.max(0, vehicle.v + accel * STEP_S);
          // Hard limits: a vehicle never enters its leader, and never passes a stop line it has to stop at.
          let travel = vehicle.v * STEP_S;
          if (gap < Infinity) travel = Math.min(travel, Math.max(0, gap - 0.5));
          if (travel < vehicle.v * STEP_S) vehicle.v = travel / STEP_S;
          vehicle.s += travel;
          vehicle.wait = vehicle.v < 0.1 ? vehicle.wait + STEP_S : 0;
        }
        while (queue.length && queue[0].s >= edge.length) {
          const vehicle = queue.shift();
          if (vehicle.next === null) { left[e] += 1; continue; }
          startCrossing(vehicle, edge, edge.lane_shapes[l]);
        }
      }
    }
    for (let i = crossing.length - 1; i >= 0; i--) {
      const vehicle = crossing[i];
      const curve = vehicle.curve;
      vehicle.v = Math.max(0, Math.min(V_MAX * 0.75, vehicle.v + ACCEL * STEP_S));
      curve.s += vehicle.v * STEP_S;
      if (curve.s < curve.length) continue;
      const queue = lanes[vehicle.next][curve.nextLane];
      const tail = queue[queue.length - 1];
      if (tail && tail.s - tail.length < 1) {   // Wait at the end of the junction until the lane ahead has room.
        curve.s = curve.length - 0.01;
        vehicle.v = 0;
        continue;
      }
      crossing.splice(i, 1);
      Object.assign(vehicle, { edge: vehicle.next, lane: curve.nextLane, s: 0, next: curve.nextOfNext, curve: null });
      queue.push(vehicle);
      entered[vehicle.edge] += 1;
    }
    stepCount += 1;
  };

  const roadSample = () => {
    const out = { t, n: [], q: [], o: [], v: [], w: [], u: [], g: [], l: [], in: [...entered], out: [...left] };
    edges.forEach((edge, e) => {
      const all = [...lanes[e][0], ...lanes[e][1]];
      const capacity = Math.max(1, Math.floor(edge.length * 2 / SPACING_M));
      const used = all.length / capacity;
      const queue = all.filter(v => v.v < 0.1).length;
      const speed = all.length ? all.reduce((sum, v) => sum + v.v, 0) / all.length : edge.speed;
      const occupancy = all.reduce((sum, v) => sum + v.length, 0) / (edge.length * 2);
      out.n.push(all.length); out.q.push(queue); out.o.push(Math.round(occupancy * 1000) / 1000);
      out.v.push(Math.round(speed * 10) / 10); out.w.push(Math.round(all.reduce((sum, v) => sum + v.wait, 0)));
      out.u.push(Math.round(used * 1000) / 1000); out.g.push(0);
      out.l.push(used >= 0.85 && speed < 1 ? 5 : occupancy >= 0.55 ? 4 : occupancy >= 0.35 ? 3 : occupancy >= 0.2 ? 2 : occupancy >= 0.1 ? 1 : 0);
    });
    entered.fill(0); left.fill(0);
    return out;
  };

  const makeFrame = () => {
    const ids = [], x = [], y = [], a = [], s = [], w = [], ty = [], e = [];
    const add = (vehicle, edgeIndex) => {
      place(vehicle);
      ids.push(vehicle.id); x.push(Math.round(vehicle.x * 10) / 10); y.push(Math.round(vehicle.y * 10) / 10);
      a.push(Math.round(vehicle.angle)); s.push(Math.round(vehicle.v * 10) / 10); w.push(Math.round(vehicle.wait)); ty.push(vehicle.typeIndex); e.push(edgeIndex);
    };
    lanes.forEach((pair, edgeIndex) => pair.forEach(queue => queue.forEach(vehicle => add(vehicle, edgeIndex))));
    crossing.forEach(vehicle => add(vehicle, -1));
    const tl = {};
    for (const signal of signals) {
      const phase = phaseAt(t, offsets.get(signal.id));
      tl[signal.id] = [phase.index, phase.state, Math.round(phase.remaining * 10) / 10];
    }
    const frame = { t, ids, x, y, a, s, w, ty, e, types: TYPE_NAMES, tl };
    if (t + 1e-9 >= nextRoad) {
      nextRoad = t + ROAD_EVERY_S;
      frame.r = roadSample();
      const junctions = {};
      for (const signal of signals) {
        let queue = 0;
        edges.forEach((edge, i) => { if (edge.to === signal.id) { queue += lanes[i][0].filter(v => v.v < 0.1).length + lanes[i][1].filter(v => v.v < 0.1).length; } });
        junctions[signal.id] = [queue, null, null];
      }
      frame.j = { t, v: junctions };
    }
    return frame;
  };

  return {
    network,
    // Advances one simulated second and returns its frame.
    nextFrame() {
      do stepOnce(); while (stepCount % FRAME_EVERY);
      return makeFrame();
    },
    edgeLengths: () => edges.map(edge => edge.length),
  };
}

// Stands in for the recorded-frame feed. It keeps a few seconds of frames ahead of the playback clock.
export function createDemoFeed({ demo, buffer, getPlayhead, onManifest, onConnection }) {
  const READ_AHEAD_S = 25;
  const fill = () => {
    const head = getPlayhead();
    let produced = 0;
    while (produced < 30 && (buffer.newest === null || buffer.newest - (head ?? buffer.newest) < READ_AHEAD_S)) {
      buffer.add([demo.nextFrame()]);
      produced += 1;
    }
    // Its own status: frames made ahead of the clock are not a live run to catch up with.
    onManifest({ status: 'demo', demo: true, last_t: buffer.newest, control: {} });
    onConnection('demo');
  };
  fill();
  const timer = setInterval(fill, 200);
  return { seek() {}, getManifest: () => null, destroy() { clearInterval(timer); } };
}
