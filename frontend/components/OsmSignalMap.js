'use client';

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import 'leaflet/dist/leaflet.css';
import {
  MapPin,
  Zap,
  Timer,
  Play,
  Pause,
  Map as MapIcon,
  Search,
  Navigation,
  Siren,
  BookOpen,
  Radio,
  Crosshair,
  Download,
  RefreshCw,
  Ruler,
  ExternalLink,
  TrafficCone,
  FlaskConical,
  LocateFixed,
} from 'lucide-react';
import RichDropdown from '@/components/RichDropdown';
import SwarmTerminal from '@/components/SwarmTerminal';
import SwarmImpactPanel from '@/components/SwarmImpactPanel';
import SwarmExplainerModal from '@/components/SwarmExplainerModal';
import { useSections } from '@/components/SiteConfigProvider';
import { useThemeTokens } from '@/lib/themeClient';
import { SUPPORTED_CITIES } from '@/lib/cityData';
import { LookaheadDemo, SWARM, FIXED, FUEL, shortName } from '@/lib/swarmMesh';
import { lab } from '@/lib/api';
import {
  overpass, signalsQuery, extractQuery, extractSignalNetwork, toGeoJSON,
  bboxAround, bboxAreaKm2, bboxCenter, bboxKey, clampBbox, LIMITS,
  cacheGet, cachePut, trimOverpass, SNAPSHOT_RADIUS_M, nearbySignalsQuery, densestSignals,
  signalsOnlyQuery, extractSignalsOnly,
} from '@/lib/osmSignals';

const LAB_MAX_KM2 = 3.9;  // experiments/lab/osm_areas.py simulates at most 4 km^2 per area

const CANVAS_TOKENS = ['--status-warn', '--accent', '--accent-soft', '--danger-soft', '--signal-red', '--text-primary'];
const MAP_BASE_TOKEN = ['--map-base'];
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
    sub: 'Check signal positions against aerial imagery',
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

const RADIUS_OPTIONS = [
  { value: '750', label: '0.75 km radius', sub: '≈2 km² · fastest download', badge: 'S' },
  { value: '1500', label: '1.5 km radius', sub: '≈9 km² · a city centre', badge: 'M' },
  { value: '2250', label: '2.25 km radius', sub: '≈20 km² · several corridors', badge: 'L' },
  { value: '3000', label: '3 km radius', sub: `≈36 km² · maximum per scan`, badge: 'XL' },
];

const WARMUP_S = 90;          // simulated seconds run before the first frame so the map starts populated
const SPEEDS = [1, 2, 4];
const PHASE_COLOR = { G: 'var(--status-ok)', Y: 'var(--status-warn)', R: 'var(--status-danger)' };
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
// OSM signal tags worth showing on hover (key -> label)
const SIGNAL_TAGS = {
  traffic_signals: 'type',
  'traffic_signals:direction': 'direction',
  'traffic_signals:countdown': 'countdown timer',
  'traffic_signals:sound': 'audible',
  'traffic_signals:vibration': 'vibration',
  button_operated: 'push button',
  crossing: 'crossing',
  'traffic_signals:arrow': 'arrows',
};

// Overpass answers already loaded this session: key -> { osm, origin, savedAt } (newest last)
const RAW_CACHE = new Map();
const cacheRaw = (key, entry) => {
  RAW_CACHE.set(key, entry);
  while (RAW_CACHE.size > 6) RAW_CACHE.delete(RAW_CACHE.keys().next().value);
};
const IDB_KEY = key => `signals:v2:${key}`;
const ORIGIN_TEXT = { snapshot: 'bundled OSM snapshot', cache: 'saved on this device', live: 'live from OpenStreetMap' };

