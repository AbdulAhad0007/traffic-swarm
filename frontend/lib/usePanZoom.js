'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Mouse-wheel zoom (around the cursor) and drag-to-pan for an SVG, done by moving its viewBox.
// Returns a ref for the <svg>, the current viewBox string and zoom level, plus button helpers.
export function usePanZoom(W, H, { maxZoom = 14 } = {}) {
  const ref = useRef(null);
  const drag = useRef(null);
  const moved = useRef(false);
  const [view, setView] = useState({ x: 0, y: 0, w: W, h: H });

  useEffect(() => setView({ x: 0, y: 0, w: W, h: H }), [W, H]);

  // Keep the zoomed window inside the drawing so the map can never be dragged off-screen.
  const clamp = useCallback(v => ({
    ...v,
    x: Math.min(W - v.w, Math.max(0, v.x)),
    y: Math.min(H - v.h, Math.max(0, v.y)),
  }), [W, H]);

  const zoomAt = useCallback((factor, px, py) => setView(v => {
    const w = Math.min(W, Math.max(W / maxZoom, v.w * factor));
    const h = (w * H) / W;
    const cx = px ?? v.x + v.w / 2;
    const cy = py ?? v.y + v.h / 2;
    if (w === W) return { x: 0, y: 0, w, h };
    return clamp({ x: cx - (cx - v.x) * (w / v.w), y: cy - (cy - v.y) * (h / v.h), w, h });
  }), [W, H, maxZoom, clamp]);

  const toSvg = (e) => {
    const svg = ref.current;
    const ctm = svg?.getScreenCTM();
    if (!ctm) return null;
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    return p.matrixTransform(ctm.inverse());
  };

  // Wheel must be a non-passive native listener so the page does not scroll while zooming.
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const onWheel = e => {
      e.preventDefault();
      const p = toSvg(e);
      zoomAt(e.deltaY < 0 ? 0.82 : 1 / 0.82, p?.x, p?.y);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const onMove = e => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.cx;
      const dy = e.clientY - d.cy;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved.current = true;
      setView(clamp({ ...d.view, x: d.view.x - dx * d.k, y: d.view.y - dy * d.k }));
    };
    const onUp = () => { drag.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [clamp]);

  const onPointerDown = e => {
    if (e.button !== 0) return;
    const rect = ref.current.getBoundingClientRect();
    moved.current = false;
    drag.current = {
      cx: e.clientX,
      cy: e.clientY,
      view,
      // preserveAspectRatio "meet": one screen pixel = the larger of the two ratios.
      k: Math.max(view.w / rect.width, view.h / rect.height),
    };
  };

  // A drag that ends over a junction must not count as a click on it.
  const onClickCapture = e => {
    if (moved.current) {
      e.stopPropagation();
      moved.current = false;
    }
  };

  return {
    ref,
    viewBox: `${view.x} ${view.y} ${view.w} ${view.h}`,
    zoom: W / view.w,
    zoomIn: () => zoomAt(0.7),
    zoomOut: () => zoomAt(1 / 0.7),
    reset: () => setView({ x: 0, y: 0, w: W, h: H }),
    handlers: { onPointerDown, onClickCapture },
  };
}

// Browser fullscreen for any element; `isFull` follows Esc and the browser's own exit too.
export function useFullscreen(ref) {
  const [isFull, setFull] = useState(false);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, [ref]);
  const toggle = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else ref.current?.requestFullscreen?.();
  };
  return [isFull, toggle];
}
