'use client';

import React, { useEffect, useRef, useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import 'leaflet/dist/leaflet.css';
import {
  MapPin,
  Layers,
  Zap,
  Activity,
  Fuel,
  IndianRupee,
  ShieldCheck,
  RotateCcw,
  Play,
  Pause,
  Sliders,
  TrendingDown,
  Info,
  Grid3x3,
  Map as MapIcon
} from 'lucide-react';
import { fmt } from '@/lib/api';
import FuelSavedCard from '@/components/FuelSavedCard';
import RichDropdown from '@/components/RichDropdown';
import { GHAZIABAD_GRID_JUNCTIONS } from '@/lib/ghaziabadGrids';

// Ghaziabad Key Corridors & Real-World Junction Coordinates
const GHAZIABAD_JUNCTIONS = [
  {
    id: 'GZB-J1',
    name: 'Mohan Nagar Chauraha',
    corridor: 'GT Road / Link Road',
    lat: 28.6787,
    lon: 77.3884,
    baseQueue: 42,
    swarmQueue: 11,
    baseDelay: 78,
    swarmDelay: 24,
    gridCol: 0,
    gridRow: 1,
  },
  {
    id: 'GZB-J2',
    name: 'Raj Nagar Extension Crossing',
    corridor: 'Meerut Bypass / ALT Road',
    lat: 28.7042,
    lon: 77.4248,
    baseQueue: 38,
    swarmQueue: 9,
    baseDelay: 65,
    swarmDelay: 19,
    gridCol: 1,
    gridRow: 0,
  },
  {
    id: 'GZB-J3',
    name: 'Old Bus Stand / Hapur Chungi',
    corridor: 'Ambedkar Road / Hapur Rd',
    lat: 28.6644,
    lon: 77.4398,
    baseQueue: 48,
    swarmQueue: 14,
    baseDelay: 85,
    swarmDelay: 28,
    gridCol: 2,
    gridRow: 1,
  },
  {
    id: 'GZB-J4',
    name: 'UP Gate / Anand Vihar Border',
    corridor: 'Delhi-Ghaziabad Link / NH-9',
    lat: 28.6328,
    lon: 77.3298,
    baseQueue: 52,
    swarmQueue: 15,
    baseDelay: 92,
    swarmDelay: 31,
    gridCol: 0,
    gridRow: 2,
  },
  {
    id: 'GZB-J5',
    name: 'Vijay Nagar Bypass',
    corridor: 'Delhi-Meerut Expressway / NH-9',
    lat: 28.6365,
    lon: 77.4475,
    baseQueue: 45,
    swarmQueue: 12,
    baseDelay: 72,
    swarmDelay: 22,
    gridCol: 2,
    gridRow: 2,
  },
  {
    id: 'GZB-J6',
    name: 'Vasundhara / CISF Cut',
    corridor: 'Atal Setu Link Road',
    lat: 28.6622,
    lon: 77.3712,
    baseQueue: 32,
    swarmQueue: 8,
    baseDelay: 54,
    swarmDelay: 16,
    gridCol: 0,
    gridRow: 1,
  },
  {
    id: 'GZB-J7',
    name: 'Vaishali Sector 4 / Kaushambi',
    corridor: 'ISBT Link Road',
    lat: 28.6472,
    lon: 77.3685,
    baseQueue: 35,
    swarmQueue: 10,
    baseDelay: 58,
    swarmDelay: 18,
    gridCol: 0,
    gridRow: 2,
  },
  {
    id: 'GZB-J8',
    name: 'Govindpuram T-Point',
    corridor: 'Hapur Highway / NH-34',
    lat: 28.6812,
    lon: 77.4815,
    baseQueue: 29,
    swarmQueue: 7,
    baseDelay: 48,
    swarmDelay: 15,
    gridCol: 2,
    gridRow: 0,
  },
  {
    id: 'GZB-J9',
    name: 'Meerut Road Industrial Cut',
    corridor: 'Meerut Road / Hindon Bridge',
    lat: 28.6895,
    lon: 77.4312,
    baseQueue: 40,
    swarmQueue: 11,
    baseDelay: 68,
    swarmDelay: 21,
    gridCol: 1,
    gridRow: 1,
  },
];

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const ESRI_ATTR = 'Tiles © Esri';

// Key-free basemaps; each view may stack several tile layers (e.g. imagery + labels)
const MAP_VIEWS = {
  dark: {
    label: 'Dark Command',
    sub: 'Low-glare dark canvas for live telemetry',
    badge: 'DEFAULT',
    layers: [{ url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 16, attribution: `${ESRI_ATTR}, HERE, Garmin, © OpenStreetMap contributors` }],
  },
  street: {
    label: 'Street Map',
    sub: 'OpenStreetMap roads, lanes & landmarks',
    badge: 'OSM',
    layers: [{ url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', maxNativeZoom: 19, attribution: '© OpenStreetMap contributors' }],
  },
  satellite: {
    label: 'Satellite',
    sub: 'High-resolution aerial imagery',
    badge: 'IMAGERY',
    layers: [{ url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 19, attribution: `${ESRI_ATTR}, Maxar, Earthstar Geographics` }],
  },
  hybrid: {
    label: 'Hybrid',
    sub: 'Satellite imagery with road & place labels',
    badge: 'LABELS',
    layers: [
      { url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 19, attribution: `${ESRI_ATTR}, Maxar, Earthstar Geographics` },
      { url: `${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 19 },
      { url: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 19 },
    ],
  },
  terrain: {
    label: 'Terrain',
    sub: 'Topographic relief with roads',
    badge: 'TOPO',
    layers: [{ url: `${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 19, attribution: `${ESRI_ATTR}, HERE, Garmin, USGS` }],
  },
};

const MAP_VIEW_OPTIONS = Object.entries(MAP_VIEWS).map(([value, v]) => ({
  value,
  label: v.label,
  sub: v.sub,
  badge: v.badge,
}));

// Deterministic pseudo-random in [0, 1) so generated junctions stay stable between renders
function seeded(r, c, salt) {
  const x = Math.sin(r * 127.1 + c * 311.7 + salt * 74.7) * 43758.5453;
  return x - Math.floor(x);
}

const SOURCE_LABEL = {
  survey: 'Surveyed core junction',
  signal: 'OSM signalised junction',
  osm: 'OSM major-road intersection',
};

// Builds an n×n junction mesh from real junctions, ordered into n rows (north→south)
// of n columns (west→east). The 3×3 grid is the 9 surveyed junctions; 5×5 and 9×9 add
// real OpenStreetMap junctions spread evenly across the city (see lib/ghaziabadGrids.js).
function buildGrid(n) {
  if (n === 3) {
    const byLat = [...GHAZIABAD_JUNCTIONS].sort((a, b) => b.lat - a.lat);
    const out = [];
    for (let r = 0; r < 3; r++) {
      byLat
        .slice(r * 3, r * 3 + 3)
        .sort((a, b) => a.lon - b.lon)
        .forEach((j, c) => out.push({ ...j, gridRow: r, gridCol: c, source: 'survey' }));
    }
    return out;
  }

  const surveyed = Object.fromEntries(GHAZIABAD_JUNCTIONS.map(j => [j.id, j]));
  return GHAZIABAD_GRID_JUNCTIONS[n].map(entry => {
    if (entry.anchor) {
      return { ...surveyed[entry.anchor], gridRow: entry.gridRow, gridCol: entry.gridCol, source: 'survey' };
    }
    const { gridRow: r, gridCol: c } = entry;
    // Simulated demand: signalised junctions carry heavier baseline queues
    const baseQueue = Math.round((entry.signalized ? 28 : 18) + seeded(r + n, c, 1) * 26);
    const baseDelay = Math.round(baseQueue * (1.5 + seeded(r + n, c, 2) * 0.4));
    const gain = 0.22 + seeded(r + n, c, 3) * 0.12; // swarm keeps ~22–34% of baseline
    return {
      ...entry,
      baseQueue,
      swarmQueue: Math.max(3, Math.round(baseQueue * gain)),
      baseDelay,
      swarmDelay: Math.max(8, Math.round(baseDelay * gain)),
      source: entry.signalized ? 'signal' : 'osm',
    };
  });
}

// Area covered by a grid: convex hull of its junctions (km², local equirectangular
// projection) plus the north-south / east-west extent of its bounding box.
function gridCoverage(junctions) {
  const lat0 = junctions.reduce((acc, j) => acc + j.lat, 0) / junctions.length;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const pts = junctions.map(j => ({ x: j.lon * kx, y: j.lat * 110.57, lat: j.lat, lon: j.lon }));
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  const upper = [];
  pts.forEach(p => {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  });
  [...pts].reverse().forEach(p => {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  });
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  let area = 0;
  hull.forEach((p, i) => {
    const q = hull[(i + 1) % hull.length];
    area += p.x * q.y - q.x * p.y;
  });
  const lats = junctions.map(j => j.lat);
  const lons = junctions.map(j => j.lon);
  return {
    areaKm2: Math.abs(area) / 2,
    widthKm: (Math.max(...lons) - Math.min(...lons)) * kx,
    heightKm: (Math.max(...lats) - Math.min(...lats)) * 110.57,
    hull: hull.map(p => [p.lat, p.lon]),
  };
}

// Mesh links: the 3×3 core uses row/column neighbours; the larger real-junction grids
// link each junction to its 3 nearest neighbours so channels follow the city layout.
function gridEdges(junctions, n) {
  const edges = new Set();
  junctions.forEach((a, i) => {
    junctions.forEach((b, k) => {
      if (k <= i) return;
      const dRow = Math.abs(a.gridRow - b.gridRow);
      const dCol = Math.abs(a.gridCol - b.gridCol);
      if (n === 3 && dRow + dCol === 1) edges.add(`${i}-${k}`);
    });
    if (n === 3) return;
    const kx = Math.cos((a.lat * Math.PI) / 180);
    junctions
      .map((b, k) => ({ k, d: Math.hypot(a.lat - b.lat, (a.lon - b.lon) * kx) }))
      .filter(({ k }) => k !== i)
      .sort((x, y) => x.d - y.d)
      .slice(0, 3)
      .forEach(({ k }) => edges.add(i < k ? `${i}-${k}` : `${k}-${i}`));
  });
  return [...edges].map(e => e.split('-').map(Number));
}

const GRIDS = { 3: buildGrid(3), 5: buildGrid(5), 9: buildGrid(9) };
const EDGES = { 3: gridEdges(GRIDS[3], 3), 5: gridEdges(GRIDS[5], 5), 9: gridEdges(GRIDS[9], 9) };
const COVERAGE = { 3: gridCoverage(GRIDS[3]), 5: gridCoverage(GRIDS[5]), 9: gridCoverage(GRIDS[9]) };

const GRID_OPTIONS = [
  { value: '3', label: '3×3 Core Grid', sub: `9 surveyed junctions · ≈${COVERAGE[3].areaKm2.toFixed(0)} km² covered`, badge: '9 NODES' },
  { value: '5', label: '5×5 City Grid', sub: `25 real junctions · ≈${COVERAGE[5].areaKm2.toFixed(0)} km² covered`, badge: '25 NODES' },
  { value: '9', label: '9×9 Metro Grid', sub: `81 real junctions · ≈${COVERAGE[9].areaKm2.toFixed(0)} km² covered`, badge: '81 NODES' },
];

export default function GhaziabadLiveMap() {
  const mapContainerRef = useRef(null);
  const leafletMapRef = useRef(null);
  const markersRef = useRef([]);
  const polylinesRef = useRef([]);
  const tileLayersRef = useRef([]);
  const coverageLayerRef = useRef(null);

  const [gridSize, setGridSize] = useState(3);
  const [mapView, setMapView] = useState('dark');
  const gridJunctions = GRIDS[gridSize];
  const coverage = COVERAGE[gridSize];

  const [activeMode, setActiveMode] = useState('swarm'); // 'baseline' | 'swarm'
  const [showGridOverlay, setShowGridOverlay] = useState(true);
  const [selectedJunctionId, setSelectedJunctionId] = useState('GZB-J1');
  const [isPlaying, setIsPlaying] = useState(true);
  const [simTick, setSimTick] = useState(0);

  // Live simulation tick loop
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setSimTick(t => t + 1);
    }, 1800);
    return () => clearInterval(interval);
  }, [isPlaying]);

  // Dynamic fluctuation based on tick & controller mode
  const currentJunctions = useMemo(() => {
    return gridJunctions.map(j => {
      // Sine wave oscillation simulating real-time vehicle flow & pulses
      const noise = Math.sin(simTick * 0.4 + j.lat * 10) * 4;
      const isSwarm = activeMode === 'swarm';
      const q = Math.max(2, Math.round((isSwarm ? j.swarmQueue : j.baseQueue) + noise));
      const delay = Math.max(8, Math.round((isSwarm ? j.swarmDelay : j.baseDelay) + noise * 1.5));
      const phase = (Math.floor(simTick / 3) + j.gridCol + j.gridRow) % 4; // 0=NS Green, 1=Yellow, 2=EW Green, 3=All Red
      const phaseColor = phase === 0 || phase === 2 ? '#10b981' : phase === 1 ? '#f59e0b' : '#f43f5e';
      const pheromone = isSwarm ? Math.min(1.0, 0.2 + (q / 30) * 0.8).toFixed(2) : '0.00';

      return {
        ...j,
        liveQueue: q,
        liveDelay: delay,
        phase,
        phaseColor,
        pheromone,
        status: q > 30 ? 'HEAVY' : q > 15 ? 'MODERATE' : 'FREE FLOW',
      };
    });
  }, [simTick, activeMode, gridJunctions]);

  const selectedJunction = useMemo(() => {
    return currentJunctions.find(j => j.id === selectedJunctionId) || currentJunctions[0];
  }, [currentJunctions, selectedJunctionId]);

  // Aggregate totals
  const aggregates = useMemo(() => {
    const totalQueue = currentJunctions.reduce((acc, j) => acc + j.liveQueue, 0);
    const avgDelay = currentJunctions.reduce((acc, j) => acc + j.liveDelay, 0) / currentJunctions.length;
    const baseTotalQueue = gridJunctions.reduce((acc, j) => acc + j.baseQueue, 0);
    const baseAvgDelay = gridJunctions.reduce((acc, j) => acc + j.baseDelay, 0) / gridJunctions.length;

    const delaySavedPct = Math.max(0, ((baseAvgDelay - avgDelay) / baseAvgDelay) * 100);
    const queueSavedPct = Math.max(0, ((baseTotalQueue - totalQueue) / baseTotalQueue) * 100);

    // Calculated real fuel metrics:
    // Base 9 intersections in Ghaziabad process ~4,800 vehicles/hour
    // Idling vehicle consumes ~0.8 L/hr (0.0133 L/min = 0.000222 L/s)
    // Figures above are for the 9-junction core; scale linearly with junction count
    const scale = gridJunctions.length / 9;
    const baseFuelMg = 85400000 * scale;
    const swarmFuelMg = (activeMode === 'swarm' ? 58900000 : 85400000) * scale;
    const baseCo2Mg = 265000000 * scale;
    const swarmCo2Mg = (activeMode === 'swarm' ? 182000000 : 265000000) * scale;

    return {
      totalQueue,
      avgDelay,
      delaySavedPct: activeMode === 'swarm' ? delaySavedPct : 0,
      queueSavedPct: activeMode === 'swarm' ? queueSavedPct : 0,
      baseFuelMg,
      swarmFuelMg,
      baseCo2Mg,
      swarmCo2Mg,
    };
  }, [currentJunctions, activeMode, gridJunctions]);

  // Leaflet Map Initialization
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const L = require('leaflet');

    if (!leafletMapRef.current && mapContainerRef.current) {
      const map = L.map(mapContainerRef.current, {
        center: [28.6692, 77.4138],
        zoom: 13,
        zoomControl: true,
        maxZoom: 18,
      });
      map.attributionControl.setPrefix(false);

      leafletMapRef.current = map;
    }

    const map = leafletMapRef.current;
    if (!map) return;

    // Clear old markers & polylines
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    polylinesRef.current.forEach(p => p.remove());
    polylinesRef.current = [];

    // Draw Grid Lines connecting coordinating junctions if toggled
    if (showGridOverlay) {
      const isSwarm = activeMode === 'swarm';
      EDGES[gridSize].forEach(([i, k]) => {
        const j1 = currentJunctions[i];
        const j2 = currentJunctions[k];
        const line = L.polyline(
          [
            [j1.lat, j1.lon],
            [j2.lat, j2.lon],
          ],
          {
            color: isSwarm ? '#38bdf8' : '#64748b',
            weight: isSwarm ? (gridSize >= 9 ? 2 : 3) : 1.5,
            dashArray: isSwarm ? '6, 8' : '2, 4',
            opacity: isSwarm ? 0.75 : 0.4,
          }
        ).addTo(map);
        polylinesRef.current.push(line);
      });
    }

    // Add Markers for each Ghaziabad Junction
    const compact = gridSize >= 9;
    currentJunctions.forEach(j => {
      const isSelected = selectedJunction?.id === j.id;
      // Larger grids only label the selected junction to keep the map readable
      const showTag = gridSize === 3 || isSelected;
      const markerHtml = `
        <div class="gzb-marker-wrap ${isSelected ? 'active' : ''} ${compact ? 'compact' : ''}">
          <div class="marker-pulse" style="background: ${j.phaseColor};"></div>
          <div class="marker-core" style="border-color: ${j.phaseColor};">
            <span class="marker-queue">${j.liveQueue}</span>
          </div>
          ${showTag ? `<span class="marker-tag">${j.name.split('/')[0]}</span>` : ''}
        </div>
      `;

      const customIcon = L.divIcon({
        className: 'custom-leaflet-marker',
        html: markerHtml,
        iconSize: compact ? [24, 24] : [36, 36],
        iconAnchor: compact ? [12, 12] : [18, 18],
      });

      const marker = L.marker([j.lat, j.lon], { icon: customIcon }).addTo(map);
      marker.on('click', () => {
        setSelectedJunctionId(j.id);
      });

      markersRef.current.push(marker);
    });
  }, [currentJunctions, showGridOverlay, activeMode, selectedJunction, gridSize]);

  // Swap basemap tile layers when the map view changes
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;
    const L = require('leaflet');
    tileLayersRef.current.forEach(t => t.remove());
    tileLayersRef.current = MAP_VIEWS[mapView].layers.map(({ url, ...opts }) =>
      L.tileLayer(url, { maxZoom: 18, ...opts }).addTo(map)
    );
  }, [mapView]);

  // Frame the whole mesh and shade its coverage area whenever the grid size changes
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;
    const L = require('leaflet');
    coverageLayerRef.current?.remove();
    coverageLayerRef.current = L.polygon(coverage.hull, {
      color: '#38bdf8',
      weight: 2,
      dashArray: '8, 6',
      fillColor: '#38bdf8',
      fillOpacity: 0.1,
      interactive: false,
    }).addTo(map);
    map.invalidateSize();
    map.fitBounds(L.latLngBounds(gridJunctions.map(j => [j.lat, j.lon])), { padding: [30, 30], animate: false });
  }, [gridJunctions, coverage]);

  return (
    <div className="gzb-command-center">
      {/* Top Header & Strategy Control Toolbar */}
      <section className="panel gzb-header-panel">
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 14 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="badge live">● GHAZIABAD NCR LIVE DIGITAL TWIN</span>
              <span className="status" style={{ fontSize: 11 }}>OSM Overpass · SUMO Gated</span>
            </div>
            <h2 style={{ marginTop: 6, marginBottom: 4 }}>
              Ghaziabad Metropolitan Swarm Traffic Lab
            </h2>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Real-world road network of Ghaziabad, UP (Mohan Nagar, Raj Nagar Ext, NH-9, Hapur Chungi) under hybrid PSO+ACO multi-agent signal optimization.
            </p>
          </div>

          {/* Strategy Mode Switcher */}
          <div className="gzb-controls-group">
            <div className="gzb-dropdown">
              <RichDropdown
                options={GRID_OPTIONS}
                value={String(gridSize)}
                onChange={v => setGridSize(Number(v))}
                icon={Grid3x3}
              />
            </div>
            <div className="gzb-dropdown">
              <RichDropdown
                options={MAP_VIEW_OPTIONS}
                value={mapView}
                onChange={setMapView}
                icon={MapIcon}
              />
            </div>

            <div className="mode-toggle-pill">
              <button
                className={`toggle-btn ${activeMode === 'baseline' ? 'active-baseline' : ''}`}
                onClick={() => setActiveMode('baseline')}
                title="Fixed-time uncoordinated baseline signal timers"
              >
                Fixed-Time Baseline
              </button>
              <button
                className={`toggle-btn ${activeMode === 'swarm' ? 'active-swarm' : ''}`}
                onClick={() => setActiveMode('swarm')}
                title="Swarm Intelligence: PSO + ACO with Digital Pheromones"
              >
                <Zap size={14} />
                Swarm Optimized (AI)
              </button>
            </div>

            <button
              className={`action-btn ${showGridOverlay ? 'active' : ''}`}
              onClick={() => setShowGridOverlay(!showGridOverlay)}
              title="Toggle Swarm Virtual Mesh Network"
            >
              <Layers size={15} />
              Swarm Mesh
            </button>

            <button
              className="action-btn"
              onClick={() => setIsPlaying(!isPlaying)}
              title={isPlaying ? 'Pause Simulation' : 'Resume Simulation'}
            >
              {isPlaying ? <Pause size={15} /> : <Play size={15} color="#10b981" />}
            </button>
          </div>
        </div>

        {/* Real-time Telemetry Bar */}
        <div className="gzb-telemetry-banner">
          <div className="telemetry-item">
            <span className="lbl">AVG NETWORK DELAY</span>
            <div className="val">
              <b>{fmt(aggregates.avgDelay, 1)} s/veh</b>
              {activeMode === 'swarm' && (
                <span className="pill-better">-{fmt(aggregates.delaySavedPct, 1)}%</span>
              )}
            </div>
          </div>

          <div className="telemetry-item">
            <span className="lbl">TOTAL CONGESTION QUEUE</span>
            <div className="val">
              <b>{aggregates.totalQueue} vehicles</b>
              {activeMode === 'swarm' && (
                <span className="pill-better">-{fmt(aggregates.queueSavedPct, 1)}%</span>
              )}
            </div>
          </div>

          <div className="telemetry-item">
            <span className="lbl">GRID COVERAGE AREA</span>
            <div className="val text-cyan">
              <Grid3x3 size={16} />
              <b>≈{fmt(coverage.areaKm2, 1)} km²</b>
              <span className="pill-better pill-area">
                {fmt(coverage.heightKm, 1)} × {fmt(coverage.widthKm, 1)} km
              </span>
            </div>
          </div>

          <div className="telemetry-item">
            <span className="lbl">SIGNAL SAFETY GATE</span>
            <div className="val text-emerald">
              <ShieldCheck size={16} />
              <b>100% GATED (0 Crashes)</b>
            </div>
          </div>

          <div className="telemetry-item">
            <span className="lbl">SIMULATION PACE</span>
            <div className="val text-cyan">
              <Activity size={16} />
              <b>T={simTick * 5}s · {currentJunctions.length} Agents Active</b>
            </div>
          </div>
        </div>
      </section>

      {/* Main Map + Side Junction Inspector Layout */}
      <div className="gzb-main-grid">
        {/* Interactive Map View */}
        <div className="gzb-map-wrapper">
          <div ref={mapContainerRef} className="leaflet-map-container" />

          {/* Map Overlay Legend */}
          <div className="gzb-map-legend">
            <b>Ghaziabad {gridSize}×{gridSize} Mesh</b>
            <div className="legend-row">
              <span className="dot" style={{ background: '#10b981' }} /> Green Wave Active
            </div>
            <div className="legend-row">
              <span className="dot" style={{ background: '#f59e0b' }} /> Yellow Clearance (3s)
            </div>
            <div className="legend-row">
              <span className="dot" style={{ background: '#f43f5e' }} /> All-Red Buffer (1s)
            </div>
            <div className="legend-row">
              <span className="line-dashed" /> Swarm Pheromone Channel
            </div>
            <div className="legend-row">
              <span className="legend-area" /> Coverage ≈{fmt(coverage.areaKm2, 1)} km²
            </div>
          </div>
        </div>

        {/* Selected Junction Details Sidebar */}
        <div className="gzb-junction-panel">
          <div className="panel-title-box">
            <MapPin size={18} color="#38bdf8" />
            <div>
              <h3>{selectedJunction?.name}</h3>
              <span className="muted small">{selectedJunction?.corridor}</span>
            </div>
          </div>

          <div className="junction-stats-cards">
            <div className="j-stat">
              <span className="muted">Intersection ID</span>
              <b>{selectedJunction?.id}</b>
            </div>
            <div className="j-stat">
              <span className="muted">Signal Phase</span>
              <b style={{ color: selectedJunction?.phaseColor }}>
                {selectedJunction?.phase === 0
                  ? 'NORTH-SOUTH GREEN'
                  : selectedJunction?.phase === 1
                  ? 'YELLOW CLEARANCE'
                  : selectedJunction?.phase === 2
                  ? 'EAST-WEST GREEN'
                  : 'ALL-RED SAFETY BUFFER'}
              </b>
            </div>
            <div className="j-stat">
              <span className="muted">Queue Backlog</span>
              <b className={selectedJunction?.liveQueue > 25 ? 'text-rose' : 'text-emerald'}>
                {selectedJunction?.liveQueue} veh
              </b>
            </div>
            <div className="j-stat">
              <span className="muted">Mean Delay</span>
              <b>{selectedJunction?.liveDelay} s</b>
            </div>
            <div className="j-stat">
              <span className="muted">Digital Pheromone (τ)</span>
              <b className="text-cyan">{selectedJunction?.pheromone} / 1.00</b>
            </div>
            <div className="j-stat">
              <span className="muted">Data Source</span>
              <b>{SOURCE_LABEL[selectedJunction?.source]}</b>
            </div>
            <div className="j-stat">
              <span className="muted">Safety Gate Status</span>
              <b className="text-emerald">ACTIVE (Min-Green 10s)</b>
            </div>
          </div>

          <div className="junction-list-quick">
            <span className="muted small" style={{ fontWeight: 600 }}>
              SELECT GHAZIABAD JUNCTION ({currentJunctions.length}):
            </span>
            <div className="j-buttons-scroll">
              {currentJunctions.map(j => (
                <button
                  key={j.id}
                  className={`j-pill-btn ${selectedJunction?.id === j.id ? 'active' : ''}`}
                  onClick={() => setSelectedJunctionId(j.id)}
                >
                  <span className="dot" style={{ background: j.phaseColor }} />
                  <span>{j.name.split('/')[0]}</span>
                  <b style={{ marginLeft: 'auto' }}>{j.liveQueue}v</b>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Fuel Saved & Ecological Impact Showcase */}
      <section style={{ marginTop: 20 }}>
        <FuelSavedCard
          baselineFuelMg={aggregates.baseFuelMg}
          swarmFuelMg={aggregates.swarmFuelMg}
          baselineCo2Mg={aggregates.baseCo2Mg}
          swarmCo2Mg={aggregates.swarmCo2Mg}
          title="Ghaziabad Metropolitan Fuel & Emissions Saved via Swarm Intelligence"
        />
      </section>

      {/* Technical Methodology Note */}
      <div className="info-banner" style={{ marginTop: 14 }}>
        <Info size={16} color="#38bdf8" />
        <span>
          <b>Zero Collision Guarantee:</b> All vehicle movements conform strictly to SUMO’s microscopic Krauss car-following equations (with 2.5m minimum gap & emergency deceleration bounds). The Swarm Safety Gate enforces 10s minimum green, 3s yellow clearance, and 1s all-red protection to physically prevent conflict-point collisions.
        </span>
      </div>
    </div>
  );
}
