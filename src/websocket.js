// Minimal RFC 6455 WebSocket server (text frames, ping/pong, close, fragmentation).
// No dependencies, which keeps the Docker image tiny.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024; // 1 MB per client message is plenty for JSON events

export class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.alive = true;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#finish());
    socket.on('error', () => this.#finish());
  }

  send(data) {
    if (this.closed) return;
    const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
    this.#writeFrame(0x1, payload);
  }

  ping() {
    if (this.closed) return;
    this.#writeFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(reason);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.#writeFrame(0x8, p);
    this.socket.end();
    this.#finish();
  }

  #finish() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.emit('close');
  }

  #writeFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.#finish();
    }
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009, 'Message too big');
        len = Number(big);
        offset = 10;
      }
      if (!masked) return this.close(1002, 'Client frames must be masked');
      if (len > MAX_MESSAGE) return this.close(1009, 'Message too big');
      if (this.buffer.length < offset + 4 + len) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = this.buffer.subarray(offset + 4 + len);
      this.alive = true;

      switch (opcode) {
        case 0x0: // continuation
          this.fragments.push(payload);
          if (fin) {
            const full = Buffer.concat(this.fragments);
            this.fragments = [];
            if (this.fragmentOpcode === 0x1) this.emit('message', full.toString('utf8'));
          }
          break;
        case 0x1: // text
        case 0x2: // binary
          if (fin) {
            if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
          } else {
            this.fragmentOpcode = opcode;
            this.fragments = [payload];
          }
          break;
        case 0x8: // close
          this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
          return;
        case 0x9: // ping
          this.#writeFrame(0xa, payload);
          break;
        case 0xa: // pong
          break;
        default:
          return this.close(1002, 'Unknown opcode');
      }
    }
  }
}

/** Completes the HTTP upgrade handshake and returns a connection, or null if invalid. */
export function acceptUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const conn = new WebSocketConnection(socket);
  if (head && head.length) socket.emit('data', head);
  return conn;
}
