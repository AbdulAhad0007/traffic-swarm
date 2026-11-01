// scrypt password hashes from Node's crypto. Format: scrypt:N:r:p:salt:hash (base64url), which has no '$'
// because Next's env loader would try to expand one.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 32768, R = 8, P = 1, KEY_LEN = 32;
const options = (n, r, p) => ({ N: n, r, p, maxmem: 256 * n * r });

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN, options(N, R, P));
  return ['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join(':');
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isInteger)) return false;
  const expected = Buffer.from(parts[5], 'base64url');
  if (!expected.length) return false;
  try {
    const actual = scryptSync(String(password), Buffer.from(parts[4], 'base64url'), expected.length, options(n, r, p));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
