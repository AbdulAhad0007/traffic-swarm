// Fetches recorded frames for one run and keeps the buffer ahead of the playback clock. Pauses with the browser tab.
import { lab } from '@/lib/api';

const READ_AHEAD_S = 20;
const BATCH = 30;
const POLL_MS = 1500;
const MAX_BACKOFF_MS = 15000;

export function createSimFeed({ jobId, controller, buffer, getPlayhead, onManifest, onConnection }) {
  let stopped = false, timer = 0, failures = 0, after = null, generation = 0, inFlight = false;
  let manifest = null;

  const url = () => {
    const q = new URLSearchParams({ controller, limit: String(BATCH) });
    if (after !== null) q.set('after', String(after));
    return `/api/lab/jobs/${jobId}/frames?${q}`;
  };

  const schedule = ms => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(poll, ms);
  };

  async function poll() {
    if (stopped || inFlight) return;
    if (document.hidden) { schedule(POLL_MS); return; }
    const head = getPlayhead();
    if (head !== null && buffer.newest !== null && buffer.newest - head > READ_AHEAD_S) { schedule(POLL_MS); return; }
    const mine = generation;
    inFlight = true;
    try {
      const data = await lab(url());
      if (stopped || mine !== generation) return;
      failures = 0;
      manifest = data;
      buffer.add(data.frames);
      if (data.frames.length) after = data.frames[data.frames.length - 1].t;
      onManifest(data);
      onConnection(data.status === 'running' ? 'live' : 'recording');
      schedule(data.frames.length >= BATCH ? 50 : POLL_MS);
    } catch (err) {
      if (stopped || mine !== generation) return;
      failures += 1;
      onConnection('offline', err.message);
      schedule(Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS));
    } finally {
      inFlight = false;
    }
  }

  const onVisibility = () => { if (!document.hidden) schedule(0); };
  document.addEventListener('visibilitychange', onVisibility);
  schedule(0);

  return {
    // Restart reading from just before t.
    seek(t) {
      generation += 1;
      inFlight = false;
      buffer.clear();
      after = t === null ? null : t - 1;
      schedule(0);
    },
    getManifest: () => manifest,
    destroy() {
      stopped = true;
      generation += 1;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
