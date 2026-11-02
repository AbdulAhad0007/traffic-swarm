// Holds recorded simulation frames and answers "where was everything at time T?". No Cesium or React here.
// Between two real samples positions are interpolated for display. Nothing is ever extrapolated past the last
// sample: vehicles hold their last reported position and the sample is marked stale.
const TELEPORT_M = 80;      // Bigger jumps are SUMO teleports or reused ids: snap rather than slide across the map.
const KEEP_BEHIND_S = 5;
const TURN_DEG = 10;        // A bigger heading change between samples is drawn as a curve, not a chord.

// Position on the curve leaving a at heading a0 and arriving at b on heading a1. Tangents use the distance actually
// travelled between the two samples, so the curve stays between them and a stopped vehicle does not move.
export function turnPoint(ax, ay, a0, bx, by, a1, f) {
  const chord = Math.hypot(bx - ax, by - ay);
  const r0 = a0 * Math.PI / 180, r1 = a1 * Math.PI / 180;
  const f2 = f * f, f3 = f2 * f;
  const h1 = 2 * f3 - 3 * f2 + 1, h2 = f3 - 2 * f2 + f, h3 = -2 * f3 + 3 * f2, h4 = f3 - f2;
  return [
    h1 * ax + h2 * chord * Math.sin(r0) + h3 * bx + h4 * chord * Math.sin(r1),
    h1 * ay + h2 * chord * Math.cos(r0) + h3 * by + h4 * chord * Math.cos(r1),
  ];
}

export function indexFrame(frame) {
  const index = new Map();
  frame.ids.forEach((id, i) => index.set(id, i));
  return { ...frame, index };
}

const lerp = (a, b, f) => a + (b - a) * f;

export function lerpAngle(a, b, f) {
  const delta = ((b - a + 540) % 360) - 180;
  return (a + delta * f + 360) % 360;
}

export function signalColor(state, links) {
  let amber = false;
  for (const link of links) {
    const c = state?.[link];
    if (c === 'G' || c === 'g') return 'green';
    if (c === 'y' || c === 'Y' || c === 'u') amber = true;
  }
  return amber ? 'amber' : 'red';
}

export class FrameBuffer {
  constructor() {
    this.frames = [];
    this.junctions = new Map();
    this.junctionTime = null;
  }

  get newest() { return this.frames.length ? this.frames[this.frames.length - 1].t : null; }
  get oldest() { return this.frames.length ? this.frames[0].t : null; }

  clear() {
    this.frames = [];
    this.junctions = new Map();
    this.junctionTime = null;
    this.roads = null;
    this.roadTime = null;
  }

  add(frames) {
    for (const frame of frames) {
      if (this.newest !== null && frame.t <= this.newest) continue;
      this.frames.push(indexFrame(frame));
    }
  }

  trimBefore(t) {
    let drop = 0;
    while (drop < this.frames.length - 1 && this.frames[drop + 1].t < t - KEEP_BEHIND_S) drop += 1;
    if (drop) this.frames.splice(0, drop);
  }

  // Latest junction measurements at or before t. Measured every few simulated seconds.
  updateJunctions(t) {
    for (const frame of this.frames) {
      if (frame.t > t) break;
      if (frame.j && frame.j.t !== this.junctionTime) {
        this.junctionTime = frame.j.t;
        this.junctions = new Map(Object.entries(frame.j.v));
      }
      if (frame.r && frame.r.t !== this.roadTime) {
        this.roadTime = frame.r.t;
        this.roads = frame.r;
      }
    }
  }

  bracket(t) {
    const { frames } = this;
    if (!frames.length) return null;
    if (t <= frames[0].t) return [frames[0], frames[0]];
    let lo = 0, hi = frames.length - 1;
    if (t >= frames[hi].t) return [frames[hi], frames[hi]];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t <= t) lo = mid; else hi = mid;
    }
    return [frames[lo], frames[hi]];
  }

  // Calls visit(id, x, y, angle, speed, waiting, typeName, edge) per vehicle. Allocates nothing per vehicle.
  sample(t, visit) {
    const pair = this.bracket(t);
    if (!pair) return null;
    const [a, b] = pair;
    const span = b.t - a.t;
    const f = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
    const source = f < 0.5 || a === b ? a : b;
    const other = source === a ? b : a;
    const n = source.ids.length;
    for (let i = 0; i < n; i++) {
      const id = source.ids[i];
      const j = other.index.get(id);
      if (j === undefined) {
        visit(id, source.x[i], source.y[i], source.a[i], source.s[i], source.w[i], source.types[source.ty[i]], source.e[i]);
        continue;
      }
      const ax = a === source ? i : j, bx = a === source ? j : i;
      const jumped = Math.hypot(b.x[bx] - a.x[ax], b.y[bx] - a.y[ax]) > TELEPORT_M;
      const turn = Math.abs(((b.a[bx] - a.a[ax] + 540) % 360) - 180);
      if (!jumped && turn > TURN_DEG) {
        const [x, y] = turnPoint(a.x[ax], a.y[ax], a.a[ax], b.x[bx], b.y[bx], b.a[bx], f);
        visit(id, x, y, lerpAngle(a.a[ax], b.a[bx], f), source.s[i], source.w[i], source.types[source.ty[i]], source.e[i]);
        continue;
      }
      visit(id,
        jumped ? source.x[i] : lerp(a.x[ax], b.x[bx], f),
        jumped ? source.y[i] : lerp(a.y[ax], b.y[bx], f),
        jumped ? source.a[i] : lerpAngle(a.a[ax], b.a[bx], f),
        source.s[i], source.w[i], source.types[source.ty[i]], source.e[i]);
    }
    return { frame: source, atEnd: t > this.newest };
  }
}
