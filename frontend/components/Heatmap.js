'use client';

import React, { useMemo, useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { LEVEL_COLORS, fmt } from '@/lib/api';
import { usePanZoom, useFullscreen } from '@/lib/usePanZoom';
import { Car, Lightbulb, Zap, Layers, Box, Building2, Globe2, ZoomIn, ZoomOut, Crosshair, Maximize2, Minimize2 } from 'lucide-react';
import DigitalTwin3D from '@/components/DigitalTwin3D';
import CityGrid3D from '@/components/CityGrid3D';

// Leaflet touches `window` at import time, so the world map is client-only.
const WorldHeatmap = dynamic(() => import('@/components/WorldHeatmap'), {
  ssr: false,
  loading: () => <p className="muted" style={{ padding: 40, textAlign: 'center' }}>Loading world map…</p>,
});

const VIEWS = [
  ['heatmap', '2D Heatmap', Layers, '#38bdf8'],
  ['city3d', '3D City Grid', Building2, '#a855f7'],
  ['world', 'World Map', Globe2, '#10b981'],
  ['digital_twin', '3D Intersection', Box, '#f59e0b'],
];

function ViewTabs({ viewMode, setViewMode }) {
  return (
    <div className="tabs">
      {VIEWS.map(([id, label, Icon, color]) => (
        <button key={id} type="button" className={viewMode === id ? 'on' : ''} onClick={() => setViewMode(id)}>
          <Icon size={14} color={color} />
          {label}
        </button>
      ))}
    </div>
  );
}

// Network heatmap with Radiant Thermal Heatmap (Image 1) & 3D Digital Twin (Image 2)
export default function Heatmap({
  layout,
  junctions,
  source,
  simTime,
  updated,
  route = [],
  routeStatus = {},
  title,
  height = 460,
  network,
}) {
  const [viewMode, setViewMode] = useState('heatmap'); // 'heatmap' | 'city3d' | 'world' | 'digital_twin'
  const boxRef = useRef(null);
  const [isFull, toggleFull] = useFullscreen(boxRef);
  const [selected, setSelected] = useState(null);
  const [hover, setHover] = useState(null);
  const [showLights, setShowLights] = useState(true);
  const [showCars, setShowCars] = useState(true);
  const [radiantGlow, setRadiantGlow] = useState(true);
  const [animationTick, setAnimationTick] = useState(0);

  // Micro-tick for vehicle animation when live simulation is running
  useEffect(() => {
    const timer = setInterval(() => {
      setAnimationTick(prev => (prev + 1) % 1000);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  // Compute node coordinates & responsive bounds (Supports 3x3, 5x5, and 9x9 with 81 nodes)
  const geo = useMemo(() => {
    if (!layout?.bounds) return null;
    const b = layout.bounds;
    const w = Math.max(1, b.max_x - b.min_x);
    const h = Math.max(1, b.max_y - b.min_y);
    const W = 1000;
    const H = Math.max(380, Math.min(1000, (W * h) / w));
    const pad = 50;
    const s = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
    const pos = {};
    for (const n of layout.nodes) {
      if (n.x != null) {
        pos[n.id] = [pad + (n.x - b.min_x) * s, H - pad - (n.y - b.min_y) * s];
      }
    }
    const nodeCount = layout.nodes.length;
    // Dynamic node radius scaled for 9x9 (81 nodes) down to 3x3 (9 nodes)
    const r = Math.max(5, Math.min(18, 320 / Math.sqrt(nodeCount)));
    return { W, H, pos, r, nodeCount };
  }, [layout]);

  const pz = usePanZoom(geo?.W || 1000, geo?.H || 600);

  const routeLinks = useMemo(() => {
    return route.slice(1).map((t, i) => [route[i], t]);
  }, [route]);

  // Generate realistic simulated cars on links based on queue and occupancy
  const vehicles = useMemo(() => {
    if (!geo || !layout?.links || !showCars) return [];
    const list = [];
    let carIndex = 0;

    layout.links.forEach(([a, b]) => {
      const posA = geo.pos[a];
      const posB = geo.pos[b];
      if (!posA || !posB) return;

      const targetJ = junctions?.[b];
      const queueCount = targetJ?.queue || 0;

      const dx = posB[0] - posA[0];
      const dy = posB[1] - posA[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 10) return;

      const nx = dx / dist;
      const ny = dy / dist;

      const density = targetJ?.occupancy != null ? Math.max(1, Math.min(5, Math.round(targetJ.occupancy * 10))) : 2;
      const effectiveCars = Math.max(1, Math.min(4, Math.ceil(queueCount > 0 ? queueCount : density)));

      for (let i = 0; i < effectiveCars; i++) {
        carIndex++;
        const isQueued = queueCount > 0 && i < queueCount;
        let progress;

        if (isQueued) {
          const queueStopDistance = 20 + i * 14;
          progress = Math.max(0.1, (dist - queueStopDistance) / dist);
        } else {
          const speedFactor = 0.05;
          const timeOffset = (carIndex * 0.28) + (animationTick * speedFactor);
          progress = (timeOffset % 1.0);
        }

        const laneOffset = (i % 2 === 0 ? 3.5 : -3.5);
        const perpX = -ny * laneOffset;
        const perpY = nx * laneOffset;

        const vx = posA[0] + dx * progress + perpX;
        const vy = posA[1] + dy * progress + perpY;
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

        const isAmbulance = route.includes(a) && route.includes(b) && i === 0;
        const type = isAmbulance ? 'ambulance' : (carIndex % 5 === 0 ? 'bus' : (carIndex % 3 === 0 ? 'bike' : 'car'));

        list.push({
          id: `veh-${a}-${b}-${i}`,
          x: vx,
          y: vy,
          angle,
          type,
          isQueued,
        });
      }
    });

    return list;
  }, [geo, layout, junctions, showCars, animationTick, route]);

  if (!geo) {
    return (
      <div className="heatmap empty">
        <p className="muted">Waiting for simulation layout and TraCI network telemetry...</p>
      </div>
    );
  }

  const levels = (layout.levels || []).map(l => l.name).concat(layout.no_data_level || 'no_data');
  const counts = {};
  let totalQueue = 0;
  for (const j of Object.values(junctions || {})) {
    counts[j.level] = (counts[j.level] || 0) + 1;
    if (j.queue) totalQueue += Number(j.queue);
  }

  const info = junctions?.[selected];
  const hv = hover && junctions?.[hover];

  // 3D city, world map and single-intersection views share the tab header.
  if (viewMode !== 'heatmap') {
    return (
      <div ref={boxRef} className={'heatmap' + (isFull ? ' is-full' : '')} style={viewMode === 'digital_twin' ? { padding: 0 } : undefined}>
        <div className="hm-head" style={viewMode === 'digital_twin' ? { padding: '14px 20px 10px', margin: 0 } : undefined}>
          <ViewTabs viewMode={viewMode} setViewMode={setViewMode} />
          {title && <b style={{ fontSize: 13, color: '#f8fafc' }}>{title}</b>}
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
            sim t = {simTime != null ? `${Math.round(simTime)} s` : '—'}
          </span>
        </div>

        {viewMode === 'city3d' && (
          <CityGrid3D
            layout={layout}
            junctions={junctions}
            route={route}
            selected={selected}
            onSelect={setSelected}
            onOpenIntersection={id => { setSelected(id); setViewMode('digital_twin'); }}
            height={Math.max(height, 520)}
          />
        )}
        {viewMode === 'world' && (
          <WorldHeatmap
            layout={layout}
            junctions={junctions}
            route={route}
            network={network}
            selected={selected}
            onSelect={setSelected}
            height={Math.max(height, 520)}
          />
        )}
        {viewMode === 'digital_twin' && (
          <DigitalTwin3D
            selectedId={selected || (layout.nodes[0]?.id || 'J1')}
            junctionData={info}
            simTime={simTime}
            allJunctions={junctions}
            nodeList={layout.nodes}
            onSelectJunction={id => setSelected(id)}
          />
        )}
      </div>
    );
  }

  // Primary Mode: Radiant City Heatmap (Image 1 Style)
  return (
    <div ref={boxRef} className={'heatmap' + (isFull ? ' is-full' : '')}>
      {/* Top Header & HUD */}
      <div className="hm-head">
        <ViewTabs viewMode={viewMode} setViewMode={setViewMode} />

        <span className={'badge ' + (source === 'live_simulation' ? 'live' : 'hist')}>
          {source === 'live_simulation' ? '● RADIANT THERMAL DENSITY' : 'HISTORICAL REPLAY'}
        </span>

        {title && <b style={{ fontSize: 13, color: '#f8fafc' }}>{title}</b>}

        <span className="muted" style={{ fontFamily: 'var(--font-mono)' }}>
          sim t = {simTime != null ? `${Math.round(simTime)} s` : '—'}
          {updated ? ` · ${updated}` : ''}
        </span>

        {/* Feature Toggles */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className={`small ${radiantGlow ? 'on' : ''}`}
            onClick={() => setRadiantGlow(!radiantGlow)}
            title="Toggle Radiant Thermal Glow Corona"
          >
            <Zap size={13} color={radiantGlow ? '#f59e0b' : 'currentColor'} />
            Thermal Glow {radiantGlow ? 'ON' : 'OFF'}
          </button>
          <button
            type="button"
            className={`small ${showCars ? 'on' : ''}`}
            onClick={() => setShowCars(!showCars)}
            title="Toggle Moving Vehicle Markers"
          >
            <Car size={13} color={showCars ? '#38bdf8' : 'currentColor'} />
            Vehicles {showCars ? 'ON' : 'OFF'}
          </button>
          <button
            type="button"
            className={`small ${showLights ? 'on' : ''}`}
            onClick={() => setShowLights(!showLights)}
            title="Toggle Physical Signal Light Heads"
          >
            <Lightbulb size={13} color={showLights ? '#10b981' : 'currentColor'} />
            Signals {showLights ? 'ON' : 'OFF'}
          </button>
          <button type="button" className="small" onClick={pz.zoomIn} title="Zoom in (or mouse wheel)"><ZoomIn size={13} /></button>
          <button type="button" className="small" onClick={pz.zoomOut} title="Zoom out"><ZoomOut size={13} /></button>
          <button type="button" className="small" onClick={pz.reset} title="Reset view"><Crosshair size={13} /></button>
          <button type="button" className="small" onClick={toggleFull} title={isFull ? 'Exit full screen' : 'Full screen'}>
            {isFull ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </div>
      </div>

      {/* Main SVG Map Viewport with Thermal Road Gradients & Urban Texture */}
      <svg
        ref={pz.ref}
        viewBox={pz.viewBox}
        {...pz.handlers}
        className="hm-svg"
        style={{
          height: isFull ? undefined : height,
          cursor: 'grab',
          borderRadius: 14,
          background: '#070b13',
          boxShadow: 'inset 0 0 40px rgba(0,0,0,0.9)',
        }}
        role="img"
        aria-label={`Radiant thermal congestion heatmap of ${layout.nodes.length} junctions`}
      >
        <defs>
          {/* Radiant Thermal Glow Filters (Image 1 look) */}
          <filter id="thermalGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur1" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="14" result="blur2" />
            <feMerge>
              <feMergeNode in="blur2" />
              <feMergeNode in="blur1" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          <filter id="junctionHeatBurst" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="10" result="burstBlur" />
            <feMerge>
              <feMergeNode in="burstBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Urban City Blueprint Grid Pattern */}
          <pattern id="urbanBlocks" width="50" height="50" patternUnits="userSpaceOnUse">
            <rect width="50" height="50" fill="#070c16" />
            <rect x="3" y="3" width="44" height="44" fill="#0a101d" rx="3" stroke="rgba(255,255,255,0.02)" strokeWidth="0.5" />
          </pattern>

          {/* Radial Thermal Burst for Bottleneck Hotspots */}
          <radialGradient id="hotspotRed" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.95" />
            <stop offset="40%" stopColor="#f97316" stopOpacity="0.75" />
            <stop offset="75%" stopColor="#eab308" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#eab308" stopOpacity="0" />
          </radialGradient>

          <radialGradient id="hotspotOrange" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#f97316" stopOpacity="0.9" />
            <stop offset="50%" stopColor="#eab308" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#eab308" stopOpacity="0" />
          </radialGradient>

          <radialGradient id="hotspotYellow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#facc15" stopOpacity="0.8" />
            <stop offset="60%" stopColor="#fde047" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#facc15" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* 1. Aerial Satellite City Blueprint Ground Texture */}
        <rect x={-geo.W} y={-geo.H} width={geo.W * 3} height={geo.H * 3} fill="url(#urbanBlocks)" />

        {/* 2. Simulated Waterway / River Canal Curve across City (Like Thames/Rivers in Image 1) */}
        <path
          d={`M 0,${geo.H * 0.72} Q ${geo.W * 0.35},${geo.H * 0.65} ${geo.W * 0.55},${geo.H * 0.82} T ${geo.W},${geo.H * 0.74}`}
          fill="none"
          stroke="#0f2238"
          strokeWidth="32"
          strokeLinecap="round"
          opacity="0.6"
        />

        {/* 3. Layer 1: Dark Asphalt Road Base */}
        {layout.links.map(([a, b]) => {
          const pA = geo.pos[a];
          const pB = geo.pos[b];
          if (!pA || !pB) return null;
          return (
            <line
              key={'base-' + a + '|' + b}
              x1={pA[0]}
              y1={pA[1]}
              x2={pB[0]}
              y2={pB[1]}
              stroke="#131e2e"
              strokeWidth={Math.max(6, geo.r * 1.2)}
              strokeLinecap="round"
            />
          );
        })}

        {/* 4. Layer 2: Radiant Thermal Corona (Outer Heat Glow Halo - Image 1 style!) */}
        {radiantGlow &&
          layout.links.map(([a, b]) => {
            const pA = geo.pos[a];
            const pB = geo.pos[b];
            if (!pA || !pB) return null;
            const targetJ = junctions?.[b];
            const q = targetJ?.queue || 0;
            const occ = targetJ?.occupancy || 0;

            // Thermal color spectrum: Yellow (low) -> Fiery Orange (medium) -> Radiant Crimson Red (heavy)
            const glowColor =
              q > 4 || occ > 0.4
                ? '#ef4444' // Heavy Bottleneck
                : q > 1 || occ > 0.2
                ? '#f97316' // Moderate Delay
                : '#facc15'; // Free Flowing Energy

            const glowWidth = Math.max(12, geo.r * 2.2);

            return (
              <line
                key={'glow-' + a + '|' + b}
                x1={pA[0]}
                y1={pA[1]}
                x2={pB[0]}
                y2={pB[1]}
                stroke={glowColor}
                strokeWidth={glowWidth}
                strokeOpacity={0.35}
                filter="url(#thermalGlow)"
                strokeLinecap="round"
              />
            );
          })}

        {/* 5. Layer 3: Vibrant Radiant Road Core Lines (Image 1 Arteries) */}
        {layout.links.map(([a, b]) => {
          const pA = geo.pos[a];
          const pB = geo.pos[b];
          if (!pA || !pB) return null;
          const targetJ = junctions?.[b];
          const q = targetJ?.queue || 0;
          const occ = targetJ?.occupancy || 0;

          const coreColor =
            q > 4 || occ > 0.4
              ? '#ff2244'
              : q > 1 || occ > 0.2
              ? '#fb923c'
              : '#fde047';

          return (
            <line
              key={'core-' + a + '|' + b}
              x1={pA[0]}
              y1={pA[1]}
              x2={pB[0]}
              y2={pB[1]}
              stroke={coreColor}
              strokeWidth={Math.max(3.5, geo.r * 0.7)}
              strokeLinecap="round"
              opacity={0.88}
            />
          );
        })}

        {/* 6. Layer 4: Incandescent White-Hot Centerline */}
        {layout.links.map(([a, b]) => {
          const pA = geo.pos[a];
          const pB = geo.pos[b];
          if (!pA || !pB) return null;
          return (
            <line
              key={'white-' + a + '|' + b}
              x1={pA[0]}
              y1={pA[1]}
              x2={pB[0]}
              y2={pB[1]}
              stroke="#fffef0"
              strokeWidth={Math.max(1.2, geo.r * 0.22)}
              opacity={0.7}
            />
          );
        })}

        {/* Ambulance Priority Corridor */}
        {routeLinks.map(([a, b]) => {
          const pA = geo.pos[a];
          const pB = geo.pos[b];
          if (!pA || !pB) return null;
          return (
            <line
              key={'r' + a + b}
              x1={pA[0]}
              y1={pA[1]}
              x2={pB[0]}
              y2={pB[1]}
              className="hm-route"
            />
          );
        })}

        {/* 7. Layer 5: Large Radial Thermal Hotspot Blobs at Intersections (Image 1 Hotspots) */}
        {layout.nodes.map(n => {
          const p = geo.pos[n.id];
          if (!p) return null;
          const j = junctions?.[n.id];
          const q = j?.queue || 0;
          const occ = j?.occupancy || 0;

          const isHot = q > 3 || occ > 0.35;
          const isMedium = q > 1 || occ > 0.18;

          const gradId = isHot ? 'url(#hotspotRed)' : isMedium ? 'url(#hotspotOrange)' : 'url(#hotspotYellow)';
          const burstRadius = geo.r * (isHot ? 3.8 : isMedium ? 2.8 : 2.0);

          return (
            <circle
              key={'hotspot-' + n.id}
              cx={p[0]}
              cy={p[1]}
              r={burstRadius}
              fill={gradId}
              filter={radiantGlow ? 'url(#junctionHeatBurst)' : undefined}
              pointerEvents="none"
            />
          );
        })}

        {/* 8. Moving Vehicle Flow Particles */}
        {vehicles.map(v => {
          if (v.type === 'ambulance') {
            return (
              <g key={v.id} transform={`translate(${v.x}, ${v.y}) rotate(${v.angle})`}>
                <circle r={8} fill="rgba(239, 68, 68, 0.6)">
                  <animate attributeName="r" values="6;12;6" dur="0.5s" repeatCount="indefinite" />
                </circle>
                <rect x={-6} y={-3.5} width={12} height={7} rx={2} fill="#ffffff" stroke="#ef4444" strokeWidth="1.2" />
              </g>
            );
          }
          return (
            <circle
              key={v.id}
              cx={v.x}
              cy={v.y}
              r={Math.max(2, geo.r * 0.32)}
              fill={v.isQueued ? '#ef4444' : '#ffffff'}
              stroke="#070b14"
              strokeWidth={0.6}
              filter="drop-shadow(0 0 3px rgba(255,255,255,0.8))"
            />
          );
        })}

        {/* 9. Junction Nodes with Physical Signal Heads & Click Handlers */}
        {layout.nodes.map(n => {
          const p = geo.pos[n.id];
          if (!p) return null;
          const j = junctions?.[n.id];
          const lv = j?.level || 'no_data';
          const nd = !j || lv === 'no_data';
          const phase = j?.phase;
          const isGreen = phase != null && phase % 2 === 0;
          const isYellow = phase != null && phase % 2 !== 0;

          return (
            <g
              key={n.id}
              onClick={() => setSelected(n.id)}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
            >
              {/* Invisible Hitbox */}
              <circle cx={p[0]} cy={p[1]} r={geo.r * 2.2} fill="transparent" />

              {/* Node Center Halo */}
              <circle
                cx={p[0]}
                cy={p[1]}
                r={geo.r}
                fill={nd ? 'none' : LEVEL_COLORS[lv] || LEVEL_COLORS.no_data}
                stroke={selected === n.id ? '#ffffff' : '#070b14'}
                strokeWidth={selected === n.id ? 3 : 1.5}
                filter={selected === n.id ? 'drop-shadow(0 0 10px #ffffff)' : undefined}
              />

              {/* Node Label (e.g. J1..J81) */}
              <text
                x={p[0]}
                y={p[1] + (geo.r > 10 ? 3.5 : 2.5)}
                textAnchor="middle"
                fontSize={Math.max(8, Math.min(11, geo.r * 0.85))}
                fontWeight="700"
                fontFamily="var(--font-mono)"
                fill="#ffffff"
                pointerEvents="none"
              >
                {n.id}
              </text>

              {/* Physical Traffic Light Gantry */}
              {showLights && j && geo.nodeCount <= 36 && (
                <g transform={`translate(${p[0] + geo.r + 2}, ${p[1] - 14})`} pointerEvents="none">
                  <rect width={9} height={22} rx={2.5} fill="#080d17" stroke="#1e293b" strokeWidth={0.8} />
                  <circle cx={4.5} cy={4} r={2.4} fill={!isGreen && !isYellow ? '#ef4444' : '#2d0f15'} />
                  <circle cx={4.5} cy={11} r={2.4} fill={isYellow ? '#fbbf24' : '#2b210a'} />
                  <circle cx={4.5} cy={18} r={2.4} fill={isGreen ? '#10b981' : '#092518'} />
                </g>
              )}
            </g>
          );
        })}

        {/* Hover Tooltip */}
        {hv && geo.pos[hover] && (
          <g
            pointerEvents="none"
            transform={`translate(${Math.min(geo.pos[hover][0] + 16, geo.W - 240)}, ${Math.max(geo.pos[hover][1] - 70, 8)})`}
          >
            <rect width={230} height={64} rx={10} className="hm-tip" />
            <text x={12} y={22} className="hm-tip-t">
              {hover} {hv.phase != null ? `· Phase ${hv.phase} (${hv.phase % 2 === 0 ? '🟢 Green' : '🟡 Yellow'})` : ''}
            </text>
            <text x={12} y={42} className="hm-tip-s">
              Congestion: {hv.level} · Queue: {fmt(hv.queue, 0)} veh
            </text>
            <text x={12} y={56} className="hm-tip-s">
              Lane Occupancy: {hv.occupancy == null ? '—' : fmt(hv.occupancy * 100, 1) + '%'} · {hv.lanes} lanes
            </text>
          </g>
        )}
      </svg>

      {/* Legend & Telemetry Summary Ribbon */}
      <div className="legend">
        {levels.map(l => (
          <span key={l}>
            <i
              style={{
                background: l === 'no_data' ? 'transparent' : LEVEL_COLORS[l],
                border: l === 'no_data' ? '1px dashed #8a94a6' : 'none',
              }}
            />
            {l.replace('_', ' ')} ({counts[l] || 0})
          </span>
        ))}
        {totalQueue > 0 && (
          <span style={{ color: '#ef4444', fontWeight: 600 }}>
            🛑 Total Halting Queue: {totalQueue} veh
          </span>
        )}
        <span style={{ color: '#38bdf8' }}>
          🌐 Scaled Network: {geo.nodeCount} Signal Nodes ({layout.links.length} Links)
        </span>
      </div>

      {/* Selected Junction Inspector & Quick 3D Launcher */}
      {info ? (
        <div className="detail" style={{ borderLeft: '3px solid #38bdf8', alignItems: 'center' }}>
          <div>
            <b>{selected}</b>
            <span style={{ marginLeft: 8, fontSize: 11, color: '#38bdf8', fontFamily: 'var(--font-mono)' }}>
              NODE TELEMETRY
            </span>
          </div>
          <span>
            Level: <b style={{ color: LEVEL_COLORS[info.level] }}>{info.level}</b>
          </span>
          <span>
            Queue: <b>{fmt(info.queue, 0)} vehicles</b>
          </span>
          <span>
            Occupancy: <b>{info.occupancy == null ? '—' : fmt(info.occupancy * 100, 1) + '%'}</b>
          </span>
          <span>
            Signal State:{' '}
            <b style={{ color: info.phase % 2 === 0 ? '#10b981' : '#fbbf24' }}>
              Phase {info.phase ?? '—'} ({info.phase % 2 === 0 ? 'GREEN' : 'YELLOW/CLEAR'})
            </b>
          </span>
          <button
            type="button"
            className="small"
            style={{ marginLeft: 'auto', background: 'linear-gradient(135deg, #0369a1, #0284c7)' }}
            onClick={() => setViewMode('digital_twin')}
          >
            <Box size={13} />
            Inspect in 3D Digital Twin
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
          <p className="muted small" style={{ margin: 0 }}>
            💡 Click any junction node to inspect live signal phases or launch the 3D Digital Twin command view.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="small" onClick={() => setViewMode('city3d')}>
              <Building2 size={13} color="#a855f7" />
              3D City Grid
            </button>
            <button type="button" className="small" onClick={() => setViewMode('world')}>
              <Globe2 size={13} color="#10b981" />
              World Map
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
