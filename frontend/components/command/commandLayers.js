// Command Center layers on top of the twin scene: road levels, road storage, agents and their hierarchy, message packets
// and the emergency corridor. Every object is created once and updated in place.
import { PACKET_S } from './eventModel.js';

const LEVEL_FADE_S = 2;
const HIERARCHY_RATIO = 0.16;       // Coordinator altitude as a share of the network radius.
const LANES_VISIBLE_M = 1100;
const FILL_FROM_USED = 0.5;

export const COMMAND_TOKENS = [
  '--road-free', '--road-normal', '--road-busy', '--road-heavy', '--road-severe', '--road-blocked',
  '--msg-traffic', '--msg-proposal', '--msg-congestion', '--msg-central', '--msg-signal', '--msg-emergency', '--msg-health',
];
const ROAD_TOKENS = COMMAND_TOKENS.slice(0, 6);
const MESSAGE = { traffic: '--msg-traffic', proposal: '--msg-proposal', congestion: '--msg-congestion', central: '--msg-central', signal: '--msg-signal', emergency: '--msg-emergency', health: '--msg-health' };

// The part of a road nearest its stop line that a share of its capacity would fill.
export function tailOfShape(shape, share) {
  let total = 0;
  for (let i = 1; i < shape.length; i++) total += Math.hypot(shape[i][0] - shape[i - 1][0], shape[i][1] - shape[i - 1][1]);
  let left = total * Math.min(1, Math.max(0, share));
  const out = [shape[shape.length - 1]];
  for (let i = shape.length - 1; i > 0 && left > 0; i--) {
    const [ax, ay] = shape[i], [bx, by] = shape[i - 1];
    const part = Math.hypot(bx - ax, by - ay);
    if (part >= left) {
      const f = part ? left / part : 0;
      out.push([ax + (bx - ax) * f, ay + (by - ay) * f]);
      break;
    }
    out.push(shape[i - 1]);
    left -= part;
  }
  return out.reverse();
}

