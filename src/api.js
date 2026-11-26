import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { config } from './config.js';
import { q, tx } from './db.js';
import {
  hashPassword,
  verifyPassword,
  createSession,
  newFriendCode,
  formatFriendCode,
  normaliseFriendCode,
  rateLimited,
} from './auth.js';
import { sendToUser, sendToConversation, isOnline, disconnect } from './hub.js';
import { pushToUser } from './push.js';

export class HttpError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (msg, code) => new HttpError(400, msg, code);
const notFound = (msg = 'Not found') => new HttpError(404, msg, 'not_found');
const forbidden = (msg = 'Not allowed') => new HttpError(403, msg, 'forbidden');

const USERNAME_RE = /^[a-z0-9_.]{3,24}$/i;
const MEDIA_DIR = () => path.join(config.dataDir, 'media');

// ───────────────────────── serialisers ─────────────────────────

export function userOut(row, viewerId = null) {
  if (!row) return null;
  const out = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    about: row.about,
    avatar: row.avatar_media,
  };
  // Online status / last seen are only shown to contacts.
  if (viewerId !== null && (viewerId === row.id || areContacts(viewerId, row.id))) {
    out.online = isOnline(row.id);
    out.lastSeen = row.last_seen;
  }
  return out;
}

function meOut(row) {
  return { ...userOut(row, row.id), friendCode: formatFriendCode(row.friend_code), createdAt: row.created_at };
}

export function messageOut(m) {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    senderId: m.sender_id,
    clientId: m.client_id,
    kind: m.kind,
    body: m.deleted ? '' : m.body,
    media: m.deleted ? null : m.media_id,
    replyTo: m.reply_to,
    createdAt: m.created_at,
    editedAt: m.edited_at,
    deleted: !!m.deleted,
  };
}

function conversationOut(convId, viewerId) {
  const c = q('SELECT * FROM conversations WHERE id = ?').get(convId);
  if (!c) return null;
  const memberRows = q(
    `SELECT m.role, m.last_read, m.last_delivered, m.muted, u.*
       FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = ? ORDER BY m.joined_at`,
  ).all(convId);
  const me = memberRows.find((r) => r.id === viewerId);
  const last = q('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(convId);
  const unread = q(
    `SELECT COUNT(*) AS n FROM messages
      WHERE conversation_id = ? AND id > ? AND deleted = 0 AND (sender_id IS NULL OR sender_id != ?)`,
  ).get(convId, me ? me.last_read : 0, viewerId).n;
  return {
    id: c.id,
    type: c.type,
    name: c.name,
    avatar: c.avatar_media,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    muted: !!me?.muted,
    unreadCount: unread,
    lastMessage: last ? messageOut(last) : null,
    members: memberRows.map((r) => ({
      user: userOut(r, viewerId),
      role: r.role,
      lastRead: r.last_read,
      lastDelivered: r.last_delivered,
    })),
  };
}

// ───────────────────────── helpers ─────────────────────────

function areContacts(a, b) {
  return !!q('SELECT 1 FROM contacts WHERE user_id = ? AND contact_id = ?').get(a, b);
}
function isBlocked(by, who) {
  return !!q('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?').get(by, who);
}
function getUser(id) {
  return q('SELECT * FROM users WHERE id = ?').get(id);
}
function requireMember(convId, userId) {
  const m = q('SELECT * FROM members WHERE conversation_id = ? AND user_id = ?').get(convId, userId);
  if (!m) throw notFound('Conversation not found');
  return m;
}
function requireAdmin(convId, userId) {
  const m = requireMember(convId, userId);
  const c = q('SELECT type FROM conversations WHERE id = ?').get(convId);
  if (c.type !== 'group') throw bad('Only group chats have admins');
  if (m.role !== 'admin') throw forbidden('Only group admins can do that');
  return m;
}
function str(v, max, field) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw bad(`${field} must be text`);
  const s = v.trim();
  if (s.length > max) throw bad(`${field} is too long (max ${max})`);
  return s;
}
function requireMedia(id, userId) {
  if (id === undefined || id === null) return null;
  const m = q('SELECT * FROM media WHERE id = ?').get(String(id));
  if (!m) throw bad('Unknown media id');
  if (m.uploader_id !== userId) throw forbidden('You can only attach media you uploaded');
  return m;
}

