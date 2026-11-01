// Server-only access to Supabase's REST API with the service role key. Row-level security keeps the admin
// tables closed to the public anon key, so this key must never reach the browser.
import 'server-only';

export const isDbConfigured = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

export async function rest(path, { method = 'GET', body, prefer } = {}) {
  if (!isDbConfigured()) throw new Error('Supabase is not configured');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Supabase request failed with status ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
