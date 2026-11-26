import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { q } from './db.js';

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, expected);
}

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function createSession(userId, deviceName = '') {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  q('INSERT INTO sessions (token_hash, user_id, device_name, created_at, last_used) VALUES (?, ?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    String(deviceName).slice(0, 80),
    now,
    now,
  );
  return token;
}

const touchCache = new Map();
/** Returns { userId, tokenHash } for a valid token, or null. */
export function authenticate(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = q('SELECT user_id FROM sessions WHERE token_hash = ?').get(tokenHash);
  if (!row) return null;
  // Update last_used at most once a minute per session.
  const now = Date.now();
  if ((touchCache.get(tokenHash) || 0) < now - 60_000) {
    touchCache.set(tokenHash, now);
    q('UPDATE sessions SET last_used = ? WHERE token_hash = ?').run(now, tokenHash);
  }
  return { userId: row.user_id, tokenHash };
}

// Friend codes: 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L), shown as XXXX-XXXX.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function newFriendCode() {
  while (true) {
    const bytes = crypto.randomBytes(8);
    let code = '';
    for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
    if (!q('SELECT 1 FROM users WHERE friend_code = ?').get(code)) return code;
  }
}
export const formatFriendCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;
export const normaliseFriendCode = (input) => String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Simple in-memory limiter for login/register attempts.
const attempts = new Map();
export function rateLimited(key, max = 10, windowMs = 15 * 60_000) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.reset < now) {
    attempts.set(key, { count: 1, reset: now + windowMs });
    return false;
  }
  entry.count++;
  return entry.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
}, 60_000).unref();
