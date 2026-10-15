// Proxy all /api/lab/* requests to the Python FastAPI lab server (port 8090)
const LAB_BACKEND = process.env.LAB_URL || 'http://localhost:8090';

export async function GET(request, { params }) {
  const { path } = await params;
  const pathStr = path.join('/');
  const finalPath = pathStr.startsWith('api/lab') ? pathStr : `api/lab/${pathStr}`;
  const target = `${LAB_BACKEND}/${finalPath}${request.nextUrl.search}`;
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
  const pathStr = path.join('/');
  const finalPath = pathStr.startsWith('api/lab') ? pathStr : `api/lab/${pathStr}`;
  const target = `${LAB_BACKEND}/${finalPath}${request.nextUrl.search}`;
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
