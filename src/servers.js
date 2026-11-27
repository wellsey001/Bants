// Servers: Discord-style communities with channels, roles and permissions.
// Chats (conversations) are untouched. The app switches between the two with one button.
import crypto from 'node:crypto';
import { q, tx } from './db.js';
import { route, HttpError, getUser, mediaAccessChecks } from './api.js';
import { sendToUser, isOnline } from './hub.js';
import {
  P, ALL, DEFAULT_EVERYONE, has, serverPermissions, channelPermissions, topRolePosition, outranks, canManageRole,
} from './permissions.js';

const bad = (msg, code) => new HttpError(400, msg, code);
const notFound = (msg = 'Not found') => new HttpError(404, msg, 'not_found');
const forbidden = (msg = 'You don’t have permission to do that') => new HttpError(403, msg, 'forbidden');

const MAX_SERVERS_OWNED = Number(process.env.MAX_SERVERS_PER_USER || 25);
const MAX_BODY = 4000;
const CHANNEL_TYPES = ['text', 'voice', 'announcement', 'category'];
const INVITE_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

function str(v, max, field) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw bad(`${field} must be text`);
  const s = v.trim();
  if (s.length > max) throw bad(`${field} is too long (max ${max})`);
  return s;
}
const int = (v, field) => {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`${field} must be a whole number`);
  return n;
};
/** Text channel names look like #general: lower case, dashes for spaces. */
const channelName = (name, type) =>
  type === 'text' || type === 'announcement' || type === 'thread'
    ? name.toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 100)
    : name.slice(0, 100);

// ───────────────────────── lookups and checks ─────────────────────────

