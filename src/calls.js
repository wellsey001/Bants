// Voice and video calls: ringing, answering, hanging up, and relaying WebRTC
// offers/answers/ICE candidates between phones. Media itself goes phone-to-phone,
// or through coturn when a direct path isn't possible.
//
// 1:1 calls have a caller and a callee. Group calls are a "mesh": everyone who joins
// connects directly to everyone else (fine for a handful of people), and the server
// just passes signals to the right person.
import crypto from 'node:crypto';
import { config } from './config.js';
import { q } from './db.js';
import { sendToUser, sendToSession, isOnline } from './hub.js';
import { pushToUser } from './push.js';
import { HttpError, route, getUser, addCallMessage, isBlocked } from './api.js';

const RING_MS = 40_000;
const MAX_GROUP = 8;
const calls = new Map(); // callId -> call
const busy = new Map(); // userId -> callId
const activeByConv = new Map(); // conversationId -> group callId

const bad = (m) => new HttpError(400, m);

function callOut(c) {
  return {
    id: c.id,
    conversationId: c.conversationId,
    callerId: c.callerId,
    calleeId: c.calleeId,
    video: c.video,
    state: c.state,
    startedAt: c.startedAt,
    answeredAt: c.answeredAt,
  };
}

function fmt(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function finish(c, reason, endedBy = null) {
  if (!calls.has(c.id)) return;
  calls.delete(c.id);
  clearTimeout(c.timer);
  if (busy.get(c.callerId) === c.id) busy.delete(c.callerId);
  if (busy.get(c.calleeId) === c.id) busy.delete(c.calleeId);

  const event = { type: 'call.ended', callId: c.id, reason };
  // Tell the caller's device and every callee device (some may still be ringing).
  if (endedBy !== c.callerId) sendToSession(c.callerId, c.callerToken, event);
  if (c.calleeToken) {
    if (endedBy !== c.calleeId) sendToSession(c.calleeId, c.calleeToken, event);
  } else {
    sendToUser(c.calleeId, event);
  }

  const kind = c.video ? 'video' : 'voice';
  const icon = c.video ? '🎥' : '📞';
  if (c.answeredAt) {
    addCallMessage(c.conversationId, `${icon} ${c.video ? 'Video' : 'Voice'} call · ${fmt(Date.now() - c.answeredAt)}`);
  } else if (reason === 'declined') {
    addCallMessage(c.conversationId, `${icon} ${c.video ? 'Video' : 'Voice'} call declined`);
  } else if (reason === 'missed' || reason === 'cancelled') {
    addCallMessage(c.conversationId, `${icon} Missed ${kind} call`);
    const caller = getUser(c.callerId);
    pushToUser(c.calleeId, {
      type: 'missed_call',
      callId: c.id,
      conversationId: c.conversationId,
      callerId: c.callerId,
      callerName: caller?.display_name || 'Someone',
      video: c.video ? '1' : '0',
    }).catch(() => {});
  }
}

/** Handles a call.* message from a phone's WebSocket. Returns a reply or throws HttpError. */
export function handleCallMessage(userId, tokenHash, msg) {
  switch (msg.type) {
    case 'call.start': {
      const convId = Number(msg.conversationId);
      const conv = q('SELECT * FROM conversations WHERE id = ?').get(convId);
      if (!conv || !q('SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ?').get(convId, userId)) {
        throw new HttpError(404, 'Conversation not found');
      }
      if (conv.type === 'group') return startGroup(userId, tokenHash, conv, !!msg.video);
      const other = q('SELECT user_id FROM members WHERE conversation_id = ? AND user_id != ?').get(convId, userId);
      if (!other) throw bad('Nobody to call');
      if (isBlocked(other.user_id, userId) || isBlocked(userId, other.user_id)) throw new HttpError(403, 'You can’t call this person');
      if (busy.has(userId)) throw bad('You’re already on a call');

      const c = {
        id: crypto.randomUUID(),
        conversationId: convId,
        callerId: userId,
        callerToken: tokenHash,
        calleeId: other.user_id,
        calleeToken: null,
        video: !!msg.video,
        state: 'ringing',
        startedAt: Date.now(),
        answeredAt: null,
      };
      if (busy.has(c.calleeId)) {
        addCallMessage(convId, `${c.video ? '🎥' : '📞'} Missed ${c.video ? 'video' : 'voice'} call (they were on another call)`);
        return { type: 'call.ended', callId: c.id, reason: 'busy' };
      }
      calls.set(c.id, c);
      busy.set(c.callerId, c.id);
      busy.set(c.calleeId, c.id);
      c.timer = setTimeout(() => finish(c, 'missed'), RING_MS);

      const caller = getUser(userId);
      sendToUser(c.calleeId, { type: 'call.incoming', call: callOut(c), caller: { id: caller.id, displayName: caller.display_name, avatar: caller.avatar_media } });
      // Always push too: a phone with the app in the background may still have a socket open.
      pushToUser(c.calleeId, {
        type: 'call',
        callId: c.id,
        conversationId: convId,
        callerId: userId,
        callerName: caller.display_name,
        video: c.video ? '1' : '0',
        startedAt: c.startedAt,
      }).catch(() => {});
      return { type: 'call.started', call: callOut(c), calleeOnline: isOnline(c.calleeId) };
    }

    case 'call.accept': {
      const g = calls.get(String(msg.callId));
      if (g?.group) return joinGroup(g, userId, tokenHash);
      const c = g;
      if (!c || c.calleeId !== userId) throw new HttpError(404, 'That call has ended');
      if (c.state !== 'ringing') throw bad('Already answered');
      c.state = 'active';
      c.answeredAt = Date.now();
      c.calleeToken = tokenHash;
      clearTimeout(c.timer);
      sendToSession(c.callerId, c.callerToken, { type: 'call.accepted', call: callOut(c) });
      // Stop ringing on the callee's other phones.
      sendToUser(c.calleeId, { type: 'call.ended', callId: c.id, reason: 'answered_elsewhere' }, tokenHash);
      return { type: 'call.joined', call: callOut(c) };
    }

    case 'call.decline': {
      const g = calls.get(String(msg.callId));
      if (g?.group) return declineGroup(g, userId, tokenHash);
      const c = g;
      if (!c || c.calleeId !== userId) return { type: 'call.ended', callId: msg.callId, reason: 'gone' };
      sendToUser(c.calleeId, { type: 'call.ended', callId: c.id, reason: 'declined_elsewhere' }, tokenHash);
      finish(c, 'declined', userId);
      return { type: 'call.ended', callId: c.id, reason: 'declined' };
    }

    case 'call.end': {
      const g = calls.get(String(msg.callId));
      if (g?.group) {
        if (g.participants.has(userId)) leaveGroup(g, userId);
        return { type: 'call.ended', callId: g.id, reason: 'hangup' };
      }
      const c = g;
      if (!c || (c.callerId !== userId && c.calleeId !== userId)) return { type: 'call.ended', callId: msg.callId, reason: 'gone' };
      const reason = c.state === 'ringing' && userId === c.callerId ? 'cancelled' : 'hangup';
      finish(c, reason, userId);
      return { type: 'call.ended', callId: c.id, reason };
    }

    case 'call.signal': {
      const g = calls.get(String(msg.callId));
      if (g?.group) {
        // Only people in the call, from the phone they joined on, to someone else in it.
        if (g.participants.get(userId) !== tokenHash) return null;
        const to = Number(msg.to);
        const data = msg.data;
        if (!data || typeof data !== 'object' || JSON.stringify(data).length > 64_000) throw bad('Bad signal');
        if (g.participants.has(to)) sendToSession(to, g.participants.get(to), { type: 'call.signal', callId: g.id, from: userId, data });
        return null;
      }
      const c = g;
      if (!c || c.state !== 'active') return null;
      const data = msg.data;
      if (!data || typeof data !== 'object' || JSON.stringify(data).length > 64_000) throw bad('Bad signal');
      if (userId === c.callerId) sendToSession(c.calleeId, c.calleeToken, { type: 'call.signal', callId: c.id, data });
      else if (userId === c.calleeId && tokenHash === c.calleeToken) sendToSession(c.callerId, c.callerToken, { type: 'call.signal', callId: c.id, data });
      return null;
    }

    default:
      throw bad(`Unknown event type: ${msg.type}`);
  }
}

/** STUN/TURN servers for WebRTC, with short-lived coturn credentials (its "REST API" scheme). */
route('GET', '/api/calls/ice', ({ user }) => {
  const iceServers = [];
  if (config.turnHost && config.turnSecret) {
    const ttl = 12 * 3600;
    const username = `${Math.floor(Date.now() / 1000) + ttl}:${user.id}`;
    const credential = crypto.createHmac('sha1', config.turnSecret).update(username).digest('base64');
    const h = `${config.turnHost}:${config.turnPort}`;
    iceServers.push({ urls: [`stun:${h}`] });
    iceServers.push({ urls: [`turn:${h}?transport=udp`, `turn:${h}?transport=tcp`], username, credential });
  }
  iceServers.push({ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] });
  return { iceServers, relay: !!(config.turnHost && config.turnSecret) };
});

