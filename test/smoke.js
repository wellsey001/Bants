// End-to-end smoke test: starts a throwaway server and walks through the main flows.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const port = 18000 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msgr-'));
const base = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, INVITE_CODE: 'letmein' },
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

  await step('edit and delete a message', async () => {
    const m = (await api('POST', `/api/conversations/${convId}/messages`, { token: alice.token, body: { body: 'typo' } })).data;
    const e = await api('PATCH', `/api/messages/${m.id}`, { token: alice.token, body: { body: 'fixed' } });
    assert.equal(e.data.body, 'fixed');
    assert.ok(e.data.editedAt);
    const d = await api('DELETE', `/api/messages/${m.id}`, { token: alice.token });
    assert.equal(d.data.deleted, true);
    const ev = await bobWs.waitFor((x) => x.type === 'message.updated' && x.message.id === m.id && x.message.deleted);
    assert.equal(ev.message.body, '');
  });

  await step('replies, reactions and media details', async () => {
    const orig = (await api('POST', `/api/conversations/${convId}/messages`, { token: alice.token, body: { body: 'react to me' } })).data;
    const reply = await api('POST', `/api/conversations/${convId}/messages`, { token: bob.token, body: { body: 'ok', replyTo: orig.id } });
    assert.equal(reply.data.replyTo, orig.id);
    let r = await api('POST', `/api/messages/${orig.id}/react`, { token: bob.token, body: { emoji: '😂' } });
    assert.deepEqual(r.data.reactions, [{ emoji: '😂', userIds: [bob.user.id] }]);
    const ev = await aliceWs.waitFor((e) => e.type === 'message.updated' && e.message.id === orig.id);
    assert.equal(ev.message.reactions[0].emoji, '😂');
    r = await api('POST', `/api/messages/${orig.id}/react`, { token: alice.token, body: { emoji: '😂' } });
    assert.equal(r.data.reactions[0].userIds.length, 2);
    r = await api('POST', `/api/messages/${orig.id}/react`, { token: bob.token, body: { emoji: '😂' } });
    assert.deepEqual(r.data.reactions, [{ emoji: '😂', userIds: [alice.user.id] }], 'same emoji again removes it');
    const up = await api('POST', '/api/media', { token: alice.token, raw: Buffer.alloc(300, 1), headers: { 'content-type': 'audio/mp4', 'x-filename': 'voice.m4a' } });
    const voice = await api('POST', `/api/conversations/${convId}/messages`, { token: alice.token, body: { media: up.data.id } });
    assert.equal(voice.data.kind, 'audio');
    assert.deepEqual(voice.data.mediaInfo, { mime: 'audio/mp4', size: 300, filename: 'voice.m4a' });
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

  aliceWs.close();
  bobWs.close();
  console.log(`\nAll ${passed} checks passed.`);
} catch (err) {
  console.error(`\n✗ Failed after ${passed} checks:`, err);
  process.exitCode = 1;
} finally {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
