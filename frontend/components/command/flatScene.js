// Top-down traffic view on one canvas, and the default Overview view. It needs neither WebGL nor Cesium, so it opens
// immediately. Roads are cached on a second canvas; vehicles and signals are drawn every frame without creating React
// work or per-vehicle objects. Everything shown comes from the frame buffer and event log it is given.
import { signalColor } from '../view3d/frameBuffer.js';

const LEVEL_TOKENS = ['--road-free', '--road-normal', '--road-busy', '--road-heavy', '--road-severe', '--road-blocked'];
const MESSAGE_TOKENS = { traffic: '--msg-traffic', proposal: '--msg-proposal', congestion: '--msg-congestion', central: '--msg-central', signal: '--msg-signal', emergency: '--msg-emergency', health: '--msg-health' };
const LANE_W = 3.2;
const STOP_MATCH_M = 8;
const ARROW_MIN_SCALE = 1.1;
const LABEL_MIN_SCALE = 2.2;
const SIGNAL_FLASH_MS = 450;
const MIN_VEHICLE_PX = 7;
const EMERGENCY_EVERY_MS = 500;

// Length, width and colour token by SUMO vehicle type. The position SUMO reports is the front bumper.
export function vehicleStyle(type) {
  const name = String(type || '');
  if (/ambulance|emergency/i.test(name)) return { kind: 'emergency', length: 6.5, width: 2.2, token: '--status-danger' };
  if (/bus/i.test(name)) return { kind: 'bus', length: 12, width: 2.5, token: '--msg-signal' };
  if (/truck|lorry/i.test(name)) return { kind: 'truck', length: 7.1, width: 2.4, token: '--msg-congestion' };
  if (/motor|bike|bicycle/i.test(name)) return { kind: 'bike', length: 2.2, width: 0.9, token: '--msg-proposal' };
  if (/rickshaw|auto/i.test(name)) return { kind: 'auto', length: 2.7, width: 1.4, token: '--msg-central' };
  return { kind: 'car', length: 4.6, width: 1.9, token: '--scene-vehicle' };
}

