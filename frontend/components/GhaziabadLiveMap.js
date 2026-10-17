'use client';

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
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
  Map as MapIcon,
  Search,
  Sparkles,
  CheckCircle,
  Navigation
} from 'lucide-react';
import { fmt } from '@/lib/api';
import FuelSavedCard from '@/components/FuelSavedCard';
import RichDropdown from '@/components/RichDropdown';
import { SUPPORTED_CITIES, CITY_INTERSECTIONS, generateCityGrid } from '@/lib/cityData';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const ESRI_ATTR = 'Tiles © Esri';

// Basemaps for Satellite, Dark Command, Street and Topographic views
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
    label: 'Satellite View',
    sub: 'High-resolution aerial satellite imagery',
    badge: 'IMAGERY',
    layers: [{ url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 19, attribution: `${ESRI_ATTR}, Maxar, Earthstar Geographics` }],
  },
  hybrid: {
    label: 'Satellite + Labels',
    sub: 'Satellite imagery with road & place labels',
    badge: 'HYBRID',
    layers: [
      { url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 19, attribution: `${ESRI_ATTR}, Maxar, Earthstar Geographics` },
      { url: `${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 19 },
      { url: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 19 },
    ],
  },
  terrain: {
    label: 'Terrain / Topo',
    sub: 'Topographic relief with roads & elevations',
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

// Area covered by convex hull of junctions
function gridCoverage(junctions) {
  if (!junctions.length) return { areaKm2: 0, widthKm: 0, heightKm: 0, hull: [] };
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
    areaKm2: Math.max(1, Math.abs(area) / 2),
    widthKm: (Math.max(...lons) - Math.min(...lons)) * kx,
    heightKm: (Math.max(...lats) - Math.min(...lats)) * 110.57,
    hull: hull.map(p => [p.lat, p.lon]),
  };
}

// Mesh edges: corridor connections between adjacent intersections
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

export default function GhaziabadLiveMap() {
  const mapContainerRef = useRef(null);
  const leafletMapRef = useRef(null);
  const markersRef = useRef([]);
  const polylinesRef = useRef([]);
  const flowLinesRef = useRef([]);
  const tileLayersRef = useRef([]);
  const coverageLayerRef = useRef(null);

  const [selectedCityId, setSelectedCityId] = useState('ghaziabad');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [customLocation, setCustomLocation] = useState(null);

  const [gridSize, setGridSize] = useState(3);
  const [mapView, setMapView] = useState('dark');
  const [activeMode, setActiveMode] = useState('swarm'); // 'baseline' | 'swarm'
  const [showGridOverlay, setShowGridOverlay] = useState(true);
  const [showFlowAnimation, setShowFlowAnimation] = useState(true);
  const [selectedJunctionId, setSelectedJunctionId] = useState(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [simTick, setSimTick] = useState(0);

  const currentCity = useMemo(() => {
    if (customLocation) return customLocation;
    return SUPPORTED_CITIES.find(c => c.id === selectedCityId) || SUPPORTED_CITIES[0];
  }, [selectedCityId, customLocation]);

  // Compute junctions for active city & grid
  const rawJunctions = useMemo(() => {
    return generateCityGrid(currentCity.id, gridSize);
  }, [currentCity, gridSize]);

  const coverage = useMemo(() => {
    return gridCoverage(rawJunctions);
  }, [rawJunctions]);

  const edges = useMemo(() => {
    return gridEdges(rawJunctions, gridSize);
  }, [rawJunctions, gridSize]);

  // Dynamic fluctuation based on tick & controller mode (continuous cars flow simulation)
  const currentJunctions = useMemo(() => {
    return rawJunctions.map((j, i) => {
      const noise = Math.sin(simTick * 0.4 + j.lat * 12) * 4;
      const isSwarm = activeMode === 'swarm';
      const q = Math.max(2, Math.round((isSwarm ? j.swarmQueue : j.baseQueue) + noise));
      const delay = Math.max(6, Math.round((isSwarm ? j.swarmDelay : j.baseDelay) + noise * 1.5));
      const phase = (Math.floor(simTick / 3) + j.gridCol + j.gridRow) % 4; // 0=NS Green, 1=Yellow, 2=EW Green, 3=All Red
      const phaseColor = phase === 0 || phase === 2 ? '#10b981' : phase === 1 ? '#f59e0b' : '#f43f5e';
      const phaseName = phase === 0 ? 'NS Green' : phase === 1 ? 'Yellow Transition' : phase === 2 ? 'EW Green' : 'All-Red Clearance';
      const pheromone = isSwarm ? Math.min(1.0, 0.2 + (q / 30) * 0.8).toFixed(2) : '0.00';
      const carsPerMin = Math.max(12, Math.round((j.carsPerMin || 38) + (isSwarm ? 14 : -6) + Math.cos(simTick * 0.2) * 4));
      const timeSavedSec = Math.max(15, Math.round((j.timeSavedSec || 45) + (isSwarm ? 8 : 0)));
      const fuelSavedPct = (Number(j.fuelSavedPct || 19.5) + (isSwarm ? 2.5 : 0)).toFixed(1);

      return {
        ...j,
        liveQueue: q,
        liveDelay: delay,
        phase,
        phaseColor,
        phaseName,
        pheromone,
        carsPerMin,
        timeSavedSec,
        fuelSavedPct,
        status: q > 32 ? 'HEAVY' : q > 16 ? 'MODERATE' : 'CONTINUOUS FLOW',
      };
    });
  }, [simTick, activeMode, rawJunctions]);

  const selectedJunction = useMemo(() => {
    return currentJunctions.find(j => j.id === selectedJunctionId) || currentJunctions[0];
  }, [currentJunctions, selectedJunctionId]);

  // Live simulation tick loop
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setSimTick(t => t + 1);
    }, 1800);
    return () => clearInterval(interval);
  }, [isPlaying]);

  // Dynamic Free OpenStreetMap Nominatim search for ANY location in the world
  const handleSearchLocation = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchQuery)}&format=json&limit=1`);
      const data = await res.json();
      if (data && data[0]) {
        const place = data[0];
        const newLat = parseFloat(place.lat);
        const newLon = parseFloat(place.lon);
        const custom = {
          id: 'custom-' + Date.now(),
          name: place.display_name.split(',')[0],
          region: place.display_name.split(',').slice(1, 3).join(','),
          center: [newLat, newLon],
          zoom: 14,
          description: `Live Real-World Intersection Grid: ${place.display_name}`
        };
        setCustomLocation(custom);
        if (leafletMapRef.current) {
          leafletMapRef.current.flyTo([newLat, newLon], 14, { duration: 1.5 });
        }
      }
    } catch (err) {
      console.error('Location search failed:', err);
    } finally {
      setIsSearching(false);
    }
  };

  // City options for dropdown
  const cityDropdownOptions = useMemo(() => {
    return SUPPORTED_CITIES.map(c => ({
      value: c.id,
      label: c.name,
      sub: c.region,
      badge: c.id.toUpperCase()
    }));
  }, []);

  const gridDropdownOptions = useMemo(() => [
    { value: '3', label: '3×3 Core Corridors', sub: `9 primary crossings · ≈${coverage.areaKm2.toFixed(0)} km² area`, badge: '9 SIGNALS' },
    { value: '5', label: '5×5 City Grid', sub: `25 real intersections · ≈${(coverage.areaKm2 * 1.8).toFixed(0)} km² area`, badge: '25 SIGNALS' },
    { value: '9', label: '9×9 Metro Grid', sub: `81 real intersections · ≈${(coverage.areaKm2 * 3.6).toFixed(0)} km² area`, badge: '81 SIGNALS' },
  ], [coverage]);

  // Leaflet Map Initialization
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const L = require('leaflet');

    if (!leafletMapRef.current && mapContainerRef.current) {
      const map = L.map(mapContainerRef.current, {
        center: currentCity.center,
        zoom: currentCity.zoom,
        zoomControl: true,
        maxZoom: 18,
      });
      map.attributionControl.setPrefix(false);
      leafletMapRef.current = map;
    }

    const map = leafletMapRef.current;
    if (!map) return;

    // Clear old layers
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    polylinesRef.current.forEach(p => p.remove());
    polylinesRef.current = [];
    flowLinesRef.current.forEach(f => f.remove());
    flowLinesRef.current = [];

    // Draw Continuous Cars Flow lines along corridors
    if (showGridOverlay) {
      const isSwarm = activeMode === 'swarm';
      edges.forEach(([i, k]) => {
        const j1 = currentJunctions[i];
        const j2 = currentJunctions[k];
        if (!j1 || !j2) return;

        // Base corridor road
        const roadLine = L.polyline([[j1.lat, j1.lon], [j2.lat, j2.lon]], {
          color: isSwarm ? '#0284c7' : '#475569',
          weight: isSwarm ? 3.5 : 2,
          opacity: isSwarm ? 0.6 : 0.4,
        }).addTo(map);
        polylinesRef.current.push(roadLine);

        // Animated continuous flow pulse line
        if (showFlowAnimation && isSwarm) {
          const flowLine = L.polyline([[j1.lat, j1.lon], [j2.lat, j2.lon]], {
            color: '#38bdf8',
            weight: 3,
            className: 'continuous-car-flow-line',
            opacity: 0.95,
          }).addTo(map);
          flowLinesRef.current.push(flowLine);
        }
      });
    }

    // Add Interactive Signal Markers with Rich Hover Tooltip
    const compact = gridSize >= 9;
    currentJunctions.forEach(j => {
      const isSelected = selectedJunction?.id === j.id;
      const showTag = gridSize === 3 || isSelected;

      const markerHtml = `
        <div class="gzb-marker-wrap ${isSelected ? 'active' : ''} ${compact ? 'compact' : ''}">
          <div class="marker-pulse" style="background: ${j.phaseColor};"></div>
          <div class="marker-core" style="border-color: ${j.phaseColor};">
            <span class="marker-queue">${j.liveQueue}</span>
          </div>
          ${showTag ? `<span class="marker-tag">${j.name.split('/')[0].split('·')[0].trim()}</span>` : ''}
        </div>
      `;

      const customIcon = L.divIcon({
        className: 'custom-leaflet-marker',
        html: markerHtml,
        iconSize: compact ? [24, 24] : [36, 36],
        iconAnchor: compact ? [12, 12] : [18, 18],
      });

      const marker = L.marker([j.lat, j.lon], { icon: customIcon }).addTo(map);

      // Rich Hover Card Tooltip (User requirement: Hovering shows full place name, cars passing, lanes, time saved, fuel, queue)
      const tooltipHtml = `
        <div class="signal-hover-card">
          <div class="hover-title">${j.name}</div>
          <div class="hover-place">📍 ${currentCity.name}, ${currentCity.region}</div>
          <div class="hover-flow-status">
            ${activeMode === 'swarm' ? '🟢 Continuous Green Wave Flow' : '🔴 Traditional Fixed Interval'}
          </div>
          <div class="hover-grid-stats">
            <div><b>Cars Passing:</b> <span class="stat-val-green">${j.carsPerMin} veh/min</span></div>
            <div><b>Total Lanes:</b> <span class="stat-val-cyan">${j.lanes || 6} Lanes</span></div>
            <div><b>Time Saved:</b> <span class="stat-val-green">${activeMode === 'swarm' ? `${j.timeSavedSec}s / veh` : '0s (Base)'}</span></div>
            <div><b>Fuel Saved:</b> <span class="stat-val-purple">${activeMode === 'swarm' ? `${j.fuelSavedPct}% (Zero Idling)` : '0%'}</span></div>
            <div><b>Queue:</b> <span class="stat-val-green">${j.liveQueue} veh</span> <span class="stat-val-muted">(${j.baseQueue} traditional)</span></div>
            <div><b>Signal Phase:</b> <span style="color: ${j.phaseColor}; font-weight: 600;">${j.phaseName}</span></div>
          </div>
        </div>
      `;

      marker.bindTooltip(tooltipHtml, {
        direction: 'top',
        className: 'rich-signal-tooltip',
        offset: [0, -16],
        opacity: 0.98
      });

      marker.on('click', () => {
        setSelectedJunctionId(j.id);
      });

      markersRef.current.push(marker);
    });
  }, [currentJunctions, showGridOverlay, showFlowAnimation, activeMode, selectedJunction, gridSize, edges, currentCity]);

  // Basemap tile layer switcher
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;
    const L = require('leaflet');
    tileLayersRef.current.forEach(t => t.remove());
    tileLayersRef.current = MAP_VIEWS[mapView].layers.map(({ url, ...opts }) =>
      L.tileLayer(url, { maxZoom: 18, ...opts }).addTo(map)
    );
  }, [mapView]);

  // Fly to new city when city or custom location changes
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map || !currentCity) return;
    const L = require('leaflet');
    map.flyTo(currentCity.center, currentCity.zoom, { duration: 1.2 });
    coverageLayerRef.current?.remove();
    if (coverage.hull && coverage.hull.length > 2) {
      coverageLayerRef.current = L.polygon(coverage.hull, {
        color: '#38bdf8',
        weight: 2,
        dashArray: '8, 6',
        fillColor: '#38bdf8',
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(map);
    }
  }, [currentCity, coverage]);

  // Aggregate stats across current grid
  const aggregates = useMemo(() => {
    const totalQueue = currentJunctions.reduce((acc, j) => acc + j.liveQueue, 0);
    const avgDelay = currentJunctions.reduce((acc, j) => acc + j.liveDelay, 0) / (currentJunctions.length || 1);
    const baseTotalQueue = rawJunctions.reduce((acc, j) => acc + j.baseQueue, 0);
    const baseAvgDelay = rawJunctions.reduce((acc, j) => acc + j.baseDelay, 0) / (rawJunctions.length || 1);

    const delaySavedPct = Math.max(0, ((baseAvgDelay - avgDelay) / baseAvgDelay) * 100);
    const queueSavedPct = Math.max(0, ((baseTotalQueue - totalQueue) / baseTotalQueue) * 100);

    const scale = rawJunctions.length / 9;
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
  }, [currentJunctions, activeMode, rawJunctions]);

  return (
    <div className="gzb-command-center" style={{ maxWidth: 1440, margin: '0 auto', padding: '16px 20px' }}>
      {/* Top Header & City Selection Toolbar */}
      <section className="panel gzb-header-panel" style={{ position: 'relative', zIndex: 50, marginBottom: 16 }}>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 14, justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 340px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="badge live" style={{ background: '#10b981', color: '#022c22' }}>
                ● {currentCity.name.toUpperCase()} LIVE CONTINUOUS TRAFFIC
              </span>
              <span className="status" style={{ fontSize: 11, background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8' }}>
                OpenStreetMap Real-World Corridors
              </span>
            </div>
            <h2 style={{ marginTop: 6, marginBottom: 4, fontSize: '1.5rem', color: '#f1f5f9' }}>
              Real-Time Smart City Traffic Map & Continuous Vehicle Flow
            </h2>
            <p className="muted small" style={{ margin: 0 }}>
              Hover over any intersection to view live cars passing, total lanes, time saved, fuel waste eliminated, and continuous flow.
            </p>
          </div>

          {/* City Selector, Grid Size & Search */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', flex: '1 1 540px', justifyContent: 'flex-end' }}>
            <div style={{ flex: '1 1 200px', minWidth: 180, maxWidth: 260 }}>
              <RichDropdown
                options={cityDropdownOptions}
                items={cityDropdownOptions}
                value={customLocation ? 'custom' : selectedCityId}
                onChange={val => {
                  setCustomLocation(null);
                  setSelectedCityId(val);
                }}
                icon={MapPin}
                label="Select Place"
                searchable
              />
            </div>

            <div style={{ flex: '1 1 180px', minWidth: 170, maxWidth: 240 }}>
              <RichDropdown
                options={gridDropdownOptions}
                items={gridDropdownOptions}
                value={String(gridSize)}
                onChange={val => setGridSize(Number(val))}
                icon={Grid3x3}
                label="Grid Layout"
              />
            </div>

            <div style={{ flex: '1 1 180px', minWidth: 170, maxWidth: 240 }}>
              <RichDropdown
                options={MAP_VIEW_OPTIONS}
                items={MAP_VIEW_OPTIONS}
                value={mapView}
                onChange={setMapView}
                icon={MapIcon}
                label="Map Style"
              />
            </div>
          </div>
        </div>

        {/* Free Dynamic Search for ANY Indian / Global Location */}
        <form onSubmit={handleSearchLocation} style={{ marginTop: 14, display: 'flex', gap: 10 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={16} style={{ position: 'absolute', left: 12, top: 11, color: '#94a3b8' }} />
            <input
              type="text"
              placeholder="Search any place in India (e.g. Pune, Connaught Place Delhi, Silk Board Bengaluru, Jaipur, Lucknow)..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                padding: '9px 12px 9px 36px',
                borderRadius: 8,
                background: 'rgba(15, 23, 42, 0.8)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                color: '#f8fafc',
                fontSize: '0.88rem'
              }}
            />
          </div>
          <button
            type="submit"
            disabled={isSearching}
            style={{
              padding: '9px 18px',
              borderRadius: 8,
              background: '#0284c7',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.88rem',
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <Navigation size={14} />
            {isSearching ? 'Locating…' : 'Locate Place'}
          </button>
        </form>
      </section>

      {/* Main Map Container */}
      <div style={{ position: 'relative', zIndex: 1, isolation: 'isolate', borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)', height: 580, marginBottom: 16 }}>
        <div ref={mapContainerRef} style={{ width: '100%', height: '100%', background: '#090e18' }} />

        {/* Floating Top Controls Overlay */}
        <div style={{
          position: 'absolute',
          top: 16,
          left: 16,
          zIndex: 1000,
          background: 'rgba(15, 23, 42, 0.92)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 8,
          padding: '8px 12px',
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          backdropFilter: 'blur(8px)'
        }}>
          <button
            onClick={() => setActiveMode(m => m === 'swarm' ? 'baseline' : 'swarm')}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              background: activeMode === 'swarm' ? '#10b981' : '#ef4444',
              color: activeMode === 'swarm' ? '#022c22' : '#fef2f2',
              fontWeight: 700,
              fontSize: '0.8rem',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <Zap size={14} />
            {activeMode === 'swarm' ? 'Swarm Intelligence ON' : 'Fixed Baseline Mode'}
          </button>

          <label style={{ fontSize: '0.8rem', color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showFlowAnimation}
              onChange={e => setShowFlowAnimation(e.target.checked)}
            />
            Continuous Cars Flow Pulse
          </label>

          <label style={{ fontSize: '0.8rem', color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showGridOverlay}
              onChange={e => setShowGridOverlay(e.target.checked)}
            />
            Corridor Links
          </label>
        </div>

        {/* Floating Bottom Status Pill */}
        <div style={{
          position: 'absolute',
          bottom: 16,
          left: 16,
          right: 16,
          zIndex: 1000,
          background: 'rgba(15, 23, 42, 0.94)',
          border: '1px solid rgba(56, 189, 248, 0.3)',
          borderRadius: 10,
          padding: '12px 18px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
          backdropFilter: 'blur(10px)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#10b981', animation: 'markerPulseAnim 1.5s infinite' }} />
            <div>
              <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#f8fafc' }}>
                {selectedJunction ? `${selectedJunction.name} · ${currentCity.name}` : `${currentCity.name} Intersections`}
              </div>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                {selectedJunction?.corridor} · {selectedJunction?.lanes || 6} Traffic Lanes
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: '0.82rem' }}>
            <div>
              <span style={{ color: '#94a3b8' }}>Cars Passing: </span>
              <b style={{ color: '#10b981' }}>{selectedJunction?.carsPerMin || 38} veh/min</b>
            </div>
            <div>
              <span style={{ color: '#94a3b8' }}>Vehicles Queued: </span>
              <b style={{ color: '#38bdf8' }}>{selectedJunction?.liveQueue} veh</b>
            </div>
            <div>
              <span style={{ color: '#94a3b8' }}>Time Saved: </span>
              <b style={{ color: '#10b981' }}>{selectedJunction?.timeSavedSec || 45}s / veh</b>
            </div>
            <div>
              <span style={{ color: '#94a3b8' }}>Fuel Saved: </span>
              <b style={{ color: '#a855f7' }}>{selectedJunction?.fuelSavedPct || 19.5}% (No Idling)</b>
            </div>
          </div>
        </div>
      </div>

      {/* Fuel Saved & Real-Time Impact Component */}
      <FuelSavedCard
        baselineFuelMg={aggregates.baseFuelMg}
        swarmFuelMg={aggregates.swarmFuelMg}
        baselineCo2Mg={aggregates.baseCo2Mg}
        swarmCo2Mg={aggregates.swarmCo2Mg}
        delayReductionPct={aggregates.delaySavedPct}
        title={`Live Ecological & Fuel Telemetry: ${currentCity.name}`}
      />
    </div>
  );
}
