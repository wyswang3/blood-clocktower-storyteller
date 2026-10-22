'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// 使用真实入口和游戏引擎，仅替换外部 IO 与时钟，重现安卓网卡异常和认证超时。
function boot({ networkError = false, publicUrl = '', tunnelUrl = null } = {}) {
  const root = path.join(__dirname, '..');
  const timeouts = [];
  const logs = [];
  let accept;
  const tunnelChild = new EventEmitter();
  const context = vm.createContext({
    require(id) {
      if (id === 'node:http') return { createServer: () => ({ listen: (_port, _host, cb) => cb() }) };
      if (id === 'node:fs') return { readFileSync() { const error = new Error('no saved game'); error.code = 'ENOENT'; throw error; } };
      if (id === 'node:os') return { networkInterfaces() { if (networkError) throw new Error('uv_interface_addresses EACCES'); return {}; } };
      if (id === './lib/ws') return { attachWebSocket: (_server, cb) => { accept = cb; } };
      if (id === './lib/tunnel' && tunnelUrl) return { startTunnel: async () => ({ url: tunnelUrl, child: tunnelChild }) };
      return require(id.startsWith('.') ? path.join(root, id) : id);
    },
    __dirname: root, Buffer, URL,
    process: { env: { HOST_PIN: '4321', PUBLIC_URL: publicUrl }, argv: tunnelUrl ? ['--tunnel'] : [], on() {} },
    console: { log: (line) => logs.push(line), warn: (line) => logs.push(line), error: (line) => logs.push(line) },
    setTimeout(fn, ms) { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout() {}, setInterval() {},
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), context, { filename: 'server.js' });
  return {
    logs,
    stopTunnel() { tunnelChild.emit('exit', 1); },
    connect() {
      const conn = new EventEmitter();
      conn.messages = [];
      conn.send = (message) => conn.messages.push(message);
      conn.close = (code) => { conn.closeCode = code; conn.emit('close'); };
      accept(conn);
      return conn;
    },
    expireHello() { for (const timer of timeouts.filter((t) => t.ms === 10000)) timer.fn(); },
  };
}

test('认证：说书人成功 hello 后，没有公共频道也不会在十秒被踢', () => {
  const server = boot();
  const conn = server.connect();
  conn.emit('message', { t: 'hello', role: 'storyteller', pin: '4321' });
  assert.ok(conn.messages.some((m) => m.t === 'welcome' && m.role === 'storyteller'));
  server.expireHello();
  assert.equal(conn.closeCode, undefined);
  conn.emit('message', { t: 'ping' });
  assert.equal(conn.messages.at(-1).t, 'pong');
});

test('认证：不 hello 的连接仍会超时，错误 PIN 仍被拒绝', () => {
  const server = boot();
  const silent = server.connect();
  const bad = server.connect();
  bad.emit('message', { t: 'hello', role: 'storyteller', pin: '0000' });
  assert.equal(bad.closeCode, 4003);
  server.expireHello();
  assert.equal(silent.closeCode, 4008);
});

test('安卓：禁止枚举网卡时仍正常启动，打印本机地址及手动查看 IP 提示', () => {
  const server = boot({ networkError: true });
  const banner = server.logs.join('\n');
  assert.match(banner, /http:\/\/127\.0\.0\.1:3000\/host\?pin=4321/);
  assert.match(banner, /Wi-Fi 设置/);
  assert.match(banner, /<设备的局域网IP>/);
  const conn = server.connect();
  conn.emit('message', { t: 'hello', role: 'host', pin: '4321' });
  assert.ok(conn.messages.some((m) => m.t === 'sync' && m.view.phase === 'lobby'));
});

test('房间地址：公共配置只下发手机加入链接，不带房主 PIN', () => {
  const server = boot({ publicUrl: 'https://room.example.test/' });
  const conn = server.connect();
  conn.emit('message', { t: 'hello', role: 'guest' });
  const view = conn.messages.find((m) => m.t === 'sync').view;
  assert.equal(view.joinUrl, 'https://room.example.test/player');
  assert.ok(!view.joinUrl.includes('pin'));
});

test('房间地址：隧道就绪后推送新链接，隧道退出后清除过期链接', async () => {
  const server = boot({ tunnelUrl: 'https://test-room.trycloudflare.com' });
  const conn = server.connect();
  conn.emit('message', { t: 'hello', role: 'guest' });
  assert.equal(conn.messages.find((m) => m.t === 'sync').view.joinUrl, null);
  await Promise.resolve();
  assert.equal(conn.messages.at(-1).view.joinUrl, 'https://test-room.trycloudflare.com/player');
  server.stopTunnel();
  assert.equal(conn.messages.at(-1).view.joinUrl, null);
  assert.match(conn.messages.at(-1).notice, /公网连接已中断/);
});
