'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// 使用真实入口和游戏引擎，仅替换外部 IO 与时钟，重现安卓网卡异常和认证超时。
function boot({ networkError = false, publicUrl = '', tunnelUrl = null, setupProbe, saveSettings, env = {} } = {}) {
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
      if (id === './lib/deepseek' && setupProbe) {
        const actual = require('../lib/deepseek');
        return { loadAIConfig: ({ env }) => actual.loadAIConfig({ env }), createDeepSeekClient: (config) => ({ choose: (input) => setupProbe(config, input) }) };
      }
      if (id === './lib/ai-settings' && setupProbe) return { ...require('../lib/ai-settings'), writeAISettings: (_file, config) => saveSettings(config) };
      if (id === './lib/tunnel' && tunnelUrl) return { startTunnel: async () => ({ url: tunnelUrl, child: tunnelChild }) };
      return require(id.startsWith('.') ? path.join(root, id) : id);
    },
    __dirname: root, Buffer, URL,
    process: { env: { HOST_PIN: '4321', PUBLIC_URL: publicUrl, ...env }, argv: tunnelUrl ? ['--tunnel'] : [], on() {} },
    console: { log: (line) => logs.push(line), warn: (line) => logs.push(line), error: (line) => logs.push(line) },
    setTimeout(fn, ms) { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout() {}, setInterval() {},
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), context, { filename: 'server.js' });
  return {
    logs,
    stopTunnel() { tunnelChild.emit('exit', 1); },
    connect({ peer = '127.0.0.1', host = '127.0.0.1:3000', forwarded, encrypted = false } = {}) {
      const conn = new EventEmitter();
      conn.messages = [];
      conn.send = (message) => conn.messages.push(message);
      conn.close = (code) => { conn.closeCode = code; conn.emit('close'); };
      accept(conn, { headers: { host, 'x-forwarded-proto': forwarded }, socket: { remoteAddress: peer, encrypted } });
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

const tick = () => new Promise((resolve) => setImmediate(resolve));
function hostConnection(server, options) {
  const host = server.connect(options); host.emit('message', { t: 'hello', role: 'host', pin: '4321' }); return host;
}
function currentView(conn) { return conn.messages.filter((m) => m.view).at(-1).view; }

test('一键连接：只有房主可配置，普通访客和说书人不能写密钥', async () => {
  let calls = 0;
  const server = boot({ setupProbe: async () => { calls++; }, saveSettings() {} });
  for (const role of ['guest', 'storyteller']) {
    const c = server.connect(); c.emit('message', { t: 'hello', role, pin: '4321' });
    c.emit('message', { t: 'host', action: 'configureAI', apiKey: 'fake-private-key' });
    assert.match(c.messages.at(-1).message, /不是房主/);
  }
  await tick(); assert.equal(calls, 0);
});

test('一键连接：验证、保存、热加载和启用依次完成；密钥与进度不广播到玩家', async () => {
  const saved = []; let calls = 0;
  const server = boot({ setupProbe: async (config, input) => {
    calls++; assert.equal(config.apiKey, 'fake-private-key'); assert.equal(config.model, 'deepseek-flash');
    assert.equal(Object.keys(input.view).length, 0); assert.equal(input.options[0].id, 'test-ok');
  }, saveSettings: (config) => saved.push(config) });
  const guest = server.connect(); guest.emit('message', { t: 'hello', role: 'guest' });
  const host = hostConnection(server);
  host.emit('message', { t: 'host', action: 'configureAI', apiKey: 'fake-private-key', baseUrl: 'https://untrusted.test' });
  await tick();
  assert.equal(calls, 1); assert.equal(saved.length, 1); assert.equal(saved[0].baseUrl, 'https://api.deepseek.com');
  assert.equal(currentView(host).ai.enabled, true); assert.equal(currentView(host).phase, 'lobby');
  assert.ok(host.messages.some((m) => m.t === 'ai-setup' && m.status === 'success'));
  assert.ok(!guest.messages.some((m) => m.t === 'ai-setup'));
  for (const c of [host, guest]) assert.doesNotMatch(JSON.stringify(c.messages), /fake-private-key/);
});

test('一键连接：错误密钥或服务失败不覆盖原设置、不自动启用', async () => {
  let saves = 0;
  const server = boot({ setupProbe: async () => { throw Object.assign(Error('RAW_PRIVATE_KEY'), { code: 'AI_HTTP_401' }); }, saveSettings: () => saves++ });
  const host = hostConnection(server); host.emit('message', { t: 'host', action: 'configureAI', apiKey: 'wrong-private-key' });
  await tick();
  assert.equal(saves, 0); assert.equal(currentView(host).ai.enabled, false);
  assert.match(host.messages.at(-1).message, /密钥.*原来的设置仍保留/);
  assert.doesNotMatch(JSON.stringify(host.messages), /RAW_PRIVATE_KEY|wrong-private-key/);
});

test('一键连接：无效输入和明文局域网不触发收费测试', async () => {
  let calls = 0;
  const server = boot({ setupProbe: async () => calls++, saveSettings() {} });
  const host = hostConnection(server);
  host.emit('message', { t: 'host', action: 'configureAI', apiKey: 'https://example.test' });
  assert.equal(host.messages.at(-1).status, 'error');
  const remote = hostConnection(server, { peer: '192.168.1.99', host: '192.168.1.5:3000' });
  remote.emit('message', { t: 'host', action: 'configureAI', apiKey: 'fake-private-key' });
  assert.match(remote.messages.at(-1).message, /本机页面或 HTTPS/);
  await tick(); assert.equal(calls, 0);
});

test('一键连接：HTTPS 反向代理可用，断线重连可恢复连接进度', async () => {
  let complete; const server = boot({ setupProbe: () => new Promise((r) => { complete = r; }), saveSettings() {} });
  const host = hostConnection(server, { host: 'room.example.test', forwarded: 'https' });
  host.emit('message', { t: 'host', action: 'configureAI', apiKey: 'fake-private-key' });
  const reconnect = hostConnection(server, { host: 'room.example.test', forwarded: 'https' });
  assert.ok(reconnect.messages.some((m) => m.t === 'ai-setup' && m.status === 'working' && m.allowed));
  complete(); await tick();
  assert.ok(reconnect.messages.some((m) => m.t === 'ai-setup' && m.status === 'success'));
});

test('一键连接：重复点击仅调用一次，测试期间不能并发更改开关', async () => {
  let calls = 0, complete; const saved = [];
  const server = boot({ setupProbe: () => { calls++; return new Promise((r) => { complete = r; }); }, saveSettings: (c) => saved.push(c) });
  const host = hostConnection(server);
  for (let i = 0; i < 3; i++) host.emit('message', { t: 'host', action: 'configureAI', apiKey: 'fake-private-key' });
  host.emit('message', { t: 'host', action: 'setAI', enabled: false });
  assert.match(host.messages.at(-1).message, /正在连接/); assert.equal(calls, 1);
  complete(); await tick(); assert.equal(saved.length, 1);
});

test('一键连接：保存失败时不换掉现有客户端；暂停必须立即生效，即使写盘失败', async () => {
  let failSave = true;
  const server = boot({ setupProbe: async () => {}, saveSettings: () => { if (failSave) throw Error('AI_SAVE_FAILED'); } });
  const host = hostConnection(server);
  host.emit('message', { t: 'host', action: 'configureAI', apiKey: 'fake-private-key' });
  await tick(); assert.equal(currentView(host).ai.enabled, false); assert.match(host.messages.at(-1).message, /未保存/);
  failSave = false; host.emit('message', { t: 'host', action: 'configureAI', apiKey: 'fake-private-key' });
  await tick(); assert.equal(currentView(host).ai.enabled, true);
  failSave = true; host.emit('message', { t: 'host', action: 'setAI', enabled: false });
  assert.equal(currentView(host).ai.enabled, false); assert.match(host.messages.at(-1).message, /本次已暂停/);
});
