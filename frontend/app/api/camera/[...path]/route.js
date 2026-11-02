import { cookies } from 'next/headers';
import { hasValidSession, isSameOrigin, SESSION_COOKIE } from '@/lib/adminAuth';
import { checkCameraRequest } from '@/lib/cameraGuard';
import { getSiteConfig } from '@/lib/siteConfig';

// Proxy to the Python camera service. Credentials, RTSP addresses and the service itself stay behind this.
const CAMERA_BACKEND = process.env.CAMERA_URL || 'http://localhost:8091';
const noStore = { 'Cache-Control': 'no-store' };
const json = (status, body) => Response.json(body, { status, headers: noStore });
const STATUS = { admin_required: 401, video_restricted: 403, module_disabled: 403, endpoint_not_allowed: 403 };

// Reads repeat many times a second for video, so a confirmed session is remembered briefly. Writes always ask the database.
const SESSION_CACHE_MS = 30000;
const sessions = (globalThis.__tsiCameraSessions ??= new Map());

async function isAdmin(fresh) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return false;
  const known = sessions.get(token);
  if (!fresh && known && Date.now() - known.at < SESSION_CACHE_MS) return known.valid;
  const valid = await hasValidSession();
  if (sessions.size > 200) sessions.clear();
  sessions.set(token, { valid, at: Date.now() });
  return valid;
}

async function forward(request, { params }) {
  const { path } = await params;
  const write = request.method !== 'GET';
  if (write && !isSameOrigin(request)) return json(403, { error: 'invalid_origin' });
  const admin = await isAdmin(write);
  if (path.join('/') === 'session') {
    return json(200, { admin, enabled: (await getSiteConfig()).modules['live-camera']?.enabled === true });
  }
  // `next dev` opened on this machine shows video without a login. A production build never takes this path.
  const localDevVideo = process.env.NODE_ENV === 'development' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(request.headers.get('host') || '');
  const decision = checkCameraRequest(await getSiteConfig(), request.method, path, admin, { localDevVideo });
  if (!decision.allowed) return json(STATUS[decision.error] || 403, { error: decision.error, detail: decision.detail });

  const headers = { 'X-TSI-Role': admin ? 'admin' : 'public' };
  if (process.env.TSI_GATEWAY_SECRET) headers['X-TSI-Gateway-Secret'] = process.env.TSI_GATEWAY_SECRET;
  const type = request.headers.get('content-type');
  if (type) headers['Content-Type'] = type;
  const res = await fetch(`${CAMERA_BACKEND}/api/camera/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`, {
    method: request.method,
    headers,
    // Streamed through, so a video upload is not held in this server's memory.
    ...(write && request.body ? { body: request.body, duplex: 'half' } : {}),
    signal: request.signal,
    cache: 'no-store',
  }).catch(() => null);
  if (!res) return json(503, { error: 'service_unreachable', detail: 'The camera service is not reachable. Start it with: uvicorn camera_service.api:app --port 8091' });

  const out = new Headers(noStore);
  for (const name of ['content-type', 'x-frame-number', 'x-frame-received', 'x-frame-width', 'x-frame-height', 'x-data-class', 'x-accel-buffering']) {
    const value = res.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(res.status === 204 ? null : res.body, { status: res.status, headers: out });
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const DELETE = forward;
