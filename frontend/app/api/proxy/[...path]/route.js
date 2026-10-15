// Proxy all /api/proxy/* requests to the Java Spring Boot backend (port 8080)
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8080';

export async function GET(request, { params }) {
  const { path } = await params;
  const target = `${BACKEND}/${path.join('/')}${request.nextUrl.search}`;
  const res = await fetch(target, {
    headers: { 'Content-Type': 'application/json' },
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
  const target = `${BACKEND}/${path.join('/')}${request.nextUrl.search}`;
  const bodyText = await request.text();
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bodyText,
    cache: 'no-store',
  });
  const resBody = await res.text();
  return new Response(resBody, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
  });
}