/** Lets a phone that woke up from a call push find out whether the call is still ringing. */
route('GET', '/api/calls/:id', ({ user, params }) => {
  const c = calls.get(params.id);
  if (c?.group) {
    if (!q('SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ?').get(c.conversationId, user.id)) throw new HttpError(404, 'That call has ended');
    const starter = getUser(c.startedBy);
    return { call: groupOut(c), caller: { id: starter.id, displayName: starter.display_name, avatar: starter.avatar_media } };
  }
  if (!c || (c.callerId !== user.id && c.calleeId !== user.id)) throw new HttpError(404, 'That call has ended');
  const caller = getUser(c.callerId);
  return { call: callOut(c), caller: { id: caller.id, displayName: caller.display_name, avatar: caller.avatar_media } };
});

// Tidy up anything left hanging (e.g. both phones vanished mid-call).
setInterval(() => {
  const cutoff = Date.now() - 6 * 3600_000;
  for (const c of calls.values()) if (c.startedAt < cutoff) (c.group ? finishGroup(c, 'timeout') : finish(c, 'timeout'));
}, 10 * 60_000).unref();

// ───────────── group calls ─────────────

function person(id) {
  const u = getUser(id);
  return { id, displayName: u?.display_name || 'Someone', avatar: u?.avatar_media || null };
}

