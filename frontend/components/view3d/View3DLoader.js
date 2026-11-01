'use client';

import dynamic from 'next/dynamic';

// Keeps Cesium out of every other page's bundle: it loads only when this route renders.
const View3D = dynamic(() => import('./View3D'), {
  ssr: false,
  loading: () => <section className="panel muted">Loading 3D View…</section>,
});

export default function View3DLoader() {
  return <View3D />;
}
