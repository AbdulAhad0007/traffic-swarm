'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { fmt, LEVEL_COLORS } from '@/lib/api';
import { usePanZoom, useFullscreen } from '@/lib/usePanZoom';
import {
  Cpu,
  Wifi,
  Radio,
  Camera,
  Layers,
  Activity,
  AlertTriangle,
  ArrowUpRight,
  ShieldCheck,
  Zap,
  Gauge,
  TreePine,
  Sunset,
  Sun,
  Moon,
  Eye,
  ZoomIn,
  ZoomOut,
  Crosshair,
  Maximize2,
  Minimize2,
} from 'lucide-react';

// ── Utility: seeded pseudo-random for deterministic building/tree placement ──
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ── Color helpers ──
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Linear blend of two #rrggbb colours (t = 0 -> a, t = 1 -> b).
function mix(a, b, t) {
  if (!t) return a;
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

// ── Time-of-day themes: every ground, road and building colour of the scene comes from here ──
const THEMES = {
  day: {
    sky: '#a9c8a0', ground: '#8db37c', groundOpacity: 0.7,
    grass: ['#6e9d5a', '#86b86f', '#93c47b', '#5d8a4a'], grassStroke: 'rgba(40,80,30,0.35)',
    asphalt: ['#5b6370', '#535b67', '#4a525e'], noise: '#555d69',
    sidewalk: ['#c9c3b6', '#d4cec1', '#cdc7ba'], junction: '#4d5561', curb: '#9ca3af',
    buildingTo: '#dfe7ef', buildingMix: 0.5,
    windowLit: 'rgba(186,230,253,0.75)', windowOff: 'rgba(148,184,214,0.6)', windowOn: 1,
    lightsOn: false, overlay: 'rgba(255,244,214,0.10)', shadow: 'rgba(30,40,30,0.35)',
  },
  dusk: {
    sky: '#2b2140', ground: '#21182f', groundOpacity: 0.6,
    grass: ['#26301f', '#34442c', '#3c5032', '#2d3b26'], grassStroke: 'rgba(120,80,40,0.25)',
    asphalt: ['#302b38', '#2a2532', '#24202c'], noise: '#2c2734',
    sidewalk: ['#3d3546', '#463d51', '#41384b'], junction: '#27222f', curb: '#4a4256',
    buildingTo: '#b0714a', buildingMix: 0.18,
    windowLit: null, windowOff: 'rgba(30,22,40,0.85)', windowOn: 0.5,
    lightsOn: true, overlay: 'url(#duskOverlay)', shadow: 'rgba(0,0,0,0.4)',
  },
  night: {
    sky: '#050810', ground: '#040608', groundOpacity: 0.6,
    grass: ['#0d1a12', '#164a2a', '#1a5c34', '#166534'], grassStroke: 'rgba(22,101,52,0.2)',
    asphalt: ['#1a2030', '#141a26', '#0f1520'], noise: '#141a26',
    sidewalk: ['#1a2030', '#1e2638', '#1c2434'], junction: '#0f1520', curb: '#2a3444',
    buildingTo: '#000000', buildingMix: 0,
    windowLit: null, windowOff: 'rgba(10,15,25,0.8)', windowOn: 0.7,
    lightsOn: true, overlay: 'rgba(56,189,248,0.03)', shadow: 'rgba(0,0,0,0.35)',
  },
};

// ── Building presets for variety ──
const BUILDING_PRESETS = [
  { topColor: '#1e3a5f', sideColor: '#152d4a', frontColor: '#0f2137', windowColor: '#38bdf8' },
  { topColor: '#2d1b4e', sideColor: '#231440', frontColor: '#1a0e30', windowColor: '#a855f7' },
  { topColor: '#1a3c2e', sideColor: '#132e22', frontColor: '#0d221a', windowColor: '#10b981' },
  { topColor: '#3a2a1e', sideColor: '#2e2017', frontColor: '#221710', windowColor: '#fbbf24' },
  { topColor: '#2a1e3a', sideColor: '#20162e', frontColor: '#170e22', windowColor: '#f472b6' },
  { topColor: '#1e2d3a', sideColor: '#16222e', frontColor: '#0e1822', windowColor: '#60a5fa' },
];

// ── Vehicle color palettes ──
const CAR_COLORS = ['#ef4444', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ffffff', '#6b7280', '#ec4899', '#06b6d4', '#84cc16'];
const BUS_COLORS = ['#dc2626', '#2563eb', '#16a34a'];

export default function DigitalTwin3D({
  selectedId = 'J5',
  junctionData,
  simTime = 0,
  allJunctions = {},
  nodeList = [],
  onSelectJunction,
}) {
  const [activeJunction, setActiveJunction] = useState(selectedId);
  const [animClock, setAnimClock] = useState(0);
  const [timeOfDay, setTimeOfDay] = useState('night'); // 'day', 'dusk', 'night'
  const [showParticles, setShowParticles] = useState(true);
  const [showPedestrians, setShowPedestrians] = useState(true);
  const sceneRef = useRef(null);
  const [isFull, toggleFull] = useFullscreen(sceneRef);
  const pz = usePanZoom(800, 620, { maxZoom: 8 });

  useEffect(() => {
    if (selectedId) setActiveJunction(selectedId);
  }, [selectedId]);

  // Animation clock at 60-ish fps feel
  useEffect(() => {
    const t = setInterval(() => {
      setAnimClock(c => (c + 1) % 3600);
    }, 50);
    return () => clearInterval(t);
  }, []);

  const jData = allJunctions?.[activeJunction] || junctionData || {
    queue: 3,
    occupancy: 0.22,
    phase: 0,
    lanes: 4,
    level: 'light',
  };

  const phase = jData.phase ?? 0;
  const isNSGreen = phase % 2 === 0;
  const isClearance = phase % 2 !== 0;

  const queue = jData.queue ?? 2;
  const occ = jData.occupancy ?? 0.18;
  const perfScore = Math.max(45, Math.min(96, Math.round(100 - (queue * 4.5) - (occ * 35))));

  const nsFlow = isNSGreen ? Math.round(58 + (occ * 40)) : 0;
  const ewFlow = !isNSGreen && !isClearance ? Math.round(62 + (occ * 35)) : 0;
  const turnFlow = isNSGreen ? Math.round(24 + (occ * 20)) : Math.round(18 + (occ * 15));

  // Ambient color based on time of day
  const ambientColors = {
    day: { sky: '#1a2744', ground: '#0f1923', ambient: 'rgba(135,206,250,0.06)' },
    dusk: { sky: '#1a1428', ground: '#0d0a16', ambient: 'rgba(255,140,50,0.05)' },
    night: { sky: '#050810', ground: '#040608', ambient: 'rgba(56,189,248,0.03)' },
  };
  const amb = ambientColors[timeOfDay];
  const T = THEMES[timeOfDay];

  // Deterministic random for buildings, trees, and decorations
  const rng = useMemo(() => seededRandom(42), []);

  // Generate buildings array for all 4 corners
  const buildings = useMemo(() => {
    const r = seededRandom(42);
    const list = [];
    // Top-left quadrant buildings
    const positions = [
      // NW corner buildings
      { bx: 60, by: 60, zone: 'nw' },
      { bx: 130, by: 85, zone: 'nw' },
      { bx: 85, by: 130, zone: 'nw' },
      { bx: 155, by: 55, zone: 'nw' },
      { bx: 40, by: 140, zone: 'nw' },
      // NE corner buildings
      { bx: 600, by: 55, zone: 'ne' },
      { bx: 660, by: 80, zone: 'ne' },
      { bx: 700, by: 50, zone: 'ne' },
      { bx: 640, by: 120, zone: 'ne' },
      { bx: 720, by: 100, zone: 'ne' },
      // SW corner buildings
      { bx: 70, by: 430, zone: 'sw' },
      { bx: 140, by: 460, zone: 'sw' },
      { bx: 50, by: 500, zone: 'sw' },
      { bx: 130, by: 520, zone: 'sw' },
      { bx: 170, by: 480, zone: 'sw' },
      // SE corner buildings
      { bx: 620, by: 440, zone: 'se' },
      { bx: 690, by: 470, zone: 'se' },
      { bx: 660, by: 520, zone: 'se' },
      { bx: 730, by: 450, zone: 'se' },
      { bx: 710, by: 510, zone: 'se' },
    ];

    positions.forEach((pos, i) => {
      const preset = BUILDING_PRESETS[i % BUILDING_PRESETS.length];
      const w = 30 + r() * 40;
      const d = 20 + r() * 30;
      const h = 35 + r() * 80;
      const floors = Math.floor(h / 18);
      const windowsPerFloor = Math.max(2, Math.floor(w / 14));
      list.push({ ...pos, w, d, h, floors, windowsPerFloor, preset, id: i });
    });

    return list;
  }, []);

  // Trees
  const trees = useMemo(() => {
    const r = seededRandom(99);
    const treePositions = [
      // Along roads
      { x: 250, y: 170 }, { x: 550, y: 170 }, { x: 200, y: 350 },
      { x: 600, y: 350 }, { x: 250, y: 450 }, { x: 550, y: 450 },
      // In building areas
      { x: 100, y: 100 }, { x: 700, y: 100 }, { x: 100, y: 500 },
      { x: 700, y: 500 }, { x: 170, y: 300 }, { x: 630, y: 300 },
    ];
    return treePositions.map((t, i) => ({
      ...t,
      scale: 0.6 + r() * 0.5,
      sway: r() * 360,
      type: r() > 0.4 ? 'deciduous' : 'conifer',
      id: i,
    }));
  }, []);

  // Streetlights
  const streetlights = useMemo(() => [
    { x: 265, y: 200, side: 'left' },
    { x: 535, y: 200, side: 'right' },
    { x: 265, y: 420, side: 'left' },
    { x: 535, y: 420, side: 'right' },
    { x: 220, y: 295, side: 'left' },
    { x: 580, y: 295, side: 'right' },
  ], []);

  // Render an isometric 3D building
  const renderBuilding = useCallback((b) => {
    const { bx, by, w, d, h, floors, windowsPerFloor, preset, id } = b;
    const isoX = bx;
    const isoY = by;

    // Building body — isometric projection
    const topW = w * 0.6;
    const topD = d * 0.4;

    return (
      <g key={`building-${id}`} className="building-3d-realistic">
        {/* Shadow on ground */}
        <ellipse
          cx={isoX + w / 2}
          cy={isoY + d / 2 + 4}
          rx={w * 0.55}
          ry={d * 0.2}
          fill={T.shadow}
          filter="url(#shadowBlur)"
        />

        {/* Front face */}
        <rect
          x={isoX}
          y={isoY - h}
          width={w}
          height={h}
          rx={2}
          fill={mix(preset.frontColor, T.buildingTo, T.buildingMix)}
          stroke="rgba(255,255,255,0.04)"
          strokeWidth={0.5}
        />

        {/* Side face (right) */}
        <polygon
          points={`
            ${isoX + w},${isoY - h}
            ${isoX + w + d * 0.4},${isoY - h - d * 0.2}
            ${isoX + w + d * 0.4},${isoY - d * 0.2}
            ${isoX + w},${isoY}
          `}
          fill={mix(preset.sideColor, T.buildingTo, T.buildingMix * 0.8)}
          stroke="rgba(255,255,255,0.03)"
          strokeWidth={0.5}
        />

        {/* Top face (roof) */}
        <polygon
          points={`
            ${isoX},${isoY - h}
            ${isoX + d * 0.4},${isoY - h - d * 0.2}
            ${isoX + w + d * 0.4},${isoY - h - d * 0.2}
            ${isoX + w},${isoY - h}
          `}
          fill={mix(preset.topColor, T.buildingTo, T.buildingMix * 1.2)}
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={0.5}
        />

        {/* Rooftop structures */}
        {h > 60 && (
          <rect
            x={isoX + w * 0.35}
            y={isoY - h - 8}
            width={w * 0.3}
            height={8}
            rx={1}
            fill={preset.sideColor}
            stroke="rgba(255,255,255,0.05)"
            strokeWidth={0.3}
          />
        )}

        {/* Antenna/spire on tall buildings */}
        {h > 80 && (
          <line
            x1={isoX + w * 0.5}
            y1={isoY - h - 8}
            x2={isoX + w * 0.5}
            y2={isoY - h - 20}
            stroke="#475569"
            strokeWidth={1.5}
          />
        )}

        {/* Windows with realistic glow */}
        {Array.from({ length: floors }).map((_, floor) =>
          Array.from({ length: windowsPerFloor }).map((_, win) => {
            const winOn = seededRandom(id * 100 + floor * 10 + win + 1)() < T.windowOn;
            const wx = isoX + 4 + win * (w / windowsPerFloor);
            const wy = isoY - h + 5 + floor * (h / floors);
            const winW = Math.max(3, (w / windowsPerFloor) - 5);
            const winH = Math.max(3, (h / floors) - 7);

            return (
              <g key={`w-${id}-${floor}-${win}`}>
                {/* Window glow halo */}
                {winOn && timeOfDay === 'night' && (
                  <rect
                    x={wx - 1}
                    y={wy - 1}
                    width={winW + 2}
                    height={winH + 2}
                    rx={1}
                    fill={preset.windowColor}
                    opacity={0.15}
                    filter="url(#windowGlow)"
                  />
                )}
                {/* Window pane */}
                <rect
                  x={wx}
                  y={wy}
                  width={winW}
                  height={winH}
                  rx={0.5}
                  fill={winOn ? (T.windowLit || hexToRgba(preset.windowColor, timeOfDay === 'night' ? 0.75 : 0.6)) : T.windowOff}
                  stroke="rgba(255,255,255,0.05)"
                  strokeWidth={0.3}
                />
              </g>
            );
          })
        )}

        {/* Ground floor entrance */}
        <rect
          x={isoX + w * 0.35}
          y={isoY - 12}
          width={w * 0.3}
          height={12}
          rx={1}
          fill="rgba(56,189,248,0.12)"
          stroke="rgba(56,189,248,0.3)"
          strokeWidth={0.5}
        />
      </g>
    );
  }, [timeOfDay]);

  // Render a tree
  const renderTree = useCallback((tree) => {
    const swayOffset = Math.sin((animClock * 0.02) + tree.sway) * 1.5;

    if (tree.type === 'conifer') {
      return (
        <g key={`tree-${tree.id}`} transform={`translate(${tree.x}, ${tree.y}) scale(${tree.scale})`}>
          {/* Shadow */}
          <ellipse cx={0} cy={8} rx={8} ry={3} fill="rgba(0,0,0,0.3)" />
          {/* Trunk */}
          <rect x={-2} y={-15} width={4} height={23} rx={1} fill="#4a3728" />
          {/* Foliage layers */}
          <polygon points={`0,-45 -14,-15 14,-15`} fill="#166534" transform={`translate(${swayOffset},0)`}>
            <animate attributeName="opacity" values="0.85;0.95;0.85" dur="3s" repeatCount="indefinite" />
          </polygon>
          <polygon points={`0,-55 -11,-30 11,-30`} fill="#15803d" transform={`translate(${swayOffset * 0.7},0)`} />
          <polygon points={`0,-62 -8,-42 8,-42`} fill="#22c55e" transform={`translate(${swayOffset * 0.5},0)`} opacity={0.9} />
        </g>
      );
    }

    return (
      <g key={`tree-${tree.id}`} transform={`translate(${tree.x}, ${tree.y}) scale(${tree.scale})`}>
        {/* Shadow */}
        <ellipse cx={2} cy={6} rx={12} ry={4} fill="rgba(0,0,0,0.25)" />
        {/* Trunk */}
        <rect x={-2} y={-20} width={4} height={26} rx={1} fill="#5c4033" />
        {/* Canopy (layered circles for realistic foliage) */}
        <circle cx={-6 + swayOffset * 0.5} cy={-28} r={10} fill="#166534" opacity={0.9} />
        <circle cx={6 + swayOffset * 0.7} cy={-30} r={9} fill="#15803d" opacity={0.85} />
        <circle cx={0 + swayOffset} cy={-35} r={11} fill="#22c55e" opacity={0.8} />
        <circle cx={-3 + swayOffset * 0.6} cy={-40} r={7} fill="#4ade80" opacity={0.6} />
      </g>
    );
  }, [animClock]);

  // Render a streetlight
  const renderStreetlight = useCallback((sl) => {
    return (
      <g key={`sl-${sl.x}-${sl.y}`}>
        {/* Pole */}
        <line x1={sl.x} y1={sl.y} x2={sl.x} y2={sl.y - 40} stroke="#475569" strokeWidth={2.5} strokeLinecap="round" />
        {/* Arm */}
        <line
          x1={sl.x}
          y1={sl.y - 38}
          x2={sl.x + (sl.side === 'left' ? 10 : -10)}
          y2={sl.y - 42}
          stroke="#475569"
          strokeWidth={2}
          strokeLinecap="round"
        />
        {/* Light housing */}
        <rect
          x={sl.x + (sl.side === 'left' ? 6 : -14)}
          y={sl.y - 46}
          width={8}
          height={5}
          rx={1.5}
          fill="#1e293b"
          stroke="#334155"
          strokeWidth={0.5}
        />
        {/* Light glow */}
        {T.lightsOn && (
          <>
            <ellipse
              cx={sl.x + (sl.side === 'left' ? 10 : -10)}
              cy={sl.y - 41}
              rx={18}
              ry={28}
              fill="url(#streetlightGlow)"
              opacity={0.25}
            />
            <circle
              cx={sl.x + (sl.side === 'left' ? 10 : -10)}
              cy={sl.y - 42}
              r={3}
              fill="#fef3c7"
              opacity={0.9}
            >
              <animate attributeName="opacity" values="0.8;1;0.8" dur="2s" repeatCount="indefinite" />
            </circle>
          </>
        )}
      </g>
    );
  }, [timeOfDay]);

  // Generate animated vehicles
  const generateVehicles = useCallback(() => {
    const vehicles = [];
    const clock = animClock;

    // NS direction vehicles (flowing or queued)
    const nsVehicleCount = isNSGreen ? 6 : 4;
    for (let i = 0; i < nsVehicleCount; i++) {
      const isQueued = !isNSGreen && i < queue;
      let progress;
      if (isQueued) {
        progress = 0.65 + i * 0.08;
      } else if (isNSGreen) {
        progress = ((clock * 0.008 + i * 0.18) % 1.2);
        if (progress > 1) progress = progress - 1.2;
      } else {
        progress = 0.1 + i * 0.15;
      }

      const x = 370 + (i % 2 === 0 ? -12 : 12);
      const y = 150 + progress * 340;

      if (y > 130 && y < 510) {
        const colorIdx = (i * 3 + 7) % CAR_COLORS.length;
        vehicles.push({
          id: `ns-${i}`,
          x, y,
          angle: 90,
          color: CAR_COLORS[colorIdx],
          type: i === 2 ? 'bus' : 'car',
          isQueued,
          headlights: isNSGreen && !isQueued,
          direction: 'ns',
        });
      }
    }

    // EW direction vehicles
    const ewVehicleCount = !isNSGreen ? 5 : 3;
    for (let i = 0; i < ewVehicleCount; i++) {
      const isQueued = isNSGreen && i < Math.min(queue, 3);
      let progress;
      if (isQueued) {
        progress = 0.55 + i * 0.1;
      } else if (!isNSGreen) {
        progress = ((clock * 0.007 + i * 0.2) % 1.3);
        if (progress > 1) progress = progress - 1.3;
      } else {
        progress = 0.1 + i * 0.18;
      }

      const x = 180 + progress * 440;
      const y = 305 + (i % 2 === 0 ? -12 : 12);

      if (x > 160 && x < 640) {
        const colorIdx = (i * 5 + 2) % CAR_COLORS.length;
        vehicles.push({
          id: `ew-${i}`,
          x, y,
          angle: 0,
          color: CAR_COLORS[colorIdx],
          type: i === 1 ? 'bus' : (i === 4 ? 'bike' : 'car'),
          isQueued,
          headlights: !isNSGreen && !isQueued,
          direction: 'ew',
        });
      }
    }

    // Turning vehicles
    if (isNSGreen) {
      const turnProgress = (clock * 0.006) % 1;
      const tx = 370 + turnProgress * 140;
      const ty = 280 + turnProgress * 50;
      if (turnProgress < 0.9) {
        vehicles.push({
          id: 'turn-1',
          x: tx, y: ty,
          angle: 30,
          color: '#f59e0b',
          type: 'car',
          isQueued: false,
          headlights: true,
          direction: 'turn',
        });
      }
    }

    return vehicles;
  }, [animClock, isNSGreen, isClearance, queue]);

  const vehicleList = useMemo(() => generateVehicles(), [generateVehicles]);

  // Render a realistic vehicle
  const renderVehicle = useCallback((v) => {
    if (v.type === 'bus') {
      return (
        <g key={v.id} transform={`translate(${v.x}, ${v.y}) rotate(${v.angle})`}>
          {/* Bus shadow */}
          <ellipse cx={0} cy={6} rx={16} ry={4} fill="rgba(0,0,0,0.4)" />
          {/* Bus body */}
          <rect x={-16} y={-7} width={32} height={14} rx={3} fill={BUS_COLORS[0]} stroke="rgba(0,0,0,0.5)" strokeWidth={0.8} />
          {/* Windows strip */}
          <rect x={-13} y={-5} width={26} height={5} rx={1} fill="rgba(56,189,248,0.4)" />
          {/* Window dividers */}
          {[-10, -5, 0, 5, 10].map(wx => (
            <line key={wx} x1={wx} y1={-5} x2={wx} y2={0} stroke="rgba(0,0,0,0.4)" strokeWidth={0.5} />
          ))}
          {/* Wheels */}
          <circle cx={-10} cy={7} r={2.5} fill="#1e293b" stroke="#0f172a" strokeWidth={0.5} />
          <circle cx={10} cy={7} r={2.5} fill="#1e293b" stroke="#0f172a" strokeWidth={0.5} />
          {/* Headlights */}
          {v.headlights && T.lightsOn && (
            <>
              <circle cx={16} cy={-3} r={1.5} fill="#fef3c7" opacity={0.9} />
              <circle cx={16} cy={3} r={1.5} fill="#fef3c7" opacity={0.9} />
              <ellipse cx={22} cy={0} rx={8} ry={5} fill="rgba(254,243,199,0.08)" />
            </>
          )}
          {/* Taillights */}
          <circle cx={-16} cy={-3} r={1.2} fill="#ef4444" opacity={v.isQueued ? 1 : 0.5} />
          <circle cx={-16} cy={3} r={1.2} fill="#ef4444" opacity={v.isQueued ? 1 : 0.5} />
        </g>
      );
    }

    if (v.type === 'bike') {
      return (
        <g key={v.id} transform={`translate(${v.x}, ${v.y}) rotate(${v.angle})`}>
          <ellipse cx={0} cy={3} rx={5} ry={2} fill="rgba(0,0,0,0.3)" />
          {/* Bike body */}
          <rect x={-5} y={-2} width={10} height={4} rx={2} fill={v.color} stroke="rgba(0,0,0,0.5)" strokeWidth={0.5} />
          {/* Rider silhouette */}
          <circle cx={0} cy={-5} r={2.5} fill="#334155" />
          <rect x={-1} y={-3} width={2} height={4} fill="#334155" />
        </g>
      );
    }

    // Default: Car
    return (
      <g key={v.id} transform={`translate(${v.x}, ${v.y}) rotate(${v.angle})`}>
        {/* Car shadow */}
        <ellipse cx={0} cy={5} rx={10} ry={3.5} fill="rgba(0,0,0,0.35)" />
        {/* Car body */}
        <rect x={-10} y={-5} width={20} height={10} rx={3.5} fill={v.color} stroke="rgba(0,0,0,0.4)" strokeWidth={0.6} />
        {/* Roof / windshield */}
        <rect x={-5} y={-4} width={10} height={8} rx={2} fill={hexToRgba(v.color, 0.6)} />
        {/* Windows */}
        <rect x={-4} y={-3.5} width={4} height={3} rx={1} fill="rgba(56,189,248,0.35)" />
        <rect x={1} y={-3.5} width={4} height={3} rx={1} fill="rgba(56,189,248,0.35)" />
        {/* Wheels */}
        <circle cx={-6} cy={5} r={2} fill="#0f172a" stroke="#1e293b" strokeWidth={0.4} />
        <circle cx={6} cy={5} r={2} fill="#0f172a" stroke="#1e293b" strokeWidth={0.4} />
        {/* Headlights */}
        {v.headlights && T.lightsOn && (
          <>
            <circle cx={10} cy={-2} r={1.2} fill="#fef3c7" opacity={0.95} />
            <circle cx={10} cy={2} r={1.2} fill="#fef3c7" opacity={0.95} />
            {/* Headlight beam cone */}
            <path
              d={`M 11,-3 L 28,-6 L 28,6 L 11,3 Z`}
              fill="rgba(254,243,199,0.04)"
            />
          </>
        )}
        {/* Taillights */}
        <circle cx={-10} cy={-2} r={1} fill="#ef4444" opacity={v.isQueued ? 1 : 0.4} />
        <circle cx={-10} cy={2} r={1} fill="#ef4444" opacity={v.isQueued ? 1 : 0.4} />
        {/* Brake lights brighter when queued */}
        {v.isQueued && (
          <rect x={-11} y={-3} width={1.5} height={6} rx={0.5} fill="#ef4444" opacity={0.6} />
        )}
      </g>
    );
  }, [timeOfDay]);

  // Generate pedestrians
  const pedestrians = useMemo(() => {
    if (!showPedestrians) return [];
    const peds = [];
    const crossings = [
      { x1: 320, y1: 240, x2: 420, y2: 240, dir: 'ew' }, // North crossing
      { x1: 320, y1: 370, x2: 420, y2: 370, dir: 'ew' }, // South crossing
      { x1: 270, y1: 280, x2: 270, y2: 330, dir: 'ns' }, // West crossing
      { x1: 500, y1: 280, x2: 500, y2: 330, dir: 'ns' }, // East crossing
    ];

    crossings.forEach((c, ci) => {
      const canCross = c.dir === 'ew' ? !isNSGreen : isNSGreen;
      const pedCount = canCross ? 3 : 1;
      for (let i = 0; i < pedCount; i++) {
        const progress = canCross
          ? ((animClock * 0.004 + i * 0.3 + ci * 0.7) % 1)
          : 0.1 + i * 0.05;
        const px = c.x1 + (c.x2 - c.x1) * progress;
        const py = c.y1 + (c.y2 - c.y1) * progress + (i % 2 === 0 ? 3 : -3);
        peds.push({ x: px, y: py, id: `ped-${ci}-${i}`, walking: canCross });
      }
    });
    return peds;
  }, [animClock, isNSGreen, showPedestrians]);

  return (
    <div className="digital-twin-container">
      {/* Top Header Bar */}
      <div className="dt-topbar">
        <div className="dt-title-wrap">
          <span className="badge live">● 3D DIGITAL TWIN SYSTEM</span>
          <b className="dt-name">
            Intersection {activeJunction} — Intelligent Signalized Node
          </b>
        </div>

        <div className="dt-controls">
          <label className="dt-select-label">
            <span>Select Junction:</span>
            <select
              value={activeJunction}
              onChange={e => {
                setActiveJunction(e.target.value);
                if (onSelectJunction) onSelectJunction(e.target.value);
              }}
            >
              {nodeList.length > 0 ? (
                nodeList.map(n => (
                  <option key={n.id} value={n.id}>
                    Node {n.id}
                  </option>
                ))
              ) : (
                ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8', 'J9'].map(id => (
                  <option key={id} value={id}>
                    Node {id}
                  </option>
                ))
              )}
            </select>
          </label>

          {/* Time-of-Day Switcher */}
          <div className="dt-time-controls">
            <button
              type="button"
              className={`dt-time-btn ${timeOfDay === 'day' ? 'active' : ''}`}
              onClick={() => setTimeOfDay('day')}
              title="Day Mode"
            >
              <Sun size={14} />
              <span>Day</span>
            </button>
            <button
              type="button"
              className={`dt-time-btn ${timeOfDay === 'dusk' ? 'active' : ''}`}
              onClick={() => setTimeOfDay('dusk')}
              title="Dusk Mode"
            >
              <Sunset size={14} />
              <span>Dusk</span>
            </button>
            <button
              type="button"
              className={`dt-time-btn ${timeOfDay === 'night' ? 'active' : ''}`}
              onClick={() => setTimeOfDay('night')}
              title="Night Mode"
            >
              <Moon size={14} />
              <span>Night</span>
            </button>
          </div>

          <span className="status" style={{ color: '#38bdf8' }}>
            ID: SC-INT-{activeJunction}
          </span>
        </div>
      </div>

      {/* Main Grid */}
      <div className="dt-main-grid">
        {/* Left Telemetry Card */}
        <div className="dt-side-card">
          <div className="dt-card-header">
            <Wifi size={16} color="#38bdf8" />
            <b>V2I / V2X Communication Hardware</b>
          </div>

          <div className="v2x-diagram">
            <div className="v2x-node">
              <Radio size={14} color="#38bdf8" />
              <span>OBU (Vehicles)</span>
            </div>
            <div className="v2x-line">
              <span className="v2x-pulse" />
            </div>
            <div className="v2x-node active">
              <Cpu size={14} color="#10b981" />
              <span>RSU (Roadside)</span>
            </div>
            <div className="v2x-line">
              <span className="v2x-pulse" />
            </div>
            <div className="v2x-node">
              <Layers size={14} color="#a855f7" />
              <span>Swarm Controller</span>
            </div>
          </div>

          <div className="dt-stat-table">
            <div className="dt-stat-row">
              <span className="muted">V2I Channel</span>
              <b>5.895 GHz (DSRC / C-V2X)</b>
            </div>
            <div className="dt-stat-row">
              <span className="muted">RSU Link Latency</span>
              <b style={{ color: '#10b981' }}>11.4 ms (Ultra-Low)</b>
            </div>
            <div className="dt-stat-row">
              <span className="muted">Packets BSM/SPaT</span>
              <b>240 pkts / sec</b>
            </div>
            <div className="dt-stat-row">
              <span className="muted">V2X Security</span>
              <b style={{ color: '#38bdf8' }}>IEEE 1609.2 Signed</b>
            </div>
          </div>

          {/* IoT Sensor Health */}
          <div className="dt-card-header" style={{ marginTop: 14 }}>
            <Camera size={15} color="#fbbf24" />
            <b>IoT Sensor Network</b>
          </div>
          <div className="iot-sensors-grid">
            <div className="sensor-chip">
              <span className="sensor-dot live" />
              <span>LiDAR Radar (360°)</span>
            </div>
            <div className="sensor-chip">
              <span className="sensor-dot live" />
              <span>AI Cameras (4K)</span>
            </div>
            <div className="sensor-chip">
              <span className="sensor-dot live" />
              <span>Inductive Loops (8/8)</span>
            </div>
            <div className="sensor-chip">
              <span className="sensor-dot live" />
              <span>Pheromone Mesh</span>
            </div>
          </div>
        </div>

        {/* ═══════════════════════════════════════════════════════════════
            CENTER: Ultra-Realistic 3D Isometric Viewport
           ═══════════════════════════════════════════════════════════════ */}
        <div className="dt-viewport-card">
          <div className="dt-viewport-badges">
            <span className="viewport-badge">
              ● REAL-TIME MICROSCOPIC DIGITAL TWIN
            </span>
            <span className="viewport-badge phase-indicator">
              {isNSGreen
                ? '🟢 N-S PHASE GREEN (FLOWING)'
                : isClearance
                ? '🟡 TRANSITION CLEARANCE'
                : '🟢 E-W PHASE GREEN (FLOWING)'}
            </span>
          </div>

          <div ref={sceneRef} className={'isometric-scene-wrap' + (isFull ? ' is-full' : '')}>
            <svg
              ref={pz.ref}
              viewBox={pz.viewBox}
              className="isometric-svg"
              preserveAspectRatio="xMidYMid meet"
              {...pz.handlers}
            >
              <defs>
                {/* ── Advanced Filters & Gradients ── */}
                <filter id="shadowBlur" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
                </filter>

                <filter id="windowGlow" x="-100%" y="-100%" width="300%" height="300%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="3" />
                </filter>

                <filter id="signalGlow" x="-100%" y="-100%" width="300%" height="300%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>

                <filter id="neonGlow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="glow" />
                  <feMerge>
                    <feMergeNode in="glow" />
                    <feMergeNode in="glow" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>

                {/* Road asphalt gradient */}
                <linearGradient id="asphaltGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor={T.asphalt[0]} />
                  <stop offset="50%" stopColor={T.asphalt[1]} />
                  <stop offset="100%" stopColor={T.asphalt[2]} />
                </linearGradient>

                <linearGradient id="duskOverlay" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f97316" stopOpacity="0.22" />
                  <stop offset="55%" stopColor="#db2777" stopOpacity="0.1" />
                  <stop offset="100%" stopColor="#4c1d95" stopOpacity="0.18" />
                </linearGradient>

                {/* Intersection center gradient */}
                <radialGradient id="intersectionGlow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="rgba(56,189,248,0.08)" />
                  <stop offset="100%" stopColor="rgba(56,189,248,0)" />
                </radialGradient>

                {/* Streetlight cone gradient */}
                <radialGradient id="streetlightGlow" cx="50%" cy="0%" r="100%">
                  <stop offset="0%" stopColor="rgba(254,243,199,0.5)" />
                  <stop offset="50%" stopColor="rgba(254,243,199,0.15)" />
                  <stop offset="100%" stopColor="rgba(254,243,199,0)" />
                </radialGradient>

                {/* Green signal glow */}
                <radialGradient id="greenGlowR">
                  <stop offset="0%" stopColor="#10b981" stopOpacity="1" />
                  <stop offset="60%" stopColor="#10b981" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
                </radialGradient>

                {/* Red signal glow */}
                <radialGradient id="redGlowR">
                  <stop offset="0%" stopColor="#ef4444" stopOpacity="1" />
                  <stop offset="60%" stopColor="#ef4444" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
                </radialGradient>

                {/* Yellow signal glow */}
                <radialGradient id="yellowGlowR">
                  <stop offset="0%" stopColor="#fbbf24" stopOpacity="1" />
                  <stop offset="60%" stopColor="#fbbf24" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
                </radialGradient>

                {/* Asphalt noise texture */}
                <pattern id="asphaltNoise" width="4" height="4" patternUnits="userSpaceOnUse">
                  <rect width="4" height="4" fill={T.noise} />
                  <rect x="0" y="0" width="1" height="1" fill="rgba(255,255,255,0.015)" />
                  <rect x="2" y="1" width="1" height="1" fill="rgba(255,255,255,0.02)" />
                  <rect x="1" y="3" width="1" height="1" fill="rgba(255,255,255,0.01)" />
                  <rect x="3" y="2" width="1" height="1" fill="rgba(0,0,0,0.08)" />
                </pattern>

                {/* Sidewalk pattern */}
                <pattern id="sidewalkPattern" width="12" height="12" patternUnits="userSpaceOnUse">
                  <rect width="12" height="12" fill={T.sidewalk[0]} />
                  <rect x="0" y="0" width="6" height="6" fill={T.sidewalk[1]} stroke="rgba(255,255,255,0.05)" strokeWidth="0.3" />
                  <rect x="6" y="6" width="6" height="6" fill={T.sidewalk[2]} stroke="rgba(255,255,255,0.05)" strokeWidth="0.3" />
                </pattern>

                {/* Grass pattern */}
                <pattern id="grassPattern" width="8" height="8" patternUnits="userSpaceOnUse">
                  <rect width="8" height="8" fill={T.grass[0]} />
                  <circle cx="2" cy="2" r="0.5" fill={T.grass[1]} opacity="0.5" />
                  <circle cx="6" cy="5" r="0.4" fill={T.grass[2]} opacity="0.4" />
                  <circle cx="4" cy="7" r="0.3" fill={T.grass[3]} opacity="0.3" />
                </pattern>
              </defs>

              {/* ═══ LAYER 0: Sky / Background ═══ */}
              <rect width="800" height="620" fill={T.sky} />

              {/* ═══ LAYER 1: Ground Plane ═══ */}
              <rect width="800" height="620" fill={T.ground} opacity={T.groundOpacity} />

              {/* City blocks (green areas / park areas) */}
              {/* NW Park */}
              <rect x="30" y="30" width="220" height="190" rx="6" fill="url(#grassPattern)" stroke={T.grassStroke} strokeWidth="0.5" />
              {/* NE Park */}
              <rect x="550" y="30" width="220" height="190" rx="6" fill="url(#grassPattern)" stroke={T.grassStroke} strokeWidth="0.5" />
              {/* SW Park */}
              <rect x="30" y="400" width="220" height="190" rx="6" fill="url(#grassPattern)" stroke={T.grassStroke} strokeWidth="0.5" />
              {/* SE Park */}
              <rect x="550" y="400" width="220" height="190" rx="6" fill="url(#grassPattern)" stroke={T.grassStroke} strokeWidth="0.5" />

              {/* ═══ LAYER 2: Sidewalks ═══ */}
              {/* North sidewalk */}
              <rect x="255" y="220" width="290" height="18" fill="url(#sidewalkPattern)" />
              {/* South sidewalk */}
              <rect x="255" y="372" width="290" height="18" fill="url(#sidewalkPattern)" />
              {/* West sidewalk */}
              <rect x="250" y="235" width="18" height="140" fill="url(#sidewalkPattern)" />
              {/* East sidewalk */}
              <rect x="532" y="235" width="18" height="140" fill="url(#sidewalkPattern)" />

              {/* ═══ LAYER 3: Roads with Asphalt Texture ═══ */}
              {/* North-South main road */}
              <rect x="310" y="0" width="180" height="620" fill="url(#asphaltGrad)" />
              <rect x="310" y="0" width="180" height="620" fill="url(#asphaltNoise)" opacity={0.6} />

              {/* East-West main road */}
              <rect x="0" y="240" width="800" height="130" fill="url(#asphaltGrad)" />
              <rect x="0" y="240" width="800" height="130" fill="url(#asphaltNoise)" opacity={0.6} />

              {/* ═══ LAYER 3.5: Road curbs ═══ */}
              {/* NS road curbs */}
              <line x1="310" y1="0" x2="310" y2="240" stroke={T.curb} strokeWidth="2" />
              <line x1="490" y1="0" x2="490" y2="240" stroke={T.curb} strokeWidth="2" />
              <line x1="310" y1="370" x2="310" y2="620" stroke={T.curb} strokeWidth="2" />
              <line x1="490" y1="370" x2="490" y2="620" stroke={T.curb} strokeWidth="2" />
              {/* EW road curbs */}
              <line x1="0" y1="240" x2="310" y2="240" stroke={T.curb} strokeWidth="2" />
              <line x1="490" y1="240" x2="800" y2="240" stroke={T.curb} strokeWidth="2" />
              <line x1="0" y1="370" x2="310" y2="370" stroke={T.curb} strokeWidth="2" />
              <line x1="490" y1="370" x2="800" y2="370" stroke={T.curb} strokeWidth="2" />

              {/* ═══ LAYER 4: Lane Markings ═══ */}
              {/* NS road center divider (double yellow) */}
              <line x1="398" y1="0" x2="398" y2="240" stroke="#eab308" strokeWidth="1.5" strokeDasharray="none" opacity="0.7" />
              <line x1="402" y1="0" x2="402" y2="240" stroke="#eab308" strokeWidth="1.5" strokeDasharray="none" opacity="0.7" />
              <line x1="398" y1="370" x2="398" y2="620" stroke="#eab308" strokeWidth="1.5" strokeDasharray="none" opacity="0.7" />
              <line x1="402" y1="370" x2="402" y2="620" stroke="#eab308" strokeWidth="1.5" strokeDasharray="none" opacity="0.7" />

              {/* NS lane dashes */}
              <line x1="355" y1="0" x2="355" y2="240" stroke="#ffffff" strokeWidth="1" strokeDasharray="16 12" opacity="0.4" />
              <line x1="445" y1="0" x2="445" y2="240" stroke="#ffffff" strokeWidth="1" strokeDasharray="16 12" opacity="0.4" />
              <line x1="355" y1="370" x2="355" y2="620" stroke="#ffffff" strokeWidth="1" strokeDasharray="16 12" opacity="0.4" />
              <line x1="445" y1="370" x2="445" y2="620" stroke="#ffffff" strokeWidth="1" strokeDasharray="16 12" opacity="0.4" />

              {/* EW road center divider (double yellow) */}
              <line x1="0" y1="303" x2="310" y2="303" stroke="#eab308" strokeWidth="1.5" opacity="0.7" />
              <line x1="0" y1="307" x2="310" y2="307" stroke="#eab308" strokeWidth="1.5" opacity="0.7" />
              <line x1="490" y1="303" x2="800" y2="303" stroke="#eab308" strokeWidth="1.5" opacity="0.7" />
              <line x1="490" y1="307" x2="800" y2="307" stroke="#eab308" strokeWidth="1.5" opacity="0.7" />

              {/* EW lane dashes */}
              <line x1="0" y1="270" x2="310" y2="270" stroke="#ffffff" strokeWidth="1" strokeDasharray="16 12" opacity="0.4" />
              <line x1="0" y1="340" x2="310" y2="340" stroke="#ffffff" strokeWidth="1" strokeDasharray="16 12" opacity="0.4" />
              <line x1="490" y1="270" x2="800" y2="270" stroke="#ffffff" strokeWidth="1" strokeDasharray="16 12" opacity="0.4" />
              <line x1="490" y1="340" x2="800" y2="340" stroke="#ffffff" strokeWidth="1" strokeDasharray="16 12" opacity="0.4" />

              {/* ═══ LAYER 4.5: Intersection Box ═══ */}
              <rect x="310" y="240" width="180" height="130" fill={T.junction} stroke="#1e293b" strokeWidth="1" />
              {/* Intersection ambient glow */}
              <rect x="310" y="240" width="180" height="130" fill="url(#intersectionGlow)" />

              {/* ═══ LAYER 5: Zebra Crossings ═══ */}
              {/* North crossing */}
              <g opacity="0.85">
                {Array.from({ length: 9 }).map((_, i) => (
                  <rect key={`zn-${i}`} x={320 + i * 18} y={228} width={12} height={14} rx={1} fill="#ffffff" opacity={0.75} />
                ))}
              </g>
              {/* South crossing */}
              <g opacity="0.85">
                {Array.from({ length: 9 }).map((_, i) => (
                  <rect key={`zs-${i}`} x={320 + i * 18} y={370} width={12} height={14} rx={1} fill="#ffffff" opacity={0.75} />
                ))}
              </g>
              {/* West crossing */}
              <g opacity="0.85">
                {Array.from({ length: 6 }).map((_, i) => (
                  <rect key={`zw-${i}`} x={298} y={248 + i * 18} width={14} height={12} rx={1} fill="#ffffff" opacity={0.75} />
                ))}
              </g>
              {/* East crossing */}
              <g opacity="0.85">
                {Array.from({ length: 6 }).map((_, i) => (
                  <rect key={`ze-${i}`} x={490} y={248 + i * 18} width={14} height={12} rx={1} fill="#ffffff" opacity={0.75} />
                ))}
              </g>

              {/* ═══ LAYER 5.5: Stop Lines ═══ */}
              <line x1="320" y1="240" x2="395" y2="240" stroke="#ffffff" strokeWidth="3" opacity="0.9" />
              <line x1="405" y1="370" x2="480" y2="370" stroke="#ffffff" strokeWidth="3" opacity="0.9" />
              <line x1="310" y1="310" x2="310" y2="370" stroke="#ffffff" strokeWidth="3" opacity="0.9" />
              <line x1="490" y1="240" x2="490" y2="300" stroke="#ffffff" strokeWidth="3" opacity="0.9" />

              {/* ═══ LAYER 5.7: Turn arrows painted on road ═══ */}
              {/* Straight arrow (north approach) */}
              <g transform="translate(355, 190)" opacity="0.5">
                <line x1="0" y1="20" x2="0" y2="0" stroke="#ffffff" strokeWidth="2" />
                <polygon points="-5,5 0,-3 5,5" fill="#ffffff" />
              </g>
              {/* Left turn arrow */}
              <g transform="translate(340, 200)" opacity="0.5">
                <path d="M 0,18 L 0,5 Q 0,0 -5,0 L -10,0" fill="none" stroke="#ffffff" strokeWidth="1.5" />
                <polygon points="-10,-3 -15,0 -10,3" fill="#ffffff" />
              </g>
              {/* Right turn arrow (south approach) */}
              <g transform="translate(445, 385)" opacity="0.5">
                <path d="M 0,-18 L 0,-5 Q 0,0 5,0 L 10,0" fill="none" stroke="#ffffff" strokeWidth="1.5" />
                <polygon points="10,-3 15,0 10,3" fill="#ffffff" />
              </g>

              {/* ═══ LAYER 6: Buildings ═══ */}
              {buildings.map(b => renderBuilding(b))}

              {/* ═══ LAYER 7: Trees ═══ */}
              {trees.map(t => renderTree(t))}

              {/* ═══ LAYER 8: Streetlights ═══ */}
              {streetlights.map(sl => renderStreetlight(sl))}

              {/* ═══ LAYER 9: Traffic Flow Trajectory Arrows ═══ */}
              {/* North → South flow */}
              <path
                d="M 370,140 C 370,220 370,380 370,490"
                fill="none"
                stroke={isNSGreen ? '#10b981' : '#ef4444'}
                strokeWidth={isNSGreen ? 3 : 1.5}
                strokeDasharray={isNSGreen ? '12 6' : '4 4'}
                opacity={0.6}
                filter={isNSGreen ? 'url(#neonGlow)' : undefined}
              >
                {isNSGreen && (
                  <animate attributeName="stroke-dashoffset" values="0;-18" dur="0.6s" repeatCount="indefinite" />
                )}
              </path>

              {/* South → North flow */}
              <path
                d="M 430,490 C 430,380 430,220 430,140"
                fill="none"
                stroke={isNSGreen ? '#10b981' : '#ef4444'}
                strokeWidth={isNSGreen ? 3 : 1.5}
                strokeDasharray={isNSGreen ? '12 6' : '4 4'}
                opacity={0.6}
                filter={isNSGreen ? 'url(#neonGlow)' : undefined}
              >
                {isNSGreen && (
                  <animate attributeName="stroke-dashoffset" values="0;18" dur="0.6s" repeatCount="indefinite" />
                )}
              </path>

              {/* West → East flow */}
              <path
                d="M 40,275 C 160,275 600,275 760,275"
                fill="none"
                stroke={!isNSGreen && !isClearance ? '#10b981' : '#ef4444'}
                strokeWidth={!isNSGreen && !isClearance ? 3 : 1.5}
                strokeDasharray={!isNSGreen ? '12 6' : '4 4'}
                opacity={0.6}
                filter={!isNSGreen && !isClearance ? 'url(#neonGlow)' : undefined}
              >
                {!isNSGreen && !isClearance && (
                  <animate attributeName="stroke-dashoffset" values="0;-18" dur="0.6s" repeatCount="indefinite" />
                )}
              </path>

              {/* East → West flow */}
              <path
                d="M 760,335 C 600,335 160,335 40,335"
                fill="none"
                stroke={!isNSGreen && !isClearance ? '#10b981' : '#ef4444'}
                strokeWidth={!isNSGreen && !isClearance ? 3 : 1.5}
                strokeDasharray={!isNSGreen ? '12 6' : '4 4'}
                opacity={0.6}
                filter={!isNSGreen && !isClearance ? 'url(#neonGlow)' : undefined}
              >
                {!isNSGreen && !isClearance && (
                  <animate attributeName="stroke-dashoffset" values="0;18" dur="0.6s" repeatCount="indefinite" />
                )}
              </path>

              {/* N→E Left turn */}
              <path
                d="M 360,180 Q 360,305 520,305"
                fill="none"
                stroke={isNSGreen ? 'rgba(16,185,129,0.5)' : 'rgba(239,68,68,0.3)'}
                strokeWidth={2}
                strokeDasharray="6 4"
                opacity={0.5}
              />

              {/* W→S Right turn */}
              <path
                d="M 200,280 Q 400,280 400,420"
                fill="none"
                stroke={!isNSGreen ? 'rgba(16,185,129,0.5)' : 'rgba(239,68,68,0.3)'}
                strokeWidth={2}
                strokeDasharray="6 4"
                opacity={0.5}
              />

              {/* ═══ LAYER 10: Flow Rate Labels ═══ */}
              <g transform="translate(400, 160)">
                <rect x="-40" y="-12" width="80" height="22" rx="6" fill="rgba(10,15,25,0.9)" stroke={isNSGreen ? '#10b981' : '#ef4444'} strokeWidth="1.2" />
                <text x="0" y="3" textAnchor="middle" fill="#fff" fontSize="11" fontFamily="var(--font-mono)" fontWeight="700">
                  ↓ {nsFlow} veh/m
                </text>
              </g>

              <g transform="translate(140, 305)">
                <rect x="-40" y="-12" width="80" height="22" rx="6" fill="rgba(10,15,25,0.9)" stroke={!isNSGreen ? '#10b981' : '#ef4444'} strokeWidth="1.2" />
                <text x="0" y="3" textAnchor="middle" fill="#fff" fontSize="11" fontFamily="var(--font-mono)" fontWeight="700">
                  → {ewFlow} veh/m
                </text>
              </g>

              <g transform="translate(500, 350)">
                <rect x="-36" y="-12" width="72" height="22" rx="6" fill="rgba(10,15,25,0.9)" stroke={isNSGreen ? '#10b981' : '#f59e0b'} strokeWidth="1.2" />
                <text x="0" y="3" textAnchor="middle" fill="#fff" fontSize="11" fontFamily="var(--font-mono)" fontWeight="700">
                  ↗ {turnFlow} veh/m
                </text>
              </g>

              {/* ═══ LAYER 11: Animated Vehicles ═══ */}
              {vehicleList.map(v => renderVehicle(v))}

              {/* ═══ LAYER 12: Pedestrians ═══ */}
              {pedestrians.map(ped => (
                <g key={ped.id} transform={`translate(${ped.x}, ${ped.y})`}>
                  {/* Body */}
                  <circle cx={0} cy={-4} r={2} fill="#94a3b8" />
                  {/* Torso */}
                  <rect x={-1} y={-2} width={2} height={4} rx={0.5} fill="#64748b" />
                  {/* Legs walking animation */}
                  {ped.walking && (
                    <>
                      <line x1={-1} y1={2} x2={-2} y2={5} stroke="#64748b" strokeWidth={1}>
                        <animate attributeName="x2" values="-2;0;-2" dur="0.4s" repeatCount="indefinite" />
                      </line>
                      <line x1={1} y1={2} x2={2} y2={5} stroke="#64748b" strokeWidth={1}>
                        <animate attributeName="x2" values="2;0;2" dur="0.4s" repeatCount="indefinite" />
                      </line>
                    </>
                  )}
                </g>
              ))}

              {/* ═══ LAYER 13: Traffic Signal Gantries (Realistic) ═══ */}
              {/* North signal */}
              <g transform="translate(305, 238)">
                {/* Pole */}
                <rect x={-3} y={-50} width={6} height={50} rx={1} fill="#334155" />
                {/* Horizontal arm */}
                <rect x={-3} y={-52} width={40} height={4} rx={1} fill="#334155" />
                {/* Signal housing */}
                <rect x={28} y={-62} width={16} height={38} rx={3} fill="#0f172a" stroke="#1e293b" strokeWidth={1} />
                {/* Red */}
                <circle cx={36} cy={-52} r={4} fill={isNSGreen ? '#2d0f15' : '#ef4444'} filter={!isNSGreen ? 'url(#signalGlow)' : undefined} />
                {/* Yellow */}
                <circle cx={36} cy={-42} r={4} fill={isClearance ? '#fbbf24' : '#2b210a'} filter={isClearance ? 'url(#signalGlow)' : undefined} />
                {/* Green */}
                <circle cx={36} cy={-32} r={4} fill={isNSGreen ? '#10b981' : '#092518'} filter={isNSGreen ? 'url(#signalGlow)' : undefined} />
                {/* Signal ground glow */}
                {isNSGreen && timeOfDay === 'night' && (
                  <ellipse cx={36} cy={0} rx={20} ry={6} fill="rgba(16,185,129,0.08)" />
                )}
              </g>

              {/* South signal */}
              <g transform="translate(495, 372)">
                <rect x={-3} y={-50} width={6} height={50} rx={1} fill="#334155" />
                <rect x={-37} y={-52} width={40} height={4} rx={1} fill="#334155" />
                <rect x={-42} y={-62} width={16} height={38} rx={3} fill="#0f172a" stroke="#1e293b" strokeWidth={1} />
                <circle cx={-34} cy={-52} r={4} fill={isNSGreen ? '#2d0f15' : '#ef4444'} filter={!isNSGreen ? 'url(#signalGlow)' : undefined} />
                <circle cx={-34} cy={-42} r={4} fill={isClearance ? '#fbbf24' : '#2b210a'} filter={isClearance ? 'url(#signalGlow)' : undefined} />
                <circle cx={-34} cy={-32} r={4} fill={isNSGreen ? '#10b981' : '#092518'} filter={isNSGreen ? 'url(#signalGlow)' : undefined} />
              </g>

              {/* East signal */}
              <g transform="translate(492, 238)">
                <rect x={-3} y={-50} width={6} height={50} rx={1} fill="#334155" />
                <rect x={-3} y={-52} width={40} height={4} rx={1} fill="#334155" />
                <rect x={28} y={-62} width={16} height={38} rx={3} fill="#0f172a" stroke="#1e293b" strokeWidth={1} />
                <circle cx={36} cy={-52} r={4} fill={!isNSGreen ? '#2d0f15' : '#ef4444'} filter={isNSGreen ? 'url(#signalGlow)' : undefined} />
                <circle cx={36} cy={-42} r={4} fill={isClearance ? '#fbbf24' : '#2b210a'} filter={isClearance ? 'url(#signalGlow)' : undefined} />
                <circle cx={36} cy={-32} r={4} fill={!isNSGreen && !isClearance ? '#10b981' : '#092518'} filter={!isNSGreen && !isClearance ? 'url(#signalGlow)' : undefined} />
                {!isNSGreen && !isClearance && timeOfDay === 'night' && (
                  <ellipse cx={36} cy={0} rx={20} ry={6} fill="rgba(16,185,129,0.08)" />
                )}
              </g>

              {/* West signal */}
              <g transform="translate(308, 372)">
                <rect x={-3} y={-50} width={6} height={50} rx={1} fill="#334155" />
                <rect x={-37} y={-52} width={40} height={4} rx={1} fill="#334155" />
                <rect x={-42} y={-62} width={16} height={38} rx={3} fill="#0f172a" stroke="#1e293b" strokeWidth={1} />
                <circle cx={-34} cy={-52} r={4} fill={!isNSGreen ? '#2d0f15' : '#ef4444'} filter={isNSGreen ? 'url(#signalGlow)' : undefined} />
                <circle cx={-34} cy={-42} r={4} fill={isClearance ? '#fbbf24' : '#2b210a'} filter={isClearance ? 'url(#signalGlow)' : undefined} />
                <circle cx={-34} cy={-32} r={4} fill={!isNSGreen && !isClearance ? '#10b981' : '#092518'} filter={!isNSGreen && !isClearance ? 'url(#signalGlow)' : undefined} />
              </g>

              {/* ═══ LAYER 14: Floating particles (atmosphere) ═══ */}
              {showParticles && timeOfDay === 'night' && (
                <g opacity={0.3}>
                  {Array.from({ length: 15 }).map((_, i) => {
                    const px = 50 + (i * 53) % 700;
                    const py = 20 + (i * 41) % 580;
                    return (
                      <circle key={`particle-${i}`} cx={px} cy={py} r={0.8} fill="#38bdf8">
                        <animate attributeName="opacity" values="0;0.6;0" dur={`${2 + i * 0.3}s`} repeatCount="indefinite" begin={`${i * 0.2}s`} />
                        <animate attributeName="cy" values={`${py};${py - 20};${py}`} dur={`${4 + i * 0.5}s`} repeatCount="indefinite" begin={`${i * 0.3}s`} />
                      </circle>
                    );
                  })}
                </g>
              )}

              {/* ═══ LAYER 15: Night rain/reflections on road ═══ */}
              {timeOfDay === 'night' && (
                <g opacity={0.06}>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <ellipse
                      key={`refl-${i}`}
                      cx={330 + (i * 22)}
                      cy={285 + (i % 3) * 25}
                      rx={8}
                      ry={2}
                      fill="#38bdf8"
                    >
                      <animate attributeName="opacity" values="0.03;0.08;0.03" dur={`${1.5 + i * 0.2}s`} repeatCount="indefinite" />
                    </ellipse>
                  ))}
                </g>
              )}

              {/* ═══ LAYER 15.5: Time-of-day light grading ═══ */}
              <rect width="800" height="620" fill={T.overlay} pointerEvents="none" />

              {/* ═══ LAYER 16: Compass Rose ═══ */}
              <g transform="translate(750, 580)">
                <circle cx={0} cy={0} r={18} fill="rgba(10,15,25,0.85)" stroke="rgba(255,255,255,0.15)" strokeWidth={0.8} />
                <text x={0} y={-8} textAnchor="middle" fill="#38bdf8" fontSize="8" fontWeight="700" fontFamily="var(--font-mono)">N</text>
                <text x={0} y={14} textAnchor="middle" fill="#64748b" fontSize="7" fontFamily="var(--font-mono)">S</text>
                <text x={10} y={3} textAnchor="middle" fill="#64748b" fontSize="7" fontFamily="var(--font-mono)">E</text>
                <text x={-10} y={3} textAnchor="middle" fill="#64748b" fontSize="7" fontFamily="var(--font-mono)">W</text>
                <line x1={0} y1={-5} x2={0} y2={-14} stroke="#38bdf8" strokeWidth={1.5} />
                <polygon points="0,-15 -3,-10 3,-10" fill="#38bdf8" />
              </g>

              {/* ═══ LAYER 17: Scale bar ═══ */}
              <g transform="translate(30, 590)">
                <line x1={0} y1={0} x2={60} y2={0} stroke="#64748b" strokeWidth={1} />
                <line x1={0} y1={-4} x2={0} y2={4} stroke="#64748b" strokeWidth={1} />
                <line x1={60} y1={-4} x2={60} y2={4} stroke="#64748b" strokeWidth={1} />
                <text x={30} y={-6} textAnchor="middle" fill="#64748b" fontSize="8" fontFamily="var(--font-mono)">50m</text>
              </g>
            </svg>

            <div className="city3d-controls">
              <button type="button" className="small" onClick={pz.zoomIn} title="Zoom in (or mouse wheel)"><ZoomIn size={14} /></button>
              <button type="button" className="small" onClick={pz.zoomOut} title="Zoom out"><ZoomOut size={14} /></button>
              <button type="button" className="small" onClick={pz.reset} title="Reset view"><Crosshair size={14} /></button>
              <button type="button" className="small" onClick={toggleFull} title={isFull ? 'Exit full screen' : 'Full screen'}>
                {isFull ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </div>
            <div className="city3d-zoom mono">{pz.zoom.toFixed(1)}× · scroll to zoom · drag to pan</div>
          </div>
        </div>

        {/* Right Telemetry Card */}
        <div className="dt-side-card">
          <div className="dt-card-header">
            <Activity size={16} color="#10b981" />
            <b>Adaptive Signal Control Dashboard</b>
          </div>

          <div className="dt-stat-table">
            <div className="dt-stat-row">
              <span className="muted">Signal Cycle Time</span>
              <b style={{ fontFamily: 'var(--font-mono)' }}>90 s (Dynamic)</b>
            </div>
            <div className="dt-stat-row">
              <span className="muted">Active Phase</span>
              <b style={{ color: isNSGreen ? '#10b981' : '#fbbf24' }}>
                Phase {phase} ({isNSGreen ? 'N-S Green' : 'E-W Green'})
              </b>
            </div>
            <div className="dt-stat-row">
              <span className="muted">Green Extension</span>
              <b style={{ color: '#10b981' }}>+12s (Swarm Optimization)</b>
            </div>
            <div className="dt-stat-row">
              <span className="muted">Incoming Lanes</span>
              <b>{jData.lanes || 4} Approach Lanes</b>
            </div>
            <div className="dt-stat-row">
              <span className="muted">Halting Queue</span>
              <b style={{ color: queue > 4 ? '#ef4444' : '#38bdf8' }}>
                {queue} Vehicles waiting
              </b>
            </div>
          </div>

          {/* Performance Index */}
          <div className="dt-card-header" style={{ marginTop: 14 }}>
            <Gauge size={15} color="#38bdf8" />
            <b>Intersection Performance Index</b>
          </div>
          <div className="gauge-wrap">
            <div className="gauge-circle">
              <span className="gauge-score">{perfScore}</span>
              <span className="gauge-label">/ 100</span>
            </div>
            <div className="gauge-meta">
              <b style={{ color: perfScore > 75 ? '#10b981' : '#fbbf24' }}>
                {perfScore > 75 ? 'OPTIMAL FLOW' : 'MODERATE CONGESTION'}
              </b>
              <span className="muted small">
                PSO multi-objective scoring weighted against queue delay & emissions.
              </span>
            </div>
          </div>

          {/* Live Vehicle Count */}
          <div className="dt-card-header" style={{ marginTop: 14 }}>
            <Eye size={15} color="#a855f7" />
            <b>Live Traffic Metrics</b>
          </div>
          <div className="dt-stat-table">
            <div className="dt-stat-row">
              <span className="muted">Active Vehicles</span>
              <b style={{ color: '#38bdf8' }}>{vehicleList.length} in viewport</b>
            </div>
            <div className="dt-stat-row">
              <span className="muted">Queued Vehicles</span>
              <b style={{ color: '#ef4444' }}>{vehicleList.filter(v => v.isQueued).length} halting</b>
            </div>
            <div className="dt-stat-row">
              <span className="muted">Pedestrians</span>
              <b style={{ color: '#10b981' }}>{pedestrians.length} crossing</b>
            </div>
            <div className="dt-stat-row">
              <span className="muted">Time of Day</span>
              <b style={{ color: '#fbbf24', textTransform: 'capitalize' }}>{timeOfDay}</b>
            </div>
          </div>

          {/* Alerts */}
          <div className="dt-alerts" style={{ marginTop: 12 }}>
            <div className="dt-alert-item ok">
              <ShieldCheck size={14} color="#10b981" />
              <span>Safety Gate: No conflicting green signals</span>
            </div>
            {queue > 5 && (
              <div className="dt-alert-item warn">
                <AlertTriangle size={14} color="#fbbf24" />
                <span>Queue buildup on East approach</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
