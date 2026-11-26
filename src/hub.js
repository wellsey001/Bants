// Tracks live WebSocket connections and fans events out to users.
import { q } from './db.js';

const connections = new Map(); // userId -> Set<{ conn, tokenHash }>

export function addConnection(userId, entry) {
  let set = connections.get(userId);
  const wasOffline = !set || set.size === 0;
  if (!set) connections.set(userId, (set = new Set()));
  set.add(entry);
  return wasOffline;
}

export function removeConnection(userId, entry) {
  const set = connections.get(userId);
  if (!set) return false;
  set.delete(entry);
  if (set.size === 0) {
    connections.delete(userId);
    return true; // went offline
  }
  return false;
}

export const isOnline = (userId) => (connections.get(userId)?.size || 0) > 0;

export function sendToUser(userId, event, exceptTokenHash = null) {
  const set = connections.get(userId);
  if (!set) return;
  const payload = JSON.stringify(event);
  for (const entry of set) if (entry.tokenHash !== exceptTokenHash) entry.conn.send(payload);
}

/** Sends to one signed-in device (session) of a user. */
export function sendToSession(userId, tokenHash, event) {
  const set = connections.get(userId);
  if (!set) return false;
  const payload = JSON.stringify(event);
  let sent = false;
  for (const entry of set) {
    if (entry.tokenHash === tokenHash) {
      entry.conn.send(payload);
      sent = true;
    }
  }
  return sent;
}

export function sendToConversation(conversationId, event, { exceptUserId = null } = {}) {
  const rows = q('SELECT user_id FROM members WHERE conversation_id = ?').all(conversationId);
  for (const { user_id } of rows) if (user_id !== exceptUserId) sendToUser(user_id, event);
}

/** Disconnects a single session (on logout) or all of a user's sessions (on account deletion). */
export function disconnect(userId, tokenHash = null) {
  const set = connections.get(userId);
  if (!set) return;
  for (const entry of [...set]) if (!tokenHash || entry.tokenHash === tokenHash) entry.conn.close(4001, 'Signed out');
}

export function allConnections() {
  const out = [];
  for (const set of connections.values()) for (const e of set) out.push(e.conn);
  return out;
}
