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
import { pushToUser, pushEnabled } from './push.js';
import { backupStatus, runBackup } from './backup.js';
import { registrationSettings, setSetting } from './settings.js';
import { firstUrl, fetchPreview } from './previews.js';
import { gifsEnabled, findGifs, downloadGif } from './gifs.js';

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

export const DECORATIONS = ['rainbow', 'fire', 'hearts', 'sparkle', 'neon', 'gold', 'snow', 'halo', 'crown', 'cat'];
export const PROFILE_EFFECTS = ['confetti', 'hearts', 'snow', 'sparkles', 'bubbles', 'fireworks', 'stars'];
export const NAME_FONTS = ['default', 'bricolage', 'mono', 'serif', 'script', 'rounded'];
const parseJson = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
/** The fun bits of a profile, shared by every place a person shows up. */
export function flairOut(row) {
  return {
    themeColours: parseJson(row.theme_colours),
    decoration: row.decoration || null,
    profileEffect: row.profile_effect || null,
    nameStyle: parseJson(row.name_style),
  };
}

export function userOut(row, viewerId = null) {
  if (!row) return null;
  const out = {
    ...flairOut(row),
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    about: row.about,
    avatar: row.avatar_media,
    banner: row.banner_media ?? null,
    accentColour: row.accent_colour ?? null,
    pronouns: row.pronouns || '',
    customStatus: row.custom_status || '',
    statusEmoji: row.status_emoji || '',
  };
  // Online status / last seen are only shown to contacts.
  if (viewerId !== null && (viewerId === row.id || areContacts(viewerId, row.id))) {
    out.online = isOnline(row.id);
    out.lastSeen = row.last_seen;
  }
  return out;
}

function meOut(row) {
  return {
    ...userOut(row, row.id),
    joinSound: row.join_sound || null,
    leaveSound: row.leave_sound || null,
    friendCode: formatFriendCode(row.friend_code),
    createdAt: row.created_at,
    isAdmin: !!row.is_admin,
  };
}

function parseMeta(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function messageOut(m) {
  let reactions = [];
  if (!m.deleted) {
    const grouped = new Map();
    const bursts = new Map();
    for (const r of q('SELECT emoji, user_id, burst FROM reactions WHERE message_id = ? ORDER BY created_at').all(m.id)) {
      if (!grouped.has(r.emoji)) { grouped.set(r.emoji, []); bursts.set(r.emoji, []); }
      grouped.get(r.emoji).push(r.user_id);
      if (r.burst) bursts.get(r.emoji).push(r.user_id);
    }
    // superIds: who sent it as a super reaction (the big bursting kind).
    reactions = [...grouped].map(([emoji, userIds]) => ({ emoji, userIds, superIds: bursts.get(emoji) }));
  }
  const media = !m.deleted && m.media_id ? q('SELECT mime, size, filename FROM media WHERE id = ?').get(m.media_id) : null;
  const meta = m.deleted ? null : parseMeta(m.meta);
  if (meta?.poll) {
    const votes = q('SELECT user_id, option_id FROM poll_votes WHERE message_id = ? ORDER BY at').all(m.id);
    meta.poll.options = meta.poll.options.map((o) => ({ ...o, voterIds: votes.filter((v) => v.option_id === o.id).map((v) => v.user_id) }));
  }
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
    reactions,
    mediaInfo: media ? { mime: media.mime, size: media.size, filename: media.filename } : null,
    meta,
    expiresAt: m.expires_at ?? null,
    // Custom emojis in the text or reactions, so everyone can draw them.
    emojis: m.deleted ? [] : emojiHooks.lookup(m.body, reactions.map((r) => r.emoji)),
  };
}