// Saved copies, fastest first: this session, the bundled snapshot of a quick-pick city, this device's cache
async function loadSaved({ key, presetId, radiusM, signal }) {
  if (RAW_CACHE.has(key)) return RAW_CACHE.get(key);
  if (presetId && radiusM === SNAPSHOT_RADIUS_M) {
    try {
      const res = await fetch(`/osm/${presetId}.json`, { signal });
      const snap = res.ok ? await res.json() : null;
      if (snap && snap.key === key) return { osm: snap.osm, origin: 'snapshot', savedAt: snap.savedAt };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
  }
  const hit = await cacheGet(IDB_KEY(key));
  return hit ? { osm: hit.osm, origin: 'cache', savedAt: hit.savedAt } : null;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const km = m => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m} m`);
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'area';

function roadLine(r) {
  const bits = [r.highway?.replace('_', ' ')];
  if (r.lanes) bits.push(`${r.lanes} lanes`);
  if (r.maxspeed) bits.push(`${r.maxspeed}${/^\d+$/.test(r.maxspeed) ? ' km/h' : ''}`);
  if (r.oneway) bits.push('one-way');
  return `${r.name || r.ref || 'unnamed road'} <span class="stat-val-muted">(${esc(bits.filter(Boolean).join(', '))})</span>`;
}

function signalTagSummary(signals) {
  const seen = new Map();
  signals.forEach(s => Object.keys(SIGNAL_TAGS).forEach(k => {
    if (s.tags[k]) {
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k).add(s.tags[k]);
    }
  }));
  return [...seen.entries()].map(([k, v]) => `${SIGNAL_TAGS[k]}: ${[...v].join(' / ')}`);
}

// Point at fraction f along a polyline of container points, offset sideways by `side` px
function along(pts, f, side) {
  if (pts.length < 2) return { x: pts[0].x, y: pts[0].y, ux: 1, uy: 0 };
  let total = 0;
  const seg = [];
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    seg.push(l);
    total += l;
  }
  let target = Math.max(0, Math.min(1, f)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] || i === seg.length - 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = seg[i] || 1;
      const t = Math.min(1, target / len);
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      return { x: a.x + (b.x - a.x) * t - uy * side, y: a.y + (b.y - a.y) * t + ux * side, ux, uy };
    }
    target -= seg[i];
  }
  return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, ux: 1, uy: 0 };
}

const markerShell = name => `
  <div class="gzb-marker-wrap">
    <div class="marker-pulse"></div>
    <div class="marker-core"><span class="marker-queue">0</span></div>
    <span class="marker-tag">${esc(shortName(name))}</span>
    <span class="marker-incoming"></span>
  </div>`;

function downloadBlob(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const presetArea = city => ({ id: city.id, name: city.name, region: city.region, center: city.center, source: 'preset' });

export default function OsmSignalMap() {
  const { on, moduleOn, sectionOn } = useSections('signal-map');
  const mapOn = on('map-canvas');
  const canSendToLab = on('send-to-lab') && sectionOn('live-lab', 'real-world-areas');
  const mapContainerRef = useRef(null);
  const fxCanvasRef = useRef(null);
  // Canvas cannot read var(): the draw loop reads resolved colors, so a theme change never restarts the simulation.
  const canvasColors = useThemeTokens(CANVAS_TOKENS);
  const canvasColorsRef = useRef(canvasColors);
  canvasColorsRef.current = canvasColors;
  const leafletMapRef = useRef(null);
  const markersRef = useRef([]);
  const headsLayerRef = useRef(null);
  const roadsRef = useRef([]);
  const routeLayersRef = useRef([]);
  const tileLayersRef = useRef([]);
  const areaLayerRef = useRef(null);
  const packetsRef = useRef([]);
  const lastStepRef = useRef(0);
  const tooltipRef = useRef(() => '');

  const [mapReady, setMapReady] = useState(false);
  const [area, setArea] = useState(() => presetArea(SUPPORTED_CITIES[0]));
  const [radiusM, setRadiusM] = useState(1500);
  const [includeCrossings, setIncludeCrossings] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const forceLiveRef = useRef(false);
  const [net, setNet] = useState({ status: 'idle' });
  const [loadSeconds, setLoadSeconds] = useState(0);
  const [retryInfo, setRetryInfo] = useState(null);
  const [download, setDownload] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  // The base map follows the theme until the visitor picks one.
  const [pickedView, setMapView] = useState(null);
  const mapBase = useThemeTokens(MAP_BASE_TOKEN)['--map-base'];
  const mapView = pickedView ?? (mapBase === 'light' ? 'street' : 'dark');
  const [activeMode, setActiveMode] = useState(SWARM);
  const [showLinks, setShowLinks] = useState(true);
  const [showFlow, setShowFlow] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState(2);
  const [, setTick] = useState(0);
  const [explainerOpen, setExplainerOpen] = useState(false);
  const [emRoute, setEmRoute] = useState(null);
  const [nearby, setNearby] = useState(null);
  const [labSend, setLabSend] = useState(null);
  const router = useRouter();

  // Shareable links: /ghaziabad?lat=28.63&lon=77.24&r=1500&name=ITO opens that exact area
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const lat = Number(q.get('lat'));
    const lon = Number(q.get('lon'));
    if (!q.has('lat') || !q.has('lon') || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return;
    const r = Number(q.get('r'));
    if (RADIUS_OPTIONS.some(o => Number(o.value) === r)) setRadiusM(r);
    setArea({ id: `link-${lat},${lon}`, name: (q.get('name') || 'Shared area').slice(0, 80), region: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, center: [lat, lon], source: 'search' });
  }, []);

  // Keep the address bar in step with the area, so the current view can be shared or bookmarked
  useEffect(() => {
    const [lat, lon] = area.center;
    const q = new URLSearchParams({ lat: lat.toFixed(5), lon: lon.toFixed(5), r: String(radiusM), name: area.name });
    window.history.replaceState(null, '', `${window.location.pathname}?${q}`);
  }, [area, radiusM]);

  // The scanned area: an explicit box (map view) or a radius around the chosen place
  const bbox = useMemo(
    () => area.bbox || bboxAround(area.center[0], area.center[1], radiusM),
    [area, radiusM],
  );
  const areaKey = bboxKey(bbox);
  const areaKm2 = bboxAreaKm2(bbox);

  // Real signals for the area, live from OpenStreetMap
  useEffect(() => {
    const ctrl = new AbortController();
    const started = Date.now();
    setNet({ status: 'loading', started });
    setLoadSeconds(0);
    setRetryInfo(null);
    const timer = setInterval(() => setLoadSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    const forceLive = forceLiveRef.current;
    forceLiveRef.current = false;
    const center = bboxCenter(bbox);
    const opts = { signal: ctrl.signal, onRetry: setRetryInfo };
    (async () => {
      try {
        const saved = forceLive ? null : await loadSaved({
          key: areaKey, presetId: area.source === 'preset' ? area.id : null, radiusM, signal: ctrl.signal,
        });
        if (saved) {
          cacheRaw(areaKey, saved);
          setNet({ status: 'ready', data: extractSignalNetwork(saved.osm, { center, includeCrossings }), origin: saved.origin, savedAt: saved.savedAt });
          return;
        }
        // Both queries start together. The signal-only one is tiny and usually returns first, so the real
        // lights appear while the roads (junction types, names, links) are still on their way.
        let partial = null;
        let full = false;
        const roadsCtrl = new AbortController();
        const lightsCtrl = new AbortController();
        ctrl.signal.addEventListener('abort', () => { roadsCtrl.abort(); lightsCtrl.abort(); }, { once: true });
        const lights = overpass(signalsOnlyQuery(bbox), { ...opts, signal: lightsCtrl.signal, timeoutMs: 90000 })
          .then(osm => {
            if (full) return;
            partial = extractSignalsOnly(osm, { center });
            setNet({ status: 'ready', data: partial, origin: 'live', stage: partial.junctions.length ? 'roads' : null });
            if (!partial.junctions.length) roadsCtrl.abort(); // nothing mapped here: the roads cannot add a light
          })
          .catch(() => {}); // the roads query still covers the lights; its failure is what gets reported
        try {
          const osm = trimOverpass(await overpass(signalsQuery(bbox), { ...opts, signal: roadsCtrl.signal }));
          full = true;
          lightsCtrl.abort();
          const entry = { osm, origin: 'live', savedAt: new Date().toISOString() };
          cacheRaw(areaKey, entry);
          cachePut(IDB_KEY(areaKey), { osm, savedAt: entry.savedAt });
          setNet({ status: 'ready', data: extractSignalNetwork(osm, { center, includeCrossings }), origin: 'live', savedAt: entry.savedAt });
        } catch (err) {
          if (ctrl.signal.aborted) throw err;
          await lights;
          if (partial && !partial.junctions.length) return; // already shown as "no lights mapped here"
          setNet(partial
            ? { status: 'ready', data: partial, origin: 'live', roadsError: err.message }
            : { status: 'error', error: err.message });
        }
      } catch (err) {
        if (err.name !== 'AbortError') setNet({ status: 'error', error: err.message });
      } finally {
        clearInterval(timer);
      }
    })();
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaKey, includeCrossings, reloadNonce]);

  const data = net.status === 'ready' ? net.data : null;

  // Few or no lights mapped here: look for the densest mapped signals within 15 km and offer a jump
  const sparse = data && data.junctions.length < 3;
  useEffect(() => {
    setNearby(null);
    if (!sparse) return undefined;
    const ctrl = new AbortController();
    const [lat, lon] = bboxCenter(bbox);
    setNearby({ status: 'searching' });
    overpass(nearbySignalsQuery(lat, lon), { signal: ctrl.signal, timeoutMs: 90000 })
      .then(res => {
        const spot = densestSignals((res.elements || []).filter(e => e.type === 'node'), { lat, lon });
        const better = spot && spot.count > (data.stats.signalNodes || 0) + 2 && spot.distM > 700;
        setNearby({ status: 'done', spot: better ? spot : null });
      })
      .catch(err => { if (err.name !== 'AbortError') setNearby(null); });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaKey, sparse]);
  const junctions = useMemo(() => (data ? data.junctions : []), [data]);
  const edges = useMemo(() => (data ? data.edges : []), [data]);

  // The agent mesh on the real junctions: swarm + static-timer copies stepped together on identical demand
  const demo = useMemo(() => {
    if (!junctions.length) return null;
    const d = new LookaheadDemo(junctions, edges);
    d.step(WARMUP_S);
    d.drainPackets();
    return d;
  }, [junctions, edges]);

  useEffect(() => {
    packetsRef.current = [];
    setEmRoute(null);
    setSelectedIdx(demo ? demo.demand.hero : 0);
  }, [demo]);

  // Simulation clock: one simulated second per step
  useEffect(() => {
    if (!isPlaying || !demo) return undefined;
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
    const map = L.map(mapContainerRef.current, { center: area.center, zoom: 14, zoomControl: true, maxZoom: 19 });
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
      L.tileLayer(url, { maxZoom: 19, ...opts }).addTo(map)
    );
  }, [mapView, mapReady]);

  // Scanned area frame; fly to it when the area changes
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;
    const L = require('leaflet');
    const bounds = L.latLngBounds([bbox.south, bbox.west], [bbox.north, bbox.east]);
    areaLayerRef.current?.remove();
    areaLayerRef.current = L.rectangle(bounds, {
      color: 'var(--accent)', weight: 1.5, dashArray: '8, 6', fill: true, fillColor: 'var(--accent)', fillOpacity: 0.03, interactive: false,
    }).addTo(map);
    if (area.source !== 'view') {
      const wide = window.matchMedia('(min-width: 901px)').matches;
      map.flyToBounds(bounds, { paddingTopLeft: [30, 30], paddingBottomRight: wide ? [400, 90] : [20, 20], duration: 1.2 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaKey, mapReady]);

  // Road links between neighbouring signals, drawn along the real OSM road geometry
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;
    const L = require('leaflet');
    roadsRef.current.forEach(p => p.remove());
    roadsRef.current = [];
    if (!showLinks || !data) return;
    const isSwarm = activeMode === SWARM;
    edges.forEach(([i, k]) => {
      roadsRef.current.push(L.polyline(data.paths.get(`${i}>${k}`), {
        color: isSwarm ? 'var(--accent)' : 'var(--text-muted)', weight: isSwarm ? 5 : 4, opacity: isSwarm ? 0.6 : 0.45, interactive: false,
      }).addTo(map));
    });
  }, [data, edges, showLinks, activeMode, mapReady]);

  // Every mapped OSM signal head at its exact position (small dots under the junction markers)
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;
    const L = require('leaflet');
    headsLayerRef.current?.remove();
    headsLayerRef.current = null;
    if (!junctions.length) return;
    headsLayerRef.current = L.layerGroup(junctions.flatMap(j => j.signals.map(s => L.circleMarker([s.lat, s.lon], {
      radius: 3, color: 'var(--warn-soft)', weight: 1, fillColor: 'var(--status-warn)', fillOpacity: 0.95, interactive: false,
    })))).addTo(map);
  }, [junctions, mapReady]);

  // Junction markers (created per network; updated in place every step)
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;
    const L = require('leaflet');
    markersRef.current.forEach(m => m.remove());
    const compact = junctions.length > 40;
    markersRef.current = junctions.map((j, i) => {
      const icon = L.divIcon({
        className: 'custom-leaflet-marker',
        html: markerShell(j.name),
        iconSize: compact ? [24, 24] : [34, 34],
        iconAnchor: compact ? [12, 12] : [17, 17],
      });
      const marker = L.marker([j.lat, j.lon], { icon, riseOnHover: true }).addTo(map);
      marker.bindTooltip('', { direction: 'top', className: 'rich-signal-tooltip', offset: [0, -16], opacity: 0.98 });

      const updateTooltipPlacement = () => {
        const tooltip = marker.getTooltip();
        if (!map || !tooltip) return;
        const pt = map.latLngToContainerPoint(marker.getLatLng());
        const size = map.getSize();
        // If the marker is in the top 54% of the container, open downwards ("bottom")
        // so the card never clips against the top boundary of the map!
        const isTopHalf = pt.y < size.y * 0.54;
        const direction = isTopHalf ? 'bottom' : 'top';

        // Keep horizontally centered unless near the left/right edges
        let offsetX = 0;
        if (pt.x < 170) {
          offsetX = 170 - pt.x;
        } else if (pt.x > size.x - 210) {
          offsetX = (size.x - 210) - pt.x;
        }

        const offsetY = isTopHalf ? 16 : -16;
        tooltip.options.direction = direction;
        tooltip.options.offset = [offsetX, offsetY];
        if (marker.isTooltipOpen()) {
          tooltip.update();
        }
      };

      marker.on('mouseover', updateTooltipPlacement);
      marker.on('tooltipopen', () => {
        updateTooltipPlacement();
        marker.setTooltipContent(tooltipRef.current(i));
      });
      marker.on('click', () => setSelectedIdx(i));
      return marker;
    });

    const handleMove = () => {
      markersRef.current.forEach(m => {
        if (m && m.isTooltipOpen()) {
          const tooltip = m.getTooltip();
          if (!tooltip) return;
          const pt = map.latLngToContainerPoint(m.getLatLng());
          const size = map.getSize();
          const isTopHalf = pt.y < size.y * 0.54;
          const direction = isTopHalf ? 'bottom' : 'top';
          let offsetX = 0;
          if (pt.x < 170) offsetX = 170 - pt.x;
          else if (pt.x > size.x - 210) offsetX = (size.x - 210) - pt.x;
          const offsetY = isTopHalf ? 16 : -16;
          tooltip.options.direction = direction;
          tooltip.options.offset = [offsetX, offsetY];
          tooltip.update();
        }
      });
    };
    map.on('zoom move', handleMove);
    return () => {
      map.off('zoom move', handleMove);
    };
  }, [junctions, mapReady]);

  const routePath = useCallback(route => route.slice(1).flatMap((to, n) => {
    const p = data?.paths.get(`${route[n]}>${to}`);
    return p || [[junctions[route[n]].lat, junctions[route[n]].lon], [junctions[to].lat, junctions[to].lon]];
  }), [data, junctions]);

  // Emergency corridor highlight
  useEffect(() => {
    const map = leafletMapRef.current;
    routeLayersRef.current.forEach(l => l.remove());
    routeLayersRef.current = [];
    if (!map || !emRoute || !demo) return;
    const L = require('leaflet');
    const pts = routePath(emRoute);
    routeLayersRef.current = [
      L.polyline(pts, { color: 'var(--signal-red)', weight: 16, opacity: 0.35, className: 'em-route-glow', interactive: false }).addTo(map),
      L.polyline(pts, { color: 'var(--text-primary)', weight: 3, opacity: 0.95, dashArray: '10 10', className: 'em-route-dash', interactive: false }).addTo(map),
    ];
  }, [emRoute, demo, routePath, mapReady]);

  const isSwarm = activeMode === SWARM;
  const otherMode = isSwarm ? FIXED : SWARM;

  const buildTooltip = useCallback(i => {
    const j = junctions[i];
    if (!j || !demo) return '';
    const v = demo.junctionView(activeMode, i);
    const o = demo.junctionView(otherMode, i);
    const inc = v.incoming[0];
    const lg = a => (v.lastGreen[a] == null ? '—' : `${v.lastGreen[a]}s`);
    const rupees = v.fuelSaved * FUEL.inr_per_l;
    const tags = signalTagSummary(j.signals);
    const nearest = j.neighbors[0];
    const roadNames = (j.roads.some(r => r.name || r.ref) ? j.roads.filter(r => r.name || r.ref) : j.roads)
      .slice(0, 3)
      .map(r => r.name || r.ref)
      .filter(Boolean);

    return `
      <div class="signal-hover-card">
        <!-- Header -->
        <div class="hover-head">
          <div class="hover-head-main">
            <h4 class="hover-title">${esc(j.name)}</h4>
            <div class="hover-place">
              <span>${j.kind === 'crossing' ? '🚸 Signal Crossing' : '🚦 Signal Junction'} · ${esc(area.name)}</span>
              <span class="hover-head-meta">• ${j.signals.length} head${j.signals.length > 1 ? 's' : ''}</span>
            </div>
          </div>
          <div class="hover-phase-pill" style="background:${PHASE_COLOR[v.state]}18;color:${PHASE_COLOR[v.state]};border:1px solid ${PHASE_COLOR[v.state]}55">
            <span class="hover-phase-dot" style="background:${PHASE_COLOR[v.state]};box-shadow:0 0 8px ${PHASE_COLOR[v.state]}"></span>
            ${v.phase}${v.state === 'G' ? ` (${v.greenElapsed}s)` : ''}
          </div>
        </div>

        <!-- Controller Status -->
        <div class="hover-flow-status ${isSwarm ? '' : 'fixed'}">
          <span>${isSwarm ? '🟢 Swarm Agent:' : '🔴 Static Timer:'}</span>
          <b>${esc(isSwarm ? (DECISION_TEXT[v.decision] || 'Observing demand') : '30s Fixed Cycle')}</b>
        </div>

        ${v.lock ? `<div class="hover-emergency">🚑 Emergency Priority: holding ${v.lock} green</div>` : ''}

        <!-- Key Realtime Telemetry Grid -->
        <div class="hover-grid-stats">
          <div class="hover-stat-box">
            <span class="hover-stat-lbl">Halting Queue</span>
            <span class="hover-stat-val" style="color:${v.queue > 4 ? 'var(--signal-red)' : v.queue > 1 ? 'var(--status-warn)' : 'var(--status-ok)'}">
              ${v.queue} <span style="font-size:10px;font-weight:500;color:var(--text-secondary)">veh</span>
            </span>
            <span class="hover-stat-sub">NS ${v.queueNS} · EW ${v.queueEW} (vs ${o.queue} ${isSwarm ? 'fixed' : 'swarm'})</span>
          </div>

          <div class="hover-stat-box">
            <span class="hover-stat-lbl">Clearance Flow</span>
            <span class="hover-stat-val" style="color:var(--status-ok)">
              ${v.carsPerMin} <span style="font-size:10px;font-weight:500;color:var(--text-secondary)">veh/min</span>
            </span>
            <span class="hover-stat-sub">Active throughput</span>
          </div>

          <div class="hover-stat-box">
            <span class="hover-stat-lbl">Green Allocation</span>
            <span class="hover-stat-val" style="color:var(--accent);font-size:11.5px">
              ${isSwarm ? `NS ${lg('NS')} / EW ${lg('EW')}` : '30s / 30s'}
            </span>
            <span class="hover-stat-sub">${isSwarm ? 'Dynamic demand allocation' : 'Fixed static cycle'}</span>
          </div>

          <div class="hover-stat-box">
            <span class="hover-stat-lbl">Fuel & Cost Saved</span>
            <span class="hover-stat-val" style="color:var(--accent-3-soft)">
              ${v.fuelSaved.toFixed(3)} L <span style="font-size:11px;color:var(--status-warn)">· ₹${rupees.toFixed(1)}</span>
            </span>
            <span class="hover-stat-sub">vs baseline fixed timer</span>
          </div>

          <div class="hover-stat-box hover-stat-full">
            <span class="hover-stat-lbl">Incoming Platoon</span>
            <span class="hover-stat-val" style="font-size:11.5px;color:${inc ? 'var(--accent)' : 'var(--text-secondary)'}">
              ${isSwarm
                ? (inc ? `▲ ${inc.size} veh arriving in ${inc.eta}s from ${esc(inc.from)}` : 'None announced · Normal flow')
                : 'No inter-junction communication'}
            </span>
          </div>
        </div>

        <!-- OpenStreetMap Highway Context -->
        <div class="hover-osm-compact">
          ${roadNames.length ? `
          <div class="hover-osm-row">
            <span class="hover-osm-lbl">Roads:</span>
            <span class="hover-osm-tag" title="${esc(roadNames.join(' × '))}">${esc(roadNames.join(' × '))}</span>
          </div>` : ''}
          ${nearest ? `
          <div class="hover-osm-row">
            <span class="hover-osm-lbl">Mesh:</span>
            <span class="hover-osm-val">${j.neighbors.length} signals linked · nearest ${esc(km(nearest.roadM))}${nearest.road ? ` along ${esc(nearest.road)}` : ''}</span>
          </div>` : ''}
          ${tags.length ? `
          <div class="hover-osm-row">
            <span class="hover-osm-lbl">Signals:</span>
            <span class="hover-osm-val">${esc(tags.slice(0, 2).join(' · '))}</span>
          </div>` : ''}
        </div>
      </div>`;
  }, [demo, junctions, activeMode, otherMode, isSwarm, area.name]);
  tooltipRef.current = buildTooltip;

  // Per-step marker refresh (in place, so CSS pulses keep running)
  useEffect(() => {
    if (!demo) return;
    const showNames = junctions.length <= 15;
    markersRef.current.forEach((marker, i) => {
      const el = marker.getElement();
      if (!el || i >= demo.junctions.length) return;
      const v = demo.junctionView(activeMode, i);
      const color = PHASE_COLOR[v.state];
      const wrap = el.querySelector('.gzb-marker-wrap');
      wrap.classList.toggle('active', i === selectedIdx);
      wrap.classList.toggle('compact', junctions.length > 40);
      wrap.classList.toggle('crossing', junctions[i].kind === 'crossing');
      wrap.classList.toggle('em-lock', isSwarm && !!v.lock);
      el.querySelector('.marker-pulse').style.background = color;
      el.querySelector('.marker-core').style.borderColor = color;
      el.querySelector('.marker-queue').textContent = v.queue;
      el.querySelector('.marker-tag').classList.toggle('hide', !(showNames || i === selectedIdx));
      const inc = isSwarm && v.incoming[0] && v.incoming[0].size >= 3 ? v.incoming[0] : null;
      const badge = el.querySelector('.marker-incoming');
      badge.textContent = inc ? `▲${inc.size} · ${inc.eta}s` : '';
      badge.classList.toggle('show', !!inc && junctions.length <= 40);
      if (marker.isTooltipOpen()) marker.setTooltipContent(buildTooltip(i));
    });
  });

  // Animated layer: vehicles on road links, inter-agent packets and the ambulance (canvas over the map)
  useEffect(() => {
    if (!demo) return undefined;
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
      const C = canvasColorsRef.current;
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const nowMs = performance.now();
      const frac = isPlaying ? Math.min(1, (nowMs - lastStepRef.current) / stepMs) : 0;
      const frame = new Map();
      const linkPts = (from, to) => {
        const key = `${from}>${to}`;
        if (!frame.has(key)) {
          const ll = data.paths.get(key) || [[demo.junctions[from].lat, demo.junctions[from].lon], [demo.junctions[to].lat, demo.junctions[to].lon]];
          frame.set(key, ll.map(p => map.latLngToContainerPoint(p)));
        }
        return frame.get(key);
      };

      if (showFlow) {
        ctx.fillStyle = C['--status-warn'];
        demo.transitGroups(activeMode, frac).forEach(g => {
          const p = along(linkPts(g.from, g.to), g.frac, 5);
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
          const pos = along(linkPts(p.from, p.to), f, em ? 0 : 5);
          const trail = ctx.createLinearGradient(pos.x - pos.ux * 34, pos.y - pos.uy * 34, pos.x, pos.y);
          trail.addColorStop(0, `color-mix(in srgb, ${C['--accent']} 0%, transparent)`);
          trail.addColorStop(1, em ? `color-mix(in srgb, ${C['--danger-soft']} 90%, transparent)` : `color-mix(in srgb, ${C['--accent']} 90%, transparent)`);
          ctx.strokeStyle = trail;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(pos.x - pos.ux * 34, pos.y - pos.uy * 34);
          ctx.lineTo(pos.x, pos.y);
          ctx.stroke();
          ctx.shadowColor = em ? C['--signal-red'] : C['--accent'];
          ctx.shadowBlur = 14;
          ctx.fillStyle = em ? (Math.floor(nowMs / 150) % 2 ? C['--text-primary'] : C['--signal-red']) : C['--accent-soft'];
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, em ? 5.5 : 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          if (!em && p.size >= 3) {
            ctx.font = '600 10px "JetBrains Mono", monospace';
            ctx.fillStyle = C['--accent-soft'];
            ctx.fillText(`${p.size}`, pos.x + 7, pos.y - 6);
          }
        });
      }

      // Ambulance, moved along the road geometry of its current link
      const m = demo.meshes[activeMode];
      const amb = m.ambulance;
      if (amb && !amb.done) {
        const now = m.t + frac;
        let p;
        let waiting;
        if (amb.posLink === null) {
          const j = demo.junctions[amb.route[0]];
          p = map.latLngToContainerPoint([j.lat, j.lon]);
          waiting = now >= amb.arriveAt;
        } else {
          const l = demo.links[amb.posLink];
          const f = Math.min(1, Math.max(0, (now - amb.depart) / Math.max(1, amb.arriveAt - amb.depart)));
          p = along(linkPts(l.from, l.to), f, 0);
          waiting = f >= 1;
        }
        const pulse = 11 + 4 * Math.sin(nowMs / 160);
        ctx.strokeStyle = `color-mix(in srgb, ${C['--signal-red']} 80%, transparent)`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = Math.floor(nowMs / 250) % 2 ? C['--signal-red'] : C['--text-primary'];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🚑', p.x, p.y - 14);
        if (waiting) {
          ctx.font = '700 10px "JetBrains Mono", monospace';
          ctx.fillStyle = C['--danger-soft'];
          ctx.fillText(`STOPPED AT RED · ${amb.delay}s`, p.x, p.y + 24);
        }
        ctx.textAlign = 'start';
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      const cv = fxCanvasRef.current;
      if (cv) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    };
  }, [demo, data, activeMode, isSwarm, showFlow, isPlaying, speed]);

  // Free OpenStreetMap Nominatim search for any place in the world
  const handleSearchLocation = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchError(null);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchQuery)}&format=json&limit=1`);
      const found = await res.json();
      if (found && found[0]) {
        const place = found[0];
        setArea({
          id: `search-${place.osm_type}-${place.osm_id}`,
          name: place.display_name.split(',')[0],
          region: place.display_name.split(',').slice(1, 3).join(',').trim(),
          center: [parseFloat(place.lat), parseFloat(place.lon)],
          source: 'search',
        });
      } else {
        setSearchError(`No place called “${searchQuery}” found on OpenStreetMap.`);
      }
    } catch (err) {
      setSearchError(`Place search failed: ${err.message}`);
    } finally {
      setIsSearching(false);
    }
  };

  // Replaces a coordinate label with the place name from Nominatim, if the area is still selected
  const nameArea = async (id, [lat, lon], prefix = '') => {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=16`);
      const place = await res.json();
      const parts = (place.display_name || '').split(',').map(x => x.trim()).filter(Boolean);
      if (parts.length) setArea(a => (a.id === id ? { ...a, name: prefix + parts[0], region: parts.slice(1, 3).join(', ') } : a));
    } catch {
      // the coordinates stay as the name
    }
  };

  const jumpToSignals = spot => {
    const id = `jump-${spot.lat.toFixed(4)},${spot.lon.toFixed(4)}`;
    const center = [spot.lat, spot.lon];
    setArea({ id, name: 'Mapped signals', region: `${(spot.distM / 1000).toFixed(1)} km from ${area.name}`, center, source: 'search' });
    nameArea(id, center);
  };

  const sendToLab = async () => {
    setLabSend({ status: 'sending' });
    try {
      await lab('/api/lab/osm-areas', { method: 'POST', body: JSON.stringify({ name: area.name, bbox: clampBbox(bbox, LAB_MAX_KM2) }) });
      if (moduleOn('live-lab')) router.push('/live');
    } catch (err) {
      setLabSend({ status: 'error', error: `Could not reach the SUMO lab server (${err.message}). Start it with: uvicorn experiments.lab.api:app --port 8090` });
    }
  };

  // Leaflet measured a hidden container while the map was off
  useEffect(() => {
    if (mapOn) leafletMapRef.current?.invalidateSize();
  }, [mapOn]);

  // Scan exactly what is on screen (clamped to the per-scan area limit)
  const scanVisibleArea = async () => {
    const map = leafletMapRef.current;
    if (!map) return;
    const b = map.getBounds();
    const box = clampBbox({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });
    const center = bboxCenter(box);
    const id = `view-${bboxKey(box)}`;
    setArea({ id, name: 'Visible map area', region: `${center[0].toFixed(4)}, ${center[1].toFixed(4)}`, center, bbox: box, source: 'view' });
    nameArea(id, center);
  };

  const downloadOsm = async () => {
    setDownload({ status: 'loading' });
    try {
      const xml = await overpass(extractQuery(bbox), { as: 'text' });
      downloadBlob(xml, 'application/xml', `tsi_${slug(area.name)}.osm`);
      setDownload({ status: 'done', file: `tsi_${slug(area.name)}.osm` });
    } catch (err) {
      setDownload({ status: 'error', error: err.message });
    }
  };

  const downloadGeoJSON = () => {
    if (!data) return;
    const gj = toGeoJSON(data, { area: area.name, region: area.region, bbox_swne: [bbox.south, bbox.west, bbox.north, bbox.east] });
    downloadBlob(JSON.stringify(gj, null, 2), 'application/geo+json', `tsi_${slug(area.name)}_signals.geojson`);
  };

  const focusJunction = i => {
    setSelectedIdx(i);
    const j = junctions[i];
    leafletMapRef.current?.flyTo([j.lat, j.lon], Math.max(leafletMapRef.current.getZoom(), 17), { duration: 0.8 });
  };

  const cityDropdownOptions = useMemo(() => SUPPORTED_CITIES.map(c => ({
    value: c.id,
    label: c.name,
    sub: `${c.region} · bundled snapshot, opens instantly`,
  })), []);

  const triggerEmergency = () => {
    if (!demo) return;
    const route = demo.triggerEmergency();
    if (route) {
      setEmRoute(route.slice());
      setActiveMode(SWARM);
    }
  };

  // Live values for this render (re-rendered once per simulated second)
  const fuel = demo ? demo.fuel() : null;
  const em = demo ? demo.emergency() : null;
  const emActive = demo ? demo.emergencyActive() : false;
  const sel = Math.min(selectedIdx, Math.max(0, junctions.length - 1));
  const selJ = demo ? junctions[sel] : null;
  const selV = selJ ? demo.junctionView(activeMode, sel) : null;
  const messages = demo ? demo.meshes[SWARM].messages.slice(-150) : [];
  const queueTotal = demo ? demo.meshes[activeMode].queueTotal() : 0;
  const queueOther = demo ? demo.meshes[otherMode].queueTotal() : 0;
  const stats = data ? data.stats : null;
  const canRoute = edges.length > 0;

  useEffect(() => {
    if (emRoute && em && em.swarm.done && em.fixed.done) setEmRoute(null);
  }, [emRoute, em]);

  return (
    <div className="gzb-command-center">
      {/* Header, place selection and scan area */}
      <section className="panel gzb-header-panel" style={{ position: 'relative', zIndex: 50, marginBottom: 16 }}>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 14, justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 340px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span className="badge live" style={{ background: 'var(--status-ok)', color: 'color-mix(in srgb, var(--status-ok) 16%, var(--bg-surface))' }}>
                ● {area.name.toUpperCase()} · REAL OSM SIGNALS
              </span>
              <span className="status" style={{ fontSize: 11, background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)' }}>
                {data ? `${junctions.length} signalised JunctionAgents` : net.status === 'loading' ? 'loading signals…' : 'no signals loaded'}
              </span>
              {moduleOn('how-it-works') && <button className="explainer-open-btn" onClick={() => setExplainerOpen(true)}>
                <BookOpen size={14} /> How Swarm Intelligence Works
              </button>}
            </div>
            <h2 style={{ marginTop: 6, marginBottom: 4, fontSize: '1.5rem', color: 'var(--text-primary)' }}>
              Real traffic signals, anywhere in the world
            </h2>
            <p className="muted small" style={{ margin: 0 }}>
              Every node is a traffic light mapped in OpenStreetMap (<code>highway=traffic_signals</code>), and every link is the real road
              between two signals. Hover a node for its OSM record plus the live swarm simulation.
            </p>
          </div>

          {on('place-controls') && <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', flex: '1 1 540px', justifyContent: 'flex-end' }}>
            <div style={{ flex: '1 1 200px', minWidth: 180, maxWidth: 260 }}>
              <RichDropdown
                options={cityDropdownOptions}
                items={cityDropdownOptions}
                value={area.source === 'preset' ? area.id : 'custom'}
                onChange={val => setArea(presetArea(SUPPORTED_CITIES.find(c => c.id === val) || SUPPORTED_CITIES[0]))}
                icon={MapPin}
                placeholder="Choose a city"
                label="Quick Place"
                searchable
              />
            </div>

            <div style={{ flex: '1 1 180px', minWidth: 170, maxWidth: 240 }}>
              <RichDropdown
                options={RADIUS_OPTIONS}
                items={RADIUS_OPTIONS}
                value={String(radiusM)}
                onChange={val => {
                  setRadiusM(Number(val));
                  if (area.bbox) setArea(a => ({ ...a, bbox: undefined, source: 'search' }));
                }}
                icon={Ruler}
                label="Scan Area"
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
          </div>}
        </div>

        {on('place-search') && <form onSubmit={handleSearchLocation} className="gzb-search-row">
          <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <Search size={16} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--text-secondary)' }} />
            <input
              type="text"
              placeholder="Search any place (e.g. Silk Board Bengaluru, Connaught Place, Times Square)…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="gzb-search-input"
            />
          </div>
          <button type="submit" disabled={isSearching} className="gzb-search-btn">
            <Navigation size={14} />
            {isSearching ? 'Locating…' : 'Locate Place'}
          </button>
          <button type="button" onClick={scanVisibleArea} className="gzb-search-btn secondary" title={`Scan the visible map (up to ${LIMITS.maxAreaKm2} km²)`}>
            <Crosshair size={14} /> Scan This View
          </button>
        </form>}
        {searchError && <p className="osm-note error">{searchError}</p>}

        {/* What was actually loaded from OSM */}
        {(on('area-stats') || on('osm-exports') || canSendToLab) && <div className="osm-strip">
          {on('area-stats') && <span><b>Area</b> {area.name}{area.region ? `, ${area.region}` : ''} · {areaKm2.toFixed(1)} km²</span>}
          {on('area-stats') && stats && (
            <>
              <span><b>{stats.signalNodes}</b> OSM signal nodes</span>
              <span><b>{stats.junctionClusters}</b> signalised junctions</span>
              <span>
                <b>{stats.crossingClusters}</b> mid-block crossings{' '}
                <label className="osm-inline-toggle">
                  <input type="checkbox" checked={includeCrossings} onChange={e => setIncludeCrossings(e.target.checked)} /> show
                </label>
              </span>
              <span><b>{stats.links}</b> road links</span>
              {stats.isolated > 0 && <span className="warn">{stats.isolated} without a linked neighbour</span>}
              {stats.truncated > 0 && <span className="warn">{stats.truncated} outer junctions not simulated (limit {LIMITS.maxJunctions}); shrink the area</span>}
              {stats.offRoad > 0 && <span className="muted">{stats.offRoad} signals off drivable roads ignored</span>}
              {stats.osmTimestamp && (
                <span className="muted">
                  {ORIGIN_TEXT[net.origin]} · OSM data as of {stats.osmTimestamp.slice(0, 10)}{' '}
                  {net.origin !== 'live' && (
                    <button type="button" className="link-btn" onClick={() => { forceLiveRef.current = true; setReloadNonce(n => n + 1); }}>
                      refresh live
                    </button>
                  )}
                </span>
              )}
            </>
          )}
          <span className="osm-actions">
            {on('osm-exports') && <><button onClick={downloadOsm} disabled={download?.status === 'loading'} title="OSM road extract for SUMO netconvert">
              <Download size={13} /> {download?.status === 'loading' ? 'Downloading .osm…' : 'Download .osm (SUMO)'}
            </button>
            <button onClick={downloadGeoJSON} disabled={!data} title="Signal junctions and road links as GeoJSON">
              <Download size={13} /> Signals GeoJSON
            </button></>}
            {canSendToLab && <button className="primary" onClick={sendToLab} disabled={!data || !junctions.length || labSend?.status === 'sending'}
              title={`Simulate this place in SUMO with its real traffic lights (centre ${LAB_MAX_KM2} km² of the scan)`}>
              <FlaskConical size={13} /> {labSend?.status === 'sending' ? 'Sending…' : 'Simulate in SUMO Lab'}
            </button>}
          </span>
        </div>}
        {labSend?.status === 'error' && <p className="osm-note error">{labSend.error}</p>}
        {nearby?.spot && (
          <div className="osm-nearby">
            <LocateFixed size={15} />
            <span>
              OpenStreetMap has few traffic lights mapped here. <b>{nearby.spot.count} mapped signals</b> are clustered{' '}
              {(nearby.spot.distM / 1000).toFixed(1)} km away.
            </span>
            <button onClick={() => jumpToSignals(nearby.spot)}>Go there</button>
          </div>
        )}
        {download?.status === 'done' && (
          <p className="osm-note">
            Saved <code>{download.file}</code>. Build a SUMO network from it:{' '}
            <code>python -m simulation.network.build_network --preset osm_user --osm-file {download.file}</code>
          </p>
        )}
        {download?.status === 'error' && <p className="osm-note error">{download.error}</p>}
      </section>

      {/* Comparison toggle, emergency trigger and simulation controls */}
      {(on('mode-toggle') || on('emergency-corridor') || on('sim-controls') || on('map-layers')) && <div className="map-control-bar">
        {on('mode-toggle') && <div className="mode-toggle" role="group" aria-label="Signal control mode">
          <button className={isSwarm ? 'on swarm' : ''} onClick={() => setActiveMode(SWARM)} aria-pressed={isSwarm}>
            <Zap size={14} /> Swarm Intelligence {isSwarm && <b>ON</b>}
          </button>
          <button className={!isSwarm ? 'on fixed' : ''} onClick={() => setActiveMode(FIXED)} aria-pressed={!isSwarm}>
            <Timer size={14} /> Traditional Fixed Timer (Static 30s)
          </button>
        </div>}

        {on('emergency-corridor') && <button className="em-trigger" onClick={triggerEmergency} disabled={!demo || !canRoute || emActive}
          title={canRoute ? '' : 'Needs at least two signals linked by road'}>
          <Siren size={15} />
          {emActive
            ? `Ambulance corridor active · swarm delay ${em.swarm.delay_s}s · static ${em.fixed.delay_s}s`
            : '🚑 Trigger Emergency Ambulance Corridor'}
        </button>}

        {on('sim-controls') && <div className="sim-controls">
          <button onClick={() => setIsPlaying(p => !p)} aria-label={isPlaying ? 'Pause simulation' : 'Play simulation'}>
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
          {SPEEDS.map(s => (
            <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)} aria-pressed={speed === s}>{s}×</button>
          ))}
          <span className="sim-clock">T+{demo ? demo.t : 0}s</span>
        </div>}

        {on('map-layers') && <div className="map-toggles">
          <label><input type="checkbox" checked={showFlow} onChange={e => setShowFlow(e.target.checked)} /> Packets &amp; vehicles</label>
          <label><input type="checkbox" checked={showLinks} onChange={e => setShowLinks(e.target.checked)} /> Road links</label>
        </div>}
      </div>}

      {on('map-legend') && <div className="map-legend">
        <span><i style={{ background: 'var(--status-warn)', boxShadow: '0 0 0 1px var(--warn-soft)' }} /> OSM signal head (exact)</span>
        <span><i style={{ background: 'var(--accent-soft)', boxShadow: '0 0 8px var(--accent)' }} /> platoon alert packet</span>
        <span><i style={{ background: 'var(--status-warn)' }} /> vehicles in transit (simulated)</span>
        <span><i style={{ background: 'var(--status-ok)' }} /> green</span>
        <span><i style={{ background: 'var(--status-warn)' }} /> yellow</span>
        <span><i style={{ background: 'var(--status-danger)' }} /> red / all-red</span>
        <span className="legend-q">network queue: <b style={{ color: isSwarm ? 'var(--status-ok)' : 'var(--status-danger)' }}>{queueTotal}</b> veh (other mode {queueOther})</span>
      </div>}

      {net.stage === 'roads' && (
        <div className="osm-stage">
          <RefreshCw size={14} className="spin" />
          <span>
            Showing <b>{junctions.length} real traffic lights</b> at their exact OSM positions. Loading the roads between them
            (names, junction types, links) · {loadSeconds}s{retryInfo ? ` · servers busy, retry ${retryInfo.round + 1} of 4` : ''}
          </span>
        </div>
      )}
      {net.roadsError && (
        <div className="osm-stage warn">
          <TrafficCone size={14} />
          <span>
            The <b>{junctions.length} traffic lights</b> are real and correctly placed, but the roads between them could not be loaded:
            {' '}{net.roadsError}
          </span>
          <button onClick={() => setReloadNonce(n => n + 1)}><RefreshCw size={13} /> Retry roads</button>
        </div>
      )}

      {/* The Leaflet container stays mounted while the map is off, so turning it back on keeps the simulation */}
      <div className={`gzb-map-wrap ${mapOn ? '' : 'map-off'}`}>
        <div ref={mapContainerRef} className="gzb-map-canvas" style={{ background: 'var(--bg-sunken)' }} />
        {mapOn && <canvas ref={fxCanvasRef} className="map-fx-canvas" aria-hidden="true" />}

        {mapOn && net.status === 'loading' && (
          <div className="map-overlay">
            <RefreshCw size={18} className="spin" />
            <div>
              <b>Reading traffic signals from OpenStreetMap…</b>
              <span>
                {areaKm2.toFixed(1)} km² around {area.name} · {loadSeconds}s
                {retryInfo ? ` · servers busy, retry ${retryInfo.round + 1} of 4…` : loadSeconds > 20 ? ' · public servers are slow, still trying' : ''}
              </span>
            </div>
          </div>
        )}
        {mapOn && net.status === 'error' && (
          <div className="map-overlay error">
            <TrafficCone size={18} />
            <div>
              <b>Could not load OpenStreetMap data</b>
              <span>{net.error}</span>
            </div>
            <button onClick={() => setReloadNonce(n => n + 1)}><RefreshCw size={13} /> Retry</button>
          </div>
        )}
        {mapOn && net.status === 'ready' && !junctions.length && (
          <div className="map-overlay">
            <TrafficCone size={18} />
            <div>
              <b>No traffic signals are mapped in OpenStreetMap here</b>
              <span>
                {stats.crossingClusters && !includeCrossings
                  ? `${stats.crossingClusters} mid-block signal crossing(s) exist; tick “show” above to include them. `
                  : ''}
                {nearby?.status === 'searching' && 'Searching 15 km around for mapped traffic lights… '}
                {nearby?.status === 'done' && !nearby.spot && 'No denser cluster of mapped lights within 15 km. '}
                Missing lights can be added at openstreetmap.org.
              </span>
              {nearby?.spot && (
                <button className="overlay-action" onClick={() => jumpToSignals(nearby.spot)}>
                  <LocateFixed size={13} /> Go to {nearby.spot.count} mapped signals ({(nearby.spot.distM / 1000).toFixed(1)} km away)
                </button>
              )}
            </div>
          </div>
        )}

        {on('swarm-terminal') && demo && <SwarmTerminal messages={messages} selectedId={selJ?.id} mode={activeMode} />}

        {on('junction-status') && selJ && selV && (
          <div className="gzb-status-pill">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <div style={{ width: 10, height: 10, flex: '0 0 auto', borderRadius: '50%', background: PHASE_COLOR[selV.state] }} />
              <div style={{ minWidth: 0 }}>
                <div className="pill-title">{selJ.name}</div>
                <div className="pill-sub">
                  {selV.phase}{selV.state === 'G' ? ` · ${selV.greenElapsed}s` : ''} · {isSwarm ? (DECISION_TEXT[selV.decision] || 'Observing') : 'static 30 s plan'}
                  {' · '}
                  <a href={`https://www.openstreetmap.org/node/${selJ.signals[0].id}`} target="_blank" rel="noreferrer" className="osm-link">
                    OSM node {selJ.signals[0].id} <ExternalLink size={11} />
                  </a>
                </div>
              </div>
            </div>
            <div className="pill-stats">
              <div><span>Cars passing (sim)</span><b style={{ color: 'var(--status-ok)' }}>{selV.carsPerMin} veh/min</b></div>
              <div><span>Queued (sim)</span><b style={{ color: 'var(--accent)' }}>{selV.queue} veh</b></div>
              <div><span>Incoming</span><b style={{ color: 'var(--accent)' }}>
                {isSwarm ? (selV.incoming[0] ? `${selV.incoming[0].size} veh in ${selV.incoming[0].eta}s` : '—') : 'no comms'}
              </b></div>
              <div><span>Fuel saved here</span><b style={{ color: 'var(--accent-3)' }}>{selV.fuelSaved.toFixed(3)} L</b></div>
            </div>
          </div>
        )}
      </div>

      {on('impact-panel') && demo && <SwarmImpactPanel fuel={fuel} emergency={em} simSeconds={demo.t} cityName={area.name} />}

      {/* Inventory of every real signal in the scan, for checking against the ground */}
      {on('signal-inventory') && data && junctions.length > 0 && (
        <section className="panel osm-inventory">
          <h3><TrafficCone size={16} /> Signal inventory · {area.name}</h3>
          <div className="osm-table-wrap">
            <table>
              <thead>
                <tr><th>#</th><th>Junction</th><th>Type</th><th>Heads</th><th>Roads (OSM)</th><th>Linked signals by road</th><th>OSM</th></tr>
              </thead>
              <tbody>
                {junctions.map((j, i) => (
                  <tr key={j.id} className={i === sel ? 'on' : ''} onClick={() => focusJunction(i)}>
                    <td>{i + 1}</td>
                    <td>{j.name}{j.hero ? ' ★' : ''}</td>
                    <td>{j.kind === 'junction' ? 'junction' : 'crossing'}</td>
                    <td>{j.signals.length}</td>
                    <td>{(j.roads.some(r => r.name || r.ref) ? j.roads.filter(r => r.name || r.ref) : j.roads).slice(0, 3)
                      .map(r => `${r.name || r.ref || 'unnamed road'} (${r.highway}${r.lanes ? `, ${r.lanes}L` : ''})`).join('; ')}</td>
                    <td>{j.neighbors.length ? j.neighbors.map(n => `${shortName(junctions[n.idx].name)} ${km(n.roadM)}`).join(' · ') : '—'}</td>
                    <td>
                      <a href={`https://www.openstreetmap.org/node/${j.signals[0].id}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
                        {j.signals[0].id}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small" style={{ margin: '8px 0 0' }}>★ marks the busiest connected junction, where the simulated platoon bursts and the ambulance start.</p>
        </section>
      )}

      <p className="muted small mesh-footnote">
        <Radio size={12} /> Junction positions, names, road classes, lanes and links are OpenStreetMap data (© OpenStreetMap contributors, ODbL 1.0),
        read live through the Overpass API. OSM has no live traffic counts, so queues, platoons and fuel figures come from the swarm engine
        (<code>simulation/swarm/junction_mesh.py</code>, mirrored in the browser) on modelled demand, and link travel times are compressed to 10–28 s
        so platoons stay visible.
      </p>

      <SwarmExplainerModal open={explainerOpen} onClose={() => setExplainerOpen(false)} />
    </div>
  );
}
