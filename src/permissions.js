// Permissions: a bitfield per role, plus per-channel allow/deny overrides.
// Same rules as Discord, so people already understand how it behaves:
//   1. Server owner, or anyone with ADMINISTRATOR, can do everything.
//   2. Start with @everyone's permissions, add every role the member has.
//   3. In a channel apply overrides in order: @everyone, then all the member's roles together, then the member themself.
//      Within each step, deny is applied first, then allow. Later steps win.
//   4. Without VIEW_CHANNEL you get nothing in that channel. Timed-out members can only read.
//
// Kept to 31 bits so ordinary JS bitwise operators work.

import { q } from './db.js';

export const P = {
  VIEW_CHANNEL:      1 << 0,
  SEND_MESSAGES:     1 << 1,
  READ_HISTORY:      1 << 2,
  ATTACH_FILES:      1 << 3,
  EMBED_LINKS:       1 << 4,
  ADD_REACTIONS:     1 << 5,
  USE_EXTERNAL_EMOJI:1 << 6,
  MENTION_EVERYONE:  1 << 7,
  MANAGE_MESSAGES:   1 << 8,   // delete/pin other people's messages
  CREATE_THREADS:    1 << 9,
  SEND_IN_THREADS:   1 << 10,
  MANAGE_THREADS:    1 << 11,
  CONNECT:           1 << 12,  // join a voice channel
  SPEAK:             1 << 13,
  VIDEO:             1 << 14,  // camera and screen share
  MUTE_MEMBERS:      1 << 15,
  DEAFEN_MEMBERS:    1 << 16,
  MOVE_MEMBERS:      1 << 17,
  CREATE_INVITE:     1 << 18,
  CHANGE_NICKNAME:   1 << 19,
  MANAGE_NICKNAMES:  1 << 20,
  MANAGE_EMOJIS:     1 << 21,
  MANAGE_CHANNELS:   1 << 22,
  MANAGE_ROLES:      1 << 23,
  KICK_MEMBERS:      1 << 24,
  BAN_MEMBERS:       1 << 25,
  TIMEOUT_MEMBERS:   1 << 26,
  VIEW_AUDIT_LOG:    1 << 27,
  MANAGE_SERVER:     1 << 28,
  ADMINISTRATOR:     1 << 29,
};

export const ALL = Object.values(P).reduce((a, b) => a | b, 0);

// What @everyone gets in a new server.
export const DEFAULT_EVERYONE =
  P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_HISTORY | P.ATTACH_FILES | P.EMBED_LINKS |
  P.ADD_REACTIONS | P.USE_EXTERNAL_EMOJI | P.CREATE_THREADS | P.SEND_IN_THREADS |
  P.CONNECT | P.SPEAK | P.VIDEO | P.CREATE_INVITE | P.CHANGE_NICKNAME;

const has = (perms, bit) => (perms & bit) === bit;
export { has };

function memberRoleIds(serverId, userId) {
  return q('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?').all(serverId, userId).map((r) => r.role_id);
}

/** Server-wide permissions for a member (ignores channel overrides). 0 if not a member. */
export function serverPermissions(serverId, userId) {
  const server = q('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  if (!server) return 0;
  const member = q('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
  if (!member) return 0;
  if (server.owner_id === userId) return ALL;

  let perms = q('SELECT permissions FROM roles WHERE server_id = ? AND is_default = 1').get(serverId)?.permissions ?? 0;
  const rows = q(
    `SELECT r.permissions FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.server_id = ? AND mr.user_id = ?`,
  ).all(serverId, userId);
  for (const r of rows) perms |= r.permissions;
  return has(perms, P.ADMINISTRATOR) ? ALL : perms;
}

/** Permissions for a user in one channel (text, voice, category or thread). */
export function channelPermissions(channelId, userId, now = Date.now()) {
  let channel = q('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return 0;

  // Threads take their permissions from the channel they live in.
  const thread = channel.type === 'thread' ? channel : null;
  if (thread) {
    channel = q('SELECT * FROM channels WHERE id = ?').get(thread.parent_id);
    if (!channel) return 0;
  }

  const base = serverPermissions(channel.server_id, userId);
  if (base === 0) return 0;
  if (base === ALL) return ALL;

  // Channels synced to their category use the category's overrides.
  let overrideSource = channel.id;
  if (channel.sync_perms && channel.parent_id && channel.type !== 'category') overrideSource = channel.parent_id;
  const overrides = q('SELECT target_type, target_id, allow, deny FROM channel_overrides WHERE channel_id = ?').all(overrideSource);

  const everyoneRole = q('SELECT id FROM roles WHERE server_id = ? AND is_default = 1').get(channel.server_id)?.id;
  const roleIds = new Set(memberRoleIds(channel.server_id, userId));

  let perms = base;
  const apply = (o) => { if (o) perms = (perms & ~o.deny) | o.allow; };

  apply(overrides.find((o) => o.target_type === 'role' && o.target_id === everyoneRole));
  let roleAllow = 0, roleDeny = 0;
  for (const o of overrides) {
    if (o.target_type === 'role' && roleIds.has(o.target_id)) { roleAllow |= o.allow; roleDeny |= o.deny; }
  }
  apply({ allow: roleAllow, deny: roleDeny });
  apply(overrides.find((o) => o.target_type === 'member' && o.target_id === userId));

  if (!has(perms, P.VIEW_CHANNEL)) return 0;

  // Things that only make sense if you can do the parent action.
  if (!has(perms, P.SEND_MESSAGES)) perms &= ~(P.ATTACH_FILES | P.EMBED_LINKS | P.MENTION_EVERYONE);
  if (!has(perms, P.CONNECT)) perms &= ~(P.SPEAK | P.VIDEO | P.MUTE_MEMBERS | P.DEAFEN_MEMBERS | P.MOVE_MEMBERS);

  // In threads, "send" means SEND_IN_THREADS, and locked threads are mods only.
  if (thread) {
    const canSend = has(perms, P.SEND_IN_THREADS) && (!thread.locked || has(perms, P.MANAGE_THREADS));
    perms = canSend ? perms | P.SEND_MESSAGES : perms & ~P.SEND_MESSAGES;
  }

  // Timed out: read only.
  const m = q('SELECT timeout_until FROM server_members WHERE server_id = ? AND user_id = ?').get(channel.server_id, userId);
  if (m?.timeout_until && m.timeout_until > now) perms &= P.VIEW_CHANNEL | P.READ_HISTORY;

  return perms;
}

/** Position of someone's most senior role (owner counts as above everything). */
export function topRolePosition(serverId, userId) {
  const server = q('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  if (server?.owner_id === userId) return Infinity;
  const row = q(
    `SELECT MAX(r.position) AS p FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.server_id = ? AND mr.user_id = ?`,
  ).get(serverId, userId);
  return row?.p ?? 0;
}

/** Can actor kick/ban/timeout/rename target? Needs a higher top role, and nobody can touch the owner. */
export function outranks(serverId, actorId, targetId) {
  if (actorId === targetId) return false;
  return topRolePosition(serverId, actorId) > topRolePosition(serverId, targetId);
}

/** Can actor edit/assign this role? Needs MANAGE_ROLES and a top role above it. */
export function canManageRole(actorId, roleId) {
  const role = q('SELECT server_id, position, is_default FROM roles WHERE id = ?').get(roleId);
  if (!role) return false;
  if (!has(serverPermissions(role.server_id, actorId), P.MANAGE_ROLES)) return false;
  return topRolePosition(role.server_id, actorId) > role.position;
}