function getOrCreateDirect(a, b) {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`;
  const existing = q('SELECT id FROM conversations WHERE direct_key = ?').get(key);
  if (existing) return { id: existing.id, created: false };
  const now = Date.now();
  const { lastInsertRowid } = q(
    `INSERT INTO conversations (type, direct_key, created_by, created_at, updated_at) VALUES ('direct', ?, ?, ?, ?)`,
  ).run(key, a, now, now);
  const id = Number(lastInsertRowid);
  q('INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(id, a, 'member', now);
  q('INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(id, b, 'member', now);
  return { id, created: true };
}

function insertSystemMessage(convId, body) {
  const now = Date.now();
  const { lastInsertRowid } = q(
    `INSERT INTO messages (conversation_id, sender_id, kind, body, created_at) VALUES (?, NULL, 'system', ?, ?)`,
  ).run(convId, body, now);
  q('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
  return q('SELECT * FROM messages WHERE id = ?').get(Number(lastInsertRowid));
}

function broadcastConversation(convId, extraUserIds = []) {
  const ids = new Set(q('SELECT user_id FROM members WHERE conversation_id = ?').all(convId).map((r) => r.user_id));
  for (const id of extraUserIds) ids.add(id);
  for (const id of ids) {
    const conv = conversationOut(convId, id);
    sendToUser(id, conv && conv.members.some((m) => m.user.id === id) ? { type: 'conversation.updated', conversation: conv } : { type: 'conversation.removed', conversationId: convId });
  }
}

export function notifyContactsPresence(userId, online) {
  const user = getUser(userId);
  if (!user) return;
  const rows = q('SELECT user_id FROM contacts WHERE contact_id = ?').all(userId);
  for (const { user_id } of rows) {
    sendToUser(user_id, { type: 'presence', userId, online, lastSeen: user.last_seen });
  }
}

// ───────────────────────── message sending (shared by HTTP + WS) ─────────────────────────

export function sendMessage(userId, convId, input) {
  requireMember(convId, userId);
  const conv = q('SELECT * FROM conversations WHERE id = ?').get(convId);

  if (conv.type === 'direct') {
    const other = q('SELECT user_id FROM members WHERE conversation_id = ? AND user_id != ?').get(convId, userId);
    if (other && (isBlocked(other.user_id, userId) || isBlocked(userId, other.user_id))) {
      throw forbidden('You can’t message this person');
    }
  }

  const clientId = str(input.clientId, 64, 'clientId') || null;
  if (clientId) {
    // Retries with the same clientId return the original message instead of a duplicate.
    const dup = q('SELECT * FROM messages WHERE sender_id = ? AND client_id = ?').get(userId, clientId);
    if (dup) return { message: messageOut(dup), duplicate: true };
  }

  const body = str(input.body ?? input.text ?? '', 10_000, 'body') || '';
  const media = requireMedia(input.media, userId);
  let kind = 'text';
  if (media) {
    kind = media.mime.startsWith('image/')
      ? 'image'
      : media.mime.startsWith('video/')
        ? 'video'
        : media.mime.startsWith('audio/')
          ? 'audio'
          : 'file';
  }
  if (!body && !media) throw bad('Message is empty');

  let replyTo = null;
  if (input.replyTo !== undefined && input.replyTo !== null) {
    const r = q('SELECT id FROM messages WHERE id = ? AND conversation_id = ?').get(Number(input.replyTo), convId);
    if (!r) throw bad('replyTo message not found in this conversation');
    replyTo = r.id;
  }

  const now = Date.now();
  const row = tx(() => {
    const { lastInsertRowid } = q(
      `INSERT INTO messages (conversation_id, sender_id, client_id, kind, body, media_id, reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(convId, userId, clientId, kind, body, media ? media.id : null, replyTo, now);
    const id = Number(lastInsertRowid);
    q('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
    // The sender has obviously read their own message.
    q('UPDATE members SET last_read = ?, last_delivered = ? WHERE conversation_id = ? AND user_id = ?').run(id, id, convId, userId);
    return q('SELECT * FROM messages WHERE id = ?').get(id);
  });

  const message = messageOut(row);
  sendToConversation(convId, { type: 'message.new', message });

  // Push to members who aren't connected right now.
  const sender = getUser(userId);
  const others = q('SELECT user_id, muted FROM members WHERE conversation_id = ? AND user_id != ?').all(convId, userId);
  for (const o of others) {
    if (o.muted || isOnline(o.user_id)) continue;
    pushToUser(o.user_id, {
      type: 'message',
      conversationId: convId,
      conversationType: conv.type,
      conversationName: conv.name || '',
      messageId: message.id,
      senderId: userId,
      senderName: sender.display_name,
      kind,
      body: body.slice(0, 200),
    }).catch(() => {});
  }
  return { message, duplicate: false };
}

