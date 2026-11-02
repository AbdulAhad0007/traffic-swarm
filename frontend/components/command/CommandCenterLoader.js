'use client';

import dynamic from 'next/dynamic';

// Loads Cesium only after the page is up, so the sections below the city do not wait for it.
const CommandCenter = dynamic(() => import('./CommandCenter'), {
  ssr: false,
  loading: () => <section className="panel muted">Loading the live city…</section>,
});

export default function CommandCenterLoader() {
  return <CommandCenter />;
}
