'use client';

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import 'leaflet/dist/leaflet.css';
import {
  MapPin,
  Zap,
  Timer,
  Play,
  Pause,
  Grid3x3,
  Map as MapIcon,
  Search,
  Navigation,
  Siren,
  BookOpen,
  Radio,
} from 'lucide-react';
import RichDropdown from '@/components/RichDropdown';
import SwarmTerminal from '@/components/SwarmTerminal';
import SwarmImpactPanel from '@/components/SwarmImpactPanel';
import SwarmExplainerModal from '@/components/SwarmExplainerModal';
import { SUPPORTED_CITIES, generateCityGrid } from '@/lib/cityData';
import { LookaheadDemo, SWARM, FIXED, FUEL, shortName } from '@/lib/swarmMesh';

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

const WARMUP_S = 90;          // simulated seconds run before the first frame so the map starts populated
const SPEEDS = [1, 2, 4];
const PHASE_COLOR = { G: '#10b981', Y: '#f59e0b', R: '#f43f5e' };
const DECISION_TEXT = {
  platoon_hold: 'Holding green for announced platoon',
  empty_green: 'Dead green eliminated',
  preempt_platoon: 'Pre-emptive switch for platoon',
  pressure: 'Queue pressure (ACO-weighted)',
  max_green: 'Max green reached',
  anti_starvation: 'Anti-starvation release',
  min_green: 'Minimum green (safety)',
  rest_in_green: 'Resting in green (no demand)',
  hold: 'Serving current queue',
  emergency_corridor: 'Emergency corridor lock',
};

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