function convexHull(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = list => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

// Each lamp stands on the stop line of one lane. Its direction comes from the lane that ends there.
function stopBars(network) {
  const ends = [];
  for (const edge of network.edges) {
    for (const shape of edge.lane_shapes?.length ? edge.lane_shapes : [edge.shape]) {
      if (shape.length >= 2) ends.push([shape[shape.length - 1], shape[shape.length - 2]]);
    }
  }
  const bars = [];
  for (const signal of network.signals) {
    for (const lamp of signal.lamps || []) {
      let best = null, bestDistance = STOP_MATCH_M;
      for (const [end, before] of ends) {
        const distance = Math.hypot(end[0] - lamp.at[0], end[1] - lamp.at[1]);
        if (distance < bestDistance) { bestDistance = distance; best = [end, before]; }
      }
      let ux = 0, uy = 1;
      if (best) {
        const dx = best[0][0] - best[1][0], dy = best[0][1] - best[1][1], n = Math.hypot(dx, dy) || 1;
        ux = dx / n; uy = dy / n;
      }
      bars.push({ signal: signal.id, links: lamp.links, x: lamp.at[0], y: lamp.at[1], ux, uy, color: null, changedAt: 0 });
    }
  }
  return bars;
}

export function createFlatScene(container, network, { onPick, insets, hierarchy = false }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'command-flat';
  container.appendChild(canvas);
  const c = canvas.getContext('2d');
  const roadsCanvas = document.createElement('canvas');
  const r2d = roadsCanvas.getContext('2d');
  const b = network.bounds || { min_x: 0, max_x: 500, min_y: 0, max_y: 500 };
  const view = { scale: 1, x: 0, y: 0 };
  const layers = { vehicles: true, signals: true, heatmap: true, agents: true, comms: true, corridor: true };
  const bars = stopBars(network);
  const edgeIndex = new Map(network.edges.map((edge, i) => [edge.id, i]));
  const signals = network.signals.filter(s => s.x !== null && s.x !== undefined);
  const hulls = new Map(signals.map(s => [s.id, convexHull((s.lamps || []).map(l => l.at))]));
  const styles = new Map();
  const signalById = new Map(signals.map(s => [s.id, s]));
  const nodes = new Map(signals.map(s => [s.id, [s.x, s.y]]));
  if (hierarchy) {
    nodes.set('CENTRAL', [(b.min_x + b.max_x) / 2, (b.min_y + b.max_y) / 2]);
    for (const [region, members] of Object.entries(network.regions || {})) {
      const placed = members.map(m => signalById.get(m)).filter(Boolean);
      if (placed.length) nodes.set(region, [placed.reduce((sum, s) => sum + s.x, 0) / placed.length, placed.reduce((sum, s) => sum + s.y, 0) / placed.length]);
    }
  }
  let tokens = {}, last = null, roads = null, frames = 0, fps = 0, width = 0, height = 0, ratio = 1;
  let drawnVehicles = 0, corridorEdges = new Set(), corridorAt = -Infinity, emergencyAhead = new Set();
  let ctxFrame = null, drag = null, redrawRoads = true;

  const px = x => view.scale * x + view.x;
  const py = y => view.y - view.scale * y;
  const worldTransform = target => target.setTransform(ratio * view.scale, 0, 0, -ratio * view.scale, ratio * view.x, ratio * view.y);

  const fit = () => {
    const gaps = (insets && insets()) || { top: 0, right: 0, bottom: 0, left: 0 };
    const w = Math.max(80, width - gaps.left - gaps.right), h = Math.max(80, height - gaps.top - gaps.bottom);
    const spanX = Math.max(1, b.max_x - b.min_x), spanY = Math.max(1, b.max_y - b.min_y);
    view.scale = 0.97 * Math.min(w / spanX, h / spanY);
    view.x = gaps.left + w / 2 - view.scale * (b.min_x + b.max_x) / 2;
    view.y = gaps.top + h / 2 + view.scale * (b.min_y + b.max_y) / 2;
    redrawRoads = true;
  };

  const resize = () => {
    ratio = window.devicePixelRatio || 1;
    width = container.clientWidth;
    height = container.clientHeight;
    canvas.width = roadsCanvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = roadsCanvas.height = Math.max(1, Math.round(height * ratio));
    fit();
  };

  const stroke = (target, shape) => {
    target.beginPath();
    shape.forEach(([x, y], k) => (k ? target.lineTo(x, y) : target.moveTo(x, y)));
    target.stroke();
  };

  // Everything that does not move: ground, asphalt, junction boxes, lane markings and direction arrows.
  const paintRoads = () => {
    const g = r2d;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = tokens['--scene-ground'] || tokens['--scene-bg'];
    g.fillRect(0, 0, roadsCanvas.width, roadsCanvas.height);
    worldTransform(g);
    g.lineCap = 'butt';
    g.lineJoin = 'round';
    const lanesOf = edge => (edge.lane_shapes?.length ? edge.lane_shapes : [edge.shape]).filter(s => s.length >= 2);
    g.strokeStyle = tokens['--scene-road-casing'];
    for (const edge of network.edges) {
      for (const lane of lanesOf(edge)) { g.lineWidth = LANE_W + 1.2; stroke(g, lane); }
    }
    g.fillStyle = tokens['--scene-road-casing'];
    for (const hull of hulls.values()) {
      if (hull.length < 3) continue;
      g.beginPath();
      hull.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.lineWidth = LANE_W + 2;
      g.strokeStyle = tokens['--scene-road-casing'];
      g.stroke();
      g.fill();
    }
    // Lanes of one road are separated by dashes.
    g.strokeStyle = tokens['--scene-road-center'];
    g.globalAlpha = 0.65;
    g.lineWidth = 0.28;
    g.setLineDash([3, 4]);
    for (const edge of network.edges) {
      const lanes = lanesOf(edge);
      for (let i = 1; i < lanes.length; i++) {
        const a = lanes[i - 1], z = lanes[i];
        if (a.length === z.length) stroke(g, a.map(([x, y], k) => [(x + z[k][0]) / 2, (y + z[k][1]) / 2]));
      }
    }
    g.setLineDash([]);
    // Junction boundary.
    g.globalAlpha = 0.45;
    g.lineWidth = 0.35;
    for (const hull of hulls.values()) {
      if (hull.length < 3) continue;
      g.beginPath();
      hull.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.stroke();
    }
    // Direction of travel, painted on each lane.
    if (view.scale >= ARROW_MIN_SCALE) {
      g.fillStyle = tokens['--scene-road-center'];
      g.globalAlpha = 0.5;
      for (const edge of network.edges) {
        for (const lane of lanesOf(edge)) {
          const [ax, ay] = lane[lane.length - 2], [bx, by] = lane[lane.length - 1];
          const length = Math.hypot(bx - ax, by - ay);
          if (length < 25) continue;
          const ux = (bx - ax) / length, uy = (by - ay) / length;
          for (const back of [14, length - 14]) {
            const x = bx - ux * back, y = by - uy * back;
            g.beginPath();
            g.moveTo(x + ux * 2.6, y + uy * 2.6);
            g.lineTo(x - uy * 0.95, y + ux * 0.95);
            g.lineTo(x + uy * 0.95, y - ux * 0.95);
            g.closePath();
            g.fill();
          }
        }
      }
    }
    g.globalAlpha = 1;
    redrawRoads = false;
  };

  const styleOf = type => {
    let style = styles.get(type);
    if (!style) { style = vehicleStyle(type); styles.set(type, style); }
    return style;
  };

  // Called once per vehicle per frame, so it reuses one transform instead of allocating.
  const drawVehicle = (id, x, y, angle, speed, waiting, type) => {
    const style = styleOf(type);
    const color = tokens[style.token];
    const rad = angle * Math.PI / 180;
    const fx = Math.sin(rad), fy = Math.cos(rad);
    const k = ratio * view.scale;
    const grow = Math.max(1, MIN_VEHICLE_PX / (style.length * view.scale));
    c.setTransform(k * fx, -k * fy, k * fy, k * fx, ratio * px(x), ratio * py(y));
    const length = style.length * grow, half = style.width * grow / 2;
    // A rim in the theme's surface colour keeps every vehicle readable, whatever the asphalt colour is.
    const rim = 0.8 / view.scale;
    c.fillStyle = tokens['--bg-surface'];
    c.fillRect(-length - rim, -half - rim, length + rim * 2, half * 2 + rim * 2);
    c.fillStyle = color;
    c.fillRect(-length, -half, length, half * 2);
    if (style.kind !== 'bike' && length * view.scale >= 8) {
      c.fillStyle = tokens['--scene-bg'];
      c.globalAlpha = 0.5;
      c.fillRect(-Math.min(length * 0.42, 2.1), -half * 0.74, Math.min(length * 0.14, 0.8), half * 1.48);
      c.globalAlpha = 1;
    }
    if (speed < 0.5) {
      c.fillStyle = tokens['--signal-red'];
      c.fillRect(-length, -half, Math.max(0.5, length * 0.08), half * 2);
    }
    if (style.kind === 'emergency' && Math.floor(performance.now() / 250) % 2) {
      c.fillStyle = tokens['--accent'];
      c.fillRect(-length * 0.55, -half, length * 0.14, half * 2);
    }
    drawnVehicles += 1;
  };

  const updateCorridor = (log, t, frame) => {
    const now = performance.now();
    if (now - corridorAt < EMERGENCY_EVERY_MS) return;
    corridorAt = now;
    corridorEdges = new Set();
    emergencyAhead = new Set();
    if (!log) return;
    for (const vehicle of log.emergencyAt(t).active) {
      const at = frame?.index?.get(vehicle.id);
      const edge = at === undefined ? -1 : frame.e[at];
      const start = edge >= 0 ? vehicle.route.indexOf(network.edges[edge]?.id) : -1;
      for (const id of vehicle.route.slice(Math.max(0, start))) {
        const i = edgeIndex.get(id);
        if (i !== undefined) corridorEdges.add(i);
      }
      for (const tls of vehicle.tls) if (!vehicle.passed.has(tls)) emergencyAhead.add(tls);
    }
  };

  const packetPoint = (id, frame) => {
    const node = nodes.get(id);
    if (node) return node;
    const at = frame?.index?.get(id);
    return at === undefined ? null : [frame.x[at], frame.y[at]];
  };

  const draw = () => {
    if (!tokens['--scene-bg'] || !width) return;
    if (redrawRoads) paintRoads();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.drawImage(roadsCanvas, 0, 0);
    if (!last) { frames += 1; return; }
    const { buffer, t, log, enabled } = last;
    const pair = buffer.bracket(t);
    const frame = pair?.[0];
    const minWidth = 1.6 / view.scale;
    worldTransform(c);
    c.lineJoin = 'round';

    if (layers.heatmap && roads?.l) {
      network.edges.forEach((edge, i) => {
        if (edge.shape.length < 2) return;
        const level = roads.l[i] ?? 0;
        c.globalAlpha = level === 0 ? 0.1 : 0.2 + level * 0.06;
        c.strokeStyle = tokens[LEVEL_TOKENS[level]];
        c.lineWidth = Math.max(minWidth, (edge.drive_lanes ?? edge.lanes) * LANE_W);
        stroke(c, edge.shape);
      });
      c.globalAlpha = 1;
    }

    if (layers.corridor) {
      updateCorridor(log, t, frame);
      if (corridorEdges.size) {
        c.strokeStyle = tokens['--msg-emergency'];
        c.globalAlpha = 0.8;
        c.setLineDash([6, 5]);
        c.lineDashOffset = -(performance.now() / 60);
        for (const i of corridorEdges) {
          const edge = network.edges[i];
          c.lineWidth = Math.max(minWidth * 1.5, 1.6);
          stroke(c, edge.shape);
        }
        c.setLineDash([]);
        c.lineDashOffset = 0;
        c.globalAlpha = 1;
      }
    }

    drawnVehicles = 0;
    if (layers.vehicles) {
      buffer.sample(t, drawVehicle);
      worldTransform(c);
    }

    if (layers.signals) {
      const now = performance.now();
      const dot = Math.max(1.5, 2.6 / view.scale);
      for (const bar of bars) {
        const color = signalColor(frame?.tl?.[bar.signal]?.[1], bar.links);
        if (color !== bar.color) { bar.color = color; bar.changedAt = now; }
        const paint = tokens[`--signal-${color}`];
        const flash = Math.max(0, 1 - (now - bar.changedAt) / SIGNAL_FLASH_MS);
        c.fillStyle = paint;
        c.globalAlpha = 0.24 + 0.4 * flash;
        c.beginPath();
        c.arc(bar.x, bar.y, dot * (2 + flash), 0, 6.3);
        c.fill();
        c.globalAlpha = 1;
        c.strokeStyle = paint;
        c.lineWidth = Math.max(0.9, 1.8 / view.scale);
        c.beginPath();
        c.moveTo(bar.x - bar.uy * LANE_W * 0.48, bar.y + bar.ux * LANE_W * 0.48);
        c.lineTo(bar.x + bar.uy * LANE_W * 0.48, bar.y - bar.ux * LANE_W * 0.48);
        c.stroke();
        c.beginPath();
        c.arc(bar.x, bar.y, dot * 0.55, 0, 6.3);
        c.fill();
      }
    }

    if (layers.agents) {
      for (const signal of signals) {
        c.strokeStyle = emergencyAhead.has(signal.id) ? tokens['--msg-emergency'] : tokens['--accent'];
        c.lineWidth = 1.6 / view.scale;
        c.beginPath();
        c.arc(signal.x, signal.y, Math.max(2.6, 5 / view.scale), 0, 6.3);
        c.stroke();
      }
    }

    if (layers.comms && log && enabled) {
      for (const packet of log.packetsAt(t, enabled, 40)) {
        const from = packetPoint(packet.route.from, frame), to = packetPoint(packet.route.to, frame);
        if (!from || !to) continue;
        const x = from[0] + (to[0] - from[0]) * packet.progress, y = from[1] + (to[1] - from[1]) * packet.progress;
        const color = tokens[MESSAGE_TOKENS[packet.category]];
        c.strokeStyle = color;
        c.globalAlpha = 0.55 * (1 - packet.progress * 0.6);
        c.lineWidth = 1.5 / view.scale;
        c.beginPath();
        c.moveTo(from[0], from[1]);
        c.lineTo(x, y);
        c.stroke();
        c.globalAlpha = 1;
        c.fillStyle = color;
        c.beginPath();
        c.arc(x, y, (packet.category === 'traffic' ? 3 : 4.5) / view.scale, 0, 6.3);
        c.fill();
      }
    }

    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (layers.agents) {
      c.textAlign = 'center';
      if (view.scale >= LABEL_MIN_SCALE) {
        c.font = `600 10px ${tokens['--font-main']}`;
        c.fillStyle = tokens['--text-primary'];
        for (const signal of signals) c.fillText(signal.id, px(signal.x), py(signal.y) + 3.5);
      }
    }
    ctxFrame = frame;
    frames += 1;
  };

  const pick = (mx, my) => {
    const junction = signals.find(s => Math.hypot(px(s.x) - mx, py(s.y) - my) < Math.max(12, 10 * view.scale));
    if (junction) return { kind: 'junction', id: junction.id };
    let best = -1, distance = 9;
    network.edges.forEach((edge, i) => {
      for (let k = 1; k < edge.shape.length; k++) {
        const ax = px(edge.shape[k - 1][0]), ay = py(edge.shape[k - 1][1]), bx = px(edge.shape[k][0]), by = py(edge.shape[k][1]);
        const dx = bx - ax, dy = by - ay;
        const f = Math.max(0, Math.min(1, ((mx - ax) * dx + (my - ay) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(ax + dx * f - mx, ay + dy * f - my);
        if (d < distance) { distance = d; best = i; }
      }
    });
    return best >= 0 ? { kind: 'road', id: network.edges[best].id, index: best } : null;
  };

  const zoomAt = (mx, my, factor) => {
    const next = Math.min(40, Math.max(0.15, view.scale * factor));
    const applied = next / view.scale;
    view.x = mx - (mx - view.x) * applied;
    view.y = my - (my - view.y) * applied;
    view.scale = next;
    redrawRoads = true;
    draw();
  };

  const relative = event => {
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };
  const down = event => { const [mx, my] = relative(event); drag = { mx, my, x: view.x, y: view.y, moved: false }; canvas.setPointerCapture?.(event.pointerId); };
  const move = event => {
    if (!drag) return;
    const [mx, my] = relative(event);
    if (Math.hypot(mx - drag.mx, my - drag.my) > 4) drag.moved = true;
    if (!drag.moved) return;
    view.x = drag.x + mx - drag.mx;
    view.y = drag.y + my - drag.my;
    redrawRoads = true;
    draw();
  };
  const up = event => {
    if (drag && !drag.moved) { const [mx, my] = relative(event); onPick(pick(mx, my)); }
    drag = null;
  };
  // The page below keeps scrolling normally: the wheel zooms only with Ctrl, or in fullscreen.
  const wheel = event => {
    if (!event.ctrlKey && document.fullscreenElement === null) return;
    event.preventDefault();
    const [mx, my] = relative(event);
    zoomAt(mx, my, event.deltaY < 0 ? 1.15 : 0.87);
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  const observer = new ResizeObserver(() => { resize(); draw(); });
  observer.observe(container);
  resize();
  const counter = setInterval(() => { fps = frames; frames = 0; }, 1000);

  const focus = (x, y, scale) => {
    const gaps = (insets && insets()) || { top: 0, right: 0, bottom: 0, left: 0 };
    view.scale = Math.max(view.scale, scale);
    view.x = gaps.left + (width - gaps.left - gaps.right) / 2 - view.scale * x;
    view.y = gaps.top + (height - gaps.top - gaps.bottom) / 2 + view.scale * y;
    redrawRoads = true;
    draw();
  };

  return {
    flat: true,
    applyTheme(next) { tokens = next; redrawRoads = true; draw(); },
    update(buffer, t, log, enabled) {
      buffer.updateJunctions(t);
      last = { buffer, t, log, enabled };
      roads = buffer.roads;
      draw();
      return { frame: ctxFrame };
    },
    setLayer(name, value) { layers[name] = value; draw(); },
    setAllowed() {},
    setQuality() {},
    select() {},
    refit() { fit(); draw(); },
    resetCamera() { fit(); draw(); },
    zoom(direction) { zoomAt(width / 2, height / 2, direction > 0 ? 1.25 : 0.8); },
    focusJunction(id) { const s = signalById.get(id); if (s) focus(s.x, s.y, 3.2); },
    focusPoint(x, y) { focus(x, y, 2.2); },
    junctionInfo: id => signalById.get(id) ?? null,
    vehicleInfo: () => null,
    vehicleGone: () => false,
    stats: () => ({ fps, drawn: drawnVehicles, total: ctxFrame?.ids?.length ?? 0, intersections: signals.length, label: '2D', auto: false }),
    destroy() {
      clearInterval(counter);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('wheel', wheel);
      canvas.remove();
    },
  };
}
