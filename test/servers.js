// End-to-end test for servers: starts a throwaway server and walks through communities, channels, roles and permissions.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const port = 18000 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msgr-'));
const base = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, INVITE_CODE: 'letmein', SWEEP_INTERVAL_MS: '300', REGISTER_LIMIT: '50', TURN_SECRET: 'turnsecret', TURN_HOST: 'turn.example.com', GIPHY_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve) => server.stdout.on('data', (d) => String(d).includes('listening') && resolve()));

let passed = 0;
const step = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

async function api(method, url, { token, body, raw, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data };
}

function socket(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const events = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    events.push(ev);
    for (const w of [...waiters]) if (w.pred(ev)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(ev);
    }
  };
  ws.waitFor = (pred, ms = 3000) => {
    const found = events.find(pred);
    if (found) {
      events.splice(events.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (ev) => { clearTimeout(t); events.splice(events.indexOf(ev), 1); resolve(ev); } };
      const t = setTimeout(() => reject(new Error('timed out waiting for event')), ms);
      waiters.push(w);
    });
  };
  ws.json = (obj) => ws.send(JSON.stringify(obj));
  return ws;
}


const P = {
  VIEW_CHANNEL: 1 << 0, SEND_MESSAGES: 1 << 1, READ_HISTORY: 1 << 2, MENTION_EVERYONE: 1 << 7, MANAGE_MESSAGES: 1 << 8,
  MANAGE_THREADS: 1 << 11, MANAGE_CHANNELS: 1 << 22, MANAGE_ROLES: 1 << 23, KICK_MEMBERS: 1 << 24, BAN_MEMBERS: 1 << 25,
  TIMEOUT_MEMBERS: 1 << 26, ADMINISTRATOR: 1 << 29,
};

