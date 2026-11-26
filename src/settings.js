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

export function registrationSettings() {
  return {
    allowRegistration: getSetting('allowRegistration', String(config.allowRegistration)) !== 'false',
    inviteCode: getSetting('inviteCode', config.inviteCode) || '',
  };
}
