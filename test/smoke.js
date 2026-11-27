// End-to-end smoke test: starts a throwaway server and walks through the main flows.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const port = 18000 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msgr-'));
const base = `http://127.0.0.1:${port}`;

// A pretend web version, to check the server hands it out safely.
const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bants-web-'));
fs.writeFileSync(path.join(webDir, 'index.html'), '<!DOCTYPE html><title>Bants web</title>');
fs.mkdirSync(path.join(webDir, 'js'));
fs.writeFileSync(path.join(webDir, 'js', 'app.js'), 'console.log(1)');
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, WEB_DIR: webDir, INVITE_CODE: 'letmein', SWEEP_INTERVAL_MS: '300', REGISTER_LIMIT: '50', TURN_SECRET: 'turnsecret', TURN_HOST: 'turn.example.com', GIPHY_API_KEY: '' },
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

try {
  let alice, bob, carol, aliceWs, bobWs, convId;

  await step('registration needs the invite code', async () => {
    const r = await api('POST', '/api/auth/register', { body: { username: 'alice', password: 'password123' } });
    assert.equal(r.status, 403);
  });

  await step('register three users', async () => {
    const reg = async (u) => (await api('POST', '/api/auth/register', { body: { username: u, password: 'password123', displayName: u[0].toUpperCase() + u.slice(1), inviteCode: 'letmein' } })).data;
    alice = await reg('alice');
    bob = await reg('bob');
    carol = await reg('carol');
    assert.ok(alice.token && alice.user.friendCode.match(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/));
  });

  await step('duplicate username rejected (case-insensitive)', async () => {
    const r = await api('POST', '/api/auth/register', { body: { username: 'ALICE', password: 'password123', inviteCode: 'letmein' } });
    assert.equal(r.status, 409);
  });

  await step('login works and bad password fails', async () => {
    assert.equal((await api('POST', '/api/auth/login', { body: { username: 'bob', password: 'password123' } })).status, 200);
    assert.equal((await api('POST', '/api/auth/login', { body: { username: 'bob', password: 'nope' } })).status, 401);
  });

  await step('websockets connect', async () => {
    aliceWs = socket(alice.token);
    bobWs = socket(bob.token);
    await aliceWs.waitFor((e) => e.type === 'ready');
    await bobWs.waitFor((e) => e.type === 'ready');
  });

  await step('add by username sends a request; accepting creates a chat', async () => {
    const r = await api('POST', '/api/contacts/requests', { token: alice.token, body: { username: 'bob' } });
    assert.equal(r.data.status, 'requested');
    const ev = await bobWs.waitFor((e) => e.type === 'contact.request');
    assert.equal(ev.request.user.username, 'alice');
    const reqs = await api('GET', '/api/contacts/requests', { token: bob.token });
    assert.equal(reqs.data.incoming.length, 1);
    const acc = await api('POST', `/api/contacts/requests/${ev.request.id}/accept`, { token: bob.token });
    assert.equal(acc.data.status, 'accepted');
    convId = acc.data.conversation.id;
    const added = await aliceWs.waitFor((e) => e.type === 'contact.added');
    assert.equal(added.conversation.id, convId);
  });

  await step('add by friend code connects immediately', async () => {
    const code = carol.user.friendCode.toLowerCase().replace('-', ' ');
    const r = await api('POST', '/api/contacts/requests', { token: alice.token, body: { friendCode: code } });
    assert.equal(r.data.status, 'accepted');
    assert.equal(r.data.contact.username, 'carol');
  });

  await step('lookup by friend code', async () => {
    const r = await api('GET', `/api/users/lookup?friendCode=${bob.user.friendCode}`, { token: carol.token });
    assert.equal(r.data.username, 'bob');
    assert.equal(r.data.online, undefined, 'non-contacts should not see online status');
  });

  await step('send over websocket with ack, delivered to the other side', async () => {
    aliceWs.json({ type: 'message.send', conversationId: convId, clientId: 'c-1', body: 'Hi Bob!' });
    const ack = await aliceWs.waitFor((e) => e.type === 'message.ack');
    assert.equal(ack.message.body, 'Hi Bob!');
    const got = await bobWs.waitFor((e) => e.type === 'message.new' && e.message.clientId === 'c-1');
    assert.equal(got.message.senderId, alice.user.id);
  });

  await step('retrying the same clientId does not duplicate', async () => {
    const r = await api('POST', `/api/conversations/${convId}/messages`, { token: alice.token, body: { clientId: 'c-1', body: 'Hi Bob!' } });
    const list = await api('GET', `/api/conversations/${convId}/messages`, { token: bob.token });
    assert.equal(list.data.messages.filter((m) => m.clientId === 'c-1').length, 1);
    assert.equal(r.data.clientId, 'c-1');
  });

  await step('typing indicator', async () => {
    bobWs.json({ type: 'typing', conversationId: convId });
    const t = await aliceWs.waitFor((e) => e.type === 'typing');
    assert.equal(t.userId, bob.user.id);
  });

  await step('unread count and read receipts', async () => {
    let convs = await api('GET', '/api/conversations', { token: bob.token });
    assert.equal(convs.data[0].unreadCount, 1);
    const last = convs.data[0].lastMessage.id;
    bobWs.json({ type: 'receipt', conversationId: convId, read: last });
    const rc = await aliceWs.waitFor((e) => e.type === 'receipt' && e.userId === bob.user.id);
    assert.equal(rc.lastRead, last);
    assert.equal(rc.lastDelivered, last);
    convs = await api('GET', '/api/conversations', { token: bob.token });
    assert.equal(convs.data[0].unreadCount, 0);
  });

  await step('upload an image, send it, and download with range', async () => {
    const png = Buffer.alloc(5000, 7);
    const up = await api('POST', '/api/media', { token: bob.token, raw: png, headers: { 'content-type': 'image/png', 'x-filename': 'pic.png' } });
    assert.equal(up.data.size, 5000);
    const sent = await api('POST', `/api/conversations/${convId}/messages`, { token: bob.token, body: { media: up.data.id, body: 'look' } });
    assert.equal(sent.data.kind, 'image');
    const dl = await api('GET', `/api/media/${up.data.id}`, { token: alice.token });
    assert.equal(dl.status, 200);
    assert.equal(dl.data.length, 5000);
    const part = await api('GET', `/api/media/${up.data.id}`, { token: alice.token, headers: { range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal(part.data.length, 100);
    const denied = await api('GET', `/api/media/${up.data.id}`, { token: carol.token });
    assert.equal(denied.status, 404, 'non-members cannot fetch media');
  });

  await step('edit and unsend a message', async () => {
    const m = (await api('POST', `/api/conversations/${convId}/messages`, { token: alice.token, body: { body: 'typo' } })).data;
    const e = await api('PATCH', `/api/messages/${m.id}`, { token: alice.token, body: { body: 'fixed' } });
    assert.equal(e.data.body, 'fixed');
    assert.ok(e.data.editedAt);
    const bobDenied = await api('DELETE', `/api/messages/${m.id}`, { token: bob.token });
    assert.equal(bobDenied.status, 404, 'only the sender can unsend');
    const d = await api('DELETE', `/api/messages/${m.id}`, { token: alice.token });
    assert.equal(d.data.ok, true);
    const ev = await bobWs.waitFor((x) => x.type === 'message.removed' && x.ids.includes(m.id));
    assert.equal(ev.unsent, true);
    const list = await api('GET', `/api/conversations/${convId}/messages?limit=200`, { token: bob.token });
    assert.ok(!list.data.messages.some((x) => x.id === m.id), 'unsent message is gone from history');
    const catchUp = await api('GET', `/api/conversations/${convId}/messages?after=${m.id}&knownFrom=1`, { token: bob.token });
    assert.deepEqual(catchUp.data.removed, [m.id], 'offline phones learn what was unsent');
  });

  await step('replies, reactions and media details', async () => {
    const orig = (await api('POST', `/api/conversations/${convId}/messages`, { token: alice.token, body: { body: 'react to me' } })).data;
    const reply = await api('POST', `/api/conversations/${convId}/messages`, { token: bob.token, body: { body: 'ok', replyTo: orig.id } });
    assert.equal(reply.data.replyTo, orig.id);
    let r = await api('POST', `/api/messages/${orig.id}/react`, { token: bob.token, body: { emoji: '😂' } });
    assert.deepEqual(r.data.reactions, [{ emoji: '😂', userIds: [bob.user.id], superIds: [] }]);
    const ev = await aliceWs.waitFor((e) => e.type === 'message.updated' && e.message.id === orig.id);
    assert.equal(ev.message.reactions[0].emoji, '😂');
    r = await api('POST', `/api/messages/${orig.id}/react`, { token: alice.token, body: { emoji: '😂' } });
    assert.equal(r.data.reactions[0].userIds.length, 2);
    r = await api('POST', `/api/messages/${orig.id}/react`, { token: bob.token, body: { emoji: '😂' } });
    assert.deepEqual(r.data.reactions, [{ emoji: '😂', userIds: [alice.user.id], superIds: [] }], 'same emoji again removes it');
    const up = await api('POST', '/api/media', { token: alice.token, raw: Buffer.alloc(300, 1), headers: { 'content-type': 'audio/mp4', 'x-filename': 'voice.m4a' } });
    const voice = await api('POST', `/api/conversations/${convId}/messages`, { token: alice.token, body: { media: up.data.id } });
    assert.equal(voice.data.kind, 'audio');
    assert.deepEqual(voice.data.mediaInfo, { mime: 'audio/mp4', size: 300, filename: 'voice.m4a' });
  });

  await step('voice call: ring, answer, relay signals, hang up', async () => {
    const ice = await api('GET', '/api/calls/ice', { token: alice.token });
    const turn = ice.data.iceServers.find((s) => s.username);
    assert.ok(turn.urls[0].startsWith('turn:turn.example.com:3478'));
    const crypto = await import('node:crypto');
    assert.equal(turn.credential, crypto.createHmac('sha1', 'turnsecret').update(turn.username).digest('base64'));

    aliceWs.json({ type: 'call.start', conversationId: convId, video: false });
    const started = await aliceWs.waitFor((e) => e.type === 'call.started');
    const incoming = await bobWs.waitFor((e) => e.type === 'call.incoming');
    assert.equal(incoming.call.id, started.call.id);
    assert.equal(incoming.caller.displayName, 'Alice');
    const peek = await api('GET', `/api/calls/${started.call.id}`, { token: bob.token });
    assert.equal(peek.data.call.state, 'ringing');

    bobWs.json({ type: 'call.accept', callId: started.call.id });
    await aliceWs.waitFor((e) => e.type === 'call.accepted');
    aliceWs.json({ type: 'call.signal', callId: started.call.id, data: { sdp: 'offer', type: 'offer' } });
    const offer = await bobWs.waitFor((e) => e.type === 'call.signal');
    assert.equal(offer.data.sdp, 'offer');
    bobWs.json({ type: 'call.signal', callId: started.call.id, data: { sdp: 'answer', type: 'answer' } });
    assert.equal((await aliceWs.waitFor((e) => e.type === 'call.signal')).data.type, 'answer');

    aliceWs.json({ type: 'call.start', conversationId: convId, video: true });
    const err = await aliceWs.waitFor((e) => e.type === 'error');
    assert.match(err.error, /already on a call/);

    bobWs.json({ type: 'call.end', callId: started.call.id });
    const ended = await aliceWs.waitFor((e) => e.type === 'call.ended');
    assert.equal(ended.reason, 'hangup');
    const log = await aliceWs.waitFor((e) => e.type === 'message.new' && e.message.kind === 'system' && e.message.body.includes('Voice call'));
    assert.match(log.message.body, /Voice call · 0:0\d/);
  });

  await step('video call: declined and missed', async () => {
    aliceWs.json({ type: 'call.start', conversationId: convId, video: true });
    const started = await aliceWs.waitFor((e) => e.type === 'call.started');
    await bobWs.waitFor((e) => e.type === 'call.incoming');
    bobWs.json({ type: 'call.decline', callId: started.call.id });
    assert.equal((await aliceWs.waitFor((e) => e.type === 'call.ended' && e.callId === started.call.id)).reason, 'declined');
    await aliceWs.waitFor((e) => e.type === 'message.new' && e.message.body.includes('Video call declined'));

    aliceWs.json({ type: 'call.start', conversationId: convId, video: false });
    const s2 = await aliceWs.waitFor((e) => e.type === 'call.started');
    await bobWs.waitFor((e) => e.type === 'call.incoming');
    aliceWs.json({ type: 'call.end', callId: s2.call.id });
    assert.equal((await bobWs.waitFor((e) => e.type === 'call.ended' && e.callId === s2.call.id)).reason, 'cancelled');
    await bobWs.waitFor((e) => e.type === 'message.new' && e.message.body.includes('Missed voice call'));
  });

  await step('group call: ring everyone, join, mesh signals, leave', async () => {
    const carolWs = socket(carol.token);
    await carolWs.waitFor((e) => e.type === 'ready');
    const g = await api('POST', '/api/conversations', { token: alice.token, body: { type: 'group', name: 'Call gang', memberIds: [bob.user.id, carol.user.id] } });
    aliceWs.json({ type: 'call.start', conversationId: g.data.id, video: true });
    const started = await aliceWs.waitFor((e) => e.type === 'call.started' && e.call.group);
    const callId = started.call.id;
    const bobRing = await bobWs.waitFor((e) => e.type === 'call.incoming' && e.call.id === callId);
    assert.equal(bobRing.groupName, 'Call gang');
    await carolWs.waitFor((e) => e.type === 'call.incoming' && e.call.id === callId);

    bobWs.json({ type: 'call.accept', callId });
    const bobJoined = await bobWs.waitFor((e) => e.type === 'call.joined' && e.call.id === callId);
    assert.deepEqual(bobJoined.participants.map((p) => p.id), [alice.user.id]);
    const aliceSees = await aliceWs.waitFor((e) => e.type === 'call.participant.joined' && e.user.id === bob.user.id);
    assert.equal(aliceSees.call.participants.length, 2);

    // Pressing call again in the group joins the call that's already going.
    carolWs.json({ type: 'call.start', conversationId: g.data.id, video: true });
    const carolJoined = await carolWs.waitFor((e) => e.type === 'call.joined' && e.call.id === callId);
    assert.equal(carolJoined.participants.length, 2);

    // Signals go to one named person, tagged with who sent them.
    carolWs.json({ type: 'call.signal', callId, to: bob.user.id, data: { type: 'offer', sdp: 'carol-offer' } });
    const sig = await bobWs.waitFor((e) => e.type === 'call.signal' && e.data.sdp === 'carol-offer');
    assert.equal(sig.from, carol.user.id);

    carolWs.json({ type: 'call.end', callId });
    await aliceWs.waitFor((e) => e.type === 'call.participant.left' && e.userId === carol.user.id);
    bobWs.json({ type: 'call.end', callId });
    const ended = await aliceWs.waitFor((e) => e.type === 'call.ended' && e.callId === callId);
    assert.equal(ended.reason, 'hangup', 'last one left alone ends the call');
    const log = await aliceWs.waitFor((e) => e.type === 'message.new' && e.message.body.includes('Group video call'));
    assert.match(log.message.body, /Group video call · 0:0\d/);
    carolWs.close();
  });

  await step('pin, archive and search', async () => {
    let c = await api('PATCH', `/api/conversations/${convId}`, { token: bob.token, body: { pinned: true, archived: true } });
    assert.equal(c.data.pinned, true);
    assert.equal(c.data.archived, true);
    await api('POST', `/api/conversations/${convId}/messages`, { token: alice.token, body: { body: 'unarchive me please' } });
    c = await api('GET', `/api/conversations/${convId}`, { token: bob.token });
    assert.equal(c.data.archived, false, 'a new message unarchives');
    assert.equal(c.data.pinned, true);
    const found = await api('GET', '/api/search?q=UNARCHIVE', { token: bob.token });
    assert.equal(found.data.results.length, 1);
    const none = await api('GET', '/api/search?q=unarchive', { token: carol.token });
    assert.equal(none.data.results.length, 0, 'cannot search chats you are not in');
    const pct = await api('GET', '/api/search?q=' + encodeURIComponent('%%'), { token: bob.token });
    assert.equal(pct.data.results.length, 0, 'wildcards are escaped');
  });

  await step('stickers', async () => {
    const up = await api('POST', '/api/media', { token: alice.token, raw: Buffer.alloc(400, 2), headers: { 'content-type': 'image/png' } });
    const st = await api('POST', '/api/stickers', { token: alice.token, body: { media: up.data.id } });
    assert.equal(st.data.media, up.data.id);
    const sent = await api('POST', `/api/conversations/${convId}/messages`, { token: alice.token, body: { media: up.data.id, kind: 'sticker' } });
    assert.equal(sent.data.kind, 'sticker');
    // Bob saves Alice's sticker from the chat and can send it himself.
    const saved = await api('POST', '/api/stickers', { token: bob.token, body: { media: up.data.id } });
    assert.equal(saved.status, 200);
    const resent = await api('POST', `/api/conversations/${convId}/messages`, { token: bob.token, body: { media: up.data.id, kind: 'sticker' } });
    assert.equal(resent.data.kind, 'sticker');
    const theft = await api('POST', '/api/stickers', { token: carol.token, body: { media: up.data.id } });
    assert.equal(theft.status, 403, 'cannot grab files you cannot see');
    const list = await api('GET', '/api/stickers', { token: bob.token });
    assert.equal(list.data.length, 1);
    assert.equal((await api('DELETE', `/api/stickers/${list.data[0].id}`, { token: bob.token })).status, 200);
  });

  await step('GIFs say they are off without a key', async () => {
    const r = await api('GET', '/api/gifs?q=cat', { token: alice.token });
    assert.equal(r.status, 503);
    assert.equal((await api('GET', '/api/server')).data.gifs, false);
  });

  await step('link previews never fetch the home network', async () => {
    const m = await api('POST', `/api/conversations/${convId}/messages`, { token: alice.token, body: { body: `look http://127.0.0.1:${port}/api/health` } });
    await new Promise((r) => setTimeout(r, 400));
    const page = await api('GET', `/api/conversations/${convId}/messages?after=${m.data.id - 1}`, { token: alice.token });
    assert.equal(page.data.messages[0].meta, null);
  });

  await step('polls: vote, change vote, multi-choice', async () => {
    const p = await api('POST', `/api/conversations/${convId}/messages`, { token: alice.token, body: { poll: { question: 'Pub or takeaway?', options: ['Pub', 'Takeaway', 'Both'] } } });
    assert.equal(p.data.kind, 'poll');
    assert.equal(p.data.meta.poll.options.length, 3);
    let v = await api('POST', `/api/messages/${p.data.id}/vote`, { token: bob.token, body: { optionIds: [1, 2] } });
    assert.deepEqual(v.data.meta.poll.options.map((o) => o.voterIds), [[bob.user.id], [], []], 'single-choice keeps one vote');
    await aliceWs.waitFor((e) => e.type === 'message.updated' && e.message.id === p.data.id);
    v = await api('POST', `/api/messages/${p.data.id}/vote`, { token: bob.token, body: { optionIds: [3] } });
    assert.deepEqual(v.data.meta.poll.options[2].voterIds, [bob.user.id]);
    const bad = await api('POST', `/api/conversations/${convId}/messages`, { token: alice.token, body: { poll: { question: 'One?', options: ['only'] } } });
    assert.equal(bad.status, 400);
  });

  await step('forwarding copies a message and marks it', async () => {
    const g = await api('POST', '/api/conversations', { token: alice.token, body: { type: 'group', name: 'Fwd', memberIds: [bob.user.id] } });
    const src = (await api('POST', `/api/conversations/${convId}/messages`, { token: bob.token, body: { body: 'forward me' } })).data;
    const f = await api('POST', `/api/messages/${src.id}/forward`, { token: alice.token, body: { conversationIds: [g.data.id] } });
    assert.equal(f.data.messages[0].body, 'forward me');
    assert.equal(f.data.messages[0].meta.forwarded, true);
    assert.equal(f.data.messages[0].senderId, alice.user.id);
  });

  await step('message info shows read times; streaks count', async () => {
    const m = (await api('POST', `/api/conversations/${convId}/messages`, { token: alice.token, body: { body: 'seen it?' } })).data;
    await api('POST', `/api/conversations/${convId}/receipts`, { token: bob.token, body: { read: m.id } });
    const info = await api('GET', `/api/messages/${m.id}/info`, { token: alice.token });
    const b = info.data.members.find((x) => x.userId === bob.user.id);
    assert.equal(b.read, true);
    assert.ok(b.readAt > 0);
    const notMine = await api('GET', `/api/messages/${m.id}/info`, { token: bob.token });
    assert.equal(notMine.status, 404);
    const conv = await api('GET', `/api/conversations/${convId}`, { token: alice.token });
    assert.equal(conv.data.streak, 1, 'both sent today');
  });

  await step('location: one-off and live updates', async () => {
    const l = await api('POST', `/api/conversations/${convId}/messages`, { token: alice.token, body: { location: { lat: 51.5, lng: -0.12, liveMinutes: 15 } } });
    assert.equal(l.data.kind, 'location');
    assert.ok(l.data.meta.location.liveUntil > Date.now());
    const u = await api('PATCH', `/api/messages/${l.data.id}/location`, { token: alice.token, body: { lat: 51.6, lng: -0.1 } });
    assert.equal(u.data.meta.location.lat, 51.6);
    const stop = await api('PATCH', `/api/messages/${l.data.id}/location`, { token: alice.token, body: { stop: true } });
    assert.ok(stop.data.meta.location.liveUntil <= Date.now());
  });

  await step('group chat: create, message, add, leave', async () => {
    // bob and carol need a contact link for later; alice is contacts with both.
    const g = await api('POST', '/api/conversations', { token: alice.token, body: { type: 'group', name: 'Gang', memberIds: [bob.user.id] } });
    assert.equal(g.data.members.length, 2);
    const upd = await bobWs.waitFor((e) => e.type === 'conversation.updated' && e.conversation.id === g.data.id);
    assert.equal(upd.conversation.name, 'Gang');
    await api('POST', `/api/conversations/${g.data.id}/members`, { token: alice.token, body: { userIds: [carol.user.id] } });
    const msgs = await api('GET', `/api/conversations/${g.data.id}/messages`, { token: carol.token });
    assert.ok(msgs.data.messages.some((m) => m.kind === 'system' && m.body.includes('added Carol')));
    const nonAdmin = await api('POST', `/api/conversations/${g.data.id}/members`, { token: bob.token, body: { userIds: [] } });
    assert.equal(nonAdmin.status, 403);
    await api('DELETE', `/api/conversations/${g.data.id}/members/${alice.user.id}`, { token: alice.token });
    const after = await api('GET', `/api/conversations/${g.data.id}`, { token: bob.token });
    assert.equal(after.data.members.length, 2);
    assert.ok(after.data.members.some((m) => m.role === 'admin'), 'someone was promoted to admin');
  });

  await step('mentions are recorded and disappearing messages vanish', async () => {
    const g = await api('POST', '/api/conversations', { token: alice.token, body: { type: 'group', name: 'Mention test', memberIds: [carol.user.id] } });
    const m = await api('POST', `/api/conversations/${g.data.id}/messages`, { token: alice.token, body: { body: 'oi @Carol and @nobody' } });
    assert.deepEqual(m.data.meta, { mentions: [carol.user.id] });
    const nonAdmin = await api('PATCH', `/api/conversations/${g.data.id}`, { token: carol.token, body: { disappearAfter: 86400 } });
    assert.equal(nonAdmin.status, 403);
    const bad = await api('PATCH', `/api/conversations/${g.data.id}`, { token: alice.token, body: { disappearAfter: 5 } });
    assert.equal(bad.status, 400);
    const on = await api('PATCH', `/api/conversations/${g.data.id}`, { token: alice.token, body: { disappearAfter: 86400 } });
    assert.equal(on.data.disappearAfter, 86400);
    const temp = await api('POST', `/api/conversations/${g.data.id}/messages`, { token: alice.token, body: { body: 'this will vanish' } });
    assert.ok(temp.data.expiresAt > Date.now() + 86_000_000);
    // Wind the clock forward by editing the database directly.
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path.join(dataDir, 'bants.db'));
    raw.prepare('UPDATE messages SET expires_at = 1 WHERE id = ?').run(temp.data.id);
    raw.close();
    const carolWs2 = socket(carol.token);
    const gone = await carolWs2.waitFor((e) => e.type === 'message.removed' && e.ids.includes(temp.data.id), 3000);
    assert.equal(gone.conversationId, g.data.id);
    carolWs2.close();
  });

  await step('admin: first user runs the server', async () => {
    const meA = await api('GET', '/api/me', { token: alice.token });
    assert.equal(meA.data.isAdmin, true);
    assert.equal((await api('GET', '/api/admin/users', { token: bob.token })).status, 403);
    const users = await api('GET', '/api/admin/users', { token: alice.token });
    assert.equal(users.data.length, 3);
    const ov = await api('GET', '/api/admin/overview', { token: alice.token });
    assert.equal(ov.data.inviteCode, 'letmein');
    await api('PATCH', '/api/admin/settings', { token: alice.token, body: { inviteCode: 'newcode' } });
    const r1 = await api('POST', '/api/auth/register', { body: { username: 'dan', password: 'password123', inviteCode: 'letmein' } });
    assert.equal(r1.status, 403, 'old invite code stops working');
    const r2 = await api('POST', '/api/auth/register', { body: { username: 'dan', password: 'password123', inviteCode: 'newcode' } });
    assert.equal(r2.status, 200);
    const reset = await api('POST', `/api/admin/users/${r2.data.user.id}/reset-password`, { token: alice.token });
    assert.equal((await api('GET', '/api/me', { token: r2.data.token })).status, 401, 'reset signs them out');
    assert.equal((await api('POST', '/api/auth/login', { body: { username: 'dan', password: reset.data.password } })).status, 200);
    assert.equal((await api('DELETE', `/api/admin/users/${r2.data.user.id}`, { token: alice.token })).status, 200);
    const page = await fetch(base + '/admin');
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('Bants admin'));
  });

  await step('sync returns messages since an id', async () => {
    const s = await api('GET', '/api/sync?since=0', { token: bob.token });
    assert.ok(s.data.messages.length >= 3);
  });

  await step('blocking stops messages', async () => {
    await api('POST', `/api/blocks/${alice.user.id}`, { token: bob.token });
    const r = await api('POST', `/api/conversations/${convId}/messages`, { token: alice.token, body: { body: 'hello?' } });
    assert.equal(r.status, 403);
    const look = await api('GET', '/api/users/lookup?username=bob', { token: alice.token });
    assert.equal(look.status, 404);
  });

  await step('presence: contacts see you go offline', async () => {
    const carolWs = socket(carol.token);
    await carolWs.waitFor((e) => e.type === 'ready');
    carolWs.close();
    const p = await aliceWs.waitFor((e) => e.type === 'presence' && e.userId === carol.user.id && e.online === false);
    assert.ok(p.lastSeen);
  });

  await step('logout invalidates the token', async () => {
    await api('POST', '/api/auth/logout', { token: carol.token });
    assert.equal((await api('GET', '/api/me', { token: carol.token })).status, 401);
  });

  await step('serves the web version', async () => {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /Bants web/);
    const js = await fetch(base + '/js/app.js');
    assert.match(js.headers.get('content-type'), /javascript/);
    const inv = await fetch(base + '/invite/abc123', { redirect: 'manual' });
    assert.equal(inv.status, 302);
    assert.equal(inv.headers.get('location'), '/?invite=abc123');
    assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
    assert.equal((await fetch(base + '/nope.js')).status, 404);
    assert.equal((await fetch(base + '/api/nope')).status, 404);
  });

  aliceWs.close();
  bobWs.close();
  console.log(`\nAll ${passed} checks passed.`);
} catch (err) {
  console.error(`\n✗ Failed after ${passed} checks:`, err);
  process.exitCode = 1;
} finally {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(webDir, { recursive: true, force: true });
}