function conversationOut(convId, viewerId) {
  const c = q('SELECT * FROM conversations WHERE id = ?').get(convId);
  if (!c) return null;
  const memberRows = q(
    `SELECT m.role, m.last_read, m.last_delivered, m.muted, m.pinned, m.archived, u.*
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
    pinned: !!me?.pinned,
    archived: !!me?.archived,
    disappearAfter: c.disappear_after || 0,
    streak: c.type === 'direct' ? streakFor(convId, memberRows.map((r) => r.id)) : 0,
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

/** Local calendar day (server time zone, set TZ to change) as "YYYY-MM-DD". */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Chat streak: days in a row where everyone in a direct chat sent at least one message.
 * Counts back from today (or from yesterday, so a streak isn't lost before today's chat).
 */
function streakFor(convId, userIds) {
  if (userIds.length !== 2) return 0;
  const since = Date.now() - 400 * 86_400_000;
  const rows = q(
    `SELECT sender_id, created_at FROM messages
      WHERE conversation_id = ? AND created_at > ? AND kind != 'system' AND sender_id IS NOT NULL`,
  ).all(convId, since);
  const days = new Map(); // day -> set of senders
  for (const r of rows) {
    const k = dayKey(r.created_at);
    if (!days.has(k)) days.set(k, new Set());
    days.get(k).add(r.sender_id);
  }
  const both = (k) => userIds.every((u) => days.get(k)?.has(u));
  const day = new Date();
  day.setHours(12, 0, 0, 0);
  if (!both(dayKey(day.getTime()))) day.setDate(day.getDate() - 1);
  let n = 0;
  while (both(dayKey(day.getTime()))) {
    n++;
    day.setDate(day.getDate() - 1);
  }
  return n;
}

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
/** Extra checks other modules add (servers.js: server icons and channel attachments). */
export const mediaAccessChecks = [];
/** Filled in by emojis.js (it imports this file, so it can't be imported back): custom emojis in chats. */
export const emojiHooks = { clean: (text) => text, lookup: () => [], reactionOk: () => false };

/** Whether someone may see a file: theirs, their sticker, an avatar, or used in one of their chats or servers. */
function canSeeMedia(m, userId) {
  return (
    mediaAccessChecks.some((check) => check(m.id, userId)) ||
    m.uploader_id === userId ||
    !!q('SELECT 1 FROM stickers WHERE media_id = ? AND user_id = ?').get(m.id, userId) ||
    !!q('SELECT 1 FROM users WHERE avatar_media = ? OR banner_media = ?').get(m.id, m.id) ||
    !!q('SELECT 1 FROM server_members WHERE avatar_media = ? OR banner_media = ?').get(m.id, m.id) ||
    !!q('SELECT 1 FROM user_emojis WHERE media_id = ?').get(m.id) ||
    !!q('SELECT 1 FROM server_emojis WHERE media_id = ?').get(m.id) ||
    !!q('SELECT 1 FROM server_sounds WHERE media_id = ?').get(m.id) ||
    !!q('SELECT 1 FROM users WHERE join_sound = ? OR leave_sound = ?').get(m.id, m.id) ||
    !!q(`SELECT 1 FROM conversations c JOIN members mb ON mb.conversation_id = c.id WHERE c.avatar_media = ? AND mb.user_id = ?`).get(m.id, userId) ||
    !!q(`SELECT 1 FROM messages msg JOIN members mb ON mb.conversation_id = msg.conversation_id WHERE msg.media_id = ? AND mb.user_id = ?`).get(m.id, userId) ||
    !!q(`SELECT 1 FROM messages msg JOIN members mb ON mb.conversation_id = msg.conversation_id WHERE msg.meta LIKE ? AND mb.user_id = ?`).get(`%${m.id}%`, userId)
  );
}

/** An image you can use for an avatar or banner. */
export function requireImage(id, userId) {
  const m = requireMedia(id, userId);
  if (!m.mime.startsWith('image/')) throw bad('That needs to be a picture');
  return m.id;
}

/** Everyone who's in a server with this person. */
export function sharedServerUsers(userId) {
  return q(`SELECT DISTINCT b.user_id FROM server_members a JOIN server_members b ON b.server_id = a.server_id
            WHERE a.user_id = ? AND b.user_id != ?`).all(userId, userId).map((r) => r.user_id);
}

export function shareAServer(a, b) {
  return !!q('SELECT 1 FROM server_members x JOIN server_members y ON y.server_id = x.server_id WHERE x.user_id = ? AND y.user_id = ? LIMIT 1').get(a, b);
}

function requireMedia(id, userId) {
  if (id === undefined || id === null) return null;
  const m = q('SELECT * FROM media WHERE id = ?').get(String(id));
  if (!m) throw bad('Unknown media id');
  if (!canSeeMedia(m, userId)) throw forbidden('You can’t use that file');
  return m;
}

/** Stores bytes as a media file and returns its id. */
export function saveMediaBuffer(buffer, mime, filename, uploaderId) {
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(MEDIA_DIR(), id), buffer);
  q('INSERT INTO media (id, uploader_id, mime, size, filename, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, uploaderId, mime, buffer.length, filename || '', Date.now(),
  );
  return id;
}

/** Removes a file once nothing refers to it any more. */
export function deleteMediaIfUnused(id) {
  if (!id) return;
  const used =
    q('SELECT 1 FROM messages WHERE media_id = ? LIMIT 1').get(id) ||
    q('SELECT 1 FROM messages WHERE meta LIKE ? LIMIT 1').get(`%${id}%`) ||
    q('SELECT 1 FROM stickers WHERE media_id = ? LIMIT 1').get(id) ||
    q('SELECT 1 FROM users WHERE avatar_media = ? OR banner_media = ? LIMIT 1').get(id, id) ||
    q('SELECT 1 FROM server_members WHERE avatar_media = ? OR banner_media = ? LIMIT 1').get(id, id) ||
    q('SELECT 1 FROM conversations WHERE avatar_media = ? LIMIT 1').get(id) ||
    q('SELECT 1 FROM channel_attachments WHERE media_id = ? LIMIT 1').get(id) ||
    q('SELECT 1 FROM user_emojis WHERE media_id = ? LIMIT 1').get(id) ||
    q('SELECT 1 FROM server_emojis WHERE media_id = ? LIMIT 1').get(id) ||
    q('SELECT 1 FROM server_sounds WHERE media_id = ? LIMIT 1').get(id) ||
    q('SELECT 1 FROM users WHERE join_sound = ? OR leave_sound = ? LIMIT 1').get(id, id) ||
    q('SELECT 1 FROM webhooks WHERE avatar_media = ? LIMIT 1').get(id) ||
    q('SELECT 1 FROM channel_messages WHERE meta LIKE ? LIMIT 1').get(`%${id}%`) ||
    q('SELECT 1 FROM servers WHERE icon_media = ? OR banner_media = ? LIMIT 1').get(id, id);
  if (used) return;
  q('DELETE FROM media WHERE id = ?').run(id);
  fs.rmSync(path.join(MEDIA_DIR(), id), { force: true });
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

/** Adds a call-history line (e.g. "Missed voice call") to a chat and shows it to everyone. */
export function addCallMessage(convId, body) {
  const msg = insertSystemMessage(convId, body);
  sendToConversation(convId, { type: 'message.new', message: messageOut(msg) });
}

/**
 * Message ids must never be reused, or a phone could mistake a new message for one that was
 * unsent (SQLite would otherwise hand out the id of a deleted newest message again).
 */
const NEXT_MESSAGE_ID = `(SELECT MAX(v) FROM (SELECT COALESCE(MAX(id), 0) AS v FROM messages UNION ALL SELECT COALESCE(MAX(message_id), 0) FROM unsent)) + 1`;

function insertSystemMessage(convId, body) {
  const now = Date.now();
  const { lastInsertRowid } = q(
    `INSERT INTO messages (id, conversation_id, sender_id, kind, body, created_at) VALUES (${NEXT_MESSAGE_ID}, ?, NULL, 'system', ?, ?)`,
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

  let body = emojiHooks.clean(str(input.body ?? input.text ?? '', 10_000, 'body') || '', userId);
  const media = requireMedia(input.media, userId);
  const extra = {};
  let kind = 'text';
  if (input.poll) {
    const p = input.poll;
    const question = str(p.question, 200, 'question');
    const options = Array.isArray(p.options) ? p.options.map((o) => str(typeof o === 'string' ? o : o?.text, 100, 'option')).filter(Boolean) : [];
    if (!question) throw bad('Ask a question');
    if (options.length < 2 || options.length > 12) throw bad('A poll needs 2 to 12 options');
    extra.poll = { question, multi: !!p.multi, options: options.map((text, i) => ({ id: i + 1, text })) };
    kind = 'poll';
    body = question;
  } else if (input.location) {
    const l = input.location;
    const lat = Number(l.lat);
    const lng = Number(l.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw bad('Bad location');
    const liveMinutes = Math.min(Math.max(Number(l.liveMinutes) || 0, 0), 8 * 60);
    extra.location = {
      lat, lng,
      accuracy: Number(l.accuracy) || null,
      label: str(l.label, 200, 'label') || null,
      liveUntil: liveMinutes ? Date.now() + liveMinutes * 60_000 : null,
      updatedAt: Date.now(),
    };
    kind = 'location';
    body = extra.location.label || (liveMinutes ? 'Live location' : 'Location');
  }
  if (input.forwarded) extra.forwarded = true;
  if (media && input.kind === 'sticker' && media.mime.startsWith('image/')) {
    kind = 'sticker';
  } else if (media) {
    kind = media.mime.startsWith('image/')
      ? 'image'
      : media.mime.startsWith('video/')
        ? 'video'
        : media.mime.startsWith('audio/')
          ? 'audio'
          : 'file';
  }
  if (!body && !media && kind === 'text') throw bad('Message is empty');

  let replyTo = null;
  if (input.replyTo !== undefined && input.replyTo !== null) {
    const r = q('SELECT id FROM messages WHERE id = ? AND conversation_id = ?').get(Number(input.replyTo), convId);
    if (!r) throw bad('replyTo message not found in this conversation');
    replyTo = r.id;
  }

  // @mentions: anyone in the chat whose username follows an @.
  const memberRows = q(
    'SELECT u.id, u.username FROM members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? AND u.id != ?',
  ).all(convId, userId);
  const named = new Set([...body.matchAll(/@([a-z0-9_.]{3,24})/gi)].map((x) => x[1].toLowerCase()));
  const mentions = memberRows.filter((r) => named.has(r.username.toLowerCase())).map((r) => r.id);
  const meta = mentions.length || Object.keys(extra).length ? { ...(mentions.length ? { mentions } : {}), ...extra } : null;

  const now = Date.now();
  const expiresAt = conv.disappear_after > 0 ? now + conv.disappear_after * 1000 : null;
  const row = tx(() => {
    const { lastInsertRowid } = q(
      `INSERT INTO messages (id, conversation_id, sender_id, client_id, kind, body, media_id, reply_to, created_at, meta, expires_at)
       VALUES (${NEXT_MESSAGE_ID}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(convId, userId, clientId, kind, body, media ? media.id : null, replyTo, now, meta ? JSON.stringify(meta) : null, expiresAt);
    const id = Number(lastInsertRowid);
    q('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
    // A new message brings an archived chat back for everyone else.
    q('UPDATE members SET archived = 0 WHERE conversation_id = ? AND user_id != ? AND archived = 1').run(convId, userId);
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
    const mentioned = mentions.includes(o.user_id);
    if ((o.muted && !mentioned) || isOnline(o.user_id)) continue;
    // Only ids go through Google's push service: the phone fetches the message itself from this
    // server before showing the notification, so no message text or names pass through Google.
    pushToUser(o.user_id, {
      mentioned: mentioned ? '1' : '0',
      type: 'message',
      conversationId: convId,
      messageId: message.id,
      senderId: userId,
    }).catch(() => {});
  }

  const link = kind === 'text' ? firstUrl(body) : null;
  if (link) addLinkPreview(row.id, link, userId).catch(() => {});
  return { message, duplicate: false };
}

/** Fetches a link's title and picture after sending, then updates the message for everyone. */
async function addLinkPreview(messageId, url, userId) {
  const preview = await fetchPreview(url);
  if (!preview) return;
  const m = q('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!m || m.deleted) return;
  let image = null;
  if (preview.image) image = saveMediaBuffer(preview.image.body, preview.image.mime, 'preview', userId);
  const meta = parseMeta(m.meta) || {};
  meta.preview = { url: preview.url, title: preview.title, description: preview.description, siteName: preview.siteName, image };
  q('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), messageId);
  sendToConversation(m.conversation_id, { type: 'message.updated', message: messageOut(q('SELECT * FROM messages WHERE id = ?').get(messageId)) });
}

/** Deletes messages whose disappearing timer has run out. Called every 30 seconds. */
export function sweepExpired() {
  const rows = q('SELECT id, conversation_id, media_id, meta FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?').all(Date.now());
  if (!rows.length) return;
  const byConv = new Map();
  for (const r of rows) {
    q('DELETE FROM messages WHERE id = ?').run(r.id);
    if (!byConv.has(r.conversation_id)) byConv.set(r.conversation_id, []);
    byConv.get(r.conversation_id).push(r.id);
  }
  for (const r of rows) {
    deleteMediaIfUnused(r.media_id);
    const img = parseMeta(r.meta)?.preview?.image;
    if (img) deleteMediaIfUnused(img);
  }
  for (const [convId, ids] of byConv) sendToConversation(convId, { type: 'message.removed', conversationId: convId, ids });
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
  const now = Date.now();
  const log = q('INSERT INTO receipt_log (conversation_id, user_id, kind, upto, at) VALUES (?, ?, ?, ?, ?)');
  if (newDelivered > m.last_delivered) log.run(convId, userId, 'delivered', newDelivered, now);
  if (newRead > m.last_read) log.run(convId, userId, 'read', newRead, now);
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
export const route = (method, pattern, handler, { auth = true, raw = false } = {}) => {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$',
  );
  routes.push({ method, re, keys, handler, auth, raw });
};

route('GET', '/api/health', () => ({ ok: true }), { auth: false });

route('GET', '/api/server', () => {
  const reg = registrationSettings();
  return {
    name: 'bants-server',
    registration: reg.allowRegistration ? (reg.inviteCode ? 'invite' : 'open') : 'closed',
    maxUploadBytes: config.maxUploadBytes,
    gifs: gifsEnabled(),
    // Handy for checking which version is running and what's switched on.
    build: (process.env.BANTS_BUILD || 'dev').slice(0, 7),
    push: pushEnabled(),
    calls: true,
    callRelay: !!process.env.TURN_SECRET,
    unsend: true,
    // The app shows the Chats / Servers switch when this is true.
    servers: true,
  };
}, { auth: false });

// ── auth ──
route('POST', '/api/auth/register', async ({ body, ip }) => {
  if (rateLimited(`reg:${ip}`, Number(process.env.REGISTER_LIMIT || 5), 60 * 60_000)) throw new HttpError(429, 'Too many attempts, try later');
  const reg = registrationSettings();
  if (!reg.allowRegistration) throw forbidden('Registration is closed on this server');
  if (reg.inviteCode && String(body.inviteCode || '').trim() !== reg.inviteCode) throw forbidden('Invalid invite code');
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
  const firstAdmin = q('SELECT 1 FROM users WHERE is_admin = 1').get() ? 0 : 1;
  const { lastInsertRowid } = q(
    `INSERT INTO users (username, display_name, friend_code, password_hash, created_at, last_seen, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(username, displayName, newFriendCode(), passwordHash, now, now, firstAdmin);
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
  const about = str(body.about, 190, 'about');
  if (displayName !== undefined && !displayName) throw bad('Display name can’t be empty');
  let avatar = user.avatar_media;
  if (body.avatar !== undefined) avatar = body.avatar === null ? null : requireImage(body.avatar, user.id);
  let banner = user.banner_media;
  if (body.banner !== undefined) banner = body.banner === null ? null : requireImage(body.banner, user.id);
  let accent = user.accent_colour;
  if (body.accentColour !== undefined) accent = body.accentColour === null ? null : Number(body.accentColour) & 0xffffff;
  const pronouns = str(body.pronouns, 40, 'pronouns');
  const customStatus = str(body.customStatus, 128, 'customStatus');
  const statusEmoji = str(body.statusEmoji, 16, 'statusEmoji');
  // Flair
  const colour = (v) => Number(v) & 0xffffff;
  if (body.themeColours !== undefined) {
    const t = Array.isArray(body.themeColours) && body.themeColours.length === 2 ? JSON.stringify(body.themeColours.map(colour)) : null;
    q('UPDATE users SET theme_colours = ? WHERE id = ?').run(t, user.id);
  }
  if (body.decoration !== undefined) q('UPDATE users SET decoration = ? WHERE id = ?').run(DECORATIONS.includes(body.decoration) ? body.decoration : null, user.id);
  if (body.profileEffect !== undefined) q('UPDATE users SET profile_effect = ? WHERE id = ?').run(PROFILE_EFFECTS.includes(body.profileEffect) ? body.profileEffect : null, user.id);
  if (body.nameStyle !== undefined) {
    const ns = body.nameStyle;
    const out = ns && typeof ns === 'object' ? {
      font: NAME_FONTS.includes(ns.font) ? ns.font : 'default',
      colours: Array.isArray(ns.colours) ? ns.colours.slice(0, 2).map(colour) : [],
    } : null;
    q('UPDATE users SET name_style = ? WHERE id = ?').run(out && (out.font !== 'default' || out.colours.length) ? JSON.stringify(out) : null, user.id);
  }
  // Join / leave sounds for voice channels: short audio you've uploaded.
  for (const [key, col] of [['joinSound', 'join_sound'], ['leaveSound', 'leave_sound']]) {
    if (body[key] === undefined) continue;
    let v = null;
    if (body[key]) {
      const m = requireMedia(body[key], user.id);
      if (!m.mime.startsWith('audio/')) throw bad('That needs to be a sound');
      if (m.size > 1024 * 1024) throw bad('Keep sounds under 1 MB');
      v = m.id;
    }
    q(`UPDATE users SET ${col} = ? WHERE id = ?`).run(v, user.id);
  }
  const oldMedia = [user.avatar_media, user.banner_media];
  q(`UPDATE users SET display_name = ?, about = ?, avatar_media = ?, banner_media = ?, accent_colour = ?,
       pronouns = ?, custom_status = ?, status_emoji = ? WHERE id = ?`).run(
    displayName ?? user.display_name,
    about ?? user.about,
    avatar,
    banner,
    accent,
    pronouns ?? user.pronouns ?? '',
    customStatus ?? user.custom_status ?? '',
    statusEmoji ?? user.status_emoji ?? '',
    user.id,
  );
  for (const id of oldMedia) if (id && id !== avatar && id !== banner) deleteMediaIfUnused(id);
  const updated = getUser(user.id);
  // Let contacts, chat partners and everyone you share a server with refresh the profile.
  const ids = new Set([
    ...q('SELECT user_id FROM contacts WHERE contact_id = ?').all(user.id).map((r) => r.user_id),
    ...q(`SELECT DISTINCT m2.user_id FROM members m1 JOIN members m2 ON m1.conversation_id = m2.conversation_id
           WHERE m1.user_id = ? AND m2.user_id != ?`).all(user.id, user.id).map((r) => r.user_id),
    ...sharedServerUsers(user.id),
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

/** Before an account is deleted: servers it owns go with it, so tell their members. */
function announceOwnedServersGone(userId) {
  for (const { id } of q('SELECT id FROM servers WHERE owner_id = ?').all(userId)) {
    for (const { user_id } of q('SELECT user_id FROM server_members WHERE server_id = ? AND user_id != ?').all(id, userId)) {
      sendToUser(user_id, { type: 'server.remove', serverId: id });
    }
  }
}

route('DELETE', '/api/me', async ({ user, body }) => {
  if (!(await verifyPassword(String(body.password || ''), user.password_hash))) {
    throw new HttpError(401, 'Password is wrong', 'bad_credentials');
  }
  const convIds = q('SELECT conversation_id FROM members WHERE user_id = ?').all(user.id).map((r) => r.conversation_id);
  disconnect(user.id);
  announceOwnedServersGone(user.id);
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
    if (!areContacts(user.id, other) && !shareAServer(user.id, other)) throw forbidden('Add them as a contact first');
    if (isBlocked(other, user.id) || isBlocked(user.id, other)) throw forbidden('You can’t message them');
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
  if (body.pinned !== undefined) {
    q('UPDATE members SET pinned = ? WHERE conversation_id = ? AND user_id = ?').run(body.pinned ? 1 : 0, id, user.id);
  }
  if (body.archived !== undefined) {
    q('UPDATE members SET archived = ? WHERE conversation_id = ? AND user_id = ?').run(body.archived ? 1 : 0, id, user.id);
  }
  if (body.disappearAfter !== undefined) {
    const allowed = [0, 86_400, 604_800, 7_776_000];
    const secs = Number(body.disappearAfter);
    if (!allowed.includes(secs)) throw bad('Pick off, 24 hours, 7 days or 90 days');
    const c = q('SELECT * FROM conversations WHERE id = ?').get(id);
    if (c.type === 'group') requireAdmin(id, user.id);
    if (c.disappear_after !== secs) {
      q('UPDATE conversations SET disappear_after = ? WHERE id = ?').run(secs, id);
      const label = { 0: 'off', 86400: '24 hours', 604800: '7 days', 7776000: '90 days' }[secs];
      const msg = insertSystemMessage(
        id,
        secs ? `${user.display_name} turned on disappearing messages. New messages will vanish after ${label}.` : `${user.display_name} turned off disappearing messages.`,
      );
      sendToConversation(id, { type: 'message.new', message: messageOut(msg) });
      broadcastConversation(id);
    }
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
  const out = { messages: rows.map(messageOut), hasMore: rows.length === limit };
  // Catching up: also say which messages the phone may have cached that were unsent since.
  if (query.after && query.knownFrom !== undefined) {
    out.removed = q('SELECT message_id FROM unsent WHERE conversation_id = ? AND message_id >= ? AND message_id <= ? LIMIT 2000')
      .all(id, Number(query.knownFrom) || 0, Number(query.after))
      .map((r) => r.message_id);
  }
  return out;
});

route('POST', '/api/conversations/:id/messages', ({ user, params, body }) => sendMessage(user.id, Number(params.id), body).message);

route('PATCH', '/api/messages/:id', ({ user, params, body }) => {
  const m = q('SELECT * FROM messages WHERE id = ?').get(Number(params.id));
  if (!m || m.sender_id !== user.id || m.deleted) throw notFound('Message not found');
  if (m.kind !== 'text') throw bad('Only text messages can be edited');
  if (Date.now() - m.created_at > 15 * 60_000) throw forbidden('Messages can only be edited for 15 minutes');
  const text = emojiHooks.clean(str(body.body, 10_000, 'body'), user.id);
  if (!text) throw bad('Message is empty');
  q('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(text, Date.now(), m.id);
  const out = messageOut(q('SELECT * FROM messages WHERE id = ?').get(m.id));
  sendToConversation(m.conversation_id, { type: 'message.updated', message: out });
  return out;
});

/**
 * Unsend: removes the message for everyone, with no "deleted" placeholder left behind.
 * The text, attachment and link preview are wiped from the server; only the id is kept,
 * so phones that were offline remove it when they catch up.
 */
route('DELETE', '/api/messages/:id', ({ user, params }) => {
  const m = q('SELECT * FROM messages WHERE id = ?').get(Number(params.id));
  if (!m || m.sender_id !== user.id || m.kind === 'system') throw notFound('Message not found');
  tx(() => {
    q('DELETE FROM messages WHERE id = ?').run(m.id); // reactions go with it
    q('INSERT OR REPLACE INTO unsent (message_id, conversation_id, at) VALUES (?, ?, ?)').run(m.id, m.conversation_id, Date.now());
  });
  deleteMediaIfUnused(m.media_id);
  const img = parseMeta(m.meta)?.preview?.image;
  if (img) deleteMediaIfUnused(img);

  sendToConversation(m.conversation_id, { type: 'message.removed', conversationId: m.conversation_id, ids: [m.id], unsent: true });
  // Phones that aren't connected may be showing it in a notification: tell them to take it down.
  const others = q('SELECT user_id FROM members WHERE conversation_id = ? AND user_id != ?').all(m.conversation_id, user.id);
  for (const o of others) {
    if (isOnline(o.user_id)) continue;
    pushToUser(o.user_id, { type: 'unsend', conversationId: m.conversation_id, messageId: m.id }).catch(() => {});
  }
  return { ok: true, id: m.id };
});

/** Vote in a poll. Send the full set of options you want; an empty list takes your vote back. */
route('POST', '/api/messages/:id/vote', ({ user, params, body }) => {
  const m = q('SELECT * FROM messages WHERE id = ?').get(Number(params.id));
  if (!m || m.deleted || m.kind !== 'poll') throw notFound('Poll not found');
  requireMember(m.conversation_id, user.id);
  const poll = parseMeta(m.meta)?.poll;
  const valid = new Set(poll.options.map((o) => o.id));
  let picks = [...new Set((Array.isArray(body.optionIds) ? body.optionIds : []).map(Number))].filter((id) => valid.has(id));
  if (!poll.multi) picks = picks.slice(0, 1);
  const now = Date.now();
  tx(() => {
    q('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?').run(m.id, user.id);
    const add = q('INSERT INTO poll_votes (message_id, user_id, option_id, at) VALUES (?, ?, ?, ?)');
    for (const id of picks) add.run(m.id, user.id, id, now);
  });
  const out = messageOut(m);
  sendToConversation(m.conversation_id, { type: 'message.updated', message: out });
  return out;
});

/** Send a copy of a message to other chats, marked as forwarded. */
route('POST', '/api/messages/:id/forward', ({ user, params, body }) => {
  const m = q('SELECT * FROM messages WHERE id = ?').get(Number(params.id));
  if (!m || m.deleted || m.kind === 'system') throw notFound('Message not found');
  requireMember(m.conversation_id, user.id);
  const targets = [...new Set((Array.isArray(body.conversationIds) ? body.conversationIds : []).map(Number))].slice(0, 20);
  if (!targets.length) throw bad('Pick a chat');
  const meta = parseMeta(m.meta) || {};
  const input = {
    body: m.kind === 'poll' || m.kind === 'location' ? '' : m.body,
    media: m.media_id || undefined,
    kind: m.kind === 'sticker' ? 'sticker' : undefined,
    forwarded: true,
  };
  if (meta.poll) input.poll = { question: meta.poll.question, multi: meta.poll.multi, options: meta.poll.options.map((o) => o.text) };
  if (meta.location) input.location = { lat: meta.location.lat, lng: meta.location.lng, label: meta.location.label }; // never live
  const sent = [];
  for (const cid of targets) {
    try {
      sent.push(sendMessage(user.id, cid, input).message);
    } catch (e) {
      // Skip chats you're not in or can't message; forward to the rest.
    }
  }
  if (!sent.length) throw bad('Couldn’t forward to those chats');
  return { messages: sent };
});

/** Who's received and read your message, and when. Only the sender can see this. */
route('GET', '/api/messages/:id/info', ({ user, params }) => {
  const m = q('SELECT * FROM messages WHERE id = ?').get(Number(params.id));
  if (!m || m.sender_id !== user.id) throw notFound('Message not found');
  const firstAt = q('SELECT MIN(at) AS at FROM receipt_log WHERE conversation_id = ? AND user_id = ? AND kind = ? AND upto >= ?');
  const members = q('SELECT user_id, last_read, last_delivered FROM members WHERE conversation_id = ? AND user_id != ?')
    .all(m.conversation_id, user.id)
    .map((r) => {
      const read = r.last_read >= m.id;
      const delivered = r.last_delivered >= m.id;
      return {
        userId: r.user_id,
        delivered,
        read,
        deliveredAt: delivered ? firstAt.get(m.conversation_id, r.user_id, 'delivered', m.id).at ?? null : null,
        readAt: read ? firstAt.get(m.conversation_id, r.user_id, 'read', m.id).at ?? null : null,
      };
    });
  return { messageId: m.id, sentAt: m.created_at, members };
});

/** Live location: the sender moves the pin, or stops sharing early. */
route('PATCH', '/api/messages/:id/location', ({ user, params, body }) => {
  const m = q('SELECT * FROM messages WHERE id = ?').get(Number(params.id));
  if (!m || m.deleted || m.kind !== 'location' || m.sender_id !== user.id) throw notFound('Location not found');
  const meta = parseMeta(m.meta);
  const loc = meta.location;
  if (body.stop) {
    loc.liveUntil = Math.min(loc.liveUntil || 0, Date.now());
  } else {
    if (!loc.liveUntil || loc.liveUntil < Date.now()) throw bad('This location isn’t live any more');
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw bad('Bad location');
    Object.assign(loc, { lat, lng, accuracy: Number(body.accuracy) || null, updatedAt: Date.now() });
  }
  q('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), m.id);
  const out = messageOut(q('SELECT * FROM messages WHERE id = ?').get(m.id));
  sendToConversation(m.conversation_id, { type: 'message.updated', message: out });
  return out;
});

/** One reaction per person per message. Sending the same emoji again removes it. */
route('POST', '/api/messages/:id/react', ({ user, params, body }) => {
  const m = q('SELECT * FROM messages WHERE id = ?').get(Number(params.id));
  if (!m || m.deleted || m.kind === 'system') throw notFound('Message not found');
  requireMember(m.conversation_id, user.id);
  const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '';
  if (!emoji || emoji.length > 64) throw bad('Pick an emoji'); // room for family and flag emojis, and <a:name:id>
  // Custom emojis: yours, or one somebody already reacted with.
  if (emoji.startsWith('<') && !emojiHooks.reactionOk(emoji, user.id) && !q('SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ?').get(m.id, emoji)) {
    throw bad('You can only react with your own custom emojis');
  }
  const existing = q('SELECT emoji, burst FROM reactions WHERE message_id = ? AND user_id = ?').get(m.id, user.id);
  const burst = body.super ? 1 : 0;
  if (existing && existing.emoji === emoji && existing.burst === burst) {
    q('DELETE FROM reactions WHERE message_id = ? AND user_id = ?').run(m.id, user.id);
  } else {
    q('INSERT OR REPLACE INTO reactions (message_id, user_id, emoji, created_at, burst) VALUES (?, ?, ?, ?, ?)').run(m.id, user.id, emoji, Date.now(), burst);
  }
  const out = messageOut(m);
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
  const allowed = canSeeMedia(m, user.id);
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

// ── search ──
route('GET', '/api/search', ({ user, query }) => {
  const text = String(query.q || '').trim();
  if (text.length < 2) return { results: [] };
  const like = `%${text.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const rows = q(
    `SELECT msg.* FROM messages msg JOIN members mb ON mb.conversation_id = msg.conversation_id
      WHERE mb.user_id = ? AND msg.deleted = 0 AND msg.kind != 'system' AND msg.body LIKE ? ESCAPE '\\'
      ORDER BY msg.id DESC LIMIT 60`,
  ).all(user.id, like);
  return { results: rows.map(messageOut) };
});

// ── stickers ──
route('GET', '/api/stickers', ({ user }) =>
  q('SELECT id, media_id, created_at FROM stickers WHERE user_id = ? ORDER BY created_at DESC').all(user.id)
    .map((r) => ({ id: r.id, media: r.media_id, createdAt: r.created_at })),
);

route('POST', '/api/stickers', ({ user, body }) => {
  const m = requireMedia(body.media, user.id);
  if (!m.mime.startsWith('image/')) throw bad('Stickers have to be pictures');
  if (q('SELECT COUNT(*) AS n FROM stickers WHERE user_id = ?').get(user.id).n >= 300) throw bad('You have loads of stickers already (300 max)');
  q('INSERT OR IGNORE INTO stickers (user_id, media_id, created_at) VALUES (?, ?, ?)').run(user.id, m.id, Date.now());
  const r = q('SELECT id, media_id, created_at FROM stickers WHERE user_id = ? AND media_id = ?').get(user.id, m.id);
  return { id: r.id, media: r.media_id, createdAt: r.created_at };
});

route('DELETE', '/api/stickers/:id', ({ user, params }) => {
  const r = q('SELECT * FROM stickers WHERE id = ? AND user_id = ?').get(Number(params.id), user.id);
  if (!r) throw notFound('Sticker not found');
  q('DELETE FROM stickers WHERE id = ?').run(r.id);
  deleteMediaIfUnused(r.media_id);
  return { ok: true };
});

// ── GIFs (Giphy, proxied so phones never need the key) ──
route('GET', '/api/gifs', async ({ query }) => {
  if (!gifsEnabled()) throw new HttpError(503, 'GIFs aren’t set up on this server yet', 'gifs_off');
  try {
    return await findGifs(String(query.q || '').trim(), query.offset);
  } catch (e) {
    throw new HttpError(502, 'Couldn’t reach Giphy, try again');
  }
});

route('POST', '/api/conversations/:id/gif', async ({ user, params, body }) => {
  const convId = Number(params.id);
  requireMember(convId, user.id);
  const clientId = str(body.clientId, 64, 'clientId') || null;
  if (clientId) {
    const dup = q('SELECT * FROM messages WHERE sender_id = ? AND client_id = ?').get(user.id, clientId);
    if (dup) return messageOut(dup);
  }
  let gif;
  try {
    gif = await downloadGif(String(body.url || ''));
  } catch (e) {
    throw bad('Couldn’t get that GIF');
  }
  const mediaId = saveMediaBuffer(gif.body, gif.mime, 'gif.gif', user.id);
  return sendMessage(user.id, convId, { clientId, media: mediaId, replyTo: body.replyTo, body: typeof body.body === 'string' ? body.body : '' }).message;
});

// ── admin ──
function requireServerAdmin(user) {
  if (!user.is_admin) throw forbidden('Only server admins can do that');
}

route('GET', '/api/admin/overview', ({ user }) => {
  requireServerAdmin(user);
  const count = (sql) => q(sql).get().n;
  let dbBytes = 0;
  try {
    dbBytes = fs.statSync(path.join(config.dataDir, 'bants.db')).size;
  } catch {}
  return {
    users: count('SELECT COUNT(*) AS n FROM users'),
    conversations: count('SELECT COUNT(*) AS n FROM conversations'),
    messages: count("SELECT COUNT(*) AS n FROM messages WHERE kind != 'system'"),
    mediaFiles: count('SELECT COUNT(*) AS n FROM media'),
    servers: count('SELECT COUNT(*) AS n FROM servers'),
    channelMessages: count('SELECT COUNT(*) AS n FROM channel_messages WHERE deleted = 0'),
    mediaBytes: q('SELECT COALESCE(SUM(size), 0) AS n FROM media').get().n,
    dbBytes,
    push: !!config.fcmServiceAccount,
    gifs: gifsEnabled(),
    callRelay: !!(config.turnSecret && config.turnHost),
    backup: backupStatus(),
    ...registrationSettings(),
  };
});

route('POST', '/api/admin/backup', async ({ user }) => {
  requireServerAdmin(user);
  try {
    return await runBackup();
  } catch (e) {
    throw bad(e.message);
  }
});

route('GET', '/api/admin/users', ({ user }) => {
  requireServerAdmin(user);
  return q(
    `SELECT u.*, (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id) AS message_count
       FROM users u ORDER BY u.created_at`,
  ).all().map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatar: u.avatar_media,
    isAdmin: !!u.is_admin,
    createdAt: u.created_at,
    lastSeen: u.last_seen,
    online: isOnline(u.id),
    messages: u.message_count,
  }));
});

route('PATCH', '/api/admin/settings', ({ user, body }) => {
  requireServerAdmin(user);
  if (body.inviteCode !== undefined) setSetting('inviteCode', String(body.inviteCode || '').trim().slice(0, 64));
  if (body.allowRegistration !== undefined) setSetting('allowRegistration', body.allowRegistration ? 'true' : 'false');
  return registrationSettings();
});

route('POST', '/api/admin/users/:id/reset-password', async ({ user, params }) => {
  requireServerAdmin(user);
  const target = getUser(Number(params.id));
  if (!target) throw notFound('User not found');
  const words = ['banter', 'kebab', 'pigeon', 'crumpet', 'wombat', 'trifle', 'noodle', 'gravy', 'biscuit', 'puddle', 'goblin', 'pickle'];
  const pick = () => words[crypto.randomInt(words.length)];
  const password = `${pick()}-${pick()}-${crypto.randomInt(100, 1000)}`;
  q('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), target.id);
  disconnect(target.id);
  q('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  return { password };
});

route('POST', '/api/admin/users/:id/admin', ({ user, params, body }) => {
  requireServerAdmin(user);
  const target = getUser(Number(params.id));
  if (!target) throw notFound('User not found');
  if (!body.admin && target.id === user.id) throw bad('You can’t remove your own admin rights');
  q('UPDATE users SET is_admin = ? WHERE id = ?').run(body.admin ? 1 : 0, target.id);
  return { ok: true };
});

route('DELETE', '/api/admin/users/:id', ({ user, params }) => {
  requireServerAdmin(user);
  const target = getUser(Number(params.id));
  if (!target) throw notFound('User not found');
  if (target.id === user.id) throw bad('Delete your own account from the app instead');
  const convIds = q('SELECT conversation_id FROM members WHERE user_id = ?').all(target.id).map((r) => r.conversation_id);
  disconnect(target.id);
  announceOwnedServersGone(target.id);
  q('DELETE FROM users WHERE id = ?').run(target.id);
  for (const id of convIds) broadcastConversation(id);
  return { ok: true };
});

const ADMIN_HTML = new URL('./admin.html', import.meta.url);
route('GET', '/admin', ({ res }) => {
  const html = fs.readFileSync(ADMIN_HTML);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
  res.end(html);
}, { auth: false });

export { getUser, conversationOut, isBlocked, areContacts };