const getServer = (id) => q('SELECT * FROM servers WHERE id = ?').get(id);
const getChannel = (id) => q('SELECT * FROM channels WHERE id = ?').get(id);
const getRole = (id) => q('SELECT * FROM roles WHERE id = ?').get(id);
const isMember = (serverId, userId) => !!q('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
const memberIds = (serverId) => q('SELECT user_id FROM server_members WHERE server_id = ?').all(serverId).map((r) => r.user_id);

function requireServer(serverId, userId) {
  const s = getServer(serverId);
  if (!s || !isMember(serverId, userId)) throw notFound('Server not found');
  return s;
}
function requireServerPerm(serverId, userId, bit) {
  const s = requireServer(serverId, userId);
  if (!has(serverPermissions(serverId, userId), bit)) throw forbidden();
  return s;
}
/** The channel, if this person can see it. Hidden channels look the same as missing ones. */
function requireChannel(channelId, userId) {
  const c = getChannel(channelId);
  if (!c) throw notFound('Channel not found');
  const perms = channelPermissions(c.id, userId);
  if (!has(perms, P.VIEW_CHANNEL)) throw notFound('Channel not found');
  return { channel: c, perms };
}
function requireChannelPerm(channelId, userId, bit) {
  const r = requireChannel(channelId, userId);
  if (!has(r.perms, bit)) throw forbidden();
  return r;
}
/** You can only hand out permissions you have yourself. */
function checkGrantable(serverId, userId, bits) {
  const mine = serverPermissions(serverId, userId);
  if ((bits & ~mine) !== 0) throw forbidden('You can’t give out permissions you don’t have');
}

function audit(serverId, actorId, action, targetId = null, meta = null) {
  q('INSERT INTO audit_log (server_id, actor_id, action, target_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(serverId, actorId, action, targetId, meta ? JSON.stringify(meta) : null, Date.now());
}

// ───────────────────────── realtime ─────────────────────────

function audienceOf(channelId) {
  const c = getChannel(channelId);
  if (!c) return [];
  return memberIds(c.server_id).filter((uid) => has(channelPermissions(channelId, uid), P.VIEW_CHANNEL));
}
function sendToChannel(channelId, event, { exceptUserId = null, audience = null } = {}) {
  for (const uid of audience || audienceOf(channelId)) if (uid !== exceptUserId) sendToUser(uid, event);
}
function sendToServer(serverId, event, { exceptUserId = null } = {}) {
  for (const uid of memberIds(serverId)) if (uid !== exceptUserId) sendToUser(uid, event);
}
/** Anything that can change who sees what (roles, overrides, channels): send each member their own fresh view. */
function refreshServer(serverId) {
  for (const uid of memberIds(serverId)) sendToUser(uid, { type: 'server.update', server: serverOut(serverId, uid) });
}

// ───────────────────────── serialisers ─────────────────────────

function roleOut(r) {
  return {
    id: r.id, name: r.name, colour: r.colour, position: r.position, permissions: r.permissions,
    hoist: !!r.hoist, mentionable: !!r.mentionable, isDefault: !!r.is_default,
  };
}

function channelOut(c, viewerId, perms = channelPermissions(c.id, viewerId)) {
  const read = q('SELECT last_read, mention_count FROM channel_reads WHERE user_id = ? AND channel_id = ?').get(viewerId, c.id);
  const out = {
    id: c.id, serverId: c.server_id, type: c.type, parentId: c.parent_id, name: c.name, topic: c.topic,
    position: c.position, slowmode: c.slowmode_s, nsfw: !!c.nsfw, syncPerms: !!c.sync_perms,
    lastMessageId: c.last_message_id,
    unread: c.type !== 'category' && c.type !== 'voice' && c.last_message_id > (read?.last_read || 0),
    mentionCount: read?.mention_count || 0,
    permissions: perms,
  };
  if (c.type === 'voice') out.userLimit = c.voice_limit;
  if (c.type === 'thread') Object.assign(out, { ownerId: c.owner_id, archived: !!c.archived, locked: !!c.locked, starterMessageId: c.starter_message_id });
  return out;
}

function memberOut(serverId, row) {
  const roleIds = q('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?').all(serverId, row.id).map((r) => r.role_id);
  return {
    user: { id: row.id, username: row.username, displayName: row.display_name, avatar: row.avatar_media, about: row.about },
    nickname: row.nickname,
    roleIds,
    joinedAt: row.joined_at,
    timeoutUntil: row.timeout_until && row.timeout_until > Date.now() ? row.timeout_until : null,
    online: isOnline(row.id),
  };
}

export function serverOut(serverId, viewerId) {
  const s = getServer(serverId);
  if (!s) return null;
  const me = q('SELECT * FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, viewerId);
  const channels = q("SELECT * FROM channels WHERE server_id = ? AND type != 'thread' ORDER BY position, id").all(serverId)
    .map((c) => ({ c, perms: channelPermissions(c.id, viewerId) }))
    .filter(({ perms }) => has(perms, P.VIEW_CHANNEL))
    .map(({ c, perms }) => channelOut(c, viewerId, perms));
  // Hide categories with nothing visible in them (unless you can manage channels).
  const myPerms = serverPermissions(serverId, viewerId);
  const visible = has(myPerms, P.MANAGE_CHANNELS)
    ? channels
    : channels.filter((c) => c.type !== 'category' || channels.some((x) => x.parentId === c.id));
  return {
    id: s.id, name: s.name, description: s.description, icon: s.icon_media, banner: s.banner_media,
    ownerId: s.owner_id, systemChannelId: s.system_channel_id, createdAt: s.created_at,
    memberCount: q('SELECT COUNT(*) AS n FROM server_members WHERE server_id = ?').get(serverId).n,
    permissions: myPerms,
    roles: q('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC, id').all(serverId).map(roleOut),
    channels: visible,
    me: me ? { nickname: me.nickname, muted: !!me.muted, position: me.position, timeoutUntil: me.timeout_until, roleIds: q('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?').all(serverId, viewerId).map((r) => r.role_id) } : null,
    unread: visible.some((c) => c.unread),
    mentionCount: visible.reduce((n, c) => n + c.mentionCount, 0),
  };
}

function messageOut(m) {
  const author = m.author_id ? getUser(m.author_id) : null;
  const ch = getChannel(m.channel_id);
  const nickname = author && ch ? q('SELECT nickname FROM server_members WHERE server_id = ? AND user_id = ?').get(ch.server_id, author.id)?.nickname : null;
  const reactions = new Map();
  if (!m.deleted) {
    for (const r of q('SELECT emoji, user_id FROM channel_reactions WHERE message_id = ? ORDER BY created_at').all(m.id)) {
      if (!reactions.has(r.emoji)) reactions.set(r.emoji, []);
      reactions.get(r.emoji).push(r.user_id);
    }
  }
  const attachments = m.deleted ? [] : q(
    'SELECT a.media_id, a.spoiler, md.mime, md.size, md.filename FROM channel_attachments a JOIN media md ON md.id = a.media_id WHERE a.message_id = ? ORDER BY a.position',
  ).all(m.id).map((a) => ({ id: a.media_id, mime: a.mime, size: a.size, filename: a.filename, spoiler: !!a.spoiler }));
  let meta = null;
  if (m.meta && !m.deleted) try { meta = JSON.parse(m.meta); } catch {}
  return {
    id: m.id, channelId: m.channel_id, serverId: ch?.server_id ?? null, clientId: m.client_id, kind: m.kind,
    author: author ? { id: author.id, username: author.username, displayName: author.display_name, avatar: author.avatar_media, nickname: nickname ?? null } : null,
    body: m.deleted ? '' : m.body,
    replyTo: m.reply_to, createdAt: m.created_at, editedAt: m.edited_at, deleted: !!m.deleted,
    pinned: !!m.pinned_at, mentionsEveryone: !!m.mentions_everyone,
    reactions: [...reactions].map(([emoji, userIds]) => ({ emoji, userIds })),
    attachments, meta,
  };
}

// ───────────────────────── core operations ─────────────────────────

/** New server with @everyone, a Text and a Voice category, #general and a General voice channel. */
export function createServer(ownerId, name, now = Date.now()) {
  return tx(() => {
    const serverId = Number(q('INSERT INTO servers (name, owner_id, created_at) VALUES (?, ?, ?)').run(name, ownerId, now).lastInsertRowid);
    q('INSERT INTO roles (server_id, name, position, permissions, is_default, created_at) VALUES (?, ?, 0, ?, 1, ?)').run(serverId, '@everyone', DEFAULT_EVERYONE, now);
    const pos = q('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM server_members WHERE user_id = ?').get(ownerId).p;
    q('INSERT INTO server_members (server_id, user_id, joined_at, position) VALUES (?, ?, ?, ?)').run(serverId, ownerId, now, pos);
    const add = (type, n, parentId, position) => Number(q(
      'INSERT INTO channels (server_id, type, name, parent_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(serverId, type, n, parentId, position, now).lastInsertRowid);
    const textCat = add('category', 'Text channels', null, 0);
    const voiceCat = add('category', 'Voice channels', null, 1);
    const general = add('text', 'general', textCat, 0);
    add('voice', 'General', voiceCat, 0);
    q('UPDATE servers SET system_channel_id = ? WHERE id = ?').run(general, serverId);
    return serverId;
  });
}

function storeMessage(channelId, authorId, body, { kind = 'default', replyTo = null, clientId = null, meta = null, allowEveryone = false, pingableRoles = null } = {}, now = Date.now()) {
  const mentionsEveryone = allowEveryone && /@(everyone|here)\b/.test(body) ? 1 : 0;
  const id = Number(q(
    `INSERT INTO channel_messages (channel_id, author_id, client_id, kind, body, reply_to, created_at, mentions_everyone, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(channelId, authorId, clientId, kind, body, replyTo, now, mentionsEveryone, meta && JSON.stringify(meta)).lastInsertRowid);
  const addMention = q('INSERT OR IGNORE INTO channel_mentions (message_id, target_type, target_id) VALUES (?, ?, ?)');
  for (const [, uid] of body.matchAll(/<@(\d+)>/g)) addMention.run(id, 'user', Number(uid));
  for (const [, rid] of body.matchAll(/<@&(\d+)>/g)) if (!pingableRoles || pingableRoles.has(Number(rid))) addMention.run(id, 'role', Number(rid));
  q('UPDATE channels SET last_message_id = ? WHERE id = ?').run(id, channelId);
  return id;
}

/** Who a message pings out of the people who can see it (never the author). */
function pingedUsers(messageId, serverId, audience) {
  const m = q('SELECT author_id, mentions_everyone FROM channel_messages WHERE id = ?').get(messageId);
  const mentions = q('SELECT target_type, target_id FROM channel_mentions WHERE message_id = ?').all(messageId);
  const users = new Set(mentions.filter((x) => x.target_type === 'user').map((x) => x.target_id));
  const roles = new Set(mentions.filter((x) => x.target_type === 'role').map((x) => x.target_id));
  return audience.filter((uid) => {
    if (uid === m.author_id) return false;
    if (m.mentions_everyone || users.has(uid)) return true;
    if (!roles.size) return false;
    return q('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?').all(serverId, uid).some((r) => roles.has(r.role_id));
  });
}

function postSystem(channelId, kind, authorId, meta = null) {
  const id = storeMessage(channelId, authorId, '', { kind, meta });
  sendToChannel(channelId, { type: 'channel.message', message: messageOut(q('SELECT * FROM channel_messages WHERE id = ?').get(id)) });
  return id;
}

export function sendChannelMessage(userId, channelId, input) {
  const { channel, perms } = requireChannel(channelId, userId);
  if (channel.type === 'category') throw bad('You can’t post in a category');
  if (!has(perms, P.SEND_MESSAGES)) {
    throw forbidden(channel.type === 'thread' && channel.locked ? 'This thread is locked' : 'You can’t send messages here');
  }
  if (channel.type === 'thread' && channel.archived) q('UPDATE channels SET archived = 0 WHERE id = ?').run(channel.id);

  const clientId = input.clientId ? String(input.clientId).slice(0, 64) : null;
  if (clientId) {
    const dupe = q('SELECT * FROM channel_messages WHERE author_id = ? AND client_id = ?').get(userId, clientId);
    if (dupe) return messageOut(dupe);
  }
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (body.length > MAX_BODY) throw bad(`Message is too long (max ${MAX_BODY})`);
  const attachmentIds = Array.isArray(input.attachments) ? input.attachments.slice(0, 10).map(String) : [];
  if (!body && !attachmentIds.length) throw bad('Message is empty');
  if (attachmentIds.length && !has(perms, P.ATTACH_FILES)) throw forbidden('You can’t attach files here');
  for (const id of attachmentIds) {
    const m = q('SELECT uploader_id FROM media WHERE id = ?').get(id);
    if (!m || m.uploader_id !== userId) throw bad('Unknown attachment');
  }
  let replyTo = null;
  if (input.replyTo) {
    const r = q('SELECT id FROM channel_messages WHERE id = ? AND channel_id = ?').get(Number(input.replyTo), channel.id);
    if (!r) throw bad('The message you’re replying to isn’t in this channel');
    replyTo = r.id;
  }

  // Slowmode: mods and channel managers skip it.
  const now = Date.now();
  if (channel.slowmode_s && !has(perms, P.MANAGE_MESSAGES) && !has(perms, P.MANAGE_CHANNELS)) {
    const last = q('SELECT created_at FROM channel_messages WHERE channel_id = ? AND author_id = ? ORDER BY id DESC LIMIT 1').get(channel.id, userId);
    const wait = last ? last.created_at + channel.slowmode_s * 1000 - now : 0;
    if (wait > 0) throw new HttpError(429, `Slowmode is on. Try again in ${Math.ceil(wait / 1000)}s`, 'slowmode');
  }

  const canPingAll = has(perms, P.MENTION_EVERYONE);
  const pingableRoles = canPingAll ? null : new Set(q('SELECT id FROM roles WHERE server_id = ? AND mentionable = 1').all(channel.server_id).map((r) => r.id));
  const id = tx(() => {
    const id = storeMessage(channel.id, userId, body, { replyTo, clientId, allowEveryone: canPingAll, pingableRoles }, now);
    attachmentIds.forEach((mid, i) => q('INSERT OR IGNORE INTO channel_attachments (message_id, media_id, position, spoiler) VALUES (?, ?, ?, ?)')
      .run(id, mid, i, input.spoilers?.includes?.(mid) ? 1 : 0));
    // Sending something means you've read everything up to it.
    q(`INSERT INTO channel_reads (user_id, channel_id, last_read, mention_count) VALUES (?, ?, ?, 0)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read = excluded.last_read, mention_count = 0`).run(userId, channel.id, id);
    return id;
  });

  const audience = audienceOf(channel.id);
  const pinged = pingedUsers(id, channel.server_id, audience);
  const bump = q(`INSERT INTO channel_reads (user_id, channel_id, mention_count) VALUES (?, ?, 1)
                  ON CONFLICT(user_id, channel_id) DO UPDATE SET mention_count = mention_count + 1`);
  for (const uid of pinged) bump.run(uid, channel.id);

  const message = messageOut(q('SELECT * FROM channel_messages WHERE id = ?').get(id));
  for (const uid of audience) sendToUser(uid, { type: 'channel.message', message, mentioned: pinged.includes(uid) });
  return message;
}

export function markChannelRead(userId, channelId, messageId) {
  const { channel } = requireChannel(channelId, userId);
  const upto = Math.min(Number(messageId) || channel.last_message_id, channel.last_message_id);
  q(`INSERT INTO channel_reads (user_id, channel_id, last_read, mention_count) VALUES (?, ?, ?, 0)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read = MAX(last_read, excluded.last_read), mention_count = 0`).run(userId, channel.id, upto);
  sendToUser(userId, { type: 'channel.read', channelId: channel.id, serverId: channel.server_id, lastRead: upto });
}

export function sendChannelTyping(userId, channelId) {
  const { channel, perms } = requireChannel(channelId, userId);
  if (!has(perms, P.SEND_MESSAGES)) return;
  sendToChannel(channel.id, { type: 'channel.typing', channelId: channel.id, serverId: channel.server_id, userId }, { exceptUserId: userId });
}

/** Tell everyone who shares a server with this person that they came online / went offline. */
export function notifyServerPresence(userId, online) {
  const others = q(`SELECT DISTINCT b.user_id FROM server_members a JOIN server_members b ON b.server_id = a.server_id
                    WHERE a.user_id = ? AND b.user_id != ?`).all(userId, userId);
  for (const { user_id } of others) sendToUser(user_id, { type: 'server.presence', userId, online });
}

/** Can this person see this file because of a server? (server icon, or attachment in a channel they can see) */
export function canSeeServerMedia(mediaId, userId) {
  if (q('SELECT 1 FROM servers s JOIN server_members m ON m.server_id = s.id WHERE (s.icon_media = ? OR s.banner_media = ?) AND m.user_id = ?').get(mediaId, mediaId, userId)) return true;
  const rows = q('SELECT DISTINCT cm.channel_id FROM channel_attachments a JOIN channel_messages cm ON cm.id = a.message_id WHERE a.media_id = ? AND cm.deleted = 0').all(mediaId);
  return rows.some((r) => has(channelPermissions(r.channel_id, userId), P.VIEW_CHANNEL | P.READ_HISTORY));
}

mediaAccessChecks.push(canSeeServerMedia);

function newInviteCode() {
  while (true) {
    const code = Array.from(crypto.randomBytes(8), (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');
    if (!q('SELECT 1 FROM server_invites WHERE code = ?').get(code)) return code;
  }
}

function removeMember(serverId, userId) {
  q('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, userId);
  q('DELETE FROM channel_reads WHERE user_id = ? AND channel_id IN (SELECT id FROM channels WHERE server_id = ?)').run(userId, serverId);
  sendToUser(userId, { type: 'server.remove', serverId });
  sendToServer(serverId, { type: 'server.member.remove', serverId, userId });
}

// ───────────────────────── routes: servers ─────────────────────────

route('GET', '/api/servers', ({ user }) =>
  q('SELECT server_id FROM server_members WHERE user_id = ? ORDER BY position, joined_at').all(user.id).map((r) => serverOut(r.server_id, user.id)));

route('POST', '/api/servers', ({ user, body }) => {
  const name = str(body.name, 100, 'name');
  if (!name) throw bad('Give your server a name');
  if (q('SELECT COUNT(*) AS n FROM servers WHERE owner_id = ?').get(user.id).n >= MAX_SERVERS_OWNED) throw bad(`You can own up to ${MAX_SERVERS_OWNED} servers`);
  const id = createServer(user.id, name);
  const out = serverOut(id, user.id);
  sendToUser(user.id, { type: 'server.add', server: out });
  return out;
});

route('GET', '/api/servers/:id', ({ user, params }) => {
  requireServer(Number(params.id), user.id);
  return serverOut(Number(params.id), user.id);
});

route('PATCH', '/api/servers/:id', ({ user, params, body }) => {
  const s = requireServerPerm(Number(params.id), user.id, P.MANAGE_SERVER);
  const name = str(body.name, 100, 'name');
  const description = str(body.description, 1000, 'description');
  if (name !== undefined && !name) throw bad('Name can’t be empty');
  const changes = {};
  if (name !== undefined) changes.name = name;
  if (description !== undefined) changes.description = description;
  for (const [key, col] of [['icon', 'icon_media'], ['banner', 'banner_media']]) {
    if (body[key] === undefined) continue;
    if (body[key] !== null) {
      const m = q('SELECT uploader_id, mime FROM media WHERE id = ?').get(String(body[key]));
      if (!m || m.uploader_id !== user.id || !m.mime.startsWith('image/')) throw bad(`Unknown ${key} image`);
    }
    changes[col] = body[key];
  }
  if (body.systemChannelId !== undefined) {
    if (body.systemChannelId !== null) {
      const c = getChannel(Number(body.systemChannelId));
      if (!c || c.server_id !== s.id || c.type !== 'text') throw bad('Pick a text channel in this server');
    }
    changes.system_channel_id = body.systemChannelId;
  }
  const keys = Object.keys(changes);
  if (keys.length) {
    q(`UPDATE servers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(changes), s.id);
    audit(s.id, user.id, 'server.update', s.id, { changed: keys });
    refreshServer(s.id);
  }
  return serverOut(s.id, user.id);
});

route('DELETE', '/api/servers/:id', ({ user, params }) => {
  const s = requireServer(Number(params.id), user.id);
  if (s.owner_id !== user.id) throw forbidden('Only the owner can delete the server');
  const members = memberIds(s.id);
  q('DELETE FROM servers WHERE id = ?').run(s.id);
  for (const uid of members) sendToUser(uid, { type: 'server.remove', serverId: s.id });
  return { ok: true };
});

route('POST', '/api/servers/:id/transfer', ({ user, params, body }) => {
  const s = requireServer(Number(params.id), user.id);
  if (s.owner_id !== user.id) throw forbidden('Only the owner can hand the server over');
  const to = Number(body.userId);
  if (!isMember(s.id, to) || to === user.id) throw bad('Pick another member of the server');
  q('UPDATE servers SET owner_id = ? WHERE id = ?').run(to, s.id);
  audit(s.id, user.id, 'server.transfer', to);
  refreshServer(s.id);
  return serverOut(s.id, user.id);
});

/** Leave a server. The owner has to hand it over or delete it first. */
route('POST', '/api/servers/:id/leave', ({ user, params }) => {
  const s = requireServer(Number(params.id), user.id);
  if (s.owner_id === user.id) throw bad('Hand the server to someone else or delete it before leaving');
  removeMember(s.id, user.id);
  return { ok: true };
});

/** Your own settings for a server: sidebar order and mute. */
route('PATCH', '/api/servers/:id/me', ({ user, params, body }) => {
  const s = requireServer(Number(params.id), user.id);
  if (body.muted !== undefined) q('UPDATE server_members SET muted = ? WHERE server_id = ? AND user_id = ?').run(body.muted ? 1 : 0, s.id, user.id);
  if (body.position !== undefined) q('UPDATE server_members SET position = ? WHERE server_id = ? AND user_id = ?').run(int(body.position, 'position'), s.id, user.id);
  return serverOut(s.id, user.id);
});

route('GET', '/api/servers/:id/audit-log', ({ user, params, query }) => {
  const s = requireServerPerm(Number(params.id), user.id, P.VIEW_AUDIT_LOG);
  const before = Number(query.before) || Number.MAX_SAFE_INTEGER;
  return q('SELECT * FROM audit_log WHERE server_id = ? AND id < ? ORDER BY id DESC LIMIT 100').all(s.id, before).map((a) => ({
    id: a.id, actorId: a.actor_id, action: a.action, targetId: a.target_id, meta: a.meta ? JSON.parse(a.meta) : null, createdAt: a.created_at,
  }));
});

// ───────────────────────── routes: members ─────────────────────────

route('GET', '/api/servers/:id/members', ({ user, params }) => {
  const s = requireServer(Number(params.id), user.id);
  return q('SELECT u.*, m.nickname, m.joined_at, m.timeout_until FROM server_members m JOIN users u ON u.id = m.user_id WHERE m.server_id = ? ORDER BY m.joined_at')
    .all(s.id).map((row) => memberOut(s.id, row));
});

/** Change a member: nickname, roles, timeout. Each part needs its own permission. */
route('PATCH', '/api/servers/:id/members/:userId', ({ user, params, body }) => {
  const s = requireServer(Number(params.id), user.id);
  const targetId = Number(params.userId);
  if (!isMember(s.id, targetId)) throw notFound('Member not found');
  const perms = serverPermissions(s.id, user.id);
  const self = targetId === user.id;

  tx(() => {
    if (body.nickname !== undefined) {
      const nick = body.nickname === null ? null : str(body.nickname, 32, 'nickname') || null;
      if (self ? !has(perms, P.CHANGE_NICKNAME) && !has(perms, P.MANAGE_NICKNAMES) : !(has(perms, P.MANAGE_NICKNAMES) && outranks(s.id, user.id, targetId))) throw forbidden();
      q('UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?').run(nick, s.id, targetId);
    }
    if (body.roleIds !== undefined) {
      if (!Array.isArray(body.roleIds)) throw bad('roleIds must be a list');
      if (!has(perms, P.MANAGE_ROLES)) throw forbidden();
      if (!self && !outranks(s.id, user.id, targetId) && s.owner_id !== user.id) throw forbidden('They’re above you in the role list');
      const want = new Set(body.roleIds.map(Number));
      const have = new Set(q('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?').all(s.id, targetId).map((r) => r.role_id));
      for (const rid of new Set([...want, ...have])) {
        if (want.has(rid) === have.has(rid)) continue;
        const role = getRole(rid);
        if (!role || role.server_id !== s.id || role.is_default) throw bad('Unknown role');
        if (!canManageRole(user.id, rid)) throw forbidden(`You can’t manage the ${role.name} role`);
        if (want.has(rid)) q('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(s.id, targetId, rid);
        else q('DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?').run(s.id, targetId, rid);
      }
      audit(s.id, user.id, 'member.roles', targetId, { roleIds: [...want] });
    }
    if (body.timeoutUntil !== undefined) {
      if (self || !has(perms, P.TIMEOUT_MEMBERS) || !outranks(s.id, user.id, targetId)) throw forbidden();
      const until = body.timeoutUntil === null ? null : Number(body.timeoutUntil);
      if (until !== null && (!Number.isFinite(until) || until > Date.now() + 28 * 86400_000)) throw bad('Timeouts can last up to 28 days');
      q('UPDATE server_members SET timeout_until = ? WHERE server_id = ? AND user_id = ?').run(until, s.id, targetId);
      audit(s.id, user.id, until ? 'member.timeout' : 'member.timeout_end', targetId, { until, reason: str(body.reason, 300, 'reason') || '' });
    }
  });

  const row = q('SELECT u.*, m.nickname, m.joined_at, m.timeout_until FROM server_members m JOIN users u ON u.id = m.user_id WHERE m.server_id = ? AND m.user_id = ?').get(s.id, targetId);
  const out = memberOut(s.id, row);
  sendToServer(s.id, { type: 'server.member.update', serverId: s.id, member: out });
  // Role changes can change which channels they see.
  if (body.roleIds !== undefined || body.timeoutUntil !== undefined) sendToUser(targetId, { type: 'server.update', server: serverOut(s.id, targetId) });
  return out;
});

route('DELETE', '/api/servers/:id/members/:userId', ({ user, params, body }) => {
  const s = requireServerPerm(Number(params.id), user.id, P.KICK_MEMBERS);
  const targetId = Number(params.userId);
  if (!isMember(s.id, targetId)) throw notFound('Member not found');
  if (!outranks(s.id, user.id, targetId)) throw forbidden('They’re above you in the role list');
  removeMember(s.id, targetId);
  audit(s.id, user.id, 'member.kick', targetId, { reason: str(body?.reason, 300, 'reason') || '' });
  return { ok: true };
});

route('GET', '/api/servers/:id/bans', ({ user, params }) => {
  const s = requireServerPerm(Number(params.id), user.id, P.BAN_MEMBERS);
  return q('SELECT b.*, u.username, u.display_name FROM server_bans b JOIN users u ON u.id = b.user_id WHERE b.server_id = ? ORDER BY b.created_at DESC').all(s.id)
    .map((b) => ({ user: { id: b.user_id, username: b.username, displayName: b.display_name }, reason: b.reason, bannedBy: b.banned_by, createdAt: b.created_at }));
});

route('POST', '/api/servers/:id/bans/:userId', ({ user, params, body }) => {
  const s = requireServerPerm(Number(params.id), user.id, P.BAN_MEMBERS);
  const targetId = Number(params.userId);
  if (!getUser(targetId)) throw notFound('User not found');
  if (targetId === user.id || targetId === s.owner_id) throw forbidden();
  if (isMember(s.id, targetId) && !outranks(s.id, user.id, targetId)) throw forbidden('They’re above you in the role list');
  const reason = str(body.reason, 300, 'reason') || '';
  q('INSERT OR REPLACE INTO server_bans (server_id, user_id, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?)').run(s.id, targetId, reason, user.id, Date.now());
  if (isMember(s.id, targetId)) removeMember(s.id, targetId);
  // Optionally wipe their recent messages (up to 7 days).
  const hours = Math.min(168, Math.max(0, Number(body.deleteMessageHours) || 0));
  if (hours) {
    const since = Date.now() - hours * 3600_000;
    const rows = q('SELECT id, channel_id FROM channel_messages WHERE author_id = ? AND created_at >= ? AND deleted = 0 AND channel_id IN (SELECT id FROM channels WHERE server_id = ?)').all(targetId, since, s.id);
    for (const r of rows) {
      q("UPDATE channel_messages SET deleted = 1, body = '', meta = NULL WHERE id = ?").run(r.id);
      q('DELETE FROM channel_attachments WHERE message_id = ?').run(r.id);
      sendToChannel(r.channel_id, { type: 'channel.message.delete', channelId: r.channel_id, messageId: r.id });
    }
  }
  audit(s.id, user.id, 'member.ban', targetId, { reason });
  return { ok: true };
});

route('DELETE', '/api/servers/:id/bans/:userId', ({ user, params }) => {
  const s = requireServerPerm(Number(params.id), user.id, P.BAN_MEMBERS);
  q('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?').run(s.id, Number(params.userId));
  audit(s.id, user.id, 'member.unban', Number(params.userId));
  return { ok: true };
});

// ───────────────────────── routes: invites ─────────────────────────

route('POST', '/api/servers/:id/invites', ({ user, params, body }) => {
  const s = requireServerPerm(Number(params.id), user.id, P.CREATE_INVITE);
  const maxUses = Math.max(0, Math.min(1000, int(body.maxUses, 'maxUses') ?? 0));
  // Default 7 days. 0 = never expires.
  const hours = body.expiresInHours === undefined ? 168 : Math.max(0, Math.min(24 * 30, Number(body.expiresInHours) || 0));
  const code = newInviteCode();
  const now = Date.now();
  q('INSERT INTO server_invites (code, server_id, created_by, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(code, s.id, user.id, maxUses, hours ? now + hours * 3600_000 : null, now);
  audit(s.id, user.id, 'invite.create', null, { code });
  return { code, serverId: s.id, maxUses, uses: 0, expiresAt: hours ? now + hours * 3600_000 : null };
});

route('GET', '/api/servers/:id/invites', ({ user, params }) => {
  const s = requireServerPerm(Number(params.id), user.id, P.MANAGE_SERVER);
  return q('SELECT * FROM server_invites WHERE server_id = ? ORDER BY created_at DESC').all(s.id)
    .map((i) => ({ code: i.code, createdBy: i.created_by, maxUses: i.max_uses, uses: i.uses, expiresAt: i.expires_at, createdAt: i.created_at }));
});

/** Preview an invite before joining. */
route('GET', '/api/invites/:code', ({ params }) => {
  const inv = q('SELECT * FROM server_invites WHERE code = ?').get(params.code);
  if (!inv || (inv.expires_at && inv.expires_at < Date.now()) || (inv.max_uses && inv.uses >= inv.max_uses)) throw notFound('This invite is invalid or has expired');
  const s = getServer(inv.server_id);
  const ids = memberIds(s.id);
  return { code: inv.code, server: { id: s.id, name: s.name, icon: s.icon_media, description: s.description }, memberCount: ids.length, onlineCount: ids.filter(isOnline).length };
});

route('POST', '/api/invites/:code', ({ user, params }) => {
  const now = Date.now();
  const serverId = tx(() => {
    const inv = q('SELECT * FROM server_invites WHERE code = ?').get(params.code);
    if (!inv || (inv.expires_at && inv.expires_at < now) || (inv.max_uses && inv.uses >= inv.max_uses)) throw notFound('This invite is invalid or has expired');
    if (q('SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?').get(inv.server_id, user.id)) throw forbidden('You’re banned from this server');
    if (isMember(inv.server_id, user.id)) return inv.server_id;
    const pos = q('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM server_members WHERE user_id = ?').get(user.id).p;
    q('INSERT INTO server_members (server_id, user_id, joined_at, position) VALUES (?, ?, ?, ?)').run(inv.server_id, user.id, now, pos);
    q('UPDATE server_invites SET uses = uses + 1 WHERE code = ?').run(inv.code);
    return -inv.server_id; // negative = newly joined
  });
  const id = Math.abs(serverId);
  if (serverId < 0) {
    const row = q('SELECT u.*, m.nickname, m.joined_at, m.timeout_until FROM server_members m JOIN users u ON u.id = m.user_id WHERE m.server_id = ? AND m.user_id = ?').get(id, user.id);
    sendToServer(id, { type: 'server.member.add', serverId: id, member: memberOut(id, row) }, { exceptUserId: user.id });
    sendToUser(user.id, { type: 'server.add', server: serverOut(id, user.id) });
    const sys = getServer(id).system_channel_id;
    if (sys && getChannel(sys)) postSystem(sys, 'join', user.id);
  }
  return serverOut(id, user.id);
});

route('DELETE', '/api/invites/:code', ({ user, params }) => {
  const inv = q('SELECT * FROM server_invites WHERE code = ?').get(params.code);
  if (!inv) throw notFound();
  requireServer(inv.server_id, user.id);
  if (inv.created_by !== user.id && !has(serverPermissions(inv.server_id, user.id), P.MANAGE_SERVER)) throw forbidden();
  q('DELETE FROM server_invites WHERE code = ?').run(inv.code);
  audit(inv.server_id, user.id, 'invite.delete', null, { code: inv.code });
  return { ok: true };
});

// ───────────────────────── routes: roles ─────────────────────────

route('POST', '/api/servers/:id/roles', ({ user, params, body }) => {
  const s = requireServerPerm(Number(params.id), user.id, P.MANAGE_ROLES);
  const name = str(body.name, 100, 'name') || 'new role';
  const permissions = (int(body.permissions, 'permissions') ?? 0) & ALL;
  checkGrantable(s.id, user.id, permissions);
  const colour = body.colour === undefined || body.colour === null ? null : int(body.colour, 'colour') & 0xffffff;
  // New roles go just above @everyone, like Discord.
  const id = tx(() => {
    q('UPDATE roles SET position = position + 1 WHERE server_id = ? AND is_default = 0').run(s.id);
    return Number(q('INSERT INTO roles (server_id, name, colour, position, permissions, hoist, mentionable, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)')
      .run(s.id, name, colour, permissions, body.hoist ? 1 : 0, body.mentionable ? 1 : 0, Date.now()).lastInsertRowid);
  });
  audit(s.id, user.id, 'role.create', id, { name });
  refreshServer(s.id);
  return roleOut(getRole(id));
});

route('PATCH', '/api/roles/:id', ({ user, params, body }) => {
  const role = getRole(Number(params.id));
  if (!role) throw notFound('Role not found');
  requireServer(role.server_id, user.id);
  const isOwner = getServer(role.server_id).owner_id === user.id;
  // @everyone has position 0 so anyone with MANAGE_ROLES and a real role can edit it.
  if (!isOwner && !canManageRole(user.id, role.id)) throw forbidden('That role is above yours');
  const changes = {};
  if (body.name !== undefined && !role.is_default) changes.name = str(body.name, 100, 'name') || role.name;
  if (body.colour !== undefined) changes.colour = body.colour === null ? null : int(body.colour, 'colour') & 0xffffff;
  if (body.hoist !== undefined) changes.hoist = body.hoist ? 1 : 0;
  if (body.mentionable !== undefined) changes.mentionable = body.mentionable ? 1 : 0;
  if (body.permissions !== undefined) {
    const perms = int(body.permissions, 'permissions') & ALL;
    checkGrantable(role.server_id, user.id, perms & ~role.permissions); // only newly added bits need checking
    changes.permissions = perms;
  }
  if (body.position !== undefined && !role.is_default) {
    const pos = int(body.position, 'position');
    if (pos < 1) throw bad('Position must be 1 or more');
    if (!isOwner && pos >= topRolePosition(role.server_id, user.id)) throw forbidden('You can only move roles below your own');
    changes.position = pos;
  }
  const keys = Object.keys(changes);
  if (keys.length) {
    tx(() => {
      if (changes.position !== undefined && changes.position !== role.position) {
        // Shift the others so positions stay unique.
        if (changes.position > role.position) q('UPDATE roles SET position = position - 1 WHERE server_id = ? AND is_default = 0 AND position > ? AND position <= ?').run(role.server_id, role.position, changes.position);
        else q('UPDATE roles SET position = position + 1 WHERE server_id = ? AND is_default = 0 AND position >= ? AND position < ?').run(role.server_id, changes.position, role.position);
      }
      q(`UPDATE roles SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(changes), role.id);
    });
    audit(role.server_id, user.id, 'role.update', role.id, { changed: keys });
    refreshServer(role.server_id);
  }
  return roleOut(getRole(role.id));
});

route('DELETE', '/api/roles/:id', ({ user, params }) => {
  const role = getRole(Number(params.id));
  if (!role) throw notFound('Role not found');
  requireServer(role.server_id, user.id);
  if (role.is_default) throw bad('You can’t delete @everyone');
  if (getServer(role.server_id).owner_id !== user.id && !canManageRole(user.id, role.id)) throw forbidden('That role is above yours');
  tx(() => {
    q('DELETE FROM roles WHERE id = ?').run(role.id);
    q("DELETE FROM channel_overrides WHERE target_type = 'role' AND target_id = ?").run(role.id);
    q('UPDATE roles SET position = position - 1 WHERE server_id = ? AND is_default = 0 AND position > ?').run(role.server_id, role.position);
  });
  audit(role.server_id, user.id, 'role.delete', role.id, { name: role.name });
  refreshServer(role.server_id);
  return { ok: true };
});

// ───────────────────────── routes: channels ─────────────────────────

function validParent(serverId, parentId, type) {
  if (parentId === undefined) return undefined;
  if (parentId === null) return null;
  if (type === 'category') throw bad('Categories can’t go inside other categories');
  const p = getChannel(Number(parentId));
  if (!p || p.server_id !== serverId || p.type !== 'category') throw bad('Pick a category in this server');
  return p.id;
}

route('POST', '/api/servers/:id/channels', ({ user, params, body }) => {
  const s = requireServerPerm(Number(params.id), user.id, P.MANAGE_CHANNELS);
  const type = CHANNEL_TYPES.includes(body.type) ? body.type : 'text';
  const name = channelName(str(body.name, 100, 'name') || '', type);
  if (!name) throw bad('Give the channel a name');
  const parentId = validParent(s.id, body.parentId, type) ?? null;
  const position = int(body.position, 'position') ??
    q('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ? AND parent_id IS ? AND type != ?').get(s.id, parentId, 'thread').p;
  const id = Number(q('INSERT INTO channels (server_id, type, name, parent_id, topic, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(s.id, type, name, parentId, str(body.topic, 1024, 'topic') || '', position, Date.now()).lastInsertRowid);
  // A private channel: hidden from @everyone, visible to the roles listed.
  if (body.private) {
    const everyone = q('SELECT id FROM roles WHERE server_id = ? AND is_default = 1').get(s.id).id;
    q('UPDATE channels SET sync_perms = 0 WHERE id = ?').run(id);
    q("INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, 'role', ?, 0, ?)").run(id, everyone, P.VIEW_CHANNEL);
    q("INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, 'member', ?, ?, 0)").run(id, user.id, P.VIEW_CHANNEL);
    for (const rid of Array.isArray(body.roleIds) ? body.roleIds : []) {
      const r = getRole(Number(rid));
      if (r && r.server_id === s.id) q("INSERT OR IGNORE INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, 'role', ?, ?, 0)").run(id, r.id, P.VIEW_CHANNEL);
    }
  }
  audit(s.id, user.id, 'channel.create', id, { name, type });
  refreshServer(s.id);
  return channelOut(getChannel(id), user.id);
});

route('PATCH', '/api/channels/:id', ({ user, params, body }) => {
  const { channel: c, perms } = requireChannel(Number(params.id), user.id);
  if (c.type === 'thread') {
    // Thread starters can rename and archive their own thread; locking needs MANAGE_THREADS.
    const mod = has(perms, P.MANAGE_THREADS);
    if (!mod && c.owner_id !== user.id) throw forbidden();
    if (body.locked !== undefined && !mod) throw forbidden();
    const changes = {};
    if (body.name !== undefined) changes.name = channelName(str(body.name, 100, 'name') || c.name, 'thread');
    if (body.archived !== undefined) changes.archived = body.archived ? 1 : 0;
    if (body.locked !== undefined) changes.locked = body.locked ? 1 : 0;
    const keys = Object.keys(changes);
    if (keys.length) q(`UPDATE channels SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(changes), c.id);
    const out = channelOut(getChannel(c.id), user.id);
    sendToChannel(c.id, { type: 'channel.thread.update', thread: out });
    return out;
  }
  if (!has(perms, P.MANAGE_CHANNELS)) throw forbidden();
  const changes = {};
  if (body.name !== undefined) changes.name = channelName(str(body.name, 100, 'name') || '', c.type) || c.name;
  if (body.topic !== undefined) changes.topic = str(body.topic, 1024, 'topic') || '';
  if (body.position !== undefined) changes.position = int(body.position, 'position');
  if (body.parentId !== undefined) changes.parent_id = validParent(c.server_id, body.parentId, c.type);
  if (body.slowmode !== undefined) changes.slowmode_s = Math.max(0, Math.min(21600, int(body.slowmode, 'slowmode')));
  if (body.nsfw !== undefined) changes.nsfw = body.nsfw ? 1 : 0;
  if (body.userLimit !== undefined && c.type === 'voice') changes.voice_limit = Math.max(0, Math.min(99, int(body.userLimit, 'userLimit')));
  if (body.syncPerms !== undefined) changes.sync_perms = body.syncPerms ? 1 : 0;
  const keys = Object.keys(changes);
  if (keys.length) {
    q(`UPDATE channels SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(changes), c.id);
    audit(c.server_id, user.id, 'channel.update', c.id, { changed: keys });
    refreshServer(c.server_id);
  }
  return channelOut(getChannel(c.id), user.id);
});

route('DELETE', '/api/channels/:id', ({ user, params }) => {
  const { channel: c, perms } = requireChannel(Number(params.id), user.id);
  const allowed = c.type === 'thread' ? has(perms, P.MANAGE_THREADS) || c.owner_id === user.id : has(perms, P.MANAGE_CHANNELS);
  if (!allowed) throw forbidden();
  if (getServer(c.server_id).system_channel_id === c.id) q('UPDATE servers SET system_channel_id = NULL WHERE id = ?').run(c.server_id);
  const audience = audienceOf(c.id);
  tx(() => {
    q("DELETE FROM channels WHERE parent_id = ? AND type = 'thread'").run(c.id);
    q('DELETE FROM channels WHERE id = ?').run(c.id); // channels in a deleted category just lose their category
  });
  audit(c.server_id, user.id, 'channel.delete', c.id, { name: c.name });
  if (c.type === 'thread') sendToChannel(c.id, { type: 'channel.thread.delete', serverId: c.server_id, threadId: c.id, parentId: c.parent_id }, { audience });
  else refreshServer(c.server_id);
  return { ok: true };
});

/** Per-channel permission tweak for a role or member. */
route('PUT', '/api/channels/:id/overrides/:targetType/:targetId', ({ user, params, body }) => {
  const { channel: c } = requireChannel(Number(params.id), user.id);
  if (c.type === 'thread') throw bad('Threads use their channel’s permissions');
  if (!has(serverPermissions(c.server_id, user.id), P.MANAGE_ROLES)) throw forbidden();
  const targetType = params.targetType === 'role' ? 'role' : params.targetType === 'member' ? 'member' : null;
  if (!targetType) throw bad('Override must be for a role or a member');
  const targetId = Number(params.targetId);
  if (targetType === 'role') {
    const r = getRole(targetId);
    if (!r || r.server_id !== c.server_id) throw bad('Unknown role');
    if (!r.is_default && !canManageRole(user.id, r.id) && getServer(c.server_id).owner_id !== user.id) throw forbidden('That role is above yours');
  } else if (!isMember(c.server_id, targetId)) throw bad('Unknown member');
  const allow = (int(body.allow, 'allow') ?? 0) & ALL;
  const deny = (int(body.deny, 'deny') ?? 0) & ALL & ~allow;
  checkGrantable(c.server_id, user.id, allow | deny);
  q(`INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, target_type, target_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny`).run(c.id, targetType, targetId, allow, deny);
  // Editing a channel's own overrides stops it following its category.
  if (c.type !== 'category') q('UPDATE channels SET sync_perms = 0 WHERE id = ?').run(c.id);
  audit(c.server_id, user.id, 'channel.override', c.id, { targetType, targetId, allow, deny });
  refreshServer(c.server_id);
  return { ok: true };
});

route('DELETE', '/api/channels/:id/overrides/:targetType/:targetId', ({ user, params }) => {
  const { channel: c } = requireChannel(Number(params.id), user.id);
  if (!has(serverPermissions(c.server_id, user.id), P.MANAGE_ROLES)) throw forbidden();
  q('DELETE FROM channel_overrides WHERE channel_id = ? AND target_type = ? AND target_id = ?').run(c.id, params.targetType, Number(params.targetId));
  audit(c.server_id, user.id, 'channel.override.delete', c.id, { targetType: params.targetType, targetId: Number(params.targetId) });
  refreshServer(c.server_id);
  return { ok: true };
});

route('GET', '/api/channels/:id/overrides', ({ user, params }) => {
  const { channel: c } = requireChannel(Number(params.id), user.id);
  if (!has(serverPermissions(c.server_id, user.id), P.MANAGE_ROLES)) throw forbidden();
  return q('SELECT target_type, target_id, allow, deny FROM channel_overrides WHERE channel_id = ?').all(c.id)
    .map((o) => ({ targetType: o.target_type, targetId: o.target_id, allow: o.allow, deny: o.deny }));
});

// ── threads ──
route('GET', '/api/channels/:id/threads', ({ user, params, query }) => {
  const { channel: c } = requireChannel(Number(params.id), user.id);
  const archived = query.archived === 'true' ? 1 : 0;
  return q("SELECT * FROM channels WHERE parent_id = ? AND type = 'thread' AND archived = ? ORDER BY last_message_id DESC, id DESC LIMIT 100").all(c.id, archived)
    .map((t) => channelOut(t, user.id));
});

route('POST', '/api/channels/:id/threads', ({ user, params, body }) => {
  const { channel: c, perms } = requireChannel(Number(params.id), user.id);
  if (c.type !== 'text' && c.type !== 'announcement') throw bad('Threads live in text channels');
  if (!has(perms, P.CREATE_THREADS)) throw forbidden();
  let starter = null;
  if (body.messageId) {
    starter = q('SELECT * FROM channel_messages WHERE id = ? AND channel_id = ? AND deleted = 0').get(Number(body.messageId), c.id);
    if (!starter) throw bad('Message not found in this channel');
    if (q("SELECT 1 FROM channels WHERE starter_message_id = ? AND type = 'thread'").get(starter.id)) throw bad('That message already has a thread');
  }
  const name = channelName(str(body.name, 100, 'name') || (starter?.body || '').slice(0, 40) || 'thread', 'thread') || 'thread';
  const id = Number(q("INSERT INTO channels (server_id, type, name, parent_id, owner_id, starter_message_id, created_at) VALUES (?, 'thread', ?, ?, ?, ?, ?)")
    .run(c.server_id, name, c.id, user.id, starter?.id ?? null, Date.now()).lastInsertRowid);
  const thread = channelOut(getChannel(id), user.id);
  postSystem(c.id, 'thread_created', user.id, { threadId: id, name });
  sendToChannel(c.id, { type: 'channel.thread.create', thread });
  return thread;
});

// ───────────────────────── routes: messages ─────────────────────────

route('GET', '/api/channels/:id/messages', ({ user, params, query }) => {
  const { channel: c, perms } = requireChannel(Number(params.id), user.id);
  if (!has(perms, P.READ_HISTORY)) return [];
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  let rows;
  if (query.after) rows = q('SELECT * FROM channel_messages WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT ?').all(c.id, Number(query.after), limit);
  else rows = q('SELECT * FROM channel_messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(c.id, Number(query.before) || Number.MAX_SAFE_INTEGER, limit).reverse();
  return rows.map(messageOut);
});

route('POST', '/api/channels/:id/messages', ({ user, params, body }) => sendChannelMessage(user.id, Number(params.id), body));

route('GET', '/api/channels/:id/pins', ({ user, params }) => {
  const { channel: c, perms } = requireChannel(Number(params.id), user.id);
  if (!has(perms, P.READ_HISTORY)) return [];
  return q('SELECT * FROM channel_messages WHERE channel_id = ? AND pinned_at IS NOT NULL AND deleted = 0 ORDER BY pinned_at DESC').all(c.id).map(messageOut);
});

route('POST', '/api/channels/:id/read', ({ user, params, body }) => {
  markChannelRead(user.id, Number(params.id), body.messageId);
  return { ok: true };
});

/** Mark every channel in a server as read. */
route('POST', '/api/servers/:id/read', ({ user, params }) => {
  const s = requireServer(Number(params.id), user.id);
  for (const c of q("SELECT id FROM channels WHERE server_id = ? AND type != 'category'").all(s.id)) {
    if (has(channelPermissions(c.id, user.id), P.VIEW_CHANNEL)) markChannelRead(user.id, c.id);
  }
  return serverOut(s.id, user.id);
});

function requireMessage(messageId, userId) {
  const m = q('SELECT * FROM channel_messages WHERE id = ?').get(messageId);
  if (!m) throw notFound('Message not found');
  const { channel, perms } = requireChannel(m.channel_id, userId);
  return { m, channel, perms };
}

route('PATCH', '/api/channel-messages/:id', ({ user, params, body }) => {
  const { m, channel } = requireMessage(Number(params.id), user.id);
  if (m.author_id !== user.id || m.deleted || m.kind !== 'default') throw forbidden('You can only edit your own messages');
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text && !q('SELECT 1 FROM channel_attachments WHERE message_id = ?').get(m.id)) throw bad('Message is empty');
  if (text.length > MAX_BODY) throw bad(`Message is too long (max ${MAX_BODY})`);
  q('UPDATE channel_messages SET body = ?, edited_at = ? WHERE id = ?').run(text, Date.now(), m.id);
  const message = messageOut(q('SELECT * FROM channel_messages WHERE id = ?').get(m.id));
  sendToChannel(channel.id, { type: 'channel.message.update', message });
  return message;
});

route('DELETE', '/api/channel-messages/:id', ({ user, params }) => {
  const { m, channel, perms } = requireMessage(Number(params.id), user.id);
  const own = m.author_id === user.id;
  if (!own && !has(perms, P.MANAGE_MESSAGES)) throw forbidden();
  q("UPDATE channel_messages SET deleted = 1, body = '', meta = NULL, pinned_at = NULL WHERE id = ?").run(m.id);
  q('DELETE FROM channel_attachments WHERE message_id = ?').run(m.id);
  q('DELETE FROM channel_reactions WHERE message_id = ?').run(m.id);
  if (!own) audit(channel.server_id, user.id, 'message.delete', m.id, { channelId: channel.id, authorId: m.author_id });
  sendToChannel(channel.id, { type: 'channel.message.delete', channelId: channel.id, serverId: channel.server_id, messageId: m.id });
  return { ok: true };
});

route('PUT', '/api/channel-messages/:id/reactions/:emoji', ({ user, params }) => {
  const { m, channel, perms } = requireMessage(Number(params.id), user.id);
  if (m.deleted) throw bad('Message was deleted');
  const emoji = String(params.emoji).slice(0, 64);
  const exists = q('SELECT 1 FROM channel_reactions WHERE message_id = ? AND emoji = ?').get(m.id, emoji);
  // Anyone who can see a message can pile onto an existing reaction; starting a new one needs ADD_REACTIONS.
  if (!exists && !has(perms, P.ADD_REACTIONS)) throw forbidden();
  if (q('SELECT COUNT(DISTINCT emoji) AS n FROM channel_reactions WHERE message_id = ?').get(m.id).n >= 20 && !exists) throw bad('That message has enough reactions');
  q('INSERT OR IGNORE INTO channel_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(m.id, user.id, emoji, Date.now());
  sendToChannel(channel.id, { type: 'channel.reaction', channelId: channel.id, messageId: m.id, userId: user.id, emoji, added: true });
  return { ok: true };
});

route('DELETE', '/api/channel-messages/:id/reactions/:emoji', ({ user, params, query }) => {
  const { m, channel, perms } = requireMessage(Number(params.id), user.id);
  const emoji = String(params.emoji).slice(0, 64);
  // Mods can remove someone else's reaction with ?userId=
  const who = query.userId ? Number(query.userId) : user.id;
  if (who !== user.id && !has(perms, P.MANAGE_MESSAGES)) throw forbidden();
  q('DELETE FROM channel_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(m.id, who, emoji);
  sendToChannel(channel.id, { type: 'channel.reaction', channelId: channel.id, messageId: m.id, userId: who, emoji, added: false });
  return { ok: true };
});

route('PUT', '/api/channel-messages/:id/pin', ({ user, params }) => {
  const { m, channel, perms } = requireMessage(Number(params.id), user.id);
  if (!has(perms, P.MANAGE_MESSAGES)) throw forbidden();
  if (m.deleted || m.kind !== 'default') throw bad('You can’t pin that');
  if (m.pinned_at) return { ok: true };
  if (q('SELECT COUNT(*) AS n FROM channel_messages WHERE channel_id = ? AND pinned_at IS NOT NULL').get(channel.id).n >= 50) throw bad('This channel has 50 pins already');
  q('UPDATE channel_messages SET pinned_at = ? WHERE id = ?').run(Date.now(), m.id);
  sendToChannel(channel.id, { type: 'channel.message.update', message: messageOut(q('SELECT * FROM channel_messages WHERE id = ?').get(m.id)) });
  postSystem(channel.id, 'pin', user.id, { messageId: m.id });
  return { ok: true };
});

route('DELETE', '/api/channel-messages/:id/pin', ({ user, params }) => {
  const { m, channel, perms } = requireMessage(Number(params.id), user.id);
  if (!has(perms, P.MANAGE_MESSAGES)) throw forbidden();
  q('UPDATE channel_messages SET pinned_at = NULL WHERE id = ?').run(m.id);
  sendToChannel(channel.id, { type: 'channel.message.update', message: messageOut(q('SELECT * FROM channel_messages WHERE id = ?').get(m.id)) });
  return { ok: true };
});

/** Search a server's messages you can see. */
route('GET', '/api/servers/:id/search', ({ user, params, query }) => {
  const s = requireServer(Number(params.id), user.id);
  const text = String(query.q || '').trim();
  if (text.length < 2) return [];
  const visible = q('SELECT id FROM channels WHERE server_id = ? AND type != ?').all(s.id, 'category')
    .filter((c) => has(channelPermissions(c.id, user.id), P.VIEW_CHANNEL | P.READ_HISTORY)).map((c) => c.id);
  if (!visible.length) return [];
  const like = `%${text.replace(/[\\%_]/g, (ch) => '\\' + ch)}%`;
  return q(`SELECT * FROM channel_messages WHERE channel_id IN (${visible.map(() => '?').join(',')}) AND deleted = 0 AND body LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 50`)
    .all(...visible, like).map(messageOut);
});
