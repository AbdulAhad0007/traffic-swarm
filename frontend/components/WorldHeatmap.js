'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import { fmt } from '@/lib/api';
import { useFullscreen } from '@/lib/usePanZoom';
import { Globe2, MapPin, Maximize2, Minimize2, Crosshair } from 'lucide-react';
import { useThemeTokens } from '@/lib/themeClient';

const MAP_BASE_TOKEN = ['--map-base'];

// Real world map (OpenStreetMap / Esri tiles) with the simulated network's congestion drawn as a
// heatmap. A network imported from OpenStreetMap is geo-referenced: every traffic light is drawn at
// its real coordinates. A synthetic grid has no real location, so it is drawn to scale at a chosen place.

const CITIES = [
  ['Bengaluru · MG Road', 12.974, 77.608],
  ['Delhi · Connaught Place', 28.6315, 77.2167],
  ['Mumbai · Bandra', 19.0596, 72.8295],
  ['Hyderabad · Hitech City', 17.4435, 78.3772],
  ['Chennai · T. Nagar', 13.0418, 80.2341],
  ['Kolkata · Park Street', 22.5526, 88.3528],
  ['Pune · Shivajinagar', 18.5308, 73.8475],
  ['Karachi · Saddar', 24.8556, 67.0296],
  ['Dubai · Downtown', 25.1972, 55.2744],
  ['London · Westminster', 51.5007, -0.1246],
  ['Paris · Opéra', 48.8708, 2.3317],
  ['New York · Midtown', 40.7549, -73.984],
  ['Tokyo · Shinjuku', 35.6938, 139.7034],
  ['Singapore · Orchard', 1.3048, 103.8318],
  ['Sydney · CBD', -33.8688, 151.2093],
];
const STORE_KEY = 'tsi.worldAnchor';

// Base maps. "dark" is standard OSM tiles inverted in CSS (.world-dark) to match the dashboard.
const BASES = {
  dark: { label: 'Dark', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
  streets: { label: 'Streets', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
  satellite: { label: 'Satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' },
};

function sev(j) {
  if (!j || j.level === 'no_data') return 0;
  const q = j.queue || 0, occ = j.occupancy || 0;
  return q > 4 || occ > 0.4 ? 3 : q > 1 || occ > 0.2 ? 2 : 1;
}
const HEAT = ['var(--text-muted)', 'var(--status-warn)', 'var(--status-warn)', 'var(--signal-red)'];
const SEV_NAME = ['no data', 'free flow', 'moderate', 'heavy'];
const RINGS = [[1.0, 0.18], [0.65, 0.3], [0.35, 0.5]];

function defaultAnchor(network) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && saved.lat != null) return saved;
  } catch { }
  if (network && /bengaluru/i.test(network)) return { lat: 12.974, lon: 77.608, name: CITIES[0][0] };
  return { lat: CITIES[0][1], lon: CITIES[0][2], name: CITIES[0][0] };
}

const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function tipHtml(node, j) {
  const s = sev(j);
  const real = node.lat != null
    ? `<div class="world-tip-real">${node.streets?.length ? `<div style="font-weight:700;color:var(--text-primary);font-size:13px;margin-bottom:2px;">${esc(node.streets.join(' × '))}</div>` : ''}`
      + `<span style="color:var(--text-secondary);font-size:10.5px;">📍 Real Signal Head · ${node.lat.toFixed(5)}, ${node.lon.toFixed(5)}</span>`
      + `${node.osm_nodes?.length ? `<div style="color:var(--text-muted);font-size:10px;font-family:monospace;margin-top:2px;">OSM #${esc(node.osm_nodes.slice(0, 3).join(', '))}</div>` : ''}</div>`
    : '';
  const q = j?.queue || 0;
  const occ = j?.occupancy;
  const ph = j?.phase;
  const isGreen = ph != null && ph % 2 === 0;
  const phasePill = ph != null
    ? `<span style="display:inline-block;padding:2px 7px;border-radius:999px;font-size:10.5px;font-weight:600;background:${isGreen ? 'color-mix(in srgb, var(--status-ok) 20%, transparent)' : 'color-mix(in srgb, var(--status-warn) 20%, transparent)'};color:${isGreen ? 'var(--status-ok)' : 'var(--status-warn)'};border:1px solid ${isGreen ? 'color-mix(in srgb, var(--status-ok) 40%, transparent)' : 'color-mix(in srgb, var(--status-warn) 40%, transparent)'};">Phase ${ph} (${isGreen ? 'GREEN' : 'YELLOW'})</span>`
    : '';

  return `<div style="min-width:220px;">
    ${real}
    <div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0 8px;padding-bottom:6px;border-bottom:1px solid color-mix(in srgb, var(--text-primary) 10%, transparent);">
      <span style="font-family:monospace;font-weight:800;color:var(--accent);font-size:15px;">${esc(node.id)}</span>
      <span style="font-size:11px;font-weight:700;color:${HEAT[s]};">${SEV_NAME[s]}</span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;font-size:11.5px;color:var(--text-secondary);">
      <div><span style="font-size:10px;text-transform:uppercase;color:var(--text-secondary);display:block;">Queue</span><b style="color:${q > 4 ? 'var(--signal-red)' : q > 1 ? 'var(--status-warn)' : 'var(--status-ok)'};">${fmt(q, 0)} veh</b></div>
      <div><span style="font-size:10px;text-transform:uppercase;color:var(--text-secondary);display:block;">Occupancy</span><b>${occ == null ? '—' : fmt(occ * 100, 1) + '%'}</b></div>
    </div>
    ${phasePill ? `<div style="margin-top:8px;">${phasePill}</div>` : ''}
  </div>`;
}

