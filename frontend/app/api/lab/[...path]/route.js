import { getSiteConfig } from '@/lib/siteConfig';
import { checkLabRequest } from '@/lib/labGuard';

// Proxy all /api/lab/* requests to the Python FastAPI lab server (port 8090)
const LAB_BACKEND = process.env.LAB_URL || 'http://localhost:8090';
const gatewayHeaders = () => (process.env.TSI_GATEWAY_SECRET ? { 'X-TSI-Gateway-Secret': process.env.TSI_GATEWAY_SECRET } : {});
const unreachable = () => Response.json({ detail: 'The simulation service is not reachable. Start it with: uvicorn experiments.lab.api:app --port 8090' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
const denied = decision => Response.json({ error: decision.error, detail: decision.detail }, { status: 403, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request, { params }) {
  const { path } = await params;
  const decision = checkLabRequest(await getSiteConfig(), 'GET', path);
  if (!decision.allowed) return denied(decision);
  const pathStr = path.join('/');
  const finalPath = pathStr.startsWith('api/lab') ? pathStr : `api/lab/${pathStr}`;
  const target = `${LAB_BACKEND}/${finalPath}${request.nextUrl.search}`;
  const res = await fetch(target, {
    headers: { 'Content-Type': 'application/json', ...gatewayHeaders() },
    cache: 'no-store',
  }).catch(() => null);
  if (!res) return unreachable();
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
  });
}

export async function POST(request, { params }) {
  const { path } = await params;
  const bodyText = await request.text();
  const decision = checkLabRequest(await getSiteConfig(), 'POST', path, bodyText);
  if (!decision.allowed) return denied(decision);
  const pathStr = path.join('/');
  const finalPath = pathStr.startsWith('api/lab') ? pathStr : `api/lab/${pathStr}`;
  const target = `${LAB_BACKEND}/${finalPath}${request.nextUrl.search}`;
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...gatewayHeaders() },
    body: bodyText,
    cache: 'no-store',
  }).catch(() => null);
  if (!res) return unreachable();
  const resBody = await res.text();
  return new Response(resBody, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
  });
}