function groupOut(g) {
  return {
    id: g.id,
    conversationId: g.conversationId,
    group: true,
    callerId: g.startedBy,
    video: g.video,
    state: g.answeredAt ? 'active' : 'ringing',
    startedAt: g.startedAt,
    answeredAt: g.answeredAt,
    participants: [...g.participants.keys()],
  };
}

function startGroup(userId, tokenHash, conv, video) {
  const existing = calls.get(activeByConv.get(conv.id));
  if (existing) return joinGroup(existing, userId, tokenHash); // a call's already going: hop in
  if (busy.has(userId)) throw bad('You’re already on a call');
  const others = q('SELECT user_id FROM members WHERE conversation_id = ? AND user_id != ?').all(conv.id, userId).map((r) => r.user_id);
  if (!others.length) throw bad('Nobody to call');
  const g = {
    id: crypto.randomUUID(),
    group: true,
    conversationId: conv.id,
    groupName: conv.name || 'Group',
    video,
    startedBy: userId,
    startedAt: Date.now(),
    answeredAt: null,
    participants: new Map([[userId, tokenHash]]),
    everJoined: new Set([userId]),
    ringing: new Set(others.filter((u) => !busy.has(u) && !isBlocked(u, userId))),
  };
  calls.set(g.id, g);
  activeByConv.set(conv.id, g.id);
  busy.set(userId, g.id);
  g.timer = setTimeout(() => stopRinging(g), RING_MS);

  const starter = person(userId);
  for (const u of g.ringing) {
    sendToUser(u, { type: 'call.incoming', call: groupOut(g), caller: starter, groupName: g.groupName });
    pushToUser(u, {
      type: 'call',
      callId: g.id,
      conversationId: conv.id,
      callerId: userId,
      callerName: starter.displayName,
      groupName: g.groupName,
      group: '1',
      video: video ? '1' : '0',
      startedAt: g.startedAt,
    }).catch(() => {});
  }
  return { type: 'call.started', call: groupOut(g), participants: [] };
}

