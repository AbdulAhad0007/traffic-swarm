'use client';

import { useEffect, useRef, useState } from 'react';

const BASE = '/api/camera';
const MAX_EVENTS = 500;

export async function cameraApi(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(`${BASE}/${path}`, {
    method,
    cache: 'no-store',
    headers: raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: raw || (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error(data?.detail || data?.error || `Request failed (${res.status})`);
  return data;
}

// One server-sent event stream for the page. Pipeline events and detections go to listeners as they arrive,
// so packets and boxes appear only when the backend reports something, and never from a timer here.
export function useCameraFeed() {
  const [overview, setOverview] = useState(null);
  const [events, setEvents] = useState([]);
  const [connection, setConnection] = useState('connecting');
  const [session, setSession] = useState({ admin: false });
  const listeners = useRef(new Set());
  const detections = useRef({});
  const seq = useRef(0);

  useEffect(() => {
    cameraApi('session').then(setSession).catch(() => {});
    const source = new EventSource(`${BASE}/stream`);
    source.onopen = () => setConnection('open');
    source.onerror = () => setConnection('lost');
    source.onmessage = message => {
      let data;
      try { data = JSON.parse(message.data); } catch { return; }
      setConnection('open');
      if (data.overview) setOverview(data.overview);
      if (data.detections) {
        Object.assign(detections.current, data.detections);
        for (const fn of listeners.current) fn({ detections: data.detections });
      }
      if (data.events?.length) {
        const fresh = data.events.filter(e => e.seq > seq.current);
        if (!fresh.length) return;
        seq.current = fresh[fresh.length - 1].seq;
        setEvents(old => [...old, ...fresh].slice(-MAX_EVENTS));
        for (const fn of listeners.current) fn({ events: fresh });
      }
    };
    return () => source.close();
  }, []);

  const subscribe = useRef(fn => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }).current;

  return { overview, events, connection, session, subscribe, detections };
}

// Poll an endpoint while a panel is on screen.
export function usePolled(path, ms = 2000, enabled = true) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path || !enabled) return undefined;
    let active = true;
    const load = () => cameraApi(path).then(d => { if (active) { setData(d); setError(null); } }).catch(e => { if (active) setError(e.message); });
    load();
    const t = setInterval(load, ms);
    return () => { active = false; clearInterval(t); };
  }, [path, ms, enabled, tick]);
  return { data, error, refresh: () => setTick(t => t + 1) };
}

export const when = iso => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString(undefined, { hour12: false });
};
export const num = (v, digits = 0) => (v === null || v === undefined ? '—' : Number(v).toFixed(digits));
export const CLASS_LABEL = { LIVE: 'LIVE', TEST: 'TEST SOURCE', REPLAY: 'REPLAY' };
export const VEHICLES = ['car', 'motorcycle', 'bus', 'truck', 'bicycle'];
// Checked per theme for color-blind separation; buses and trucks also have dashed boxes, and every box has a text label.
export const VEHICLE_TOKEN = { car: '--veh-car', motorcycle: '--veh-motorcycle', bus: '--veh-bus', truck: '--veh-truck', bicycle: '--veh-bicycle' };

export function DataClass({ value }) {
  return <span className={`lcm-class lcm-class-${(value || 'none').toLowerCase()}`}>{CLASS_LABEL[value] || value}</span>;
}

export function StatusPill({ status }) {
  return <span className={`lcm-status lcm-st-${String(status).toLowerCase()}`}><i />{String(status).replace(/_/g, ' ')}</span>;
}