try {
  const reg = async (u) => (await api('POST', '/api/auth/register', { body: { username: u, password: 'password123', displayName: u, inviteCode: 'letmein' } })).data;
  const owner = await reg('wellsey');
  const mod = await reg('moddy');
  const dave = await reg('dave');
  const randomer = await reg('randomer');
  let server, general, invite, modRole, ownerWs, daveWs, modsChannel;

  await step('the app can see servers are supported', async () => {
    assert.equal((await api('GET', '/api/server')).data.servers, true);
  });

  await step('create a server: @everyone, two categories, #general and a voice channel', async () => {
    ownerWs = socket(owner.token);
    await ownerWs.waitFor((e) => e.type === 'ready');
    const r = await api('POST', '/api/servers', { token: owner.token, body: { name: 'The Lads' } });
    assert.equal(r.status, 200);
    server = r.data;
    assert.equal(server.ownerId, owner.user.id);
    assert.deepEqual(server.channels.map((c) => c.type).sort(), ['category', 'category', 'text', 'voice']);
    general = server.channels.find((c) => c.name === 'general');
    assert.equal(server.systemChannelId, general.id);
    await ownerWs.waitFor((e) => e.type === 'server.add' && e.server.id === server.id);
  });

  await step('strangers can’t see a server', async () => {
    assert.equal((await api('GET', `/api/servers/${server.id}`, { token: dave.token })).status, 404);
    assert.equal((await api('GET', `/api/channels/${general.id}/messages`, { token: dave.token })).status, 404);
  });

  await step('invite link: preview, join, limited uses', async () => {
    invite = (await api('POST', `/api/servers/${server.id}/invites`, { token: owner.token, body: { maxUses: 2 } })).data;
    const preview = (await api('GET', `/api/invites/${invite.code}`, { token: dave.token })).data;
    assert.equal(preview.server.name, 'The Lads');
    daveWs = socket(dave.token);
    await daveWs.waitFor((e) => e.type === 'ready');
    assert.equal((await api('POST', `/api/invites/${invite.code}`, { token: dave.token })).status, 200);
    await daveWs.waitFor((e) => e.type === 'server.add');
    await ownerWs.waitFor((e) => e.type === 'server.member.add' && e.member.user.id === dave.user.id);
    const join = await ownerWs.waitFor((e) => e.type === 'channel.message' && e.message.kind === 'join');
    assert.equal(join.message.author.id, dave.user.id);
    assert.equal((await api('POST', `/api/invites/${invite.code}`, { token: mod.token })).status, 200);
    assert.equal((await api('POST', `/api/invites/${invite.code}`, { token: randomer.token })).status, 404, 'used up');
  });

  await step('messages arrive live, with mentions and unread badges', async () => {
    const r = await api('POST', `/api/channels/${general.id}/messages`, { token: owner.token, body: { body: `oi <@${dave.user.id}> you coming?`, clientId: 'c1' } });
    assert.equal(r.status, 200);
    const ev = await daveWs.waitFor((e) => e.type === 'channel.message' && e.message.id === r.data.id);
    assert.equal(ev.mentioned, true);
    const again = await api('POST', `/api/channels/${general.id}/messages`, { token: owner.token, body: { body: 'dupe', clientId: 'c1' } });
    assert.equal(again.data.id, r.data.id, 'same clientId is not sent twice');
    const view = (await api('GET', `/api/servers/${server.id}`, { token: dave.token })).data;
    const g = view.channels.find((c) => c.id === general.id);
    assert.equal(g.unread, true);
    assert.equal(g.mentionCount, 1);
    await api('POST', `/api/channels/${general.id}/read`, { token: dave.token, body: {} });
    const after = (await api('GET', `/api/servers/${server.id}`, { token: dave.token })).data.channels.find((c) => c.id === general.id);
    assert.equal(after.unread, false);
    assert.equal(after.mentionCount, 0);
  });

  await step('sending over the WebSocket works too, and typing is relayed', async () => {
    daveWs.json({ type: 'channel.typing', channelId: general.id });
    await ownerWs.waitFor((e) => e.type === 'channel.typing' && e.userId === dave.user.id);
    daveWs.json({ type: 'channel.send', channelId: general.id, body: 'yeah mate', clientId: 'ws1' });
    const ack = await daveWs.waitFor((e) => e.type === 'channel.ack' && e.clientId === 'ws1');
    await ownerWs.waitFor((e) => e.type === 'channel.message' && e.message.id === ack.message.id);
    const list = (await api('GET', `/api/channels/${general.id}/messages`, { token: owner.token })).data;
    assert.deepEqual(list.slice(-2).map((m) => m.body), [`oi <@${dave.user.id}> you coming?`, 'yeah mate']);
  });

  await step('@everyone only pings when you’re allowed to', async () => {
    const m = await api('POST', `/api/channels/${general.id}/messages`, { token: dave.token, body: { body: '@everyone wake up' } });
    assert.equal(m.data.mentionsEveryone, false);
    const o = await api('POST', `/api/channels/${general.id}/messages`, { token: owner.token, body: { body: '@everyone game night' } });
    assert.equal(o.data.mentionsEveryone, true);
  });

  await step('roles: create, assign, and the hierarchy is enforced', async () => {
    modRole = (await api('POST', `/api/servers/${server.id}/roles`, { token: owner.token, body: { name: 'Mods', colour: 0x7c4dff, permissions: P.KICK_MEMBERS | P.MANAGE_MESSAGES | P.MANAGE_ROLES | P.TIMEOUT_MEMBERS } })).data;
    assert.equal(modRole.position, 1);
    assert.equal((await api('PATCH', `/api/servers/${server.id}/members/${mod.user.id}`, { token: owner.token, body: { roleIds: [modRole.id] } })).status, 200);
    // Dave can't hand himself roles
    assert.equal((await api('PATCH', `/api/servers/${server.id}/members/${dave.user.id}`, { token: dave.token, body: { roleIds: [modRole.id] } })).status, 403);
    // Mod can't give out permissions he doesn't have
    assert.equal((await api('POST', `/api/servers/${server.id}/roles`, { token: mod.token, body: { name: 'Admins', permissions: P.ADMINISTRATOR } })).status, 403);
    // Mod can't edit his own role (it's not below him)
    assert.equal((await api('PATCH', `/api/roles/${modRole.id}`, { token: mod.token, body: { name: 'Gods' } })).status, 403);
    // Mod can't kick the owner
    assert.equal((await api('DELETE', `/api/servers/${server.id}/members/${owner.user.id}`, { token: mod.token })).status, 403);
  });

  await step('private channel: hidden from members, visible to the Mods role', async () => {
    modsChannel = (await api('POST', `/api/servers/${server.id}/channels`, { token: owner.token, body: { name: 'Mod Chat', private: true, roleIds: [modRole.id], parentId: general.parentId } })).data;
    assert.equal(modsChannel.name, 'mod-chat');
    const daveView = (await api('GET', `/api/servers/${server.id}`, { token: dave.token })).data;
    assert.ok(!daveView.channels.some((c) => c.id === modsChannel.id));
    const modView = (await api('GET', `/api/servers/${server.id}`, { token: mod.token })).data;
    assert.ok(modView.channels.some((c) => c.id === modsChannel.id));
    assert.equal((await api('POST', `/api/channels/${modsChannel.id}/messages`, { token: dave.token, body: { body: 'let me in' } })).status, 404);
    // Dave doesn't get messages from it live either
    await api('POST', `/api/channels/${modsChannel.id}/messages`, { token: mod.token, body: { body: 'secret' } });
    await assert.rejects(daveWs.waitFor((e) => e.message?.body === 'secret', 400), /timed out/);
  });

  await step('read-only announcements channel via an override', async () => {
    const ann = (await api('POST', `/api/servers/${server.id}/channels`, { token: owner.token, body: { name: 'announcements', type: 'announcement' } })).data;
    const everyone = server.roles.find((r) => r.isDefault).id;
    assert.equal((await api('PUT', `/api/channels/${ann.id}/overrides/role/${everyone}`, { token: owner.token, body: { deny: P.SEND_MESSAGES } })).status, 200);
    assert.equal((await api('POST', `/api/channels/${ann.id}/messages`, { token: dave.token, body: { body: 'hi' } })).status, 403);
    assert.equal((await api('POST', `/api/channels/${ann.id}/messages`, { token: owner.token, body: { body: 'big news' } })).status, 200);
  });

  await step('voice channels: drop in, see who’s there, talk, leave', async () => {
    const voice = server.channels.find((c) => c.type === 'voice');
    ownerWs.json({ type: 'voice.join', channelId: voice.id });
    const joined = await ownerWs.waitFor((e) => e.type === 'call.joined');
    assert.equal(joined.call.voice, true);
    assert.equal(joined.participants.length, 0, 'first one in has nobody to connect to');
    const state = await daveWs.waitFor((e) => e.type === 'voice.state' && e.channelId === voice.id);
    assert.deepEqual(state.members.map((m) => m.id), [owner.user.id]);
    const view = (await api('GET', `/api/servers/${server.id}`, { token: dave.token })).data;
    assert.equal(view.channels.find((c) => c.id === voice.id).voiceMembers.length, 1, 'channel list shows who is in voice');

    daveWs.json({ type: 'voice.join', channelId: voice.id });
    const dj = await daveWs.waitFor((e) => e.type === 'call.joined');
    assert.deepEqual(dj.participants.map((p) => p.id), [owner.user.id]);
    await ownerWs.waitFor((e) => e.type === 'call.participant.joined' && e.user.id === dave.user.id);
    // Signals pass between the two of them
    daveWs.json({ type: 'call.signal', callId: dj.call.id, to: owner.user.id, data: { sdp: 'offer' } });
    const sig = await ownerWs.waitFor((e) => e.type === 'call.signal');
    assert.equal(sig.from, dave.user.id);
    // Mute shows up for everyone
    daveWs.json({ type: 'voice.update', muted: true });
    const muted = await ownerWs.waitFor((e) => e.type === 'voice.state' && e.members.some((m) => m.id === dave.user.id && m.muted));
    assert.equal(muted.members.length, 2);
    // Camera and screen share show up too
    daveWs.json({ type: 'voice.update', muted: true, video: true, screen: true });
    await ownerWs.waitFor((e) => e.type === 'voice.state' && e.members.some((m) => m.id === dave.user.id && m.video && m.screen));
    // Voice channels have their own text chat, with unread dots
    const vm = await api('POST', `/api/channels/${voice.id}/messages`, { token: dave.token, body: { body: 'can you see my screen?' } });
    assert.equal(vm.status, 200);
    const vview = (await api('GET', `/api/servers/${server.id}`, { token: owner.token })).data;
    assert.equal(vview.channels.find((c) => c.id === voice.id).unread, true);
        // Owner leaves: room stays open for Dave
    ownerWs.json({ type: 'call.end', callId: joined.call.id });
    await daveWs.waitFor((e) => e.type === 'call.participant.left' && e.userId === owner.user.id);
    const after = await daveWs.waitFor((e) => e.type === 'voice.state' && e.members.length === 1);
    assert.equal(after.members[0].id, dave.user.id);
    // Last one out closes it
    daveWs.json({ type: 'call.end', callId: dj.call.id });
    await ownerWs.waitFor((e) => e.type === 'voice.state' && e.members.length === 0);
  });

  await step('voice respects permissions', async () => {
    const vc = (await api('POST', `/api/servers/${server.id}/channels`, { token: owner.token, body: { name: 'Staff', type: 'voice' } })).data;
    const everyone = server.roles.find((r) => r.isDefault).id;
    await api('PUT', `/api/channels/${vc.id}/overrides/role/${everyone}`, { token: owner.token, body: { deny: 1 << 12 } });
    daveWs.json({ type: 'voice.join', channelId: vc.id });
    const err = await daveWs.waitFor((e) => e.type === 'error');
    assert.match(err.error, /can’t join/);
  });

  await step('profiles: main profile, server profile, and the profile card', async () => {
    const png = Buffer.alloc(3000, 9);
    const up = (await api('POST', '/api/media', { token: dave.token, raw: png, headers: { 'content-type': 'image/png', 'x-filename': 'b.png' } })).data;
    const up2 = (await api('POST', '/api/media', { token: dave.token, raw: png, headers: { 'content-type': 'image/png', 'x-filename': 'a.png' } })).data;
    // Main profile
    const me = await api('PATCH', '/api/me', { token: dave.token, body: { banner: up.id, accentColour: 0xff4d8d, pronouns: 'he/him', customStatus: 'gaming', statusEmoji: '🎮', about: 'Here for the bants' } });
    assert.equal(me.status, 200);
    assert.equal(me.data.banner, up.id);
    assert.equal(me.data.pronouns, 'he/him');
    // Server profile
    const sp = await api('PATCH', `/api/servers/${server.id}/me`, { token: dave.token, body: { nickname: 'Big Dave', avatar: up2.id, bio: 'Mod of the year', pronouns: 'he/they' } });
    assert.equal(sp.status, 200);
    const upd = await ownerWs.waitFor((e) => e.type === 'server.member.update' && e.member.user.id === dave.user.id && e.member.serverProfile.bio);
    assert.equal(upd.member.nickname, 'Big Dave');
    assert.equal(upd.member.serverProfile.avatar, up2.id);
    // The owner can see Dave's server avatar and banner
    assert.equal((await api('GET', `/api/media/${up2.id}`, { token: owner.token })).status, 200);
    assert.equal((await api('GET', `/api/media/${up.id}`, { token: owner.token })).status, 200);
    // Profile card
    const card = (await api('GET', `/api/servers/${server.id}/members/${dave.user.id}/profile`, { token: owner.token })).data;
    assert.equal(card.user.customStatus, 'gaming');
    assert.equal(card.serverProfile.bio, 'Mod of the year');
    assert.equal(card.contact, 'none');
    assert.equal(card.canMessage, true);
    assert.ok(card.memberSince > 0);
    // Messages show the server avatar
    const m = (await api('POST', `/api/channels/${general.id}/messages`, { token: dave.token, body: { body: 'new pfp who dis' } })).data;
    assert.equal(m.author.avatar, up2.id);
    assert.equal(m.author.nickname, 'Big Dave');
    // You can message people you share a server with, like Discord
    const dm = await api('POST', '/api/conversations', { token: owner.token, body: { type: 'direct', userId: dave.user.id } });
    assert.equal(dm.status, 200);
    // Clearing the server avatar falls back to the main one
    await api('PATCH', `/api/servers/${server.id}/me`, { token: dave.token, body: { avatar: null } });
    const m2 = (await api('POST', `/api/channels/${general.id}/messages`, { token: dave.token, body: { body: 'back to normal' } })).data;
    assert.equal(m2.author.avatar, me.data.avatar ?? null);
  });

  await step('edit, react, pin and delete', async () => {
    const m = (await api('POST', `/api/channels/${general.id}/messages`, { token: dave.token, body: { body: 'typo' } })).data;
    assert.equal((await api('PATCH', `/api/channel-messages/${m.id}`, { token: owner.token, body: { body: 'hijack' } })).status, 403);
    assert.equal((await api('PATCH', `/api/channel-messages/${m.id}`, { token: dave.token, body: { body: 'fixed' } })).data.body, 'fixed');
    await api('PUT', `/api/channel-messages/${m.id}/reactions/${encodeURIComponent('😂')}`, { token: owner.token });
    await api('PUT', `/api/channel-messages/${m.id}/reactions/${encodeURIComponent('🔥')}`, { token: owner.token });
    const r = await daveWs.waitFor((e) => e.type === 'channel.reaction' && e.emoji === '🔥');
    assert.equal(r.added, true);
    assert.equal((await api('PUT', `/api/channel-messages/${m.id}/pin`, { token: dave.token })).status, 403);
    assert.equal((await api('PUT', `/api/channel-messages/${m.id}/pin`, { token: mod.token })).status, 200);
    assert.equal((await api('GET', `/api/channels/${general.id}/pins`, { token: dave.token })).data.length, 1);
    assert.equal((await api('DELETE', `/api/channel-messages/${m.id}`, { token: mod.token })).status, 200, 'mods can delete');
    await daveWs.waitFor((e) => e.type === 'channel.message.delete' && e.messageId === m.id);
  });

  await step('threads', async () => {
    const m = (await api('POST', `/api/channels/${general.id}/messages`, { token: dave.token, body: { body: 'FIFA tonight?' } })).data;
    const t = (await api('POST', `/api/channels/${general.id}/threads`, { token: dave.token, body: { messageId: m.id } })).data;
    assert.equal(t.type, 'thread');
    assert.equal((await api('POST', `/api/channels/${t.id}/messages`, { token: owner.token, body: { body: 'in' } })).status, 200);
    assert.equal((await api('GET', `/api/channels/${general.id}/threads`, { token: owner.token })).data.length, 1);
    assert.equal((await api('PATCH', `/api/channels/${t.id}`, { token: dave.token, body: { locked: true } })).status, 403, 'only mods lock');
    await api('PATCH', `/api/channels/${t.id}`, { token: owner.token, body: { locked: true } });
    assert.equal((await api('POST', `/api/channels/${t.id}/messages`, { token: dave.token, body: { body: 'oi' } })).status, 403);
  });

  await step('slowmode', async () => {
    await api('PATCH', `/api/channels/${general.id}`, { token: owner.token, body: { slowmode: 30 } });
    // Dave posted a moment ago, so he has to wait.
    const r = await api('POST', `/api/channels/${general.id}/messages`, { token: dave.token, body: { body: 'two' } });
    assert.equal(r.status, 429);
    assert.equal(r.data.code, 'slowmode');
    assert.equal((await api('POST', `/api/channels/${general.id}/messages`, { token: mod.token, body: { body: 'mods skip it' } })).status, 200);
    await api('PATCH', `/api/channels/${general.id}`, { token: owner.token, body: { slowmode: 0 } });
  });

  await step('timeout makes someone read-only', async () => {
    assert.equal((await api('PATCH', `/api/servers/${server.id}/members/${dave.user.id}`, { token: mod.token, body: { timeoutUntil: Date.now() + 60_000 } })).status, 200);
    assert.equal((await api('POST', `/api/channels/${general.id}/messages`, { token: dave.token, body: { body: 'mmph' } })).status, 403);
    assert.ok((await api('GET', `/api/channels/${general.id}/messages`, { token: dave.token })).data.length > 0, 'can still read');
    await api('PATCH', `/api/servers/${server.id}/members/${dave.user.id}`, { token: mod.token, body: { timeoutUntil: null } });
  });

  await step('kick, ban, and banned people can’t rejoin', async () => {
    const code = (await api('POST', `/api/servers/${server.id}/invites`, { token: owner.token, body: {} })).data.code;
    await api('POST', `/api/invites/${code}`, { token: randomer.token });
    assert.equal((await api('DELETE', `/api/servers/${server.id}/members/${randomer.user.id}`, { token: mod.token })).status, 200);
    assert.equal((await api('POST', `/api/invites/${code}`, { token: randomer.token })).status, 200, 'kicked people can come back');
    assert.equal((await api('POST', `/api/servers/${server.id}/bans/${randomer.user.id}`, { token: owner.token, body: { reason: 'spam' } })).status, 200);
    assert.equal((await api('POST', `/api/invites/${code}`, { token: randomer.token })).status, 403);
    const log = (await api('GET', `/api/servers/${server.id}/audit-log`, { token: owner.token })).data;
    assert.ok(log.some((a) => a.action === 'member.ban'));
  });

  await step('search only finds messages you can see', async () => {
    const hits = (await api('GET', `/api/servers/${server.id}/search?q=secret`, { token: dave.token })).data;
    assert.equal(hits.length, 0);
    assert.equal((await api('GET', `/api/servers/${server.id}/search?q=secret`, { token: mod.token })).data.length, 1);
  });

  await step('custom emojis: upload, use, react, limits and deleting', async () => {
    const png = Buffer.alloc(800, 7);
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(500, 1)]);
    const upPng = (await api('POST', '/api/media', { token: dave.token, raw: png, headers: { 'content-type': 'image/png' } })).data;
    const upGif = (await api('POST', '/api/media', { token: dave.token, raw: gif, headers: { 'content-type': 'image/gif' } })).data;
    const pepe = await api('POST', '/api/emojis', { token: dave.token, body: { name: 'pepe', media: upPng.id } });
    assert.equal(pepe.status, 200);
    assert.equal(pepe.data.animated, false);
    const dance = (await api('POST', '/api/emojis', { token: dave.token, body: { name: 'dance', media: upGif.id } })).data;
    assert.equal(dance.animated, true);
    assert.equal((await api('POST', '/api/emojis', { token: dave.token, body: { name: 'PEPE', media: upPng.id } })).status, 400, 'names are unique');
    assert.equal((await api('POST', '/api/emojis', { token: owner.token, body: { name: 'stolen', media: upPng.id } })).status, 400, 'only your own uploads');
    const mine = (await api('GET', '/api/emojis', { token: dave.token })).data;
    assert.equal(mine.emojis.length, 2);
    assert.equal(mine.max, 50);

    // In a message: your own go through, someone else's turn into :name:
    const tok = `<:pepe:${pepe.data.id}>`;
    const sent = (await api('POST', `/api/channels/${general.id}/messages`, { token: dave.token, body: { body: `hey ${tok} <a:dance:${dance.id}>` } })).data;
    assert.equal(sent.body, `hey ${tok} <a:dance:${dance.id}>`);
    assert.equal(sent.emojis.length, 2);
    const owners = (await api('POST', `/api/channels/${general.id}/messages`, { token: owner.token, body: { body: `copying ${tok}` } })).data;
    assert.equal(owners.body, 'copying :pepe:');
    // Everyone can see the picture
    assert.equal((await api('GET', `/api/media/${upPng.id}`, { token: owner.token })).status, 200);

    // Reactions: the owner starts it, others can pile on, but can't start one with someone else's
    assert.equal((await api('PUT', `/api/channel-messages/${owners.id}/reactions/${encodeURIComponent(tok)}`, { token: owner.token })).status, 400);
    assert.equal((await api('PUT', `/api/channel-messages/${owners.id}/reactions/${encodeURIComponent(tok)}`, { token: dave.token })).status, 200);
    assert.equal((await api('PUT', `/api/channel-messages/${owners.id}/reactions/${encodeURIComponent(tok)}`, { token: owner.token })).status, 200);
    const page = (await api('GET', `/api/channels/${general.id}/messages`, { token: owner.token })).data;
    const list = Array.isArray(page) ? page : page.messages;
    const reacted = list.find((m) => m.id === owners.id);
    assert.equal(reacted.reactions[0].userIds.length, 2);
    assert.equal(reacted.emojis[0].name, 'pepe');

    // Deleting removes it from the list (messages fall back to :name: on the apps)
    assert.equal((await api('DELETE', `/api/emojis/${dance.id}`, { token: dave.token })).status, 200);
    assert.equal((await api('GET', '/api/emojis', { token: dave.token })).data.emojis.length, 1);

    // The 50 limit
    for (let i = 0; i < 49; i++) {
      const u = (await api('POST', '/api/media', { token: dave.token, raw: png, headers: { 'content-type': 'image/png' } })).data;
      assert.equal((await api('POST', '/api/emojis', { token: dave.token, body: { name: `e${i}`, media: u.id } })).status, 200);
    }
    const over = (await api('POST', '/api/media', { token: dave.token, raw: png, headers: { 'content-type': 'image/png' } })).data;
    assert.equal((await api('POST', '/api/emojis', { token: dave.token, body: { name: 'onemore', media: over.id } })).status, 400);
  });

  await step('GIFs in channels say when they are switched off', async () => {
    assert.equal((await api('POST', `/api/channels/${general.id}/gif`, { token: dave.token, body: { url: 'https://media.giphy.com/x.gif' } })).status, 503);
  });

  await step('forums, polls, events, rules, server emojis and webhooks', async () => {
    const sid = server.id;
    // Forum: posts are threads with a first message
    const forum = (await api('POST', `/api/servers/${sid}/channels`, { token: owner.token, body: { name: 'Help Desk', type: 'forum' } })).data;
    assert.equal(forum.type, 'forum');
    assert.equal((await api('POST', `/api/channels/${forum.id}/messages`, { token: owner.token, body: { body: 'nope' } })).status, 400);
    const post = await api('POST', `/api/channels/${forum.id}/threads`, { token: dave.token, body: { name: 'My PC won’t boot', body: 'Tried turning it off and on' } });
    assert.equal(post.status, 200);
    assert.equal(post.data.firstMessage.body, 'Tried turning it off and on');
    const posts = (await api('GET', `/api/channels/${forum.id}/threads`, { token: owner.token })).data;
    assert.equal(posts.length, 1);
    assert.equal(posts[0].messageCount, 1);

    // Poll
    const poll = (await api('POST', `/api/channels/${general.id}/polls`, { token: owner.token, body: { question: 'FIFA or COD?', options: ['FIFA', 'COD'] } })).data;
    assert.equal(poll.kind, 'poll');
    const voted = (await api('POST', `/api/channel-messages/${poll.id}/vote`, { token: dave.token, body: { options: [1] } })).data;
    assert.deepEqual(voted.poll.votes[1], [dave.user.id]);
    const changed = (await api('POST', `/api/channel-messages/${poll.id}/vote`, { token: dave.token, body: { options: [0, 1] } })).data;
    assert.deepEqual(changed.poll.votes.map((v) => v.length), [1, 0], 'single choice keeps one');

    // Event with RSVP
    assert.equal((await api('POST', `/api/servers/${sid}/events`, { token: dave.token, body: { title: 'x', startsAt: Date.now() + 3600e3 } })).status, 403);
    const ev = (await api('POST', `/api/servers/${sid}/events`, { token: owner.token, body: { title: 'Game night', startsAt: Date.now() + 10 * 60e3, description: 'Bring snacks' } })).data;
    assert.deepEqual(ev.going, [owner.user.id]);
    const r = (await api('PUT', `/api/events/${ev.id}/rsvp`, { token: dave.token, body: { status: 'interested' } })).data;
    assert.equal(r.myRsvp, 'interested');
    assert.equal((await api('GET', `/api/servers/${sid}/events`, { token: dave.token })).data.length, 1);

    // Server emojis: anyone in the server can use them, nobody else's stay :name:
    const png = Buffer.alloc(700, 3);
    const up = (await api('POST', '/api/media', { token: owner.token, raw: png, headers: { 'content-type': 'image/png' } })).data;
    const se = (await api('POST', `/api/servers/${sid}/emojis`, { token: owner.token, body: { name: 'lads', media: up.id } })).data;
    assert.ok(se.id > 1e9);
    const usedByDave = (await api('POST', `/api/channels/${general.id}/messages`, { token: dave.token, body: { body: `<:lads:${se.id}>` } })).data;
    assert.equal(usedByDave.body, `<:lads:${se.id}>`);
    assert.equal(usedByDave.emojis[0].serverId, sid);
    assert.equal((await api('PUT', `/api/channel-messages/${usedByDave.id}/reactions/${encodeURIComponent(`<:lads:${se.id}>`)}`, { token: dave.token })).status, 200);
    assert.equal((await api('GET', `/api/servers/${sid}`, { token: dave.token })).data.emojis.length, 1);

    // Rules: must accept before posting
    assert.equal((await api('PUT', `/api/servers/${sid}/rules`, { token: owner.token, body: { rules: 'Be nice', welcome: 'Hiya', requireRules: true } })).status, 200);
    assert.equal((await api('GET', `/api/servers/${sid}`, { token: dave.token })).data.rulesAccepted, false);
    assert.equal((await api('POST', `/api/channels/${general.id}/messages`, { token: dave.token, body: { body: 'hi' } })).status, 403);
    await api('POST', `/api/servers/${sid}/accept-rules`, { token: dave.token });
    assert.equal((await api('POST', `/api/channels/${general.id}/messages`, { token: dave.token, body: { body: 'hi' } })).status, 200);
    await api('PUT', `/api/servers/${sid}/rules`, { token: owner.token, body: { requireRules: false } });

    // Webhook: Discord-style JSON, no login needed
    const hook = (await api('POST', `/api/channels/${general.id}/webhooks`, { token: owner.token, body: { name: 'Unraid' } })).data;
    const path = new URL(hook.url).pathname;
    const posted = await api('POST', path + '?wait=true', { body: { content: 'Array started', embeds: [{ title: 'Disk 1', description: 'Healthy' }] } });
    assert.equal(posted.status, 200);
    assert.equal(posted.data.author.displayName, 'Unraid');
    assert.ok(posted.data.body.includes('Disk 1'));
    assert.equal((await api('POST', path.replace(/[^/]+$/, 'wrong'), { body: { content: 'x' } })).status, 404);
  });

  await step('leaving, and the owner can’t leave without handing over', async () => {
    assert.equal((await api('POST', `/api/servers/${server.id}/leave`, { token: owner.token })).status, 400);
    assert.equal((await api('POST', `/api/servers/${server.id}/leave`, { token: dave.token })).status, 200);
    await daveWs.waitFor((e) => e.type === 'server.remove' && e.serverId === server.id);
    assert.equal((await api('GET', '/api/servers', { token: dave.token })).data.length, 0);
  });

  await step('deleting the server', async () => {
    assert.equal((await api('DELETE', `/api/servers/${server.id}`, { token: mod.token })).status, 403);
    assert.equal((await api('DELETE', `/api/servers/${server.id}`, { token: owner.token })).status, 200);
    assert.equal((await api('GET', '/api/servers', { token: owner.token })).data.length, 0);
  });

  await step('deleting an account that owns a server removes the server too', async () => {
    const temp = await reg('tempo');
    const s2 = (await api('POST', '/api/servers', { token: temp.token, body: { name: 'Temp' } })).data;
    const code = (await api('POST', `/api/servers/${s2.id}/invites`, { token: temp.token, body: {} })).data.code;
    await api('POST', `/api/invites/${code}`, { token: dave.token });
    await api('POST', `/api/channels/${s2.channels.find((c) => c.type === 'text').id}/messages`, { token: dave.token, body: { body: 'hi' } });
    assert.equal((await api('DELETE', '/api/me', { token: temp.token, body: { password: 'password123' } })).status, 200);
    await daveWs.waitFor((e) => e.type === 'server.remove' && e.serverId === s2.id);
    assert.equal((await api('GET', '/api/servers', { token: dave.token })).data.length, 0);
  });

  await step('chats still work alongside servers', async () => {
    const r = await api('GET', '/api/conversations', { token: owner.token });
    assert.equal(r.status, 200);
  });

  ownerWs.close();
  daveWs.close();
  console.log(`\nAll ${passed} server checks passed.`);
} catch (err) {
  console.error(`\n✗ Failed after ${passed} checks:`, err);
  process.exitCode = 1;
} finally {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