export function updateReceipts(userId, convId, { delivered, read }) {
  const m = requireMember(convId, userId);
  const maxId = q('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE conversation_id = ?').get(convId).id;
  let newRead = m.last_read;
  let newDelivered = m.last_delivered;
  if (read !== undefined && read !== null) newRead = Math.max(m.last_read, Math.min(Number(read) || 0, maxId));
  if (delivered !== undefined && delivered !== null) newDelivered = Math.max(m.last_delivered, Math.min(Number(delivered) || 0, maxId));
  newDelivered = Math.max(newDelivered, newRead); // read implies delivered
  if (newRead === m.last_read && newDelivered === m.last_delivered) return;
  q('UPDATE members SET last_read = ?, last_delivered = ? WHERE conversation_id = ? AND user_id = ?').run(newRead, newDelivered, convId, userId);
  sendToConversation(convId, {
    type: 'receipt',
    conversationId: convId,
    userId,
    lastRead: newRead,
    lastDelivered: newDelivered,
  });
}

export function sendTyping(userId, convId, typing = true) {
  requireMember(convId, userId);
  sendToConversation(convId, { type: 'typing', conversationId: convId, userId, typing: !!typing }, { exceptUserId: userId });
}

// ───────────────────────── routes ─────────────────────────

export const routes = [];
const route = (method, pattern, handler, { auth = true, raw = false } = {}) => {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$',
  );
  routes.push({ method, re, keys, handler, auth, raw });
};

route('GET', '/api/health', () => ({ ok: true }), { auth: false });

route('GET', '/api/server', () => ({
  name: 'bants-server',
  registration: config.allowRegistration ? (config.inviteCode ? 'invite' : 'open') : 'closed',
  maxUploadBytes: config.maxUploadBytes,
}), { auth: false });

