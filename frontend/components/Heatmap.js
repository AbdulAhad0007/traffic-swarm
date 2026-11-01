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
  ['heatmap', '2D Heatmap', Layers, 'var(--accent)'],
  ['city3d', '3D City Grid', Building2, 'var(--accent-3)'],
  ['world', 'World Map', Globe2, 'var(--status-ok)'],
  ['digital_twin', '3D Intersection', Box, 'var(--status-warn)'],
];

const ALL_VIEWS = VIEWS.map(([id]) => id);

function ViewTabs({ viewMode, setViewMode, allowedViews }) {
  return (
    <div className="tabs">
      {VIEWS.filter(([id]) => allowedViews.includes(id)).map(([id, label, Icon, color]) => (
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
  allowedViews = ALL_VIEWS,
}) {
  const [requestedView, setViewMode] = useState('heatmap'); // 'heatmap' | 'city3d' | 'world' | 'digital_twin'
  const viewMode = allowedViews.includes(requestedView) ? requestedView : allowedViews[0];
  // A network imported from OpenStreetMap opens on the world map, where its lights sit at their real positions
  const openedGeoFor = useRef(null);
  useEffect(() => {
    if (layout?.geo && openedGeoFor.current !== network) {
      openedGeoFor.current = network;
      setViewMode('world');
    }
  }, [layout?.geo, network]);
  const boxRef = useRef(null);
  const [isFull, toggleFull] = useFullscreen(boxRef);
  const [selected, setSelected] = useState(null);
  const [hover, setHover] = useState(null);
  const [hoverPos, setHoverPos] = useState(null);

  const updateHover = (id, e) => {
    setHover(id);
    if (boxRef.current && e?.currentTarget) {
      const nodeRect = e.currentTarget.getBoundingClientRect();
      const boxRect = boxRef.current.getBoundingClientRect();
      setHoverPos({
        x: nodeRect.left + nodeRect.width / 2 - boxRect.left,
        y: nodeRect.top - boxRect.top,
        bottomY: nodeRect.bottom - boxRect.top,
        boxW: boxRect.width,
        boxH: boxRect.height,
      });
    }
  };

  const clearHover = () => {
    setHover(null);
    setHoverPos(null);
  };
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
          <ViewTabs viewMode={viewMode} setViewMode={setViewMode} allowedViews={allowedViews} />
          {title && <b style={{ fontSize: 13, color: 'var(--text-primary)' }}>{title}</b>}
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
        <ViewTabs viewMode={viewMode} setViewMode={setViewMode} allowedViews={allowedViews} />

        <span className={'badge ' + (source === 'live_simulation' ? 'live' : 'hist')}>
          {source === 'live_simulation' ? '● RADIANT THERMAL DENSITY' : 'HISTORICAL REPLAY'}
        </span>

        {title && <b style={{ fontSize: 13, color: 'var(--text-primary)' }}>{title}</b>}

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
            <Zap size={13} color={radiantGlow ? 'var(--status-warn)' : 'currentColor'} />
            Thermal Glow {radiantGlow ? 'ON' : 'OFF'}
          </button>
          <button
            type="button"
            className={`small ${showCars ? 'on' : ''}`}
            onClick={() => setShowCars(!showCars)}
            title="Toggle Moving Vehicle Markers"
          >
            <Car size={13} color={showCars ? 'var(--accent)' : 'currentColor'} />
            Vehicles {showCars ? 'ON' : 'OFF'}
          </button>
          <button
            type="button"
            className={`small ${showLights ? 'on' : ''}`}
            onClick={() => setShowLights(!showLights)}
            title="Toggle Physical Signal Light Heads"
          >
            <Lightbulb size={13} color={showLights ? 'var(--status-ok)' : 'currentColor'} />
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
          background: 'var(--bg-sunken)',
          boxShadow: 'inset 0 0 40px color-mix(in srgb, var(--shadow-color) 90%, transparent)',
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
            <rect width="50" height="50" fill="var(--bg-sunken)" />
            <rect x="3" y="3" width="44" height="44" fill="var(--bg-surface)" rx="3" stroke="color-mix(in srgb, var(--text-primary) 2%, transparent)" strokeWidth="0.5" />
          </pattern>

          {/* Radial Thermal Burst for Bottleneck Hotspots */}
          <radialGradient id="hotspotRed" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--signal-red)" stopOpacity="0.95" />
            <stop offset="40%" stopColor="var(--status-warn)" stopOpacity="0.75" />
            <stop offset="75%" stopColor="var(--status-warn)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--status-warn)" stopOpacity="0" />
          </radialGradient>

          <radialGradient id="hotspotOrange" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--status-warn)" stopOpacity="0.9" />
            <stop offset="50%" stopColor="var(--status-warn)" stopOpacity="0.5" />
            <stop offset="100%" stopColor="var(--status-warn)" stopOpacity="0" />
          </radialGradient>

          <radialGradient id="hotspotYellow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--status-warn)" stopOpacity="0.8" />
            <stop offset="60%" stopColor="var(--status-warn)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="var(--status-warn)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* 1. Aerial Satellite City Blueprint Ground Texture */}
        <rect x={-geo.W} y={-geo.H} width={geo.W * 3} height={geo.H * 3} fill="url(#urbanBlocks)" />

        {/* 2. Simulated Waterway / River Canal Curve across City (Like Thames/Rivers in Image 1) */}
        <path
          d={`M 0,${geo.H * 0.72} Q ${geo.W * 0.35},${geo.H * 0.65} ${geo.W * 0.55},${geo.H * 0.82} T ${geo.W},${geo.H * 0.74}`}
          fill="none"
          stroke="var(--bg-elevated)"
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
              stroke="var(--bg-surface)"
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
                ? 'var(--signal-red)' // Heavy Bottleneck
                : q > 1 || occ > 0.2
                ? 'var(--status-warn)' // Moderate Delay
                : 'var(--status-warn)'; // Free Flowing Energy

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
              ? 'var(--status-danger)'
              : q > 1 || occ > 0.2
              ? 'var(--status-warn)'
              : 'var(--status-warn)';

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
              stroke="var(--warn-soft)"
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
                <circle r={8} fill="color-mix(in srgb, var(--signal-red) 60%, transparent)">
                  <animate attributeName="r" values="6;12;6" dur="0.5s" repeatCount="indefinite" />
                </circle>
                <rect x={-6} y={-3.5} width={12} height={7} rx={2} fill="var(--text-primary)" stroke="var(--signal-red)" strokeWidth="1.2" />
              </g>
            );
          }
          return (
            <circle
              key={v.id}
              cx={v.x}
              cy={v.y}
              r={Math.max(2, geo.r * 0.32)}
              fill={v.isQueued ? 'var(--signal-red)' : 'var(--text-primary)'}
              stroke="var(--bg-sunken)"
              strokeWidth={0.6}
              filter="drop-shadow(0 0 3px color-mix(in srgb, var(--text-primary) 80%, transparent))"
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
              onMouseEnter={(e) => updateHover(n.id, e)}
              onMouseMove={(e) => updateHover(n.id, e)}
              onMouseLeave={clearHover}
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
                stroke={selected === n.id ? 'var(--text-primary)' : 'var(--bg-sunken)'}
                strokeWidth={selected === n.id ? 3 : 1.5}
                filter={selected === n.id ? 'drop-shadow(0 0 10px var(--text-primary))' : undefined}
              />

              {/* Node Label (e.g. J1..J81) */}
              <text
                x={p[0]}
                y={p[1] + (geo.r > 10 ? 3.5 : 2.5)}
                textAnchor="middle"
                fontSize={Math.max(8, Math.min(11, geo.r * 0.85))}
                fontWeight="700"
                fontFamily="var(--font-mono)"
                fill="var(--text-primary)"
                pointerEvents="none"
              >
                {n.id}
              </text>

              {/* Physical Traffic Light Gantry */}
              {showLights && j && geo.nodeCount <= 36 && (
                <g transform={`translate(${p[0] + geo.r + 2}, ${p[1] - 14})`} pointerEvents="none">
                  <rect width={9} height={22} rx={2.5} fill="var(--bg-sunken)" stroke="var(--bg-elevated)" strokeWidth={0.8} />
                  <circle cx={4.5} cy={4} r={2.4} fill={!isGreen && !isYellow ? 'var(--signal-red)' : 'color-mix(in srgb, var(--status-danger) 16%, var(--bg-surface))'} />
                  <circle cx={4.5} cy={11} r={2.4} fill={isYellow ? 'var(--status-warn)' : 'color-mix(in srgb, var(--status-warn) 16%, var(--bg-surface))'} />
                  <circle cx={4.5} cy={18} r={2.4} fill={isGreen ? 'var(--status-ok)' : 'color-mix(in srgb, var(--status-ok) 16%, var(--bg-surface))'} />
                </g>
              )}
            </g>
          );
        })}

              </svg>

      {/* Floating HTML Hover Popup Card */}
      {hover && hoverPos && (() => {
        const j = junctions?.[hover];
        const lv = j?.level || 'no_data';
        const phase = j?.phase;
        const isGreen = phase != null && phase % 2 === 0;
        const isYellow = phase != null && phase % 2 !== 0;
        const occ = j?.occupancy;
        const occPct = occ != null ? occ * 100 : null;
        const q = j?.queue || 0;
        const isOnRoute = route?.includes(hover);
        const isBelow = hoverPos.y < 165;
        const cardHalfWidth = 145;
        const clampedX = Math.max(cardHalfWidth + 12, Math.min(hoverPos.boxW - cardHalfWidth - 12, hoverPos.x));
        const topPos = isBelow ? hoverPos.bottomY + 12 : hoverPos.y - 12;
        const levelColor = LEVEL_COLORS[lv] || LEVEL_COLORS.no_data;

        return (
          <div
            className="hm-floating-card"
            style={{
              left: `${clampedX}px`,
              top: `${topPos}px`,
              transform: isBelow ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            }}
          >
            <div className="hm-fc-head">
              <div className="hm-fc-id-badge">
                <span className="hm-fc-id">{hover}</span>
                <span className="hm-fc-label">Junction Node</span>
              </div>
              {phase != null ? (
                <span className={`hm-fc-phase-pill ${isGreen ? 'green' : isYellow ? 'yellow' : 'nodata'}`}>
                  <span className={`hm-fc-dot ${isGreen ? 'green' : 'yellow'}`} />
                  Phase {phase} · {isGreen ? 'GREEN' : 'YELLOW'}
                </span>
              ) : (
                <span className="hm-fc-phase-pill nodata">
                  Phase —
                </span>
              )}
            </div>

            <div className="hm-fc-grid">
              <div className="hm-fc-stat">
                <span className="hm-fc-stat-lbl">Congestion</span>
                <span className="hm-fc-stat-val" style={{ color: levelColor }}>
                  {lv.replace('_', ' ').toUpperCase()}
                </span>
              </div>

              <div className="hm-fc-stat">
                <span className="hm-fc-stat-lbl">Halting Queue</span>
                <span className="hm-fc-stat-val" style={{ color: q > 4 ? 'var(--signal-red)' : q > 1 ? 'var(--status-warn)' : 'var(--status-ok)' }}>
                  {fmt(q, 0)} <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-secondary)' }}>veh</span>
                </span>
              </div>

              <div className="hm-fc-stat">
                <span className="hm-fc-stat-lbl">Occupancy</span>
                <span className="hm-fc-stat-val">
                  {occPct != null ? `${fmt(occPct, 1)}%` : '—'}
                </span>
                {occPct != null && (
                  <div className="hm-fc-progress-wrap">
                    <div
                      className="hm-fc-progress-bar"
                      style={{
                        width: `${Math.min(100, Math.max(2, occPct))}%`,
                        background: occPct > 60 ? 'var(--signal-red)' : occPct > 30 ? 'var(--status-warn)' : 'var(--status-ok)',
                      }}
                    />
                  </div>
                )}
              </div>

              <div className="hm-fc-stat">
                <span className="hm-fc-stat-lbl">Lanes</span>
                <span className="hm-fc-stat-val">
                  {j?.lanes ? `${j.lanes} lanes` : '4 lanes'}
                </span>
              </div>
            </div>

            {isOnRoute && (
              <div className="hm-fc-emergency">
                <span>🚑 Priority Emergency Corridor Active</span>
              </div>
            )}

            <div className="hm-fc-hint">
              <span>💡 Click node to inspect details</span>
            </div>
          </div>
        );
      })()}

      {/* Legend & Telemetry Summary Ribbon */}
      <div className="legend">
        {levels.map(l => (
          <span key={l}>
            <i
              style={{
                background: l === 'no_data' ? 'transparent' : LEVEL_COLORS[l],
                border: l === 'no_data' ? '1px dashed var(--text-secondary)' : 'none',
              }}
            />
            {l.replace('_', ' ')} ({counts[l] || 0})
          </span>
        ))}
        {totalQueue > 0 && (
          <span style={{ color: 'var(--signal-red)', fontWeight: 600 }}>
            🛑 Total Halting Queue: {totalQueue} veh
          </span>
        )}
        <span style={{ color: 'var(--accent)' }}>
          🌐 Scaled Network: {geo.nodeCount} Signal Nodes ({layout.links.length} Links)
        </span>
      </div>

      {/* Selected Junction Inspector & Quick 3D Launcher */}
      {info ? (
        <div className="detail" style={{ borderLeft: '3px solid var(--accent)', alignItems: 'center' }}>
          <div>
            <b>{selected}</b>
            <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
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
            <b style={{ color: info.phase % 2 === 0 ? 'var(--status-ok)' : 'var(--status-warn)' }}>
              Phase {info.phase ?? '—'} ({info.phase % 2 === 0 ? 'GREEN' : 'YELLOW/CLEAR'})
            </b>
          </span>
          {allowedViews.includes('digital_twin') && <button
            type="button"
            className="small"
            style={{ marginLeft: 'auto', background: 'linear-gradient(135deg, var(--accent), var(--accent))' }}
            onClick={() => setViewMode('digital_twin')}
          >
            <Box size={13} />
            Inspect in 3D Digital Twin
          </button>}
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
          <p className="muted small" style={{ margin: 0 }}>
            💡 Click any junction node to inspect live signal phases or launch the 3D Digital Twin command view.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            {allowedViews.includes('city3d') && <button type="button" className="small" onClick={() => setViewMode('city3d')}>
              <Building2 size={13} color="var(--accent-3)" />
              3D City Grid
            </button>}
            {allowedViews.includes('world') && <button type="button" className="small" onClick={() => setViewMode('world')}>
              <Globe2 size={13} color="var(--status-ok)" />
              World Map
            </button>}
          </div>
        </div>
      )}
    </div>
  );
}
