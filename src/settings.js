import { q } from './db.js';
import { config } from './config.js';

/** Settings changed on the admin page win over the container's environment variables. */
export function getSetting(key, fallback) {
  const row = q('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

/**
 * The server's secure (https) address, so the web version can send people there when they've
 * opened it on a plain http address (where browsers block cameras and microphones).
 * Set PUBLIC_URL, or it's learnt from the first request that comes in through an https proxy
 * like Cloudflare Tunnel.
 */
let publicUrl = null;
export function getPublicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  if (publicUrl === null) publicUrl = getSetting('publicUrl', '') || '';
  return publicUrl || null;
}
export function notePublicUrl(req) {
  if (process.env.PUBLIC_URL) return;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const cf = String(req.headers['cf-visitor'] || '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!(proto === 'https' || cf.includes('"https"')) || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return;
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return;
  const url = `https://${host}`;
  if (getPublicUrl() === url) return;
  publicUrl = url;
  setSetting('publicUrl', url);
}

export function registrationSettings() {
  return {
    allowRegistration: getSetting('allowRegistration', String(config.allowRegistration)) !== 'false',
    inviteCode: getSetting('inviteCode', config.inviteCode) || '',
  };
}
