import { NextResponse } from 'next/server';
import {
  SESSION_COOKIE, clearFailures, clientIp, createSession, credentialsMatch, isAuthConfigured, isLockedOut, isSameOrigin,
  jsonError, noStore, recordFailure, sessionCookieOptions,
} from '@/lib/adminAuth';
import { isDbConfigured } from '@/lib/supabaseRest';

export async function POST(request) {
  if (!isSameOrigin(request)) return jsonError(403, 'invalid_origin');
  if (!isAuthConfigured() || !isDbConfigured()) return jsonError(503, 'admin_not_configured');

  const body = await request.json().catch(() => null);
  const username = typeof body?.username === 'string' ? body.username.slice(0, 200) : '';
  const password = typeof body?.password === 'string' ? body.password.slice(0, 1000) : '';
  if (!username || !password) return jsonError(400, 'invalid_credentials');

  const ip = clientIp(request);
  try {
    if (await isLockedOut(username, ip)) return jsonError(429, 'too_many_attempts');
    if (!(await credentialsMatch(username, password))) {
      await recordFailure(username, ip);
      return jsonError(401, 'invalid_credentials');
    }
    await clearFailures(username, ip);
    const token = await createSession();
    const res = NextResponse.json({ ok: true }, { headers: noStore });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(request));
    return res;
  } catch (err) {
    console.error('Admin login failed:', err.message);
    return jsonError(503, 'service_unavailable');
  }
}