/** Ringing time's up: stop ringing anyone who hasn't picked up. */
function stopRinging(g) {
  for (const u of g.ringing) {
    sendToUser(u, { type: 'call.ended', callId: g.id, reason: 'missed' });
    pushToUser(u, {
      type: 'missed_call',
      callId: g.id,
      conversationId: g.conversationId,
      callerId: g.startedBy,
      callerName: g.groupName,
      video: g.video ? '1' : '0',
    }).catch(() => {});
  }
  g.ringing.clear();
  // Nobody came: end it.
  if (g.everJoined.size <= 1) finishGroup(g, 'missed');
}

function joinGroup(g, userId, tokenHash) {
  if (g.participants.has(userId)) {
    g.participants.set(userId, tokenHash);
  } else {
    if (g.participants.size >= MAX_GROUP) throw bad(`Group calls are limited to ${MAX_GROUP} people`);
    if (busy.has(userId) && busy.get(userId) !== g.id) throw bad('You’re already on a call');
    g.participants.set(userId, tokenHash);
    g.everJoined.add(userId);
    busy.set(userId, g.id);
    if (!g.answeredAt) g.answeredAt = Date.now();
    const who = person(userId);
    for (const [u, tok] of g.participants) {
      if (u !== userId) sendToSession(u, tok, { type: 'call.participant.joined', callId: g.id, user: who, call: groupOut(g) });
    }
  }
  g.ringing.delete(userId);
  // Stop ringing on this person's other phones.
  sendToUser(userId, { type: 'call.ended', callId: g.id, reason: 'answered_elsewhere' }, tokenHash);
  const others = [...g.participants.keys()].filter((u) => u !== userId).map(person);
  return { type: 'call.joined', call: groupOut(g), participants: others, groupName: g.groupName };
}

function declineGroup(g, userId, tokenHash) {
  g.ringing.delete(userId);
  sendToUser(userId, { type: 'call.ended', callId: g.id, reason: 'declined_elsewhere' }, tokenHash);
  if (!g.ringing.size && g.everJoined.size <= 1) finishGroup(g, 'declined');
  return { type: 'call.ended', callId: g.id, reason: 'declined' };
}

function leaveGroup(g, userId) {
  g.participants.delete(userId);
  if (busy.get(userId) === g.id) busy.delete(userId);
  for (const [u, tok] of g.participants) sendToSession(u, tok, { type: 'call.participant.left', callId: g.id, userId, call: groupOut(g) });
  // Last one out turns off the lights; nobody stays on alone once ringing's over.
  if (g.participants.size === 0 || (g.participants.size === 1 && !g.ringing.size)) finishGroup(g, 'hangup');
}

function finishGroup(g, reason) {
  if (!calls.has(g.id)) return;
  calls.delete(g.id);
  if (activeByConv.get(g.conversationId) === g.id) activeByConv.delete(g.conversationId);
  clearTimeout(g.timer);
  for (const [u, tok] of g.participants) {
    if (busy.get(u) === g.id) busy.delete(u);
    sendToSession(u, tok, { type: 'call.ended', callId: g.id, reason });
  }
  for (const u of g.ringing) sendToUser(u, { type: 'call.ended', callId: g.id, reason: 'missed' });
  const icon = g.video ? '🎥' : '📞';
  const kind = g.video ? 'video' : 'voice';
  if (g.everJoined.size > 1) {
    addCallMessage(g.conversationId, `${icon} Group ${kind} call · ${fmt(Date.now() - (g.answeredAt || g.startedAt))}`);
  } else {
    addCallMessage(g.conversationId, `${icon} Missed group ${kind} call`);
  }
}
