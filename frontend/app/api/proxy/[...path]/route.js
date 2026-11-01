import { getSiteConfig } from '@/lib/siteConfig';
import { checkBackendRequest } from '@/lib/labGuard';

// Proxy all /api/proxy/* requests to the Java Spring Boot backend (port 8080)
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8080';
const gatewayHeaders = () => (process.env.TSI_GATEWAY_SECRET ? { 'X-TSI-Gateway-Secret': process.env.TSI_GATEWAY_SECRET } : {});
const denied = decision => Response.json({ error: decision.error, detail: decision.detail }, { status: 403, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request, { params }) {
  const { path } = await params;
  const decision = checkBackendRequest(await getSiteConfig(), 'GET', path);
  if (!decision.allowed) return denied(decision);
  const target = `${BACKEND}/${path.join('/')}${request.nextUrl.search}`;
  const res = await fetch(target, {
    headers: { 'Content-Type': 'application/json', ...gatewayHeaders() },
    cache: 'no-store',
  });
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
  });
}

export async function POST(request, { params }) {
  const { path } = await params;
  const decision = checkBackendRequest(await getSiteConfig(), 'POST', path);
  if (!decision.allowed) return denied(decision);
  const target = `${BACKEND}/${path.join('/')}${request.nextUrl.search}`;
  const bodyText = await request.text();
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...gatewayHeaders() },
    body: bodyText,
    cache: 'no-store',
  });
  const resBody = await res.text();
  return new Response(resBody, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
  });
}
