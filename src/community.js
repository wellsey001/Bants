// Server extras: server emojis, polls, events, rules and webhooks.
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { q, tx } from './db.js';
import { route, HttpError, saveMediaBuffer, deleteMediaIfUnused, mediaAccessChecks } from './api.js';
import { sendToUser } from './hub.js';
import { pushToUser } from './push.js';
import { P, has } from './permissions.js';
import { emojiOut, isAnimated } from './emojis.js';
import { internals as I } from './servers.js';
import { safeFetch } from './safefetch.js';

const { bad, notFound, forbidden } = I;

// A webhook's picture can be seen by anyone in a server where it posted.
mediaAccessChecks.push((mediaId, userId) => !!q(
  `SELECT 1 FROM channel_messages cm JOIN channels c ON c.id = cm.channel_id JOIN server_members m ON m.server_id = c.server_id
   WHERE cm.meta LIKE ? AND m.user_id = ? LIMIT 1`).get(`%"avatar":"${mediaId}"%`, userId));

// ───────────────────────── server emojis ─────────────────────────
// Up to 50 per server, owned by the server so everyone in it can use them.

const MAX_SERVER_EMOJIS = 50;
const NAME = /^[A-Za-z0-9_]{2,32}$/;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function serverEmojis(serverId) {
  return q('SELECT * FROM server_emojis WHERE server_id = ? ORDER BY name COLLATE NOCASE').all(serverId).map(emojiOut);
}
function tellEmojis(serverId) {
  I.sendToServer(serverId, { type: 'server.emojis', serverId, emojis: serverEmojis(serverId) });
}
const cleanName = (v) => String(v || '').trim().replace(/[^A-Za-z0-9_]/g, '_');

route('GET', '/api/servers/:id/emojis', ({ user, params }) => {
  const s = I.requireServer(Number(params.id), user.id);
  return { emojis: serverEmojis(s.id), max: MAX_SERVER_EMOJIS };
});

