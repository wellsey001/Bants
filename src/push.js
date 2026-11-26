// Firebase Cloud Messaging (HTTP v1) without the firebase-admin package.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.js';
import { q } from './db.js';

let account = null;
if (config.fcmServiceAccount) {
  try {
    account = JSON.parse(fs.readFileSync(config.fcmServiceAccount, 'utf8'));
    console.log(`[push] FCM enabled for project ${account.project_id}`);
  } catch (err) {
    console.warn(`[push] Could not read FCM service account: ${err.message}. Push disabled.`);
  }
} else {
  console.log('[push] FCM_SERVICE_ACCOUNT not set. Push notifications disabled.');
}

export const pushEnabled = () => account !== null;

let accessToken = null;
let accessTokenExpiry = 0;

async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiry - 60_000) return accessToken;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  accessToken = json.access_token;
  accessTokenExpiry = Date.now() + json.expires_in * 1000;
  return accessToken;
}

/**
 * Sends a data-only push to every device a user is signed in on.
 * The app builds the notification itself, so it can group and style it.
 * All values in `data` must be strings (an FCM rule).
 */
export async function pushToUser(userId, data) {
  if (!account) return;
  const sessions = q('SELECT token_hash, push_token FROM sessions WHERE user_id = ? AND push_token IS NOT NULL').all(userId);
  if (!sessions.length) return;
  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    console.warn(`[push] ${err.message}`);
    return;
  }
  const stringData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? '')]));
  await Promise.all(
    sessions.map(async (s) => {
      try {
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: { token: s.push_token, data: stringData, android: { priority: 'high', ttl: '86400s' } },
          }),
        });
        if (res.status === 404 || res.status === 400) {
          const text = await res.text();
          if (text.includes('UNREGISTERED') || text.includes('INVALID_ARGUMENT')) {
            q('UPDATE sessions SET push_token = NULL WHERE token_hash = ?').run(s.token_hash);
          }
        }
      } catch (err) {
        console.warn(`[push] send failed: ${err.message}`);
      }
    }),
  );
}
