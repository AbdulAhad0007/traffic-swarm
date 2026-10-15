'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fmt, LEVEL_COLORS } from '@/lib/api';
import { usePanZoom, useFullscreen } from '@/lib/usePanZoom';
import { ZoomIn, ZoomOut, RotateCw, Maximize2, Minimize2, Crosshair, Building2, Car, BarChart3, Box, ScanEye } from 'lucide-react';

// Isometric 3D view of the whole signal network (3x3 up to 9x9 and OSM layouts).
// Geometry comes from the live layout (SUMO metres); buildings are placed off-road deterministically.

// Camera presets: azimuth (degrees around the vertical) and elevation (0 = side-on, 90 = straight down).
const CAMERAS = [
  ['iso', '3D', 45, 35.26],
  ['bird', "Bird's-eye", 45, 60],
  ['top', 'Top view', 0, 90],
];
const W = 1200;
const H = 720;

const BUILDING_PRESETS = [
  { top: '#2a4a72', south: '#152d4a', east: '#0f2137', win: '#38bdf8' },
  { top: '#3d2a63', south: '#231440', east: '#1a0e30', win: '#a855f7' },
  { top: '#245240', south: '#132e22', east: '#0d221a', win: '#34d399' },
  { top: '#4d3a2a', south: '#2e2017', east: '#221710', win: '#fbbf24' },
  { top: '#3a2a4d', south: '#20162e', east: '#170e22', win: '#f472b6' },
  { top: '#2a3d4d', south: '#16222e', east: '#0e1822', win: '#60a5fa' },
];
const CAR_COLORS = ['#e2e8f0', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4', '#94a3b8'];

function hash(n) {
  let s = (n * 2654435761) % 2147483647;
  s = (s * 16807) % 2147483647;
  return s / 2147483647;
}

function rotate([u, v], rot) {
  if (rot === 1) return [-v, u];
  if (rot === 2) return [-u, -v];
  if (rot === 3) return [v, -u];
  return [u, v];
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// 0 = no data, 1 = free flowing, 2 = moderate, 3 = heavy (same thresholds as the 2D heatmap)
function severity(j) {
  if (!j || j.level === 'no_data') return 0;
  const q = j.queue || 0, occ = j.occupancy || 0;
  return q > 4 || occ > 0.4 ? 3 : q > 1 || occ > 0.2 ? 2 : 1;
}
const HEAT = ['#475569', '#facc15', '#f97316', '#ef4444'];

export default function CityGrid3D({ layout, junctions, route = [], selected, onSelect, onOpenIntersection, height = 560 }) {
  const wrapRef = useRef(null);
  const [isFull, toggleFull] = useFullscreen(wrapRef);
  const pz = usePanZoom(W, H);
  const [rot, setRot] = useState(0);
  const [cam, setCam] = useState({ id: 'iso', az: 45, el: 35.26 });
  const [hover, setHover] = useState(null);
  const [showBuildings, setShowBuildings] = useState(true);
  const [showCars, setShowCars] = useState(true);
  const [showPillars, setShowPillars] = useState(true);
  const [t, setT] = useState(0);

  // ~15 fps animation clock for vehicles
  useEffect(() => {
    let raf, last = 0;
    const loop = now => {
      if (now - last > 66) { last = now; setT(now / 1000); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Static geometry: rotated world coords, projection, roads and building sites ──
  const geo = useMemo(() => {
    if (!layout?.bounds) return null;
    const b = layout.bounds;
    const cx = (b.min_x + b.max_x) / 2, cy = (b.min_y + b.max_y) / 2;
    const world = {};
    for (const n of layout.nodes) if (n.x != null) world[n.id] = [n.x - cx, -(n.y - cy)];

    const segs = layout.links.map(([a, c]) => [a, c]).filter(([a, c]) => world[a] && world[c]);
    const lens = segs.map(([a, c]) => Math.hypot(world[c][0] - world[a][0], world[c][1] - world[a][1])).sort((x, y) => x - y);
    const L = lens.length ? Math.max(20, lens[Math.floor(lens.length / 2)]) : 150;
    const rw = L * 0.085;

    // Building sites on a half-block lattice, kept clear of every road and near the network.
    const sites = [];
    const step = L / 2;
    const x0 = b.min_x - cx - 0.75 * L, x1 = b.max_x - cx + 0.75 * L;
    const y0 = -(b.max_y - cy) - 0.75 * L, y1 = -(b.min_y - cy) + 0.75 * L;
    let k = 0;
    for (let x = x0; x <= x1 + 1e-6; x += step) {
      for (let y = y0; y <= y1 + 1e-6; y += step) {
        k++;
        const a = L * (0.09 + hash(k) * 0.04);
        const bb = L * (0.09 + hash(k + 7) * 0.04);
        let dmin = Infinity;
        for (const [p, q] of segs) {
          dmin = Math.min(dmin, distToSeg(x, y, world[p][0], world[p][1], world[q][0], world[q][1]));
          if (dmin < rw + Math.max(a, bb) * 1.2) break;
        }
        if (segs.length && (dmin < rw + Math.max(a, bb) * 1.2 || dmin > 0.8 * L)) continue;
        sites.push({ id: k, u: x, v: y, a, b: bb });
      }
    }
    const maxR = Math.max(1, ...sites.map(s => Math.hypot(s.u, s.v)));
    for (const s of sites) {
      const centre = 1 - Math.hypot(s.u, s.v) / maxR;
      s.h = L * (0.1 + hash(s.id + 3) * 0.32) * (1 + centre * 0.9);
      s.preset = BUILDING_PRESETS[Math.floor(hash(s.id + 11) * BUILDING_PRESETS.length)];
    }

    // Rotate everything, then fit the projection into the W x H canvas.
    const rnodes = {};
    for (const id in world) rnodes[id] = rotate(world[id], rot);
    const rsites = sites.map(s => {
      const [u, v] = rotate([s.u, s.v], rot);
      const odd = rot % 2 === 1;
      return { ...s, u, v, a: odd ? s.b : s.a, b: odd ? s.a : s.b };
    });
    // Orthographic camera: turn by the azimuth, then tilt by the elevation.
    const ca = Math.cos((cam.az * Math.PI) / 180), sa = Math.sin((cam.az * Math.PI) / 180);
    const se = Math.sin((cam.el * Math.PI) / 180), ce = Math.max(0, Math.cos((cam.el * Math.PI) / 180));
    const raw = (u, v, z) => [u * ca - v * sa, (u * sa + v * ca) * se - z * ce];
    const depthOf = (u, v) => u * sa + v * ca;
    const pts = [];
    const ext = [...Object.values(rnodes), ...rsites.map(s => [s.u, s.v])];
    for (const [u, v] of ext) {
      pts.push(raw(u - L * 0.4, v - L * 0.4, 0), raw(u + L * 0.4, v + L * 0.4, 0), raw(u + L * 0.4, v - L * 0.4, 0), raw(u - L * 0.4, v + L * 0.4, 0));
    }
    for (const st of rsites) pts.push(raw(st.u, st.v, st.h));
    const minX = Math.min(...pts.map(p => p[0])), maxX = Math.max(...pts.map(p => p[0]));
    const minY = Math.min(...pts.map(p => p[1])), maxY = Math.max(...pts.map(p => p[1]));
    const pad = 30;
    const s = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1));
    const ox = (W - (maxX - minX) * s) / 2 - minX * s;
    const oy = (H - (maxY - minY) * s) / 2 - minY * s;
    const P = (u, v, z = 0) => { const [x, y] = raw(u, v, z); return [x * s + ox, y * s + oy]; };
    const poly = pts4 => pts4.map(([u, v, z]) => P(u, v, z).map(n => n.toFixed(1)).join(',')).join(' ');

    const roads = segs.map(([a, c]) => {
      const [ua, va] = rnodes[a], [uc, vc] = rnodes[c];
      const len = Math.hypot(uc - ua, vc - va) || 1;
      const dx = (uc - ua) / len, dy = (vc - va) / len;
      const nx = -dy, ny = dx;
      const quad = w => poly([[ua + nx * w, va + ny * w, 0], [uc + nx * w, vc + ny * w, 0], [uc - nx * w, vc - ny * w, 0], [ua - nx * w, va - ny * w, 0]]);
      return { a, c, len, dx, dy, nx, ny, ua, va, uc, vc, asphalt: quad(rw), heat: quad(rw * 0.55), line: [P(ua, va), P(uc, vc)] };
    });

    return { L, rw, s, P, poly, se, depthOf, rnodes, roads, sites: rsites, nodeCount: Object.keys(rnodes).length };
  }, [layout, rot, cam.az, cam.el]);

  const detailed = pz.zoom >= 2;

  // Buildings are pure geometry: built once per rotation/detail level and reused every frame.
  const buildingEls = useMemo(() => {
    if (!geo || !showBuildings) return [];
    const { poly, L, s } = geo;
    const bands = geo.nodeCount > 25 ? 5 : 8;
    return geo.sites.map(st => {
      const { u, v, a, b, h, preset } = st;
      const floorLines = [];
      if (detailed) {
        const n = Math.max(2, Math.min(bands, Math.floor(h / (L * 0.05))));
        for (let f = 0; f < n; f++) {
          const z = h * ((f + 0.6) / (n + 0.4));
          const P = geo.P;
          const [sx1, sy1] = P(u - a * 0.85, v + b, z), [sx2, sy2] = P(u + a * 0.85, v + b, z);
          const [ex1, ey1] = P(u + a, v + b * 0.85, z), [ex2, ey2] = P(u + a, v - b * 0.85, z);
          const lit = hash(st.id * 31 + f) > 0.35;
          floorLines.push(
            <line key={'s' + f} x1={sx1} y1={sy1} x2={sx2} y2={sy2} stroke={lit ? preset.win : '#0b1220'} strokeWidth={Math.max(0.6, L * 0.018 * s)} strokeDasharray={`${L * 0.03 * s} ${L * 0.02 * s}`} opacity={0.75} />,
            <line key={'e' + f} x1={ex1} y1={ey1} x2={ex2} y2={ey2} stroke={lit ? preset.win : '#0b1220'} strokeWidth={Math.max(0.6, L * 0.018 * s)} strokeDasharray={`${L * 0.03 * s} ${L * 0.02 * s}`} opacity={0.5} />
          );
        }
      }
      return {
        depth: geo.depthOf(u, v),
        el: (
          <g key={'b' + st.id}>
            <polygon points={poly([[u - a, v + b, 0], [u + a, v + b, 0], [u + a, v + b, h], [u - a, v + b, h]])} fill={preset.south} stroke="rgba(255,255,255,0.05)" strokeWidth={0.4} />
            <polygon points={poly([[u + a, v - b, 0], [u + a, v + b, 0], [u + a, v + b, h], [u + a, v - b, h]])} fill={preset.east} stroke="rgba(255,255,255,0.04)" strokeWidth={0.4} />
            <polygon points={poly([[u - a, v - b, h], [u + a, v - b, h], [u + a, v + b, h], [u - a, v + b, h]])} fill={preset.top} stroke="rgba(255,255,255,0.1)" strokeWidth={0.4} />
            {floorLines}
          </g>
        ),
      };
    });
  }, [geo, detailed, showBuildings]);

  const groundEl = useMemo(() => {
    if (!geo) return null;
    const { poly, rnodes, L } = geo;
    const us = Object.values(rnodes).map(p => p[0]), vs = Object.values(rnodes).map(p => p[1]);
    const m = L * 0.95;
    const u0 = Math.min(...us) - m, u1 = Math.max(...us) + m, v0 = Math.min(...vs) - m, v1 = Math.max(...vs) + m;
    const slab = L * 0.08;
    return (
      <g>
        <polygon points={poly([[u0, v1, 0], [u1, v1, 0], [u1, v1, -slab], [u0, v1, -slab]])} fill="#0a1220" />
        <polygon points={poly([[u1, v0, 0], [u1, v1, 0], [u1, v1, -slab], [u1, v0, -slab]])} fill="#070d18" />
        <polygon points={poly([[u0, v0, 0], [u1, v0, 0], [u1, v1, 0], [u0, v1, 0]])} fill="url(#cityGround)" stroke="rgba(56,189,248,0.25)" strokeWidth={1} />
      </g>
    );
  }, [geo]);

  if (!geo) {
    return <div className="heatmap empty"><p className="muted">Waiting for simulation layout…</p></div>;
  }

  const { P, poly, rnodes, roads, L, rw, s, nodeCount } = geo;
  const routeSet = new Set(route.slice(1).map((id, i) => [route[i], id].sort().join('|')));

  // ── Dynamic layers ──
  const cars = [];
  if (showCars) {
    const cl = rw * 0.42, cw = rw * 0.22, ch = rw * 0.28;
    let k = 0;
    for (const r of roads) {
      for (const dir of [1, -1]) {
        const target = dir === 1 ? r.c : r.a;
        const j = junctions?.[target];
        const q = Math.max(0, Math.round(j?.queue || 0));
        const dens = j?.occupancy != null ? Math.round(j.occupancy * 10) : 2;
        const n = Math.max(1, Math.min(4, q > 0 ? q : dens));
        const [su, sv] = dir === 1 ? [r.ua, r.va] : [r.uc, r.vc];
        const dx = r.dx * dir, dy = r.dy * dir;
        // Drive on the right of the direction of travel (v grows southwards, so right = (-dy, dx)).
        const ox = -dy * rw * 0.45, oy = dx * rw * 0.45;
        for (let i = 0; i < n; i++) {
          k++;
          const queued = i < q;
          const prog = queued
            ? Math.max(0.05, 1 - (rw * 1.3 + cl + i * cl * 2.6) / r.len)
            : ((t * 0.09 + hash(k) + i * 0.27) % 1);
          const cu = su + dx * r.len * prog + ox, cv = sv + dy * r.len * prog + oy;
          const color = queued ? '#ef4444' : CAR_COLORS[k % CAR_COLORS.length];
          if (!detailed && nodeCount > 25) {
            const [x, y] = P(cu, cv, ch);
            cars.push(<circle key={'c' + k} cx={x} cy={y} r={Math.max(1.4, rw * 0.22 * s)} fill={color} />);
            continue;
          }
          const corner = (fl, fw, z) => [cu + dx * fl - dy * fw, cv + dy * fl + dx * fw, z];
          cars.push(
            <g key={'c' + k}>
              <polygon points={poly([corner(-cl, -cw, 0), corner(cl, -cw, 0), corner(cl, cw, 0), corner(-cl, cw, 0)])} fill="rgba(0,0,0,0.5)" />
              <polygon points={poly([corner(-cl, -cw, ch), corner(cl, -cw, ch), corner(cl, cw, ch), corner(-cl, cw, ch)])} fill={color} stroke="rgba(0,0,0,0.6)" strokeWidth={0.3} />
              {detailed && <polygon points={poly([corner(-cl * 0.2, -cw * 0.8, ch * 1.01), corner(cl * 0.5, -cw * 0.8, ch * 1.01), corner(cl * 0.5, cw * 0.8, ch * 1.01), corner(-cl * 0.2, cw * 0.8, ch * 1.01)])} fill="rgba(15,23,42,0.55)" />}
            </g>
          );
        }
      }
    }
  }

  // Tall things that must be depth-sorted together with the buildings: heat pillars and signal poles.
  const tall = [...buildingEls];
  const labels = [];
  for (const [id, [u, v]] of Object.entries(rnodes)) {
    const j = junctions?.[id];
    const sev = severity(j);
    const color = HEAT[sev];
    const q = j?.queue || 0;
    const ph = L * (0.05 + Math.min(q, 15) * 0.035);
    const a = rw * 0.75;
    const isSel = selected === id, isHover = hover === id;
    const handlers = {
      onClick: () => onSelect?.(id),
      onDoubleClick: () => onOpenIntersection?.(id),
      onMouseEnter: () => setHover(id),
      onMouseLeave: () => setHover(h => (h === id ? null : h)),
      style: { cursor: 'pointer' },
    };
    tall.push({
      depth: geo.depthOf(u, v) + 0.001,
      el: (
        <g key={'j' + id} {...handlers}>
          {showPillars && j && (
            <>
              <polygon points={poly([[u - a, v + a, 0], [u + a, v + a, 0], [u + a, v + a, ph], [u - a, v + a, ph]])} fill={color} opacity={0.75} />
              <polygon points={poly([[u + a, v - a, 0], [u + a, v + a, 0], [u + a, v + a, ph], [u + a, v - a, ph]])} fill={color} opacity={0.55} />
              <polygon points={poly([[u - a, v - a, ph], [u + a, v - a, ph], [u + a, v + a, ph], [u - a, v + a, ph]])} fill={color} stroke="#fff7d6" strokeWidth={1} opacity={0.95} filter="url(#pillarGlow)" />
            </>
          )}
          {(detailed || nodeCount <= 9) && j && (() => {
            const [pu, pv] = [u + rw * 1.25, v - rw * 1.25];
            const [x0, y0] = P(pu, pv, 0), [x1, y1] = P(pu, pv, L * 0.12);
            const lamp = j.phase == null ? '#64748b' : j.phase % 2 === 0 ? '#10b981' : '#fbbf24';
            return (
              <g>
                <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#64748b" strokeWidth={Math.max(1, L * 0.008 * s)} />
                <rect x={x1 - L * 0.012 * s} y={y1 - L * 0.04 * s} width={L * 0.024 * s} height={L * 0.045 * s} rx={1} fill="#0b1220" stroke="#334155" strokeWidth={0.4} />
                <circle cx={x1} cy={y1 - L * 0.018 * s} r={L * 0.009 * s} fill={lamp} filter="url(#pillarGlow)" />
              </g>
            );
          })()}
        </g>
      ),
    });
    if (nodeCount <= 25 || pz.zoom >= 1.8 || isSel || isHover) {
      const [x, y] = P(u, v, (showPillars && j ? ph : 0) + L * 0.06);
      const fs = Math.max(3, 12 / Math.pow(pz.zoom, 0.75));
      labels.push(
        <g key={'l' + id} pointerEvents="none">
          <rect x={x - fs * 1.4} y={y - fs * 0.95} width={fs * 2.8} height={fs * 1.3} rx={fs * 0.3} fill="rgba(7,11,19,0.85)" stroke={isSel ? '#ffffff' : color} strokeWidth={isSel ? 1.2 : 0.6} />
          <text x={x} y={y} textAnchor="middle" fontSize={fs * 0.85} fontWeight="700" fontFamily="var(--font-mono)" fill="#f8fafc">{id}</text>
        </g>
      );
    }
  }
  tall.sort((p, q) => p.depth - q.depth);

  const info = junctions?.[hover || selected];
  const infoId = hover || selected;

  return (
    <div ref={wrapRef} className={'city3d' + (isFull ? ' is-full' : '')}>
      <svg
        ref={pz.ref}
        viewBox={pz.viewBox}
        preserveAspectRatio="xMidYMid meet"
        style={{ height: isFull ? '100%' : height }}
        className="city3d-svg"
        {...pz.handlers}
        role="img"
        aria-label={`3D isometric city view of ${nodeCount} signalised junctions`}
      >
        <defs>
          <linearGradient id="citySky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#020617" />
            <stop offset="100%" stopColor="#0b1324" />
          </linearGradient>
          <pattern id="cityGroundTex" width="14" height="14" patternUnits="userSpaceOnUse">
            <rect width="14" height="14" fill="#0b1626" />
            <circle cx="3" cy="3" r="0.7" fill="#12304a" />
            <circle cx="10" cy="9" r="0.5" fill="#143a2a" />
          </pattern>
          <linearGradient id="cityGround" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0d1b2c" />
            <stop offset="100%" stopColor="#09121f" />
          </linearGradient>
          <filter id="roadHeat" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="pillarGlow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="2" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <radialGradient id="hotGlow3" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.75" />
            <stop offset="55%" stopColor="#f97316" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#f97316" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="hotGlow2" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#f97316" stopOpacity="0.6" />
            <stop offset="100%" stopColor="#facc15" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="hotGlow1" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#facc15" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#facc15" stopOpacity="0" />
          </radialGradient>
        </defs>

        <rect x={-W} y={-H} width={W * 3} height={H * 3} fill="url(#citySky)" />
        {groundEl}

        {/* Roads + thermal congestion strips */}
        {roads.map(r => (
          <polygon key={'ra' + r.a + r.c} points={r.asphalt} fill="#1a2232" stroke="#273246" strokeWidth={0.6} />
        ))}
        {Object.entries(rnodes).map(([id, [u, v]]) => (
          <polygon key={'pad' + id} points={poly([[u - rw * 1.15, v - rw * 1.15, 0], [u + rw * 1.15, v - rw * 1.15, 0], [u + rw * 1.15, v + rw * 1.15, 0], [u - rw * 1.15, v + rw * 1.15, 0]])} fill="#111827" stroke={selected === id ? '#ffffff' : '#334155'} strokeWidth={selected === id ? 1.6 : 0.5} />
        ))}
        {roads.map(r => {
          const sev = Math.max(severity(junctions?.[r.a]), severity(junctions?.[r.c]));
          return <polygon key={'rh' + r.a + r.c} points={r.heat} fill={HEAT[sev]} opacity={sev ? 0.55 : 0.15} filter={sev >= 2 ? 'url(#roadHeat)' : undefined} />;
        })}
        {roads.map(r => (
          <line key={'rl' + r.a + r.c} x1={r.line[0][0]} y1={r.line[0][1]} x2={r.line[1][0]} y2={r.line[1][1]} stroke="#fef9c3" strokeWidth={Math.max(0.4, rw * 0.05 * s)} strokeDasharray={`${rw * 0.6 * s} ${rw * 0.5 * s}`} opacity={0.5} />
        ))}

        {/* Ground hotspot glow at each junction */}
        {Object.entries(rnodes).map(([id, [u, v]]) => {
          const sev = severity(junctions?.[id]);
          if (!sev) return null;
          const rr = L * (0.25 + sev * 0.13);
          const [x, y] = P(u, v, 0);
          return <ellipse key={'g' + id} cx={x} cy={y} rx={rr * s} ry={rr * geo.se * s} fill={`url(#hotGlow${sev})`} pointerEvents="none" />;
        })}

        {/* Emergency corridor */}
        {roads.filter(r => routeSet.has([r.a, r.c].sort().join('|'))).map(r => (
          <line key={'rt' + r.a + r.c} x1={r.line[0][0]} y1={r.line[0][1]} x2={r.line[1][0]} y2={r.line[1][1]} className="hm-route" />
        ))}

        {cars}
        {tall.map(x => x.el)}
        {labels}
      </svg>

      {/* Controls */}
      <div className="city3d-controls">
        <button type="button" className="small" onClick={pz.zoomIn} title="Zoom in (or mouse wheel)"><ZoomIn size={14} /></button>
        <button type="button" className="small" onClick={pz.zoomOut} title="Zoom out"><ZoomOut size={14} /></button>
        <button type="button" className="small" onClick={pz.reset} title="Reset view"><Crosshair size={14} /></button>
        <button type="button" className="small" onClick={() => setRot(r => (r + 1) % 4)} title="Rotate city 90°"><RotateCw size={14} /></button>
        <button type="button" className={'small ' + (cam.id === 'top' ? 'on' : '')} onClick={() => setCam(cam.id === 'top' ? { id: 'iso', az: 45, el: 35.26 } : { id: 'top', az: 0, el: 90 })} title="Top view (plan)"><ScanEye size={14} /></button>
        <button type="button" className="small" onClick={toggleFull} title={isFull ? 'Exit full screen' : 'Full screen'}>
          {isFull ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <span className="city3d-sep" />
        <button type="button" className={'small ' + (showBuildings ? 'on' : '')} onClick={() => setShowBuildings(x => !x)} title="Buildings"><Building2 size={14} /></button>
        <button type="button" className={'small ' + (showCars ? 'on' : '')} onClick={() => setShowCars(x => !x)} title="Vehicles"><Car size={14} /></button>
        <button type="button" className={'small ' + (showPillars ? 'on' : '')} onClick={() => setShowPillars(x => !x)} title="3D queue pillars"><BarChart3 size={14} /></button>
      </div>

      <div className="city3d-zoom mono">{pz.zoom.toFixed(1)}× · scroll to zoom · drag to pan</div>

      {/* Camera angle */}
      <div className="city3d-camera">
        <div className="tabs">
          {CAMERAS.map(([id, label, az, el]) => (
            <button key={id} type="button" className={cam.id === id ? 'on' : ''} onClick={() => setCam({ id, az, el })}>{label}</button>
          ))}
        </div>
        <label title="Camera tilt">
          Tilt
          <input
            type="range"
            min="20"
            max="90"
            step="1"
            value={Math.round(cam.el)}
            onChange={e => setCam(c => ({ id: 'custom', az: Number(e.target.value) >= 90 ? 0 : c.az === 0 ? 45 : c.az, el: Number(e.target.value) }))}
          />
          <span className="mono">{Math.round(cam.el)}°</span>
        </label>
      </div>

      {/* Junction HUD */}
      <div className="city3d-hud">
        {infoId && info ? (
          <>
            <b>{infoId}</b>
            <span>Level <b style={{ color: LEVEL_COLORS[info.level] || '#94a3b8' }}>{info.level}</b></span>
            <span>Queue <b>{fmt(info.queue, 0)} veh</b></span>
            <span>Occupancy <b>{info.occupancy == null ? '—' : fmt(info.occupancy * 100, 1) + '%'}</b></span>
            <span>Phase <b>{info.phase ?? '—'}</b></span>
            {onOpenIntersection && (
              <button type="button" className="small" onClick={() => onOpenIntersection(infoId)}><Box size={13} /> Intersection view</button>
            )}
          </>
        ) : (
          <span className="muted">{nodeCount} junctions · pillar height = queue · click a junction, double-click for street view</span>
        )}
      </div>
    </div>
  );
}