route('POST', '/api/servers/:id/emojis', ({ user, params, body }) => {
  const s = I.requireServerPerm(Number(params.id), user.id, P.MANAGE_EMOJIS);
  const name = cleanName(body.name);
  if (!NAME.test(name)) throw bad('Names are 2–32 letters, numbers or underscores');
  if (q('SELECT COUNT(*) AS n FROM server_emojis WHERE server_id = ?').get(s.id).n >= MAX_SERVER_EMOJIS) throw bad(`This server has ${MAX_SERVER_EMOJIS} emojis already`);
  if (q('SELECT 1 FROM server_emojis WHERE server_id = ? AND name = ? COLLATE NOCASE').get(s.id, name)) throw bad(`This server already has :${name}:`);
  const media = q('SELECT * FROM media WHERE id = ?').get(String(body.media || ''));
  if (!media || media.uploader_id !== user.id) throw bad('Upload the picture first');
  if (!IMAGE_TYPES.has(media.mime)) throw bad('Emojis need to be PNG, JPEG, WebP or GIF');
  if (media.size > 1024 * 1024) throw bad('That emoji is too big (max 1 MB)');
  const animated = isAnimated(path.join(config.dataDir, 'media', media.id), media.mime) ? 1 : 0;
  const id = Number(q('INSERT INTO server_emojis (server_id, name, media_id, animated, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(s.id, name, media.id, animated, user.id, Date.now()).lastInsertRowid);
  I.audit(s.id, user.id, 'emoji.create', id, { name });
  tellEmojis(s.id);
  return emojiOut(q('SELECT * FROM server_emojis WHERE id = ?').get(id));
});

route('PATCH', '/api/server-emojis/:id', ({ user, params, body }) => {
  const e = q('SELECT * FROM server_emojis WHERE id = ?').get(Number(params.id));
  if (!e) throw notFound('Emoji not found');
  I.requireServerPerm(e.server_id, user.id, P.MANAGE_EMOJIS);
  const name = cleanName(body.name);
  if (!NAME.test(name)) throw bad('Names are 2–32 letters, numbers or underscores');
  if (q('SELECT 1 FROM server_emojis WHERE server_id = ? AND name = ? COLLATE NOCASE AND id != ?').get(e.server_id, name, e.id)) throw bad(`This server already has :${name}:`);
  q('UPDATE server_emojis SET name = ? WHERE id = ?').run(name, e.id);
  tellEmojis(e.server_id);
  return emojiOut({ ...e, name });
});

route('DELETE', '/api/server-emojis/:id', ({ user, params }) => {
  const e = q('SELECT * FROM server_emojis WHERE id = ?').get(Number(params.id));
  if (!e) throw notFound('Emoji not found');
  I.requireServerPerm(e.server_id, user.id, P.MANAGE_EMOJIS);
  q('DELETE FROM server_emojis WHERE id = ?').run(e.id);
  deleteMediaIfUnused(e.media_id);
  I.audit(e.server_id, user.id, 'emoji.delete', e.id, { name: e.name });
  tellEmojis(e.server_id);
  return { ok: true };
});

// ───────────────────────── polls ─────────────────────────

route('POST', '/api/channels/:id/polls', ({ user, params, body }) => {
  const { channel, perms } = I.requireChannel(Number(params.id), user.id);
  if (channel.type === 'category' || channel.is_forum) throw bad('Polls go in a text channel');
  I.requireRulesAccepted(channel.server_id, user.id);
  if (!has(perms, P.SEND_MESSAGES)) throw forbidden('You can’t send messages here');
  const question = String(body.question || '').trim().slice(0, 300);
  const options = (Array.isArray(body.options) ? body.options : []).map((o) => String(o || '').trim().slice(0, 100)).filter(Boolean).slice(0, 10);
  if (!question) throw bad('Ask a question');
  if (options.length < 2) throw bad('Give at least two answers');
  const hours = Math.min(24 * 14, Math.max(0, Number(body.hours) || 0));
  const poll = { question, options, multi: !!body.multi, endsAt: hours ? Date.now() + hours * 3600_000 : null };
  const id = I.storeMessage(channel.id, user.id, question, { meta: { poll } });
  return I.deliverMessage(channel, id);
});

route('POST', '/api/channel-messages/:id/vote', ({ user, params, body }) => {
  const { m, channel } = I.requireMessage(Number(params.id), user.id);
  let poll = null;
  try { poll = JSON.parse(m.meta || 'null')?.poll; } catch {}
  if (!poll || m.deleted) throw bad('That isn’t a poll');
  I.requireRulesAccepted(channel.server_id, user.id);
  if (poll.endsAt && Date.now() > poll.endsAt) throw bad('This poll has closed');
  let picks = (Array.isArray(body.options) ? body.options : []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < poll.options.length);
  if (!poll.multi) picks = picks.slice(0, 1);
  tx(() => {
    q('DELETE FROM channel_poll_votes WHERE message_id = ? AND user_id = ?').run(m.id, user.id);
    for (const i of new Set(picks)) q('INSERT INTO channel_poll_votes (message_id, user_id, option) VALUES (?, ?, ?)').run(m.id, user.id, i);
  });
  const message = I.messageOut(q('SELECT * FROM channel_messages WHERE id = ?').get(m.id));
  I.sendToChannel(channel.id, { type: 'channel.message.update', message });
  return message;
});

// ───────────────────────── events ─────────────────────────

function eventOut(e, viewerId) {
  const rsvps = q('SELECT user_id, status FROM event_rsvps WHERE event_id = ?').all(e.id);
  return {
    id: e.id, serverId: e.server_id, channelId: e.channel_id, title: e.title, description: e.description, location: e.location,
    startsAt: e.starts_at, endsAt: e.ends_at, createdBy: e.created_by, createdAt: e.created_at,
    going: rsvps.filter((r) => r.status === 'going').map((r) => r.user_id),
    interested: rsvps.filter((r) => r.status === 'interested').map((r) => r.user_id),
    myRsvp: rsvps.find((r) => r.user_id === viewerId)?.status || null,
  };
}

function readEvent(body, existing = {}) {
  const title = body.title !== undefined ? String(body.title || '').trim().slice(0, 100) : existing.title;
  if (!title) throw bad('Give the event a name');
  const startsAt = body.startsAt !== undefined ? Number(body.startsAt) : existing.starts_at;
  if (!Number.isFinite(startsAt) || startsAt <= 0) throw bad('Pick when it starts');
  const endsAt = body.endsAt !== undefined ? (body.endsAt ? Number(body.endsAt) : null) : existing.ends_at ?? null;
  if (endsAt && endsAt <= startsAt) throw bad('It has to end after it starts');
  return {
    title, starts_at: startsAt, ends_at: endsAt,
    description: body.description !== undefined ? String(body.description || '').slice(0, 1000) : existing.description || '',
    location: body.location !== undefined ? String(body.location || '').slice(0, 100) : existing.location || '',
    channel_id: body.channelId !== undefined ? (body.channelId ? Number(body.channelId) : null) : existing.channel_id ?? null,
  };
}

const tellEvent = (serverId, event) => I.sendToServer(serverId, { type: 'server.event', serverId, event });

route('GET', '/api/servers/:id/events', ({ user, params }) => {
  const s = I.requireServer(Number(params.id), user.id);
  const since = Date.now() - 6 * 3600_000;
  return q('SELECT * FROM server_events WHERE server_id = ? AND COALESCE(ends_at, starts_at + 3 * 3600000) > ? ORDER BY starts_at').all(s.id, since).map((e) => eventOut(e, user.id));
});

route('POST', '/api/servers/:id/events', ({ user, params, body }) => {
  const s = I.requireServerPerm(Number(params.id), user.id, P.MANAGE_SERVER);
  const v = readEvent(body);
  if (v.starts_at < Date.now() - 60_000) throw bad('That time has already gone');
  if (v.channel_id) {
    const c = I.getChannel(v.channel_id);
    if (!c || c.server_id !== s.id) throw bad('Pick a channel in this server');
  }
  const id = Number(q(`INSERT INTO server_events (server_id, channel_id, title, description, location, starts_at, ends_at, created_by, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.id, v.channel_id, v.title, v.description, v.location, v.starts_at, v.ends_at, user.id, Date.now()).lastInsertRowid);
  // Whoever makes it is going, obviously.
  q("INSERT INTO event_rsvps (event_id, user_id, status) VALUES (?, ?, 'going')").run(id, user.id);
  I.audit(s.id, user.id, 'event.create', id, { title: v.title });
  const e = q('SELECT * FROM server_events WHERE id = ?').get(id);
  tellEvent(s.id, eventOut(e, null));
  if (s.system_channel_id) {
    const msg = I.storeMessage(s.system_channel_id, user.id, `📅 New event: ${v.title}`, { kind: 'system', meta: { event: { id, title: v.title, startsAt: v.starts_at } } });
    I.deliverMessage(I.getChannel(s.system_channel_id), msg);
  }
  return eventOut(e, user.id);
});

route('PATCH', '/api/events/:id', ({ user, params, body }) => {
  const e = q('SELECT * FROM server_events WHERE id = ?').get(Number(params.id));
  if (!e) throw notFound('Event not found');
  I.requireServerPerm(e.server_id, user.id, P.MANAGE_SERVER);
  const v = readEvent(body, e);
  const moved = v.starts_at !== e.starts_at;
  q(`UPDATE server_events SET title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?, channel_id = ?,
     reminded = CASE WHEN ? THEN 0 ELSE reminded END, started = CASE WHEN ? THEN 0 ELSE started END WHERE id = ?`)
    .run(v.title, v.description, v.location, v.starts_at, v.ends_at, v.channel_id, moved ? 1 : 0, moved ? 1 : 0, e.id);
  const out = eventOut(q('SELECT * FROM server_events WHERE id = ?').get(e.id), user.id);
  tellEvent(e.server_id, out);
  return out;
});

route('DELETE', '/api/events/:id', ({ user, params }) => {
  const e = q('SELECT * FROM server_events WHERE id = ?').get(Number(params.id));
  if (!e) throw notFound('Event not found');
  I.requireServerPerm(e.server_id, user.id, P.MANAGE_SERVER);
  q('DELETE FROM server_events WHERE id = ?').run(e.id);
  I.sendToServer(e.server_id, { type: 'server.event.delete', serverId: e.server_id, eventId: e.id });
  return { ok: true };
});

route('PUT', '/api/events/:id/rsvp', ({ user, params, body }) => {
  const e = q('SELECT * FROM server_events WHERE id = ?').get(Number(params.id));
  if (!e) throw notFound('Event not found');
  I.requireServer(e.server_id, user.id);
  const status = ['going', 'interested'].includes(body.status) ? body.status : null;
  if (status) q('INSERT INTO event_rsvps (event_id, user_id, status) VALUES (?, ?, ?) ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status').run(e.id, user.id, status);
  else q('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?').run(e.id, user.id);
  const out = eventOut(e, user.id);
  tellEvent(e.server_id, { ...out, myRsvp: undefined });
  return out;
});

/** Reminders: 15 minutes before, and when it starts. Runs every minute. */
export function eventTick(now = Date.now()) {
  const soon = q('SELECT * FROM server_events WHERE reminded = 0 AND starts_at <= ? AND starts_at > ?').all(now + 15 * 60_000, now);
  const starting = q('SELECT * FROM server_events WHERE started = 0 AND starts_at <= ? AND starts_at > ?').all(now, now - 30 * 60_000);
  const notify = (e, title, body) => {
    const server = I.getServer(e.server_id);
    for (const { user_id } of q('SELECT user_id FROM event_rsvps WHERE event_id = ?').all(e.id)) {
      sendToUser(user_id, { type: 'server.event.reminder', serverId: e.server_id, eventId: e.id, title, body });
      pushToUser(user_id, { type: 'event', title, body: `${body} · ${server?.name || ''}`, serverId: String(e.server_id), eventId: String(e.id) }).catch(() => {});
    }
  };
  for (const e of soon) {
    q('UPDATE server_events SET reminded = 1 WHERE id = ?').run(e.id);
    notify(e, `⏰ ${e.title}`, 'Starts in 15 minutes');
  }
  for (const e of starting) {
    q('UPDATE server_events SET started = 1, reminded = 1 WHERE id = ?').run(e.id);
    notify(e, `🎉 ${e.title}`, 'Starting now');
  }
}
setInterval(() => { try { eventTick(); } catch {} }, 60_000).unref();

// ───────────────────────── rules and welcome ─────────────────────────

route('PUT', '/api/servers/:id/rules', ({ user, params, body }) => {
  const s = I.requireServerPerm(Number(params.id), user.id, P.MANAGE_SERVER);
  const rules = String(body.rules ?? s.rules ?? '').slice(0, 4000);
  const welcome = String(body.welcome ?? s.welcome ?? '').slice(0, 1000);
  const requireRules = body.requireRules !== undefined ? !!body.requireRules : !!s.require_rules;
  if (requireRules && !rules.trim()) throw bad('Write some rules first');
  q('UPDATE servers SET rules = ?, welcome = ?, require_rules = ? WHERE id = ?').run(rules, welcome, requireRules ? 1 : 0, s.id);
  I.audit(s.id, user.id, 'server.rules', s.id);
  I.refreshServer(s.id);
  return { rules, welcome, requireRules };
});

route('POST', '/api/servers/:id/accept-rules', ({ user, params }) => {
  const s = I.requireServer(Number(params.id), user.id);
  q('UPDATE server_members SET rules_accepted_at = ? WHERE server_id = ? AND user_id = ?').run(Date.now(), s.id, user.id);
  return { ok: true };
});

// ───────────────────────── webhooks ─────────────────────────
// Other things (Unraid, game servers, GitHub…) can post into a channel. The URL works with
// anything that can send to a Discord webhook: same JSON (content, username, avatar_url, embeds).

const hookOut = (h, base = '') => ({
  id: h.id, channelId: h.channel_id, name: h.name, avatar: h.avatar_media, createdBy: h.created_by, createdAt: h.created_at,
  url: `${base}/api/webhooks/${h.id}/${h.token}`,
});
const baseUrl = (req) => {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
};

route('GET', '/api/channels/:id/webhooks', ({ user, params, req }) => {
  const { channel, perms } = I.requireChannel(Number(params.id), user.id);
  if (!has(perms, P.MANAGE_CHANNELS)) throw forbidden();
  return q('SELECT * FROM webhooks WHERE channel_id = ? ORDER BY id').all(channel.id).map((h) => hookOut(h, baseUrl(req)));
});

route('POST', '/api/channels/:id/webhooks', ({ user, params, body, req }) => {
  const { channel, perms } = I.requireChannel(Number(params.id), user.id);
  if (!has(perms, P.MANAGE_CHANNELS)) throw forbidden();
  if (channel.type === 'category' || channel.type === 'voice' || channel.is_forum) throw bad('Webhooks post into a text channel');
  if (q('SELECT COUNT(*) AS n FROM webhooks WHERE channel_id = ?').get(channel.id).n >= 10) throw bad('That channel has 10 webhooks already');
  const name = String(body.name || '').trim().slice(0, 80) || 'Webhook';
  const token = crypto.randomBytes(24).toString('base64url');
  const id = Number(q('INSERT INTO webhooks (channel_id, name, token, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(channel.id, name, token, user.id, Date.now()).lastInsertRowid);
  I.audit(channel.server_id, user.id, 'webhook.create', id, { name, channelId: channel.id });
  return hookOut(q('SELECT * FROM webhooks WHERE id = ?').get(id), baseUrl(req));
});

route('PATCH', '/api/webhooks/:id', ({ user, params, body, req }) => {
  const h = q('SELECT * FROM webhooks WHERE id = ?').get(Number(params.id));
  if (!h) throw notFound('Webhook not found');
  const { perms } = I.requireChannel(h.channel_id, user.id);
  if (!has(perms, P.MANAGE_CHANNELS)) throw forbidden();
  const name = body.name !== undefined ? String(body.name || '').trim().slice(0, 80) || h.name : h.name;
  const token = body.newToken ? crypto.randomBytes(24).toString('base64url') : h.token;
  q('UPDATE webhooks SET name = ?, token = ? WHERE id = ?').run(name, token, h.id);
  return hookOut(q('SELECT * FROM webhooks WHERE id = ?').get(h.id), baseUrl(req));
});

route('DELETE', '/api/webhooks/:id', ({ user, params }) => {
  const h = q('SELECT * FROM webhooks WHERE id = ?').get(Number(params.id));
  if (!h) throw notFound('Webhook not found');
  const { channel, perms } = I.requireChannel(h.channel_id, user.id);
  if (!has(perms, P.MANAGE_CHANNELS)) throw forbidden();
  q('DELETE FROM webhooks WHERE id = ?').run(h.id);
  I.audit(channel.server_id, user.id, 'webhook.delete', h.id, { name: h.name });
  return { ok: true };
});

/** Discord embeds, flattened into plain text so they read well in Bants. */
function embedText(embeds) {
  const out = [];
  for (const e of (Array.isArray(embeds) ? embeds : []).slice(0, 5)) {
    if (!e || typeof e !== 'object') continue;
    if (e.title) out.push(`${String(e.title).slice(0, 256)}${e.url ? ` ${e.url}` : ''}`);
    if (e.description) out.push(String(e.description).slice(0, 2000));
    for (const f of (Array.isArray(e.fields) ? e.fields : []).slice(0, 15)) if (f?.name || f?.value) out.push(`${f.name ? `${String(f.name).slice(0, 256)}: ` : ''}${String(f.value || '').slice(0, 1024)}`);
    if (e.footer?.text) out.push(String(e.footer.text).slice(0, 256));
  }
  return out.join('\n');
}

const hookRate = new Map(); // webhook id -> recent post times
const avatarCache = new Map(); // avatar_url -> media id, so each picture is only fetched once

route('POST', '/api/webhooks/:id/:token', async ({ params, body, req }) => {
  const h = q('SELECT * FROM webhooks WHERE id = ?').get(Number(params.id));
  const a = Buffer.from(String(params.token));
  const b = Buffer.from(h?.token || '');
  if (!h || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw notFound('Unknown webhook');
  // 30 posts a minute is plenty for notifications and stops a runaway script flooding a channel.
  const now = Date.now();
  const recent = (hookRate.get(h.id) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 30) throw new HttpError(429, 'Slow down: 30 posts a minute', 'rate_limited');
  hookRate.set(h.id, [...recent, now]);
  const channel = I.getChannel(h.channel_id);
  if (!channel) throw notFound('Unknown webhook');
  // Accept JSON (Discord style) or a plain text body.
  const content = typeof body === 'string' ? body : String(body?.content ?? body?.text ?? body?.message ?? '');
  const text = [content.trim(), embedText(body?.embeds)].filter(Boolean).join('\n').slice(0, 4000);
  if (!text) throw bad('Nothing to post: send "content"');
  const name = String(body?.username || h.name).trim().slice(0, 80) || h.name;
  let avatar = h.avatar_media;
  if (body?.avatar_url && avatarCache.has(body.avatar_url)) avatar = avatarCache.get(body.avatar_url);
  else if (body?.avatar_url && typeof body.avatar_url === 'string' && /^https:\/\//.test(body.avatar_url)) {
    try {
      const f = await safeFetch(body.avatar_url, { maxBytes: 1_000_000, accept: 'image/*' });
      const mime = f.contentType.split(';')[0].trim();
      if (/^image\//.test(mime)) {
        avatar = saveMediaBuffer(f.body, mime, 'avatar', h.created_by);
        avatarCache.set(body.avatar_url, avatar);
      }
    } catch {}
  }
  // No pings from webhooks: @everyone and mentions show as plain text.
  const id = I.storeMessage(channel.id, null, text, { meta: { webhook: { id: h.id, name, avatar } }, allowEveryone: false, pingableRoles: new Set() });
  const message = I.deliverMessage(channel, id);
  return req.url.includes('wait=true') ? message : { ok: true };
}, { auth: false });

// ───────────────────────── soundboard ─────────────────────────
// Short clips anyone in a voice channel can play for everyone. Each server keeps up to 30;
// favourite one and you can play it in any server (like Nitro).

const MAX_SOUNDS = 30;
const soundOut = (r, viewerId) => ({
  id: r.id, serverId: r.server_id, name: r.name, emoji: r.emoji, media: r.media_id, volume: r.volume,
  favourite: !!q('SELECT 1 FROM sound_favourites WHERE user_id = ? AND sound_id = ?').get(viewerId, r.id),
});

route('GET', '/api/servers/:id/sounds', ({ user, params }) => {
  const s = I.requireServer(Number(params.id), user.id);
  return q('SELECT * FROM server_sounds WHERE server_id = ? ORDER BY name COLLATE NOCASE').all(s.id).map((r) => soundOut(r, user.id));
});

route('POST', '/api/servers/:id/sounds', ({ user, params, body }) => {
  const s = I.requireServerPerm(Number(params.id), user.id, P.MANAGE_EMOJIS);
  if (q('SELECT COUNT(*) AS n FROM server_sounds WHERE server_id = ?').get(s.id).n >= MAX_SOUNDS) throw bad(`This server has ${MAX_SOUNDS} sounds already`);
  const name = String(body.name || '').trim().slice(0, 32);
  if (!name) throw bad('Give the sound a name');
  const media = q('SELECT * FROM media WHERE id = ?').get(String(body.media || ''));
  if (!media || media.uploader_id !== user.id) throw bad('Upload the sound first');
  if (!media.mime.startsWith('audio/')) throw bad('That needs to be a sound (MP3, OGG, WAV…)');
  if (media.size > 1024 * 1024) throw bad('Keep sounds under 1 MB (about 5 seconds)');
  const emoji = String(body.emoji || '🔊').slice(0, 16);
  const volume = Math.min(1, Math.max(0.1, Number(body.volume) || 1));
  const id = Number(q('INSERT INTO server_sounds (server_id, name, emoji, media_id, volume, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(s.id, name, emoji, media.id, volume, user.id, Date.now()).lastInsertRowid);
  I.audit(s.id, user.id, 'sound.create', id, { name });
  I.sendToServer(s.id, { type: 'server.sounds', serverId: s.id });
  return soundOut(q('SELECT * FROM server_sounds WHERE id = ?').get(id), user.id);
});

route('DELETE', '/api/sounds/:id', ({ user, params }) => {
  const r = q('SELECT * FROM server_sounds WHERE id = ?').get(Number(params.id));
  if (!r) throw notFound('Sound not found');
  I.requireServerPerm(r.server_id, user.id, P.MANAGE_EMOJIS);
  q('DELETE FROM server_sounds WHERE id = ?').run(r.id);
  deleteMediaIfUnused(r.media_id);
  I.sendToServer(r.server_id, { type: 'server.sounds', serverId: r.server_id });
  return { ok: true };
});

route('PUT', '/api/sounds/:id/favourite', ({ user, params, body }) => {
  const r = q('SELECT * FROM server_sounds WHERE id = ?').get(Number(params.id));
  if (!r) throw notFound('Sound not found');
  I.requireServer(r.server_id, user.id);
  if (body.favourite === false) q('DELETE FROM sound_favourites WHERE user_id = ? AND sound_id = ?').run(user.id, r.id);
  else q('INSERT OR IGNORE INTO sound_favourites (user_id, sound_id) VALUES (?, ?)').run(user.id, r.id);
  return soundOut(r, user.id);
});

/** Your favourite sounds, playable in any server. */
route('GET', '/api/me/sounds', ({ user }) =>
  q('SELECT s.* FROM sound_favourites f JOIN server_sounds s ON s.id = f.sound_id WHERE f.user_id = ? ORDER BY s.name COLLATE NOCASE').all(user.id).map((r) => soundOut(r, user.id)));