// Mesh edges: row/column neighbours when every junction has its own grid cell, otherwise the 3 nearest
function gridEdges(junctions) {
  const edges = new Set();
  const lattice = new Set(junctions.map(j => `${j.gridRow},${j.gridCol}`)).size === junctions.length;
  junctions.forEach((a, i) => {
    if (lattice) {
      junctions.forEach((b, k) => {
        if (k > i && Math.abs(a.gridRow - b.gridRow) + Math.abs(a.gridCol - b.gridCol) === 1) edges.add(`${i}-${k}`);
      });
      return;
    }
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

const markerShell = name => `
  <div class="gzb-marker-wrap">
    <div class="marker-pulse"></div>
    <div class="marker-core"><span class="marker-queue">0</span></div>
    <span class="marker-tag">${esc(shortName(name))}</span>
    <span class="marker-incoming"></span>
  </div>`;

export default function GhaziabadLiveMap() {
  const mapContainerRef = useRef(null);
  const fxCanvasRef = useRef(null);
  const leafletMapRef = useRef(null);
  const markersRef = useRef([]);
  const roadsRef = useRef([]);
  const routeLayersRef = useRef([]);
  const tileLayersRef = useRef([]);
  const coverageLayerRef = useRef(null);
  const packetsRef = useRef([]);
  const lastStepRef = useRef(0);
  const tooltipRef = useRef(() => '');

  const [mapReady, setMapReady] = useState(false);
  const [selectedCityId, setSelectedCityId] = useState('ghaziabad');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [customLocation, setCustomLocation] = useState(null);
  const [gridSize, setGridSize] = useState(3);
  const [mapView, setMapView] = useState('dark');
  const [activeMode, setActiveMode] = useState(SWARM);
  const [showLinks, setShowLinks] = useState(true);
  const [showFlow, setShowFlow] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState(2);
  const [, setTick] = useState(0);
  const [explainerOpen, setExplainerOpen] = useState(false);
  const [emRoute, setEmRoute] = useState(null);

  const currentCity = useMemo(() => {
    if (customLocation) return customLocation;
    return SUPPORTED_CITIES.find(c => c.id === selectedCityId) || SUPPORTED_CITIES[0];
  }, [selectedCityId, customLocation]);

  // Junction grid for the active city; a searched place gets the Ghaziabad lattice re-centred on it
  const rawJunctions = useMemo(() => {
    const base = generateCityGrid(customLocation ? 'ghaziabad' : currentCity.id, gridSize);
    if (!customLocation) return base;
    const cLat = base.reduce((s, j) => s + j.lat, 0) / base.length;
    const cLon = base.reduce((s, j) => s + j.lon, 0) / base.length;
    return base.map(j => ({
      ...j,
      id: `${customLocation.id}-${j.gridRow + 1}-${j.gridCol + 1}`,
      name: `${customLocation.name} · R${j.gridRow + 1}C${j.gridCol + 1}`,
      corridor: customLocation.region,
      lat: j.lat - cLat + customLocation.center[0],
      lon: j.lon - cLon + customLocation.center[1],
    }));
  }, [currentCity, gridSize, customLocation]);

  const coverage = useMemo(() => gridCoverage(rawJunctions), [rawJunctions]);
  const edges = useMemo(() => gridEdges(rawJunctions), [rawJunctions]);

  // The agent mesh: swarm + static-timer copies stepped together on identical demand
  const demo = useMemo(() => {
    const d = new LookaheadDemo(rawJunctions, edges);
    d.step(WARMUP_S);
    d.drainPackets();
    return d;
  }, [rawJunctions, edges]);

  useEffect(() => {
    packetsRef.current = [];
    setEmRoute(null);
    setSelectedIdx(demo.demand.hero);
  }, [demo]);

  // Simulation clock: one simulated second per step
  useEffect(() => {
    if (!isPlaying) return undefined;
    const stepMs = 1000 / speed;
    const durMs = Math.max(700, 1500 / Math.sqrt(speed));
    const id = setInterval(() => {
      demo.step(1);
      const nowMs = performance.now();
      lastStepRef.current = nowMs;
      demo.drainPackets().forEach(p => {
        packetsRef.current.push({ ...p, startMs: nowMs + Math.max(0, p.sentAt - demo.t) * stepMs, durMs });
      });
      setTick(t => t + 1);
    }, stepMs);
    return () => clearInterval(id);
  }, [demo, isPlaying, speed]);

  // Leaflet map (created once)
  useEffect(() => {
    const L = require('leaflet');
    const map = L.map(mapContainerRef.current, { center: currentCity.center, zoom: currentCity.zoom, zoomControl: true, maxZoom: 18 });
    map.attributionControl.setPrefix(false);
    leafletMapRef.current = map;
    setMapReady(true);
    return () => {
      map.remove();
      leafletMapRef.current = null;
      setMapReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Basemap tile layer switcher
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;
    const L = require('leaflet');
    tileLayersRef.current.forEach(t => t.remove());
    tileLayersRef.current = MAP_VIEWS[mapView].layers.map(({ url, ...opts }) =>
      L.tileLayer(url, { maxZoom: 18, ...opts }).addTo(map)
    );
  }, [mapView, mapReady]);

  // Fly to new city when city or custom location changes
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map || !currentCity) return;
    const L = require('leaflet');
    // Fit the grid, leaving room for the floating terminal (top-right) and status pill (bottom) on desktop
    const wide = window.matchMedia('(min-width: 901px)').matches;
    map.flyToBounds(L.latLngBounds(rawJunctions.map(j => [j.lat, j.lon])), {
      paddingTopLeft: [50, 50],
      paddingBottomRight: wide ? [420, 110] : [30, 30],
      duration: 1.2,
      maxZoom: 15,
    });
    coverageLayerRef.current?.remove();
    if (coverage.hull && coverage.hull.length > 2) {
      coverageLayerRef.current = L.polygon(coverage.hull, {
        color: '#38bdf8',
        weight: 2,
        dashArray: '8, 6',
        fillColor: '#38bdf8',
        fillOpacity: 0.06,
        interactive: false,
      }).addTo(map);
    }
  }, [rawJunctions, coverage, mapReady]);

  // Corridor roads
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;
    const L = require('leaflet');
    roadsRef.current.forEach(p => p.remove());
    roadsRef.current = [];
    if (!showLinks) return;
    const isSwarm = activeMode === SWARM;
    edges.forEach(([i, k]) => {
      const a = rawJunctions[i];
      const b = rawJunctions[k];
      roadsRef.current.push(L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
        color: isSwarm ? '#0284c7' : '#64748b', weight: isSwarm ? 5 : 4, opacity: isSwarm ? 0.55 : 0.45, interactive: false,
      }).addTo(map));
    });
  }, [edges, rawJunctions, showLinks, activeMode, mapReady]);

  // Signal markers (created per grid; updated in place every step)
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;
    const L = require('leaflet');
    markersRef.current.forEach(m => m.remove());
    const compact = gridSize >= 9;
    markersRef.current = rawJunctions.map((j, i) => {
      const icon = L.divIcon({
        className: 'custom-leaflet-marker',
        html: markerShell(j.name),
        iconSize: compact ? [24, 24] : [36, 36],
        iconAnchor: compact ? [12, 12] : [18, 18],
      });
      const marker = L.marker([j.lat, j.lon], { icon, riseOnHover: true }).addTo(map);
      marker.bindTooltip('', { direction: 'top', className: 'rich-signal-tooltip', offset: [0, -16], opacity: 0.98 });
      marker.on('tooltipopen', () => marker.setTooltipContent(tooltipRef.current(i)));
      marker.on('click', () => setSelectedIdx(i));
      return marker;
    });
  }, [rawJunctions, gridSize, mapReady]);

  // Emergency corridor highlight
  useEffect(() => {
    const map = leafletMapRef.current;
    routeLayersRef.current.forEach(l => l.remove());
    routeLayersRef.current = [];
    if (!map || !emRoute) return;
    const L = require('leaflet');
    const pts = emRoute.map(i => [demo.junctions[i].lat, demo.junctions[i].lon]);
    routeLayersRef.current = [
      L.polyline(pts, { color: '#ef4444', weight: 16, opacity: 0.35, className: 'em-route-glow', interactive: false }).addTo(map),
      L.polyline(pts, { color: '#ffffff', weight: 3, opacity: 0.95, dashArray: '10 10', className: 'em-route-dash', interactive: false }).addTo(map),
    ];
  }, [emRoute, demo, mapReady]);

  const isSwarm = activeMode === SWARM;
  const otherMode = isSwarm ? FIXED : SWARM;

  const buildTooltip = useCallback(i => {
    const j = rawJunctions[i];
    if (!j) return '';
    const v = demo.junctionView(activeMode, i);
    const o = demo.junctionView(otherMode, i);
    const inc = v.incoming[0];
    const lg = a => (v.lastGreen[a] == null ? '—' : `${v.lastGreen[a]}s`);
    const rupees = v.fuelSaved * FUEL.inr_per_l;
    return `
      <div class="signal-hover-card">
        <div class="hover-title">${esc(j.name)}</div>
        <div class="hover-place">📍 ${esc(currentCity.name)}${currentCity.region ? `, ${esc(currentCity.region)}` : ''}</div>
        <div class="hover-flow-status">${isSwarm ? '🟢 Swarm JunctionAgent · ' + esc(DECISION_TEXT[v.decision] || 'Observing') : '🔴 Traditional static 30 s timer'}</div>
        ${v.lock ? `<div class="hover-emergency">🚑 Emergency lock: holding ${v.lock} green</div>` : ''}
        <div class="hover-grid-stats">
          <div><b>Cars passing:</b> <span class="stat-val-green">${v.carsPerMin} veh/min</span></div>
          <div><b>Queue:</b> <span class="stat-val-cyan">${v.queue} veh</span> <span class="stat-val-muted">(NS ${v.queueNS} · EW ${v.queueEW}; ${o.queue} under ${isSwarm ? 'static timer' : 'swarm'})</span></div>
          <div><b>Signal:</b> <span style="color:${PHASE_COLOR[v.state]};font-weight:600">${v.phase}</span>${v.state === 'G' ? ` <span class="stat-val-muted">· ${v.greenElapsed}s</span>` : ''}</div>
          <div><b>Green allocation:</b> ${isSwarm
            ? `<span class="stat-val-green">dynamic NS ${lg('NS')} / EW ${lg('EW')}</span> <span class="stat-val-muted">vs static 30s / 30s</span>`
            : '<span class="stat-val-muted">static 30s / 30s, every cycle</span>'}</div>
          <div><b>Incoming platoon:</b> ${isSwarm
            ? (inc ? `<span class="stat-val-cyan">${inc.size} veh arriving in ${inc.eta}s from ${esc(inc.from)}</span>` : '<span class="stat-val-muted">none announced</span>')
            : '<span class="stat-val-muted">no inter-junction communication</span>'}</div>
          <div><b>Fuel saved here:</b> <span class="stat-val-purple">${v.fuelSaved.toFixed(3)} L · ₹${rupees.toFixed(1)}</span> <span class="stat-val-muted">(measured vs static)</span></div>
          ${isSwarm ? `<div><b>Pheromone τ:</b> <span class="stat-val-muted">NS ${v.tau.NS.toFixed(2)} · EW ${v.tau.EW.toFixed(2)}</span></div>` : ''}
        </div>
      </div>`;
  }, [demo, rawJunctions, activeMode, otherMode, isSwarm, currentCity]);
  tooltipRef.current = buildTooltip;

  // Per-step marker refresh (in place, so CSS pulses keep running)
  useEffect(() => {
    markersRef.current.forEach((marker, i) => {
      const el = marker.getElement();
      if (!el || i >= demo.junctions.length) return;
      const v = demo.junctionView(activeMode, i);
      const color = PHASE_COLOR[v.state];
      const wrap = el.querySelector('.gzb-marker-wrap');
      wrap.classList.toggle('active', i === selectedIdx);
      wrap.classList.toggle('compact', gridSize >= 9);
      wrap.classList.toggle('em-lock', isSwarm && !!v.lock);
      el.querySelector('.marker-pulse').style.background = color;
      el.querySelector('.marker-core').style.borderColor = color;
      el.querySelector('.marker-queue').textContent = v.queue;
      el.querySelector('.marker-tag').classList.toggle('hide', !(gridSize === 3 || i === selectedIdx));
      const inc = isSwarm && v.incoming[0] && v.incoming[0].size >= 3 ? v.incoming[0] : null;
      const badge = el.querySelector('.marker-incoming');
      badge.textContent = inc ? `▲${inc.size} · ${inc.eta}s` : '';
      badge.classList.toggle('show', !!inc && gridSize < 9);
      if (marker.isTooltipOpen()) marker.setTooltipContent(buildTooltip(i));
    });
  });

  // Animated layer: vehicles on links, inter-agent packets and the ambulance (canvas over the map)
  useEffect(() => {
    let raf = 0;
    const stepMs = 1000 / speed;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = fxCanvasRef.current;
      const map = leafletMapRef.current;
      if (!cv || !map) return;
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const nowMs = performance.now();
      const frac = isPlaying ? Math.min(1, (nowMs - lastStepRef.current) / stepMs) : 0;
      const P = demo.junctions.map(j => map.latLngToContainerPoint([j.lat, j.lon]));
      const along = (a, b, f, side) => {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        return { x: a.x + dx * f - (dy / len) * side, y: a.y + dy * f + (dx / len) * side, ux: dx / len, uy: dy / len };
      };

      if (showFlow) {
        ctx.fillStyle = '#fbbf24';
        demo.transitGroups(activeMode, frac).forEach(g => {
          const p = along(P[g.from], P[g.to], g.frac, 5);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.2 + Math.min(4, Math.sqrt(g.count) * 1.1), 0, Math.PI * 2);
          ctx.fill();
        });
      }

      packetsRef.current = packetsRef.current.filter(p => nowMs < p.startMs + p.durMs);
      if (showFlow && isSwarm) {
        packetsRef.current.forEach(p => {
          if (nowMs < p.startMs) return;
          const t = (nowMs - p.startMs) / p.durMs;
          const f = 1 - (1 - t) * (1 - t);
          const em = p.kind === 'emergency';
          const pos = along(P[p.from], P[p.to], f, em ? 0 : 5);
          const trail = ctx.createLinearGradient(pos.x - pos.ux * 34, pos.y - pos.uy * 34, pos.x, pos.y);
          trail.addColorStop(0, 'rgba(34,211,238,0)');
          trail.addColorStop(1, em ? 'rgba(248,113,113,0.9)' : 'rgba(34,211,238,0.9)');
          ctx.strokeStyle = trail;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(pos.x - pos.ux * 34, pos.y - pos.uy * 34);
          ctx.lineTo(pos.x, pos.y);
          ctx.stroke();
          ctx.shadowColor = em ? '#ef4444' : '#22d3ee';
          ctx.shadowBlur = 14;
          ctx.fillStyle = em ? (Math.floor(nowMs / 150) % 2 ? '#ffffff' : '#ef4444') : '#a5f3fc';
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, em ? 5.5 : 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          if (!em && p.size >= 3) {
            ctx.font = '600 10px "JetBrains Mono", monospace';
            ctx.fillStyle = '#cffafe';
            ctx.fillText(`${p.size}`, pos.x + 7, pos.y - 6);
          }
        });
      }

      const amb = demo.ambulancePosition(activeMode, frac);
      if (amb) {
        const p = map.latLngToContainerPoint([amb.lat, amb.lon]);
        const pulse = 11 + 4 * Math.sin(nowMs / 160);
        ctx.strokeStyle = 'rgba(239,68,68,0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = Math.floor(nowMs / 250) % 2 ? '#ef4444' : '#ffffff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🚑', p.x, p.y - 14);
        if (amb.waiting) {
          ctx.font = '700 10px "JetBrains Mono", monospace';
          ctx.fillStyle = '#fca5a5';
          ctx.fillText(`STOPPED AT RED · ${amb.delay}s`, p.x, p.y + 24);
        }
        ctx.textAlign = 'start';
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [demo, activeMode, isSwarm, showFlow, isPlaying, speed]);

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
        setCustomLocation({
          id: 'custom-' + Date.now(),
          name: place.display_name.split(',')[0],
          region: place.display_name.split(',').slice(1, 3).join(',').trim(),
          center: [parseFloat(place.lat), parseFloat(place.lon)],
          zoom: 13,
          description: `Live Real-World Intersection Grid: ${place.display_name}`,
        });
      }
    } catch (err) {
      console.warn('Location search failed:', err);
    } finally {
      setIsSearching(false);
    }
  };

  const cityDropdownOptions = useMemo(() => SUPPORTED_CITIES.map(c => ({
    value: c.id,
    label: c.name,
    sub: c.region,
    badge: c.id.toUpperCase(),
  })), []);

  const gridDropdownOptions = useMemo(() => [
    { value: '3', label: '3×3 Core Corridors', sub: '9 primary crossings', badge: '9 SIGNALS' },
    { value: '5', label: '5×5 City Grid', sub: '25 intersections', badge: '25 SIGNALS' },
    { value: '9', label: '9×9 Metro Grid', sub: '81 intersections', badge: '81 SIGNALS' },
  ], []);

  const triggerEmergency = () => {
    const route = demo.triggerEmergency();
    if (route) {
      setEmRoute(route.slice());
      setActiveMode(SWARM);
    }
  };

  // Live values for this render (re-rendered once per simulated second)
  const fuel = demo.fuel();
  const em = demo.emergency();
  const emActive = demo.emergencyActive();
  const sel = Math.min(selectedIdx, rawJunctions.length - 1);
  const selJ = rawJunctions[sel];
  const selV = demo.junctionView(activeMode, sel);
  const messages = demo.meshes[SWARM].messages.slice(-150);
  const queueTotal = demo.meshes[activeMode].queueTotal();
  const queueOther = demo.meshes[otherMode].queueTotal();

  useEffect(() => {
    if (emRoute && em && em.swarm.done && em.fixed.done) setEmRoute(null);
  }, [emRoute, em]);

  return (
    <div className="gzb-command-center" style={{ maxWidth: 1440, margin: '0 auto', padding: '16px 20px' }}>
      {/* Top Header & City Selection Toolbar */}
      <section className="panel gzb-header-panel" style={{ position: 'relative', zIndex: 50, marginBottom: 16 }}>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 14, justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 340px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span className="badge live" style={{ background: '#10b981', color: '#022c22' }}>
                ● {currentCity.name.toUpperCase()} LIVE AGENT MESH
              </span>
              <span className="status" style={{ fontSize: 11, background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8' }}>
                {rawJunctions.length} autonomous JunctionAgents
              </span>
              <button className="explainer-open-btn" onClick={() => setExplainerOpen(true)}>
                <BookOpen size={14} /> How Swarm Intelligence Works
              </button>
            </div>
            <h2 style={{ marginTop: 6, marginBottom: 4, fontSize: '1.5rem', color: '#f1f5f9' }}>
              Predictive green waves: junctions that talk before the traffic arrives
            </h2>
            <p className="muted small" style={{ margin: 0 }}>
              Cyan pulses are platoon alerts racing ahead of the vehicles (amber). Hover a signal for its live flow, incoming platoon countdown,
              dynamic green time and fuel saved.
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
        <form onSubmit={handleSearchLocation} className="gzb-search-row">
          <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <Search size={16} style={{ position: 'absolute', left: 12, top: 11, color: '#94a3b8' }} />
            <input
              type="text"
              placeholder="Search any place (e.g. Pune, Connaught Place Delhi, Silk Board Bengaluru)…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="gzb-search-input"
            />
          </div>
          <button type="submit" disabled={isSearching} className="gzb-search-btn">
            <Navigation size={14} />
            {isSearching ? 'Locating…' : 'Locate Place'}
          </button>
        </form>
      </section>

      {/* Comparison toggle, emergency trigger and simulation controls */}
      <div className="map-control-bar">
        <div className="mode-toggle" role="group" aria-label="Signal control mode">
          <button className={isSwarm ? 'on swarm' : ''} onClick={() => setActiveMode(SWARM)} aria-pressed={isSwarm}>
            <Zap size={14} /> Swarm Intelligence {isSwarm && <b>ON</b>}
          </button>
          <button className={!isSwarm ? 'on fixed' : ''} onClick={() => setActiveMode(FIXED)} aria-pressed={!isSwarm}>
            <Timer size={14} /> Traditional Fixed Timer (Static 30s)
          </button>
        </div>

        <button className="em-trigger" onClick={triggerEmergency} disabled={emActive}>
          <Siren size={15} />
          {emActive
            ? `Ambulance corridor active · swarm delay ${em.swarm.delay_s}s · static ${em.fixed.delay_s}s`
            : '🚑 Trigger Emergency Ambulance Corridor'}
        </button>

        <div className="sim-controls">
          <button onClick={() => setIsPlaying(p => !p)} aria-label={isPlaying ? 'Pause simulation' : 'Play simulation'}>
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
          {SPEEDS.map(s => (
            <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)} aria-pressed={speed === s}>{s}×</button>
          ))}
          <span className="sim-clock">T+{demo.t}s</span>
        </div>

        <div className="map-toggles">
          <label><input type="checkbox" checked={showFlow} onChange={e => setShowFlow(e.target.checked)} /> Packets &amp; vehicles</label>
          <label><input type="checkbox" checked={showLinks} onChange={e => setShowLinks(e.target.checked)} /> Corridor links</label>
        </div>
      </div>

      <div className="map-legend">
        <span><i style={{ background: '#a5f3fc', boxShadow: '0 0 8px #22d3ee' }} /> platoon alert packet</span>
        <span><i style={{ background: '#fbbf24' }} /> vehicles in transit</span>
        <span><i style={{ background: '#10b981' }} /> green</span>
        <span><i style={{ background: '#f59e0b' }} /> yellow</span>
        <span><i style={{ background: '#f43f5e' }} /> red / all-red</span>
        <span className="legend-q">network queue: <b style={{ color: isSwarm ? '#10b981' : '#f43f5e' }}>{queueTotal}</b> veh (other mode {queueOther})</span>
      </div>

      {/* Main Map Container */}
      <div className="gzb-map-wrap">
        <div ref={mapContainerRef} className="gzb-map-canvas" style={{ background: '#090e18' }} />
        <canvas ref={fxCanvasRef} className="map-fx-canvas" aria-hidden="true" />

        <SwarmTerminal messages={messages} selectedId={selJ?.id} mode={activeMode} />

        {/* Floating Bottom Status Pill */}
        {selJ && (
          <div className="gzb-status-pill">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <div style={{ width: 10, height: 10, flex: '0 0 auto', borderRadius: '50%', background: PHASE_COLOR[selV.state] }} />
              <div style={{ minWidth: 0 }}>
                <div className="pill-title">{selJ.name} · {currentCity.name}</div>
                <div className="pill-sub">
                  {selV.phase}{selV.state === 'G' ? ` · ${selV.greenElapsed}s` : ''} · {isSwarm ? (DECISION_TEXT[selV.decision] || 'Observing') : 'static 30 s plan'}
                </div>
              </div>
            </div>
            <div className="pill-stats">
              <div><span>Cars passing</span><b style={{ color: '#10b981' }}>{selV.carsPerMin} veh/min</b></div>
              <div><span>Queued</span><b style={{ color: '#38bdf8' }}>{selV.queue} veh</b></div>
              <div><span>Incoming</span><b style={{ color: '#22d3ee' }}>
                {isSwarm ? (selV.incoming[0] ? `${selV.incoming[0].size} veh in ${selV.incoming[0].eta}s` : '—') : 'no comms'}
              </b></div>
              <div><span>Fuel saved here</span><b style={{ color: '#a855f7' }}>{selV.fuelSaved.toFixed(3)} L</b></div>
            </div>
          </div>
        )}
      </div>

      <SwarmImpactPanel fuel={fuel} emergency={em} simSeconds={demo.t} cityName={currentCity.name} />

      <p className="muted small mesh-footnote">
        <Radio size={12} /> Same engine as <code>simulation/swarm/junction_mesh.py</code>, which the lab API serves at <code>/api/lab/swarm/mesh/*</code>. Both
        implementations give identical results. Link travel times are compressed to 10–28 s so platoons stay visible on screen.
      </p>

      <SwarmExplainerModal open={explainerOpen} onClose={() => setExplainerOpen(false)} />
    </div>
  );
}