export default function WorldHeatmap({ layout, junctions, route = [], network, selected, onSelect, height = 560 }) {
  const wrapRef = useRef(null);
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const LRef = useRef(null);
  const tileRef = useRef(null);
  const drawn = useRef(null); // Leaflet objects of the current network, updated in place
  const placing = useRef(false);
  const onSelectRef = useRef(onSelect);
  const fittedFor = useRef(null);
  const [ready, setReady] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const [placeMode, setPlaceMode] = useState(false);
  // The base map follows the theme until the visitor picks one.
  const [pickedBase, setBase] = useState(null);
  const mapBase = useThemeTokens(MAP_BASE_TOKEN)['--map-base'];
  const base = pickedBase ?? (mapBase === 'light' ? 'streets' : 'dark');
  const [isFull, toggleFull] = useFullscreen(wrapRef);

  onSelectRef.current = onSelect;
  const isGeo = !!(layout?.geo && layout.nodes?.some(n => n.lat != null));
  useEffect(() => { setAnchor(defaultAnchor(network)); }, [network]);
  useEffect(() => { placing.current = placeMode; }, [placeMode]);

  // The live API returns a new layout object on every poll; only rebuild when the geometry changes.
  const layoutKey = useMemo(() => (layout?.bounds
    ? layout.nodes.map(n => `${n.id}:${n.x}:${n.y}`).join('|') + '#' + layout.links.length
    : ''), [layout]);

  // Create the Leaflet map once (Leaflet needs `window`, so it is loaded on the client only).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !mapEl.current) return;
      LRef.current = L;
      const map = L.map(mapEl.current, { worldCopyJump: true, minZoom: 2, zoomControl: true }).setView([20, 30], 2);
      const heatPane = map.createPane('heat');
      heatPane.style.zIndex = 420;
      heatPane.style.filter = 'blur(8px)';
      heatPane.style.pointerEvents = 'none';
      map.createPane('roads').style.zIndex = 430;
      map.createPane('nodes').style.zIndex = 640;
      map.on('click', e => {
        if (!placing.current) return;
        const a = { lat: e.latlng.lat, lon: e.latlng.lng, name: `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}` };
        setAnchor(a);
        setPlaceMode(false);
        try { localStorage.setItem(STORE_KEY, JSON.stringify(a)); } catch { }
      });
      mapRef.current = map;
      setReady(true);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      drawn.current = null;
    };
  }, []);

  // Base map tiles.
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!ready || !L || !map) return;
    tileRef.current?.remove();
    const b = BASES[base];
    tileRef.current = L.tileLayer(b.url, { attribution: b.attribution, maxZoom: b.maxZoom }).addTo(map);
  }, [ready, base]);

  // Leaflet must re-measure when the container changes size (full screen, tab shown).
  useEffect(() => {
    const t = setTimeout(() => mapRef.current?.invalidateSize(), 150);
    return () => clearTimeout(t);
  }, [isFull, ready]);
  useEffect(() => {
    if (!ready || !mapEl.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => mapRef.current?.invalidateSize());
    ro.observe(mapEl.current);
    return () => ro.disconnect();
  }, [ready]);

  // Real coordinates for a geo-referenced network, otherwise SUMO metres placed around the anchor.
  const nodeLatLng = n => (isGeo ? (n.lat != null ? [n.lat, n.lon] : null) : (n.x != null ? toLatLng(n.x, n.y) : null));
  const toLatLng = (x, y) => {
    const b = layout.bounds;
    const cx = (b.min_x + b.max_x) / 2, cy = (b.min_y + b.max_y) / 2;
    const lat = anchor.lat + (y - cy) / 111320;
    const lon = anchor.lon + (x - cx) / (111320 * Math.cos((anchor.lat * Math.PI) / 180));
    return [lat, lon];
  };

  const fit = () => {
    const map = mapRef.current;
    if (!map || !layout?.bounds) return;
    if (isGeo) {
      const pts = layout.nodes.filter(n => n.lat != null).map(n => [n.lat, n.lon]);
      if (pts.length) map.flyToBounds(LRef.current.latLngBounds(pts).pad(0.15), { duration: 1.6, maxZoom: 17 });
      return;
    }
    if (!anchor) return;
    const b = layout.bounds;
    const m = 120;
    map.flyToBounds([toLatLng(b.min_x - m, b.min_y - m), toLatLng(b.max_x + m, b.max_y + m)], { duration: 1.6 });
  };

  // Build the network's map objects when the geometry or anchor changes, then fly to it.
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!ready || !L || !map || !layout?.bounds || (!isGeo && !anchor)) return;
    drawn.current?.group.remove();
    const group = L.layerGroup().addTo(map);
    const pos = {};
    for (const n of layout.nodes) {
      const p = nodeLatLng(n);
      if (p) pos[n.id] = p;
    }
    const byId = Object.fromEntries(layout.nodes.map(n => [n.id, n]));
    const lens = layout.links.filter(([a, c]) => pos[a] && pos[c])
      .map(([a, c]) => Math.hypot(byId[a].x - byId[c].x, byId[a].y - byId[c].y)).sort((x, y) => x - y);
    const Lm = lens.length ? lens[Math.floor(lens.length / 2)] : 150;

    const links = layout.links.filter(([a, c]) => pos[a] && pos[c]).map(([a, c]) => ({
      a, c,
      glow: L.polyline([pos[a], pos[c]], { pane: 'heat', weight: 16, lineCap: 'round', interactive: false }).addTo(group),
      line: L.polyline([pos[a], pos[c]], { pane: 'roads', weight: 4, opacity: 0.95, lineCap: 'round', interactive: false }).addTo(group),
    }));
    const nodes = layout.nodes.filter(n => pos[n.id]).map(n => {
      const rings = RINGS.map(([, op]) => L.circle(pos[n.id], { pane: 'heat', radius: 1, stroke: false, fillOpacity: op, interactive: false }).addTo(group));
      const marker = L.circleMarker(pos[n.id], { pane: 'nodes', fillOpacity: 1 }).addTo(group);
      marker.bindTooltip('', { direction: 'top', offset: [0, -6], className: 'world-tip' });
      marker.on('click', () => onSelectRef.current?.(n.id));
      return { id: n.id, node: n, rings, marker };
    });
    // A synthetic grid gets a beacon at its anchor; a real network needs none
    const beacon = isGeo ? null : L.marker([anchor.lat, anchor.lon], { pane: 'nodes', icon: L.divIcon({ className: '', html: '<div class="world-beacon"><span></span></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) })
      .bindTooltip('', { className: 'world-tip' })
      .addTo(group);
    beacon?.on('click', fit);
    const routeGroup = L.layerGroup().addTo(group);
    drawn.current = { group, links, nodes, beacon, routeGroup, pos, Lm };

    const key = isGeo ? `geo,${layoutKey}` : `${anchor.lat},${anchor.lon},${layoutKey}`;
    if (fittedFor.current !== key) {
      fittedFor.current = key;
      fit();
    }
  }, [ready, layoutKey, anchor, isGeo]);

  // Telemetry updates restyle the existing objects, so open tooltips and the view are not disturbed.
  useEffect(() => {
    const d = drawn.current;
    if (!ready || !d) return;
    for (const l of d.links) {
      const s = Math.max(sev(junctions?.[l.a]), sev(junctions?.[l.c]));
      l.glow.setStyle({ color: HEAT[s], weight: 12 + s * 6, opacity: s ? 0.6 : 0.15 });
      l.line.setStyle({ color: HEAT[s] });
    }
    let worst = 0, totalQ = 0;
    for (const n of d.nodes) {
      const j = junctions?.[n.id];
      const s = sev(j);
      worst = Math.max(worst, s);
      totalQ += j?.queue || 0;
      n.rings.forEach((r, i) => {
        r.setRadius(s ? d.Lm * (0.25 + s * 0.17) * RINGS[i][0] : 0);
        r.setStyle({ fillColor: HEAT[s] });
      });
      const isSel = selected === n.id;
      n.marker.setStyle({ radius: isSel ? 8 : 5.5, color: isSel ? 'var(--text-primary)' : 'var(--bg-surface)', weight: isSel ? 2.5 : 1.5, fillColor: HEAT[s] });
      n.marker.setRadius(isSel ? 8 : 5.5);
      n.marker.setTooltipContent(tipHtml(n.node, j));
    }
    if (d.beacon) {
      const el = d.beacon.getElement()?.querySelector('.world-beacon');
      if (el) el.style.setProperty('--c', HEAT[worst]);
      d.beacon.setTooltipContent(`<b>Synthetic network</b><br/>${esc(anchor?.name || '')}<br/>${d.nodes.length} junctions · total queue ${Math.round(totalQ)} veh`);
    }

    d.routeGroup.clearLayers();
    const L = LRef.current;
    for (let i = 1; i < route.length; i++) {
      const p = d.pos[route[i - 1]], q = d.pos[route[i]];
      if (p && q) L.polyline([p, q], { pane: 'roads', color: 'var(--accent)', weight: 6, dashArray: '10 8', opacity: 0.95, interactive: false }).addTo(d.routeGroup);
    }
  }, [ready, layoutKey, anchor, junctions, selected, route, isGeo]);

  const pickCity = e => {
    const c = CITIES.find(x => x[0] === e.target.value);
    if (!c) return;
    const a = { lat: c[1], lon: c[2], name: c[0] };
    setAnchor(a);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(a)); } catch { }
  };

  return (
    <div ref={wrapRef} className={'world-map' + (isFull ? ' is-full' : '')}>
      <div className="world-bar">
        {isGeo ? (
          <span className="world-geo-badge" title="Positions come from the OpenStreetMap import of this network">
            <MapPin size={13} /> {layout.nodes.length} real traffic lights · OpenStreetMap positions
          </span>
        ) : (
          <>
            <select value={CITIES.some(c => c[0] === anchor?.name) ? anchor.name : ''} onChange={pickCity} title="Place the synthetic grid in this city">
              <option value="" disabled>{anchor?.name || 'Choose a city'}</option>
              {CITIES.map(c => <option key={c[0]} value={c[0]}>{c[0]}</option>)}
            </select>
            <button type="button" className={'small ' + (placeMode ? 'on' : '')} onClick={() => setPlaceMode(x => !x)} title="Click anywhere on the map to place the grid there">
              <MapPin size={13} /> {placeMode ? 'Click on map…' : 'Place anywhere'}
            </button>
          </>
        )}
        <button type="button" className="small" onClick={fit} title="Fly to the network"><Crosshair size={13} /> Fly to network</button>
        <button type="button" className="small" onClick={() => mapRef.current?.flyTo([20, 30], 2, { duration: 1.4 })} title="Whole world">
          <Globe2 size={13} /> World
        </button>
        <div className="tabs world-base">
          {Object.entries(BASES).map(([k, b]) => (
            <button key={k} type="button" className={base === k ? 'on' : ''} onClick={() => setBase(k)}>{b.label}</button>
          ))}
        </div>
        <button type="button" className="small" onClick={toggleFull} title={isFull ? 'Exit full screen' : 'Full screen'} style={{ marginLeft: 'auto' }}>
          {isFull ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>
      <div ref={mapEl} className={'world-canvas' + (base === 'dark' ? ' world-dark' : '')} style={{ height: isFull ? undefined : height, cursor: placeMode ? 'crosshair' : undefined }} />
      {isGeo ? (
        <p className="muted small" style={{ margin: '8px 2px 0' }}>
          Every node is a traffic light from OpenStreetMap at its real position (© OpenStreetMap contributors, ODbL). Colours are the live
          SUMO simulation&apos;s congestion on those real roads, not measured real-world traffic.
        </p>
      ) : (
        <p className="world-synthetic-note">
          This is a <b>synthetic grid</b>, so it has no real-world location and is only drawn to scale at the chosen place.
          To simulate real traffic lights, start a job on a <b>Real-world area</b> network.
        </p>
      )}
    </div>
  );
}