// ── auth ──
route('POST', '/api/auth/register', async ({ body, ip }) => {
  if (rateLimited(`reg:${ip}`, 5, 60 * 60_000)) throw new HttpError(429, 'Too many attempts, try later');
  if (!config.allowRegistration) throw forbidden('Registration is closed on this server');
  if (config.inviteCode && body.inviteCode !== config.inviteCode) throw forbidden('Invalid invite code');
  const username = str(body.username, 24, 'username');
  if (!username || !USERNAME_RE.test(username)) {
    throw bad('Username must be 3–24 characters: letters, numbers, _ or .', 'invalid_username');
  }
  if (typeof body.password !== 'string' || body.password.length < 8) throw bad('Password must be at least 8 characters');
  if (body.password.length > 200) throw bad('Password is too long');
  const displayName = str(body.displayName, 50, 'displayName') || username;
  if (q('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'Username is taken', 'username_taken');

  const passwordHash = await hashPassword(body.password);
  const now = Date.now();
  const { lastInsertRowid } = q(
    `INSERT INTO users (username, display_name, friend_code, password_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(username, displayName, newFriendCode(), passwordHash, now, now);
  const user = getUser(Number(lastInsertRowid));
  const token = createSession(user.id, body.deviceName);
  return { token, user: meOut(user) };
}, { auth: false });

route('POST', '/api/auth/login', async ({ body, ip }) => {
  if (rateLimited(`login:${ip}`, 20) || rateLimited(`login:${String(body.username).toLowerCase()}`, 10)) {
    throw new HttpError(429, 'Too many attempts, try later');
  }
  const user = q('SELECT * FROM users WHERE username = ?').get(String(body.username || ''));
  if (!user || typeof body.password !== 'string' || !(await verifyPassword(body.password, user.password_hash))) {
    throw new HttpError(401, 'Wrong username or password', 'bad_credentials');
  }
  const token = createSession(user.id, body.deviceName);
  return { token, user: meOut(user) };
}, { auth: false });

route('POST', '/api/auth/logout', ({ user, tokenHash }) => {
  q('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  disconnect(user.id, tokenHash);
  return { ok: true };
});

// ── me ──
route('GET', '/api/me', ({ user }) => meOut(user));

route('PATCH', '/api/me', ({ user, body }) => {
  const displayName = str(body.displayName, 50, 'displayName');
  const about = str(body.about, 140, 'about');
  if (displayName !== undefined && !displayName) throw bad('Display name can’t be empty');
  let avatar = user.avatar_media;
  if (body.avatar !== undefined) avatar = body.avatar === null ? null : requireMedia(body.avatar, user.id).id;
  q('UPDATE users SET display_name = ?, about = ?, avatar_media = ? WHERE id = ?').run(
    displayName ?? user.display_name,
    about ?? user.about,
    avatar,
    user.id,
  );
  const updated = getUser(user.id);
  // Let contacts and chat partners refresh the profile.
  const ids = new Set([
    ...q('SELECT user_id FROM contacts WHERE contact_id = ?').all(user.id).map((r) => r.user_id),
    ...q(`SELECT DISTINCT m2.user_id FROM members m1 JOIN members m2 ON m1.conversation_id = m2.conversation_id
           WHERE m1.user_id = ? AND m2.user_id != ?`).all(user.id, user.id).map((r) => r.user_id),
  ]);
  for (const id of ids) sendToUser(id, { type: 'user.updated', user: userOut(updated, id) });
  return meOut(updated);
});

route('POST', '/api/me/password', async ({ user, body, tokenHash }) => {
  if (!(await verifyPassword(String(body.currentPassword || ''), user.password_hash))) {
    throw new HttpError(401, 'Current password is wrong', 'bad_credentials');
  }
  if (typeof body.newPassword !== 'string' || body.newPassword.length < 8) throw bad('Password must be at least 8 characters');
  q('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(body.newPassword), user.id);
  // Sign out every other device.
  for (const s of q('SELECT token_hash FROM sessions WHERE user_id = ? AND token_hash != ?').all(user.id, tokenHash)) {
    disconnect(user.id, s.token_hash);
  }
  q('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, tokenHash);
  return { ok: true };
});

route('POST', '/api/me/friend-code/reset', ({ user }) => {
  q('UPDATE users SET friend_code = ? WHERE id = ?').run(newFriendCode(), user.id);
  return meOut(getUser(user.id));
});

route('POST', '/api/me/push-token', ({ body, tokenHash }) => {
  const token = body.token === null ? null : str(body.token, 4096, 'token');
  q('UPDATE sessions SET push_token = ? WHERE token_hash = ?').run(token || null, tokenHash);
  return { ok: true };
});

route('DELETE', '/api/me', async ({ user, body }) => {
  if (!(await verifyPassword(String(body.password || ''), user.password_hash))) {
    throw new HttpError(401, 'Password is wrong', 'bad_credentials');
  }
  const convIds = q('SELECT conversation_id FROM members WHERE user_id = ?').all(user.id).map((r) => r.conversation_id);
  disconnect(user.id);
  q('DELETE FROM users WHERE id = ?').run(user.id);
  for (const id of convIds) broadcastConversation(id);
  return { ok: true };
});

// ── users ──
route('GET', '/api/users/lookup', ({ user, query }) => {
  // Exact lookups only, so nobody can browse a list of every account.
  let row;
  if (query.username) row = q('SELECT * FROM users WHERE username = ?').get(query.username);
  else if (query.friendCode) row = q('SELECT * FROM users WHERE friend_code = ?').get(normaliseFriendCode(query.friendCode));
  else throw bad('Pass username or friendCode');
  if (!row || isBlocked(row.id, user.id)) throw notFound('No one found');
  return userOut(row, user.id);
});

route('GET', '/api/users/:id', ({ user, params }) => {
  const row = getUser(Number(params.id));
  if (!row) throw notFound('User not found');
  return userOut(row, user.id);
});

// ── contacts ──
route('GET', '/api/contacts', ({ user }) => {
  const rows = q(
    `SELECT u.* FROM contacts c JOIN users u ON u.id = c.contact_id WHERE c.user_id = ? ORDER BY u.display_name COLLATE NOCASE`,
  ).all(user.id);
  return rows.map((r) => userOut(r, user.id));
});

route('GET', '/api/contacts/requests', ({ user }) => {
  const incoming = q(
    `SELECT u.*, r.id AS request_id, r.created_at AS requested_at FROM contact_requests r JOIN users u ON u.id = r.from_user WHERE r.to_user = ? ORDER BY r.created_at DESC`,
  ).all(user.id);
  const outgoing = q(
    `SELECT u.*, r.id AS request_id, r.created_at AS requested_at FROM contact_requests r JOIN users u ON u.id = r.to_user WHERE r.from_user = ? ORDER BY r.created_at DESC`,
  ).all(user.id);
  const map = (rows) => rows.map((r) => ({ id: r.request_id, createdAt: r.requested_at, user: userOut(r, user.id) }));
  return { incoming: map(incoming), outgoing: map(outgoing) };
});

route('POST', '/api/contacts/requests', ({ user, body }) => {
  let target;
  if (body.username) target = q('SELECT * FROM users WHERE username = ?').get(String(body.username).trim());
  else if (body.friendCode) target = q('SELECT * FROM users WHERE friend_code = ?').get(normaliseFriendCode(body.friendCode));
  else throw bad('Pass username or friendCode');

  if (!target || isBlocked(target.id, user.id)) throw notFound('No one found with that username or code');
  if (target.id === user.id) throw bad('That’s you!');
  if (areContacts(user.id, target.id)) throw new HttpError(409, 'Already in your contacts', 'already_contacts');
  if (isBlocked(user.id, target.id)) q('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(user.id, target.id);

  // If they already asked us, adding them back accepts straight away.
  const reverse = q('SELECT id FROM contact_requests WHERE from_user = ? AND to_user = ?').get(target.id, user.id);
  if (reverse) return acceptRequest(user, reverse.id);

  // Adding by friend code means they gave you the code, so it connects immediately.
  if (body.friendCode) {
    const conv = connect(user.id, target.id);
    return { status: 'accepted', contact: userOut(target, user.id), conversation: conversationOut(conv, user.id) };
  }

  const now = Date.now();
  q('INSERT OR IGNORE INTO contact_requests (from_user, to_user, created_at) VALUES (?, ?, ?)').run(user.id, target.id, now);
  const req = q('SELECT id, created_at FROM contact_requests WHERE from_user = ? AND to_user = ?').get(user.id, target.id);
  sendToUser(target.id, { type: 'contact.request', request: { id: req.id, createdAt: req.created_at, user: userOut(user, target.id) } });
  if (!isOnline(target.id)) {
    pushToUser(target.id, { type: 'contact_request', requestId: req.id, fromId: user.id, fromName: user.display_name }).catch(() => {});
  }
  return { status: 'requested', request: { id: req.id, createdAt: req.created_at, user: userOut(target, user.id) } };
});

function connect(a, b) {
  const now = Date.now();
  const convId = tx(() => {
    q('INSERT OR IGNORE INTO contacts (user_id, contact_id, created_at) VALUES (?, ?, ?)').run(a, b, now);
    q('INSERT OR IGNORE INTO contacts (user_id, contact_id, created_at) VALUES (?, ?, ?)').run(b, a, now);
    q('DELETE FROM contact_requests WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)').run(a, b, b, a);
    return getOrCreateDirect(a, b).id;
  });
  const ua = getUser(a);
  const ub = getUser(b);
  sendToUser(a, { type: 'contact.added', contact: userOut(ub, a), conversation: conversationOut(convId, a) });
  sendToUser(b, { type: 'contact.added', contact: userOut(ua, b), conversation: conversationOut(convId, b) });
  return convId;
}

function acceptRequest(user, requestId) {
  const r = q('SELECT * FROM contact_requests WHERE id = ? AND to_user = ?').get(requestId, user.id);
  if (!r) throw notFound('Request not found');
  const convId = connect(user.id, r.from_user);
  if (!isOnline(r.from_user)) {
    pushToUser(r.from_user, { type: 'contact_accepted', userId: user.id, name: user.display_name, conversationId: convId }).catch(() => {});
  }
  return { status: 'accepted', contact: userOut(getUser(r.from_user), user.id), conversation: conversationOut(convId, user.id) };
}

route('POST', '/api/contacts/requests/:id/accept', ({ user, params }) => acceptRequest(user, Number(params.id)));

route('POST', '/api/contacts/requests/:id/decline', ({ user, params }) => {
  // Works for declining incoming requests and cancelling outgoing ones.
  const r = q('SELECT * FROM contact_requests WHERE id = ? AND (to_user = ? OR from_user = ?)').get(Number(params.id), user.id, user.id);
  if (!r) throw notFound('Request not found');
  q('DELETE FROM contact_requests WHERE id = ?').run(r.id);
  const other = r.to_user === user.id ? r.from_user : r.to_user;
  sendToUser(other, { type: 'contact.request.removed', requestId: r.id });
  return { ok: true };
});

route('DELETE', '/api/contacts/:id', ({ user, params }) => {
  const id = Number(params.id);
  q('DELETE FROM contacts WHERE user_id = ? AND contact_id = ?').run(user.id, id);
  return { ok: true };
});

route('GET', '/api/blocks', ({ user }) =>
  q('SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ?').all(user.id).map((r) => userOut(r, user.id)),
);

route('POST', '/api/blocks/:id', ({ user, params }) => {
  const id = Number(params.id);
  if (!getUser(id) || id === user.id) throw notFound('User not found');
  tx(() => {
    q('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)').run(user.id, id, Date.now());
    q('DELETE FROM contacts WHERE (user_id = ? AND contact_id = ?) OR (user_id = ? AND contact_id = ?)').run(user.id, id, id, user.id);
    q('DELETE FROM contact_requests WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)').run(user.id, id, id, user.id);
  });
  return { ok: true };
});

route('DELETE', '/api/blocks/:id', ({ user, params }) => {
  q('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(user.id, Number(params.id));
  return { ok: true };
});

// ── conversations ──
route('GET', '/api/conversations', ({ user }) => {
  const ids = q(
    `SELECT c.id FROM conversations c JOIN members m ON m.conversation_id = c.id WHERE m.user_id = ? ORDER BY c.updated_at DESC`,
  ).all(user.id);
  return ids.map((r) => conversationOut(r.id, user.id));
});

route('POST', '/api/conversations', ({ user, body }) => {
  if (body.type === 'direct') {
    const other = Number(body.userId);
    if (!areContacts(user.id, other)) throw forbidden('Add them as a contact first');
    const { id } = tx(() => getOrCreateDirect(user.id, other));
    return conversationOut(id, user.id);
  }
  if (body.type === 'group') {
    const name = str(body.name, 60, 'name');
    if (!name) throw bad('Group needs a name');
    const memberIds = [...new Set((body.memberIds || []).map(Number))].filter((id) => id !== user.id);
    if (memberIds.length > 255) throw bad('Too many members');
    for (const id of memberIds) if (!areContacts(user.id, id)) throw forbidden(`User ${id} isn’t in your contacts`);
    const avatar = body.avatar ? requireMedia(body.avatar, user.id).id : null;
    const now = Date.now();
    const convId = tx(() => {
      const { lastInsertRowid } = q(
        `INSERT INTO conversations (type, name, avatar_media, created_by, created_at, updated_at) VALUES ('group', ?, ?, ?, ?, ?)`,
      ).run(name, avatar, user.id, now, now);
      const id = Number(lastInsertRowid);
      q('INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(id, user.id, 'admin', now);
      for (const m of memberIds) q('INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(id, m, 'member', now);
      insertSystemMessage(id, `${user.display_name} created the group "${name}"`);
      return id;
    });
    broadcastConversation(convId);
    return conversationOut(convId, user.id);
  }
  throw bad('type must be "direct" or "group"');
});

route('GET', '/api/conversations/:id', ({ user, params }) => {
  const id = Number(params.id);
  requireMember(id, user.id);
  return conversationOut(id, user.id);
});

route('PATCH', '/api/conversations/:id', ({ user, params, body }) => {
  const id = Number(params.id);
  requireMember(id, user.id);
  if (body.muted !== undefined) {
    q('UPDATE members SET muted = ? WHERE conversation_id = ? AND user_id = ?').run(body.muted ? 1 : 0, id, user.id);
  }
  if (body.name !== undefined || body.avatar !== undefined) {
    requireAdmin(id, user.id);
    const c = q('SELECT * FROM conversations WHERE id = ?').get(id);
    const name = body.name !== undefined ? str(body.name, 60, 'name') : c.name;
    if (!name) throw bad('Group needs a name');
    const avatar = body.avatar === undefined ? c.avatar_media : body.avatar === null ? null : requireMedia(body.avatar, user.id).id;
    q('UPDATE conversations SET name = ?, avatar_media = ? WHERE id = ?').run(name, avatar, id);
    if (name !== c.name) {
      const msg = insertSystemMessage(id, `${user.display_name} renamed the group to "${name}"`);
      sendToConversation(id, { type: 'message.new', message: messageOut(msg) });
    }
    broadcastConversation(id);
  }
  return conversationOut(id, user.id);
});

route('POST', '/api/conversations/:id/members', ({ user, params, body }) => {
  const id = Number(params.id);
  requireAdmin(id, user.id);
  const ids = [...new Set((body.userIds || []).map(Number))];
  const now = Date.now();
  const added = [];
  for (const uid of ids) {
    if (!areContacts(user.id, uid)) throw forbidden(`User ${uid} isn’t in your contacts`);
    const res = q('INSERT OR IGNORE INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(id, uid, 'member', now);
    if (res.changes) added.push(getUser(uid));
  }
  if (added.length) {
    const msg = insertSystemMessage(id, `${user.display_name} added ${added.map((u) => u.display_name).join(', ')}`);
    sendToConversation(id, { type: 'message.new', message: messageOut(msg) });
    broadcastConversation(id);
  }
  return conversationOut(id, user.id);
});

route('DELETE', '/api/conversations/:id/members/:userId', ({ user, params }) => {
  const id = Number(params.id);
  const target = Number(params.userId);
  const conv = q('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!conv || conv.type !== 'group') throw bad('Only works for groups');
  if (target === user.id) requireMember(id, user.id);
  else requireAdmin(id, user.id);
  requireMember(id, target);
  const targetUser = getUser(target);
  q('DELETE FROM members WHERE conversation_id = ? AND user_id = ?').run(id, target);
  // Keep at least one admin around.
  const remaining = q('SELECT user_id, role FROM members WHERE conversation_id = ? ORDER BY joined_at').all(id);
  if (remaining.length && !remaining.some((m) => m.role === 'admin')) {
    q('UPDATE members SET role = ? WHERE conversation_id = ? AND user_id = ?').run('admin', id, remaining[0].user_id);
  }
  const text = target === user.id ? `${targetUser.display_name} left` : `${user.display_name} removed ${targetUser.display_name}`;
  const msg = insertSystemMessage(id, text);
  sendToConversation(id, { type: 'message.new', message: messageOut(msg) });
  broadcastConversation(id, [target]);
  return { ok: true };
});

route('POST', '/api/conversations/:id/admins/:userId', ({ user, params, body }) => {
  const id = Number(params.id);
  requireAdmin(id, user.id);
  requireMember(id, Number(params.userId));
  q('UPDATE members SET role = ? WHERE conversation_id = ? AND user_id = ?').run(body.admin === false ? 'member' : 'admin', id, Number(params.userId));
  broadcastConversation(id);
  return conversationOut(id, user.id);
});

// ── messages ──
route('GET', '/api/conversations/:id/messages', ({ user, params, query }) => {
  const id = Number(params.id);
  requireMember(id, user.id);
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  let rows;
  if (query.after) {
    rows = q('SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?').all(id, Number(query.after), limit);
  } else {
    const before = query.before ? Number(query.before) : Number.MAX_SAFE_INTEGER;
    rows = q('SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(id, before, limit).reverse();
  }
  return { messages: rows.map(messageOut), hasMore: rows.length === limit };
});

route('POST', '/api/conversations/:id/messages', ({ user, params, body }) => sendMessage(user.id, Number(params.id), body).message);

route('PATCH', '/api/messages/:id', ({ user, params, body }) => {
  const m = q('SELECT * FROM messages WHERE id = ?').get(Number(params.id));
  if (!m || m.sender_id !== user.id || m.deleted) throw notFound('Message not found');
  if (m.kind !== 'text') throw bad('Only text messages can be edited');
  if (Date.now() - m.created_at > 15 * 60_000) throw forbidden('Messages can only be edited for 15 minutes');
  const text = str(body.body, 10_000, 'body');
  if (!text) throw bad('Message is empty');
  q('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(text, Date.now(), m.id);
  const out = messageOut(q('SELECT * FROM messages WHERE id = ?').get(m.id));
  sendToConversation(m.conversation_id, { type: 'message.updated', message: out });
  return out;
});

route('DELETE', '/api/messages/:id', ({ user, params }) => {
  const m = q('SELECT * FROM messages WHERE id = ?').get(Number(params.id));
  if (!m || m.sender_id !== user.id) throw notFound('Message not found');
  q('UPDATE messages SET deleted = 1, body = ?, media_id = NULL WHERE id = ?').run('', m.id);
  const out = messageOut(q('SELECT * FROM messages WHERE id = ?').get(m.id));
  sendToConversation(m.conversation_id, { type: 'message.updated', message: out });
  return out;
});

route('POST', '/api/conversations/:id/receipts', ({ user, params, body }) => {
  updateReceipts(user.id, Number(params.id), body);
  return { ok: true };
});

/** Everything new since a message id, across all chats. Call after reconnecting. */
route('GET', '/api/sync', ({ user, query }) => {
  const since = Number(query.since) || 0;
  const rows = q(
    `SELECT msg.* FROM messages msg JOIN members m ON m.conversation_id = msg.conversation_id
      WHERE m.user_id = ? AND msg.id > ? ORDER BY msg.id ASC LIMIT 500`,
  ).all(user.id, since);
  return { messages: rows.map(messageOut), hasMore: rows.length === 500 };
});

// ── media ──
route('POST', '/api/media', async ({ user, req }) => {
  const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > config.maxUploadBytes) throw new HttpError(413, 'File is too large');
  const filename = decodeURIComponent(String(req.headers['x-filename'] || '')).slice(0, 200);
  const id = crypto.randomBytes(16).toString('hex');
  const file = path.join(MEDIA_DIR(), id);
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > config.maxUploadBytes) return cb(new HttpError(413, 'File is too large'));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, fs.createWriteStream(file));
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err instanceof HttpError ? err : bad('Upload failed');
  }
  if (size === 0) {
    fs.rmSync(file, { force: true });
    throw bad('Empty upload');
  }
  q('INSERT INTO media (id, uploader_id, mime, size, filename, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, user.id, mime, size, filename, Date.now());
  return { id, mime, size, filename };
}, { raw: true });

route('GET', '/api/media/:id', ({ user, params, res, req }) => {
  const m = q('SELECT * FROM media WHERE id = ?').get(params.id);
  if (!m) throw notFound();
  const allowed =
    m.uploader_id === user.id ||
    q('SELECT 1 FROM users WHERE avatar_media = ?').get(m.id) ||
    q(`SELECT 1 FROM conversations c JOIN members mb ON mb.conversation_id = c.id WHERE c.avatar_media = ? AND mb.user_id = ?`).get(m.id, user.id) ||
    q(`SELECT 1 FROM messages msg JOIN members mb ON mb.conversation_id = msg.conversation_id WHERE msg.media_id = ? AND mb.user_id = ?`).get(m.id, user.id);
  if (!allowed) throw notFound();
  const file = path.join(MEDIA_DIR(), m.id);
  if (!fs.existsSync(file)) throw notFound();

  const headers = {
    'content-type': m.mime,
    'cache-control': 'private, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
  };
  if (m.filename) headers['content-disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(m.filename)}`;

  // Range support so videos and voice notes can seek.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] ? Number(range[1]) : m.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : m.size - 1;
    if (!range[1]) end = m.size - 1;
    if (start < 0 || start >= m.size || end >= m.size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${m.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${m.size}`, 'content-length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': m.size });
  fs.createReadStream(file).pipe(res);
});

export { getUser, conversationOut };
