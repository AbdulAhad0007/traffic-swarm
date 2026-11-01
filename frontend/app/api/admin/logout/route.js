import { NextResponse } from 'next/server';
import { SESSION_COOKIE, deleteSession, isSameOrigin, jsonError, noStore, sessionCookieOptions } from '@/lib/adminAuth';

export async function POST(request) {
  if (!isSameOrigin(request)) return jsonError(403, 'invalid_origin');
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await deleteSession(token);
    } catch (err) {
      console.error('Admin logout could not revoke the session:', err.message);
      return jsonError(503, 'service_unavailable');
    }
  }
  const res = NextResponse.json({ ok: true }, { headers: noStore });
  res.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(request, 0));
  return res;
}
