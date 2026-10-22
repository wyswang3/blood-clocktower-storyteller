'use strict';

/**
 * 最小 RFC 6455 WebSocket 服务端实现。
 * 不引第三方包：现场不联网也能 node server.js 直接跑。
 * 只支持文本帧（本项目的全部消息都是 JSON），带分片、ping/pong、close 处理。
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20; // 1MB，超过直接断开

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
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
  return Buffer.concat([header, payload]);
}

class WsConnection extends EventEmitter {
  constructor(socket, head, meta = {}) {
    super();
    this.socket = socket;
    this.meta = meta;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragParts = [];
    this.fragOpcode = 0;
    this.closed = false;
    this.isAlive = true;
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
    socket.on('end', () => this._finish());
    if (this.buf.length) this._parse();
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > MAX_FRAME) {
      this.close(1009, 'frame too large');
      return;
    }
    this._parse();
  }

  _parse() {
    while (!this.closed) {
      const buf = this.buf;
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) {
          this.close(1009, 'frame too large');
          return;
        }
        len = Number(big);
        offset = 10;
      }
      if (!masked) {
        // 客户端必须加掩码
        this.close(1002, 'unmasked frame');
        return;
      }
      if (buf.length < offset + 4 + len) return;
      const mask = buf.subarray(offset, offset + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[offset + 4 + i] ^ mask[i & 3];
      this.buf = buf.subarray(offset + 4 + len);

      if (opcode === 0x8) {
        this.close(1000, '');
        return;
      }
      if (opcode === 0x9) {
        this._write(0xa, payload);
        continue;
      }
      if (opcode === 0xa) {
        this.isAlive = true;
        continue;
      }
      if (opcode === 0x0) {
        if (!this.fragOpcode) {
          this.close(1002, 'unexpected continuation');
          return;
        }
        this.fragParts.push(payload);
        if (fin) {
          const all = Buffer.concat(this.fragParts);
          const op = this.fragOpcode;
          this.fragParts = [];
          this.fragOpcode = 0;
          if (op === 0x1) this._text(all.toString('utf8'));
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          this.fragOpcode = opcode;
          this.fragParts = [payload];
          continue;
        }
        if (opcode === 0x1) this._text(payload.toString('utf8'));
        else this.emit('binary', payload);
        continue;
      }
      this.close(1002, 'unknown opcode');
      return;
    }
  }

  _text(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.send({ t: 'error', message: '消息不是合法 JSON' });
      return;
    }
    this.emit('message', msg);
  }

  _write(opcode, payload) {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(opcode, payload));
    } catch {
      this._finish();
    }
  }

  send(obj) {
    this._write(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  ping() {
    this.isAlive = false;
    this._write(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    try {
      this._write(0x8, payload);
      this.socket.end();
    } catch {
      /* ignore */
    }
    this.closed = true;
    this.emit('close');
  }
}

/**
 * 把 WebSocket 挂到已有的 http server 上。
 * @param {import('node:http').Server} server
 * @param {(conn: WsConnection, req, url: URL) => void} onConnection
 */
function attachWebSocket(server, onConnection) {
  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers['sec-websocket-version']) !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
        '\r\n'
    );
    const conn = new WsConnection(socket, head, { url });
    try {
      onConnection(conn, req, url);
    } catch (e) {
      console.error('[ws] 连接处理失败', e);
      conn.close(1011, 'server error');
    }
  });
}

module.exports = { WsConnection, attachWebSocket, encodeFrame };
