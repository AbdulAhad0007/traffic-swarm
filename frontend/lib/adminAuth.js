// Admin login, database-backed sessions and login throttling. Every failure here denies access.
import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { rest, isDbConfigured } from './supabaseRest';
import { verifyPassword } from './password';

export const SESSION_COOKIE = 'tsi_admin_session';
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_FAILURES = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const sameText = (a, b) => timingSafeEqual(Buffer.from(sha256(String(a))), Buffer.from(sha256(String(b))));

export const noStore = { 'Cache-Control': 'no-store' };
export const jsonError = (status, error) => Response.json({ error }, { status, headers: noStore });

export const isAuthConfigured = () => !!(
  (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD_HASH) || isDbConfigured()
);

// Checks env credentials first, and falls back to Supabase public.admin_credentials table.
export async function credentialsMatch(username, password) {
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD_HASH) {
    const passwordOk = verifyPassword(password, process.env.ADMIN_PASSWORD_HASH);
    if (sameText(username, process.env.ADMIN_USERNAME) && passwordOk) {
      return true;
    }
  }

  // Fallback to Supabase admin_credentials table
  if (isDbConfigured()) {
    try {
      const rows = await rest(`admin_credentials?username=eq.${encodeURIComponent(username)}&select=password_hash`);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (row?.password_hash) {
        return verifyPassword(password, row.password_hash);
      }
    } catch (err) {
      console.warn('Fallback admin_credentials table lookup failed:', err.message);
    }
  }

  return false;
}

const attemptKey = (username, ip) => sha256(`${String(username).toLowerCase()}|${ip}`);
export const clientIp = request => request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';

export async function isLockedOut(username, ip) {
  const [row] = await rest(`admin_login_attempts?key_hash=eq.${attemptKey(username, ip)}&select=failed_count,window_started_at`);
  return !!row && row.failed_count >= MAX_FAILURES && Date.now() - Date.parse(row.window_started_at) < LOCK_WINDOW_MS;
}

export async function recordFailure(username, ip) {
  const key = attemptKey(username, ip);
  const [row] = await rest(`admin_login_attempts?key_hash=eq.${key}&select=failed_count,window_started_at`);
  const fresh = !row || Date.now() - Date.parse(row.window_started_at) >= LOCK_WINDOW_MS;
  await rest('admin_login_attempts', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates',
    body: {
      key_hash: key,
      failed_count: fresh ? 1 : row.failed_count + 1,
      window_started_at: fresh ? new Date().toISOString() : row.window_started_at,
    },
  });
}

export const clearFailures = (username, ip) => rest(`admin_login_attempts?key_hash=eq.${attemptKey(username, ip)}`, { method: 'DELETE' });

export async function createSession() {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  await rest(`admin_sessions?expires_at=lt.${now.toISOString()}`, { method: 'DELETE' });
  await rest('admin_sessions', {
    method: 'POST',
    body: { token_hash: sha256(token), expires_at: new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString() },
  });
  return token;
}

export const deleteSession = token => rest(`admin_sessions?token_hash=eq.${sha256(token)}`, { method: 'DELETE' });

async function tokenIsValid(token) {
  if (!token) return false;
  try {
    const [row] = await rest(`admin_sessions?token_hash=eq.${sha256(token)}&expires_at=gt.${new Date().toISOString()}&select=token_hash`);
    return !!row;
  } catch (err) {
    console.error('Could not validate admin session:', err.message);
    return false;
  }
}

export async function hasValidSession() {
  return tokenIsValid((await cookies()).get(SESSION_COOKIE)?.value);
}

export function sessionCookieOptions(request, maxAge = SESSION_SECONDS) {
  const proto = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '');
  return { httpOnly: true, sameSite: 'strict', secure: proto === 'https', path: '/', maxAge };
}

// SameSite=Strict already stops cross-site cookies; writes also have to come from this site's own origin.
export function isSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// Guard for admin route handlers: returns an error Response, or null when the request may proceed.
export async function denyUnlessAdmin(request, { write = false } = {}) {
  if (write && !isSameOrigin(request)) return jsonError(403, 'invalid_origin');
  if (!(await hasValidSession())) return jsonError(401, 'unauthorized');
  return null;
}
