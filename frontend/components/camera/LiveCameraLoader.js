'use client';

import dynamic from 'next/dynamic';

const LiveCamera = dynamic(() => import('./LiveCamera'), {
  ssr: false,
  loading: () => <section className="panel"><p className="muted">Loading Live Camera…</p></section>,
});

export default function LiveCameraLoader() {
  return <LiveCamera />;
}
