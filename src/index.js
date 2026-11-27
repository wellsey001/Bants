import http from 'node:http';
import { config } from './config.js';
import { q } from './db.js';
import { authenticate } from './auth.js';
import { acceptUpgrade } from './websocket.js';
import { addConnection, removeConnection, allConnections } from './hub.js';
import {
  routes,
  HttpError,
  getUser,
  userOut,
  sendMessage,
  updateReceipts,
  sendTyping,
  notifyContactsPresence,
  sweepExpired,
} from './api.js';
import './push.js';
import { sendChannelMessage, sendChannelTyping, markChannelRead, notifyServerPresence } from './servers.js';
import './community.js';
import { handleCallMessage, onSessionGone } from './calls.js';
import { scheduleBackups } from './backup.js';
import { serveWeb } from './web.js';

const MAX_JSON = 1024 * 1024;

function clientIp(req) {
  if (config.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf);
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

function bearer(req, url) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return url.searchParams.get('token') || null; // handy for image loaders and WebSockets
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-filename');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  const started = Date.now();
  try {
    let match = null;
    let methodMismatch = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      if (r.method !== req.method) {
        methodMismatch = true;
        continue;
      }
      match = { r, m };
      break;
    }
    if (!match && !methodMismatch && serveWeb(req, res, url.pathname)) return;
    if (!match) throw new HttpError(methodMismatch ? 405 : 404, methodMismatch ? 'Method not allowed' : 'Not found');

    const { r, m } = match;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), ip: clientIp(req) };

    if (r.auth) {
      const session = authenticate(bearer(req, url));
      if (!session) throw new HttpError(401, 'Sign in required', 'unauthorised');
      ctx.user = getUser(session.userId);
      ctx.tokenHash = session.tokenHash;
    }
    ctx.body = r.raw || req.method === 'GET' || req.method === 'HEAD' ? {} : await readJson(req);

    const result = await r.handler(ctx);
    if (!res.headersSent && !res.writableEnded) send(res, 200, result ?? { ok: true });
  } catch (err) {
    if (err instanceof HttpError) {
      send(res, err.status, { error: err.message, code: err.code });
    } else {
      console.error(err);
      send(res, 500, { error: 'Something went wrong on the server' });
    }
  } finally {
    if (process.env.LOG_REQUESTS === 'true') {
      res.on('finish', () => console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
    }
  }
});

// ───────────── WebSocket: /ws?token=... (or Authorization header) ─────────────
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  const session = authenticate(bearer(req, url));
  if (!session) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  const conn = acceptUpgrade(req, socket, head);
  if (!conn) return;

  const userId = session.userId;
  const entry = { conn, tokenHash: session.tokenHash };
  const cameOnline = addConnection(userId, entry);
  q('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), userId);
  if (cameOnline) {
    notifyContactsPresence(userId, true);
    notifyServerPresence(userId, true);
  }

  const me = getUser(userId);
  conn.send({ type: 'ready', user: userOut(me, userId) });

  conn.on('message', (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return conn.send({ type: 'error', error: 'Invalid JSON' });
    }
    try {
      switch (msg.type) {
        case 'ping':
          conn.send({ type: 'pong', t: msg.t });
          break;
        case 'typing':
          sendTyping(userId, Number(msg.conversationId), msg.typing !== false);
          break;
        case 'receipt':
          updateReceipts(userId, Number(msg.conversationId), { delivered: msg.delivered, read: msg.read });
          break;
        // Servers
        case 'channel.typing':
          sendChannelTyping(userId, Number(msg.channelId));
          break;
        case 'channel.read':
          markChannelRead(userId, Number(msg.channelId), msg.messageId);
          break;
        case 'channel.send': {
          const message = sendChannelMessage(userId, Number(msg.channelId), msg);
          conn.send({ type: 'channel.ack', clientId: msg.clientId ?? null, message });
          break;
        }
        case 'message.send': {
          const { message } = sendMessage(userId, Number(msg.conversationId), msg);
          conn.send({ type: 'message.ack', clientId: msg.clientId ?? null, message });
          break;
        }
        default:
          if (typeof msg.type === 'string' && (msg.type.startsWith('call.') || msg.type.startsWith('voice.') || msg.type.startsWith('stage.'))) {
            const reply = handleCallMessage(userId, session.tokenHash, msg);
            if (reply) conn.send(reply);
            break;
          }
          conn.send({ type: 'error', error: `Unknown event type: ${msg.type}` });
      }
    } catch (err) {
      conn.send({
        type: 'error',
        clientId: msg.clientId ?? null,
        error: err instanceof HttpError ? err.message : 'Server error',
        code: err.code,
      });
      if (!(err instanceof HttpError)) console.error(err);
    }
  });

  conn.on('close', () => {
    q('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), userId);
    if (removeConnection(userId, entry)) {
      notifyContactsPresence(userId, false);
      notifyServerPresence(userId, false);
    }
    onSessionGone(userId, session.tokenHash);
  });
});

// Disappearing messages.
setInterval(() => {
  try {
    sweepExpired();
  } catch (err) {
    console.error('[sweep]', err);
  }
}, Number(process.env.SWEEP_INTERVAL_MS || 30_000)).unref();

// Ping every 30 s; drop connections that stopped answering (phone lost signal, etc).
setInterval(() => {
  for (const conn of allConnections()) {
    if (!conn.alive) {
      conn.close(1001, 'Timed out');
      continue;
    }
    conn.alive = false;
    conn.ping();
  }
}, 30_000).unref();

// Big uploads (4K video over a slow connection) can take a while: allow up to 2 hours per request.
server.requestTimeout = 2 * 60 * 60 * 1000;

scheduleBackups();

server.listen(config.port, () => {
  console.log(`bants-server listening on :${config.port} (data in ${config.dataDir})`);
  const mode = config.allowRegistration ? (config.inviteCode ? 'invite code required' : 'open') : 'closed';
  console.log(`registration: ${mode}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const c of allConnections()) c.close(1001, 'Server restarting');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