export function createCommandLayers(Cesium, twin, network, { hierarchy }) {
  const { BillboardCollection, Cartesian2, Cartesian3, Color, DistanceDisplayCondition, HorizontalOrigin, LabelCollection, LabelStyle, Material,
    NearFarScalar, PointPrimitiveCollection, PolylineCollection, VerticalOrigin } = Cesium;
  const { scene, toWorld, vehiclePosition } = twin.context();
  const bounds = network.bounds || { min_x: 0, max_x: 500, min_y: 0, max_y: 500 };
  const radius = Math.max(150, Math.hypot(bounds.max_x - bounds.min_x, bounds.max_y - bounds.min_y) / 2);
  const altitude = radius * HIERARCHY_RATIO;

  const lines = scene.primitives.add(new PolylineCollection());
  const points = scene.primitives.add(new PointPrimitiveCollection());
  const glows = scene.primitives.add(new BillboardCollection());
  const labels = scene.primitives.add(new LabelCollection());
  const line = (positions, width, show = true, id) => lines.add({ positions, width, show, id, material: Material.fromType('Color', { color: Color.WHITE.clone() }) });

  // ---------------------------------------------- roads
  const edgeIndex = new Map(network.edges.map((e, i) => [e.id, i]));
  const roads = network.edges.map((edge, i) => {
    if (edge.shape.length < 2) return null;
    const pick = { kind: 'road', id: edge.id, index: i };
    return {
      edge,
      overlay: line(edge.shape.map(([x, y]) => toWorld(x, y, 0.7)), Math.min(7, 2.5 + (edge.drive_lanes ?? edge.lanes)), true, pick),
      fill: line([toWorld(edge.shape[0][0], edge.shape[0][1], 1.1), toWorld(edge.shape[1][0], edge.shape[1][1], 1.1)], Math.min(9, 4 + (edge.drive_lanes ?? edge.lanes)), false, pick),
      lanes: (edge.lane_shapes || []).filter(s => s.length >= 2).map(shape => {
        const lane = line(shape.map(([x, y]) => toWorld(x, y, 0.85)), 1, true, pick);
        lane.distanceDisplayCondition = new DistanceDisplayCondition(0, LANES_VISIBLE_M);
        return lane;
      }),
      level: 0, from: 0, mix: 1, color: null, used: 0, fillShown: null,
    };
  });

  // ---------------------------------------------- agents and hierarchy
  const signals = network.signals.filter(s => s.x !== null && s.x !== undefined);
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = glowCanvas.height = 64;
  const g2d = glowCanvas.getContext('2d');
  const gradient = g2d.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'white');
  gradient.addColorStop(1, 'transparent');
  g2d.fillStyle = gradient;
  g2d.fillRect(0, 0, 64, 64);

  const makeNode = (id, position, size, label, kind) => {
    const pick = { kind, id };
    return {
      id, position, size, kind, pulse: -Infinity, pulseColor: null,
      point: points.add({ position, pixelSize: size, outlineWidth: 2, id: pick, disableDepthTestDistance: Number.POSITIVE_INFINITY }),
      glow: glows.add({ position, image: glowCanvas, width: size * 4, height: size * 4, show: false, id: pick, disableDepthTestDistance: Number.POSITIVE_INFINITY }),
      label: label && labels.add({
        position, text: label, scale: 0.42, pixelOffset: new Cartesian2(0, -(size + 8)), horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY, style: LabelStyle.FILL_AND_OUTLINE, outlineWidth: 3,
      }),
    };
  };

  const nodes = new Map();
  const agentById = new Map(signals.map(s => [s.id, s]));
  for (const signal of signals) nodes.set(signal.id, makeNode(signal.id, toWorld(signal.x, signal.y, 6), 9, null, 'junction'));

  const channels = (network.links || []).filter(([a, b]) => agentById.has(a) && agentById.has(b)).map(([a, b]) => {
    const [from, to] = [nodes.get(a), nodes.get(b)];
    return { a, b, line: line([from.position, to.position], 1) };
  });

  const regionLines = [];
  const regionCenters = new Map();
  if (hierarchy) {
    const center = toWorld((bounds.min_x + bounds.max_x) / 2, (bounds.min_y + bounds.max_y) / 2, altitude * 2);
    nodes.set('CENTRAL', makeNode('CENTRAL', center, 20, 'Central supervisor', 'central'));
    for (const [region, members] of Object.entries(network.regions || {})) {
      const placed = members.map(m => agentById.get(m)).filter(Boolean);
      if (!placed.length) continue;
      const x = placed.reduce((sum, s) => sum + s.x, 0) / placed.length, y = placed.reduce((sum, s) => sum + s.y, 0) / placed.length;
      regionCenters.set(region, { x, y });
      const position = toWorld(x, y, altitude);
      nodes.set(region, makeNode(region, position, 14, `Coordinator ${region}`, 'region'));
      regionLines.push(line([position, center], 1.5));
      for (const member of placed) regionLines.push(line([nodes.get(member.id).position, position], 1));
    }
  }

  // ---------------------------------------------- packets, message caption, corridor
  const packets = Array.from({ length: 60 }, () => points.add({ position: Cartesian3.ZERO, pixelSize: 8, show: false, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY }));
  const trails = Array.from({ length: 16 }, () => line([Cartesian3.ZERO, Cartesian3.UNIT_Z], 2.5, false));
  const captions = Array.from({ length: 3 }, () => labels.add({ position: Cartesian3.ZERO, text: ' ', show: false, scale: 0.42, pixelOffset: new Cartesian2(0, -24), horizontalOrigin: HorizontalOrigin.CENTER, verticalOrigin: VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY, style: LabelStyle.FILL_AND_OUTLINE, outlineWidth: 3, showBackground: true }));
  const corridor = roads.map(road => (road ? line(road.edge.shape.map(([x, y]) => toWorld(x, y, 1.3)), Math.min(11, 6 + (road.edge.drive_lanes ?? road.edge.lanes)), false, { kind: 'road', id: road.edge.id, index: edgeIndex.get(road.edge.id) }) : null));

  // ---------------------------------------------- state
  let theme = null;
  const visible = { heatmap: true, agents: true, comms: true, corridor: true };
  let selected = null;
  let hoverJunctions = new Set();
  let lastT = null;
  let lastRoadT = null;
  const scratchA = new Cartesian3();

  const applyTheme = (tokens, sceneTheme) => {
    const color = name => Color.fromCssColorString(tokens[name]);
    theme = {
      road: ROAD_TOKENS.map(color), message: Object.fromEntries(Object.entries(MESSAGE).map(([k, v]) => [k, color(v)])), scene: sceneTheme,
      laneLine: Color.fromAlpha(sceneTheme.roadCenter, 0.55), channel: Color.fromAlpha(sceneTheme.marker, 0.28), hierarchy: Color.fromAlpha(color('--msg-central'), 0.3),
      caption: Color.fromAlpha(sceneTheme.markerOutline, 0.86), outline: sceneTheme.markerOutline, label: sceneTheme.label,
    };
    for (const road of roads) {
      if (!road) continue;
      road.color = theme.road[road.level].clone();
      road.overlay.material.uniforms.color = road.color;
      road.fill.material.uniforms.color = theme.road[Math.max(3, road.level)];
      road.lanes.forEach(lane => { lane.material.uniforms.color = theme.laneLine; });
    }
    channels.forEach(c => { c.line.material.uniforms.color = theme.channel; });
    regionLines.forEach(l => { l.material.uniforms.color = theme.hierarchy; });
    corridor.forEach(l => { if (l) l.material.uniforms.color = Color.fromAlpha(theme.message.emergency, 0.8); });
    for (const node of nodes.values()) {
      node.point.color = node.kind === 'junction' ? sceneTheme.marker : theme.message.central;
      node.point.outlineColor = theme.outline;
      if (node.label) { node.label.font = `600 26px ${sceneTheme.font}`; node.label.fillColor = theme.label; node.label.outlineColor = theme.outline; }
    }
    packets.forEach(p => { p.outlineColor = theme.outline; });
    captions.forEach(c => { c.font = `600 24px ${sceneTheme.font}`; c.fillColor = theme.label; c.outlineColor = theme.outline; c.backgroundColor = theme.caption; });
    scene.requestRender();
  };

  const applyVisibility = () => {
    for (const road of roads) {
      if (!road) continue;
      road.overlay.show = visible.heatmap && (road.level > 0 || selected?.id === road.edge.id);
      road.fill.show = visible.heatmap && road.fillShown !== null;
    }
    channels.forEach(c => { c.line.show = visible.agents && visible.comms; });
    regionLines.forEach(l => { l.show = visible.agents && visible.comms; });
    for (const node of nodes.values()) {
      node.point.show = visible.agents;
      if (node.label) node.label.show = visible.agents;
      if (!visible.agents) node.glow.show = false;
    }
    if (!visible.corridor) corridor.forEach(l => { if (l) l.show = false; });
    if (!visible.comms) { packets.forEach(p => { p.show = false; }); trails.forEach(t => { t.show = false; }); captions.forEach(c => { c.show = false; }); }
    scene.requestRender();
  };

  // A new road sample only starts a fade, so traffic changes appear gradually instead of jumping.
  const applyRoadSample = sample => {
    for (let i = 0; i < roads.length; i++) {
      const road = roads[i];
      if (!road) continue;
      const level = sample.l[i] ?? 0;
      if (level !== road.level) { road.from = road.level; road.level = level; road.mix = 0; }
      road.used = sample.u[i] ?? 0;
      const fill = road.used >= FILL_FROM_USED || selected?.id === road.edge.id ? Math.round(road.used * 20) / 20 : null;
      if (fill !== road.fillShown) {
        road.fillShown = fill;
        if (fill !== null) road.fill.positions = tailOfShape(road.edge.shape, fill).map(([x, y]) => toWorld(x, y, 1.1));
        if (theme) road.fill.material.uniforms.color = theme.road[Math.max(3, road.level)];
      }
      road.fill.show = visible.heatmap && fill !== null;
    }
  };

  const fadeRoads = dt => {
    if (!theme) return;
    for (const road of roads) {
      if (!road) continue;
      if (road.mix < 1) {
        road.mix = Math.min(1, road.mix + Math.abs(dt) / LEVEL_FADE_S);
        Color.lerp(theme.road[road.from], theme.road[road.level], road.mix, road.color);
        road.overlay.material.uniforms.color = road.color;
      }
      road.overlay.show = visible.heatmap && (road.level > 0 || road.mix < 1 || selected?.id === road.edge.id);
    }
  };

  const resolve = id => nodes.get(id)?.position ?? vehiclePosition(id);

  const updatePackets = (t, log, enabled) => {
    let used = 0, trailsUsed = 0, captionsUsed = 0;
    for (const node of nodes.values()) if (node.glow.show && t - node.pulse > PACKET_S) node.glow.show = false;
    if (visible.comms && theme) {
      // Newest first, so captions follow what just happened and rarer kinds keep their label.
      const live = log.packetsAt(t, enabled, packets.length);
      const important = live.filter(p => p.category !== 'traffic' && p.category !== 'proposal');
      for (const packet of live) {
        if (used >= packets.length) break;
        const from = resolve(packet.route.from), to = resolve(packet.route.to);
        if (!from || !to) continue;
        const color = theme.message[packet.category];
        const dot = packets[used++];
        Cartesian3.lerp(from, to, packet.progress, scratchA);
        dot.position = scratchA;
        dot.color = color;
        dot.pixelSize = packet.category === 'traffic' ? 7 : 11;
        dot.show = true;
        if (trailsUsed < trails.length && packet.category !== 'traffic') {
          const trail = trails[trailsUsed++];
          trail.positions = [from, Cartesian3.clone(scratchA)];
          trail.material.uniforms.color = color;
          trail.show = true;
        }
        const sender = nodes.get(packet.route.from), receiver = nodes.get(packet.route.to);
        if (visible.agents) {
          if (sender && packet.progress < 0.4) { sender.glow.color = Color.fromAlpha(color, 0.7, sender.glow.color); sender.glow.show = true; sender.pulse = t; }
          if (receiver && packet.progress > 0.75) { receiver.glow.color = Color.fromAlpha(color, 0.9, receiver.glow.color); receiver.glow.show = true; receiver.pulse = t; }
        }
        if (important.includes(packet) && captionsUsed < captions.length && packet.event.payload.text) {
          const caption = captions[captionsUsed++];
          caption.position = to;
          const text = packet.event.payload.text;
          caption.text = text.length > 58 ? `${text.slice(0, 57)}…` : text;
          caption.show = true;
        }
      }
    }
    for (let i = used; i < packets.length; i++) packets[i].show = false;
    for (let i = trailsUsed; i < trails.length; i++) trails[i].show = false;
    for (let i = captionsUsed; i < captions.length; i++) captions[i].show = false;
  };

  const updateCorridor = (emergency, frame) => {
    const onRoute = new Set();
    hoverJunctions = new Set();
    if (visible.corridor) {
      for (const vehicle of emergency.active) {
        const at = frame?.index?.get(vehicle.id);
        const edge = at === undefined ? -1 : frame.e[at];
        const name = edge >= 0 ? network.edges[edge]?.id : null;
        const start = name ? vehicle.route.indexOf(name) : -1;
        vehicle.route.slice(Math.max(0, start)).forEach(id => { const i = edgeIndex.get(id); if (i !== undefined) onRoute.add(i); });
        vehicle.tls.filter(tls => !vehicle.passed.has(tls)).forEach(tls => hoverJunctions.add(tls));
      }
    }
    corridor.forEach((l, i) => { if (l) l.show = onRoute.has(i); });
    for (const [id, node] of nodes) {
      if (node.kind !== 'junction' || !theme) continue;
      const ahead = hoverJunctions.has(id);
      node.point.color = ahead ? theme.message.emergency : theme.scene.marker;
      node.point.pixelSize = ahead ? node.size + 5 : selected?.id === id ? node.size + 6 : node.size;
    }
  };

  return {
    applyTheme,
    setLayer(name, value) { visible[name] = value; applyVisibility(); },
    setSelected(next) { selected = next; lastRoadT = null; applyVisibility(); },
    update(buffer, t, log, enabled, frame) {
      const dt = lastT === null ? 0 : t - lastT;
      lastT = t;
      if (buffer.roadTime !== lastRoadT && buffer.roads) { lastRoadT = buffer.roadTime; applyRoadSample(buffer.roads); }
      fadeRoads(dt);
      updatePackets(t, log, enabled);
      updateCorridor(log.emergencyAt(t), frame);
      scene.requestRender();
    },
    regionCenter: id => regionCenters.get(id) ?? null,
    destroy() { for (const collection of [lines, points, glows, labels]) if (!scene.isDestroyed()) scene.primitives.remove(collection); },
  };
}
