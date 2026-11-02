'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Maximize, Minimize, VideoOff, Lock } from 'lucide-react';
import { useThemeTokens } from '@/lib/themeClient';
import { DataClass, StatusPill, VEHICLE_TOKEN, num, when } from './feed';

const OFFLINE = new Set(['STOPPED', 'RECONNECTING', 'OFFLINE']);
const TRAIL_POINTS = 24;
// Read once per theme. Reading computed styles while drawing forces a style recalculation for every box.
const OVERLAY_TOKENS = [...new Set([...Object.values(VEHICLE_TOKEN), '--accent', '--bg-sunken', '--font-mono'])];

function drawOverlay(canvas, frameW, frameH, detection, trails, layers, tokens) {
  const ctx = canvas.getContext('2d');
  if (!detection || !frameW) return;
  const sx = canvas.width / frameW, sy = canvas.height / frameH;
  const font = tokens['--font-mono'] || 'monospace';
  const ink = tokens['--bg-sunken'];
  const tokenColor = cls => tokens[VEHICLE_TOKEN[cls] || '--accent'];
  ctx.lineJoin = 'round';
  if (layers.trails) {
    for (const points of Object.values(trails)) {
      if (points.length < 2) continue;
      ctx.strokeStyle = tokenColor(points.cls);
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 2;
      ctx.beginPath();
      points.forEach(([x, y], i) => (i ? ctx.lineTo(x * sx, y * sy) : ctx.moveTo(x * sx, y * sy)));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  for (const o of detection.objects) {
    const [x1, y1, x2, y2] = o.box;
    const color = tokenColor(o.cls);
    if (layers.boxes) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(o.cls === 'truck' || o.cls === 'bus' ? [8, 4] : []);
      ctx.strokeRect(x1 * sx, y1 * sy, (x2 - x1) * sx, (y2 - y1) * sy);
      ctx.setLineDash([]);
    }
    const parts = [];
    if (layers.labels) parts.push(`${o.cls} ${Math.round(o.conf * 100)}%`);
    if (layers.ids && o.track_id != null) parts.push(`#${o.track_id}`);
    if (parts.length) {
      const text = parts.join(' ');
      ctx.font = `11px ${font}`;
      const w = ctx.measureText(text).width + 8;
      const top = Math.max(0, y1 * sy - 16);
      ctx.fillStyle = color;
      ctx.fillRect(x1 * sx, top, w, 16);
      ctx.fillStyle = ink;
      ctx.fillText(text, x1 * sx + 4, top + 12);
    }
  }
}

// Video comes from the stream reader, one real frame at a time. When none arrives, nothing is drawn but the offline state.
export function useFrames(cameraId, enabled, onFrame) {
  const [state, setState] = useState({ restricted: false, hasFrame: false });
  useEffect(() => {
    if (!enabled) { setState({ restricted: false, hasFrame: false }); return undefined; }
    let active = true, after = -1, timer = null;
    const controller = new AbortController();
    const loop = async () => {
      if (!active) return;
      if (document.hidden) { timer = setTimeout(loop, 500); return; }
      try {
        const res = await fetch(`/api/camera/cameras/${cameraId}/frame.jpg?after=${after}&wait=1`, { cache: 'no-store', signal: controller.signal });
        if (res.status === 403) { setState({ restricted: true, hasFrame: false }); timer = setTimeout(loop, 5000); return; }
        if (res.status === 200) {
          after = Number(res.headers.get('x-frame-number'));
          const bitmap = await createImageBitmap(await res.blob());
          if (!active) { bitmap.close(); return; }
          onFrame(bitmap, Number(res.headers.get('x-frame-width')), Number(res.headers.get('x-frame-height')));
          setState(s => (s.hasFrame && !s.restricted ? s : { restricted: false, hasFrame: true }));
        } else if (res.status !== 204) {
          setState(s => ({ ...s, hasFrame: false }));
          timer = setTimeout(loop, 1500);
          return;
        }
        timer = setTimeout(loop, 0);
      } catch (err) {
        if (err.name !== 'AbortError' && active) timer = setTimeout(loop, 1500);
      }
    };
    loop();
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  // onFrame is a stable ref-based callback in every caller.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, enabled]);
  return state;
}

export default function CameraTile({ camera, selected, onSelect, subscribe, layers, large }) {
  const rootRef = useRef(null);
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const size = useRef({ w: 0, h: 0 });
  const detection = useRef(null);
  const trails = useRef({});
  const layersRef = useRef(layers);
  const [fullscreen, setFullscreen] = useState(false);
  const tokens = useThemeTokens(OVERLAY_TOKENS);
  const tokensRef = useRef(tokens);
  layersRef.current = layers;
  tokensRef.current = tokens;

  const redraw = () => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
    drawOverlay(overlay, size.current.w, size.current.h, detection.current, trails.current, layersRef.current, tokensRef.current);
  };

  const onFrame = (bitmap, w, h) => {
    const video = videoRef.current;
    if (!video) { bitmap.close(); return; }
    if (video.width !== w || video.height !== h) {
      video.width = w; video.height = h;
      overlayRef.current.width = w; overlayRef.current.height = h;
    }
    size.current = { w, h };
    video.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
  };

  const connected = camera.status === 'CONNECTED';
  const { restricted, hasFrame } = useFrames(camera.id, !OFFLINE.has(camera.status), onFrame);

  useEffect(() => subscribe(message => {
    const d = message.detections?.[camera.id];
    if (!d) return;
    detection.current = d;
    const live = new Set();
    for (const o of d.objects) {
      if (o.track_id == null) continue;
      live.add(String(o.track_id));
      const t = (trails.current[o.track_id] ??= Object.assign([], { cls: o.cls }));
      t.push([(o.box[0] + o.box[2]) / 2, o.box[3]]);
      if (t.length > TRAIL_POINTS) t.shift();
    }
    for (const id of Object.keys(trails.current)) if (!live.has(id)) delete trails.current[id];
    redraw();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [camera.id, subscribe]);

  // A stream that drops takes its boxes with it.
  useEffect(() => {
    if (!connected) { detection.current = null; trails.current = {}; redraw(); }
    else redraw();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, layers, tokens]);

  useEffect(() => {
    const change = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);

  const toggleFull = e => {
    e.stopPropagation();
    if (document.fullscreenElement) document.exitFullscreen?.();
    else rootRef.current?.requestFullscreen?.();
  };

  const showVideo = connected && hasFrame && !restricted;
  return (
    <article ref={rootRef} className={`lcm-tile ${selected ? 'is-selected' : ''} ${large ? 'is-large' : ''} ${fullscreen ? 'is-full' : ''}`} data-class={camera.data_class}>
      <div className="lcm-video" role="button" tabIndex={0} aria-label={`Inspect ${camera.camera_name}`} onClick={() => onSelect(camera.id)} onKeyDown={e => { if (e.key === 'Enter') onSelect(camera.id); }}>
        <canvas ref={videoRef} className="lcm-canvas" style={{ visibility: showVideo ? 'visible' : 'hidden' }} />
        <canvas ref={overlayRef} className="lcm-canvas lcm-overlay" style={{ visibility: showVideo ? 'visible' : 'hidden' }} />
        {!showVideo && (
          <div className="lcm-novideo">
            {restricted ? <Lock size={28} /> : <VideoOff size={28} />}
            <b>{restricted ? 'Video restricted' : connected ? 'Waiting for the first frame' : 'No signal'}</b>
            <span>{restricted ? 'Sign in as an administrator to view video. Live measurements continue below.' : camera.status === 'STOPPED' ? 'This camera is stopped.' : camera.detail || 'Trying to connect to the source.'}</span>
            {camera.next_retry_in_s != null && <span>Next attempt in {Math.max(0, camera.next_retry_in_s).toFixed(0)}s</span>}
          </div>
        )}
        <div className="lcm-video-top">
          <DataClass value={camera.data_class} />
          <button type="button" className="small icon" onClick={toggleFull} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>{fullscreen ? <Minimize size={14} /> : <Maximize size={14} />}</button>
        </div>
        {connected && camera.vehicle_count != null && <div className="lcm-video-count"><b>{camera.vehicle_count}</b> vehicles</div>}
      </div>
      <div className="lcm-tile-info">
        <div className="lcm-tile-head">
          <div><b>{camera.camera_name}</b><small>{camera.id} · {camera.location || camera.intersection_id}</small></div>
          <StatusPill status={camera.status} />
        </div>
        <dl className="lcm-facts">
          <div><dt>Protocol</dt><dd>{camera.protocol}</dd></div>
          <div><dt>FPS</dt><dd>{num(camera.fps, 1)}</dd></div>
          <div><dt>Resolution</dt><dd>{camera.width ? `${camera.width}×${camera.height}` : '—'}</dd></div>
          <div><dt>Last frame</dt><dd>{when(camera.last_frame)}</dd></div>
          <div><dt>Latency</dt><dd>{camera.latency_ms != null ? `${num(camera.latency_ms)} ms` : '—'}</dd></div>
          <div><dt>Detection</dt><dd>{camera.detection_status}</dd></div>
          <div><dt>Junction</dt><dd>{camera.intersection_id}</dd></div>
          <div><dt>Recording</dt><dd>{camera.recording == null ? 'Unknown' : camera.recording ? 'On' : 'Off'}</dd></div>
        </dl>
      </div>
    </article>
  );
}
