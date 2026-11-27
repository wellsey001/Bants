// Custom emojis. Each person can upload up to 50 (static or animated) and use them in any server,
// like Nitro on Discord. In a message they're written <:name:id> or <a:name:id> for animated ones.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { q } from './db.js';
import { route, HttpError, deleteMediaIfUnused } from './api.js';
import { sendToUser } from './hub.js';

export const MAX_EMOJIS = 50;
const MAX_BYTES = 1024 * 1024; // 1 MB, plenty for a 128px GIF
const NAME = /^[A-Za-z0-9_]{2,32}$/;
const TOKEN = /<(a?):([A-Za-z0-9_]{2,32}):(\d{1,12})>/g;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const bad = (msg) => new HttpError(400, msg);

export const emojiOut = (e) => ({ id: e.id, name: e.name, media: e.media_id, animated: !!e.animated, userId: e.user_id ?? null, serverId: e.server_id ?? null });

/** Whether the file moves: GIFs, animated WebP and animated PNG. */
export function isAnimated(file, mime) {
  if (mime === 'image/gif') return true;
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    head = Buffer.alloc(4096);
    const n = fs.readSync(fd, head, 0, 4096, 0);
    fs.closeSync(fd);
    head = head.subarray(0, n);
  } catch {
    return false;
  }
  if (mime === 'image/webp') return head.includes('ANIM');
  if (mime === 'image/png') return head.includes('acTL');
  return false;
}

/** The ids of every custom emoji written in some text (or used as a reaction). */
export function emojiIdsIn(...texts) {
  const ids = new Set();
  for (const t of texts) if (t) for (const m of String(t).matchAll(TOKEN)) ids.add(Number(m[3]));
  return [...ids];
}

/** Looks up emojis by id, for drawing them. Deleted ones are simply missing. */
export function emojisById(ids) {
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  return [
    ...q(`SELECT * FROM user_emojis WHERE id IN (${marks})`).all(...ids),
    ...q(`SELECT * FROM server_emojis WHERE id IN (${marks})`).all(...ids),
  ].map(emojiOut);
}

/** Only your own emojis (and this server's) go through. Anyone else's turn into plain :name:. */
export function cleanEmojiTokens(text, userId, serverId = null) {
  if (!text || !text.includes('<')) return text;
  const mine = new Set(q('SELECT id FROM user_emojis WHERE user_id = ?').all(userId).map((r) => r.id));
  if (serverId) for (const r of q('SELECT id FROM server_emojis WHERE server_id = ?').all(serverId)) mine.add(r.id);
  return text.replace(TOKEN, (all, a, name, id) => (mine.has(Number(id)) ? all : `:${name}:`));
}

/** A reaction that's a custom emoji: is it a real one, and is it theirs? */
export function customReaction(emoji) {
  const m = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{1,12})>$/.exec(emoji);
  if (!m) return null;
  return q('SELECT * FROM user_emojis WHERE id = ?').get(Number(m[3])) || q('SELECT * FROM server_emojis WHERE id = ?').get(Number(m[3])) || { missing: true };
}

/** Can this person start a reaction / use this emoji here? Their own, or one belonging to this server. */
export function canUseEmoji(e, userId, serverId) {
  if (!e || e.missing) return false;
  if (e.server_id != null) return e.server_id === serverId;
  return e.user_id === userId;
}

function tellMine(userId) {
  const emojis = q('SELECT * FROM user_emojis WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(userId).map(emojiOut);
  sendToUser(userId, { type: 'emojis.updated', emojis });
  return emojis;
}

route('GET', '/api/emojis', ({ user }) => ({
  emojis: q('SELECT * FROM user_emojis WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(user.id).map(emojiOut),
  max: MAX_EMOJIS,
}));

/** Upload the picture with POST /api/media first, then name it here. */
route('POST', '/api/emojis', ({ user, body }) => {
  const name = String(body.name || '').trim().replace(/[^A-Za-z0-9_]/g, '_');
  if (!NAME.test(name)) throw bad('Names are 2–32 letters, numbers or underscores');
  const count = q('SELECT COUNT(*) AS n FROM user_emojis WHERE user_id = ?').get(user.id).n;
  if (count >= MAX_EMOJIS) throw bad(`You’ve got ${MAX_EMOJIS} emojis already. Delete one to add another`);
  if (q('SELECT 1 FROM user_emojis WHERE user_id = ? AND name = ? COLLATE NOCASE').get(user.id, name)) throw bad(`You already have :${name}:`);
  const media = q('SELECT * FROM media WHERE id = ?').get(String(body.media || ''));
  if (!media || media.uploader_id !== user.id) throw bad('Upload the picture first');
  if (!IMAGE_TYPES.has(media.mime)) throw bad('Emojis need to be PNG, JPEG, WebP or GIF');
  if (media.size > MAX_BYTES) throw bad('That emoji is too big (max 1 MB)');
  const animated = isAnimated(path.join(config.dataDir, 'media', media.id), media.mime) ? 1 : 0;
  const id = Number(q('INSERT INTO user_emojis (user_id, name, media_id, animated, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(user.id, name, media.id, animated, Date.now()).lastInsertRowid);
  tellMine(user.id);
  return emojiOut(q('SELECT * FROM user_emojis WHERE id = ?').get(id));
});

route('PATCH', '/api/emojis/:id', ({ user, params, body }) => {
  const e = q('SELECT * FROM user_emojis WHERE id = ? AND user_id = ?').get(Number(params.id), user.id);
  if (!e) throw new HttpError(404, 'Emoji not found');
  const name = String(body.name || '').trim().replace(/[^A-Za-z0-9_]/g, '_');
  if (!NAME.test(name)) throw bad('Names are 2–32 letters, numbers or underscores');
  if (q('SELECT 1 FROM user_emojis WHERE user_id = ? AND name = ? COLLATE NOCASE AND id != ?').get(user.id, name, e.id)) throw bad(`You already have :${name}:`);
  q('UPDATE user_emojis SET name = ? WHERE id = ?').run(name, e.id);
  tellMine(user.id);
  return emojiOut({ ...e, name });
});

route('DELETE', '/api/emojis/:id', ({ user, params }) => {
  const e = q('SELECT * FROM user_emojis WHERE id = ? AND user_id = ?').get(Number(params.id), user.id);
  if (!e) throw new HttpError(404, 'Emoji not found');
  q('DELETE FROM user_emojis WHERE id = ?').run(e.id);
  deleteMediaIfUnused(e.media_id);
  tellMine(user.id);
  return { ok: true };
});
