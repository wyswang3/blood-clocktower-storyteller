'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { nativeAuthorized, createNativeControl } = require('../lib/native-control');
const { createTunnelManager } = require('../lib/tunnel-manager');
const TOKEN = 'native-test-only-'.repeat(4);
const req = (changes = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3000', 'x-btc-native': TOKEN }, method: 'GET', ...changes });

test('APK 管理接口：本机、准确 Host 和随机令牌必须同时成立', () => {
  assert.equal(nativeAuthorized(req(), TOKEN), true);
  assert.equal(nativeAuthorized(req(), undefined), false);
  assert.equal(nativeAuthorized(req(), 'short'), false);
  assert.equal(nativeAuthorized(req({ socket: { remoteAddress: '192.168.1.2' } }), TOKEN), false);
  for (const host of ['room.trycloudflare.com', '127.0.0.1.evil.test:3000', 'localhost:3000', '']) {
    assert.equal(nativeAuthorized(req({ headers: { host, 'x-btc-native': TOKEN } }), TOKEN), false);
  }
  for (const value of ['', TOKEN + 'x', ['array'], TOKEN.replace('n', 'z')]) {
    assert.equal(nativeAuthorized(req({ headers: { host: '127.0.0.1', 'x-btc-native': value } }), TOKEN), false);
  }
});

function api() {
  const calls = [];
  const control = createNativeControl({ token: TOKEN, status: () => ({ pin: '4321' }), retry: () => calls.push('retry'),
    setMode: (mode) => calls.push(mode), networkChanged: (ip) => calls.push(ip), stop: () => calls.push('saved') });
  function invoke(path, method = 'GET', request = req()) {
    let response;
    const handled = control({ ...request, method }, { setHeader() {} }, path, (_res, code, data) => { response = { code, data }; });
    return { handled, ...response };
  }
  return { invoke, calls };
}
test('APK 管理接口：网页访客、伪造代理头不能读取 PIN 或停止房间', () => {
  const a = api();
  const unauthorized = req({ headers: { host: 'room.trycloudflare.com', 'x-forwarded-proto': 'https' } });
  assert.equal(a.invoke('/__native/status', 'GET', unauthorized).code, 403);
  assert.equal(a.invoke('/__native/stop', 'POST', unauthorized).code, 403);
  assert.deepEqual(a.calls, []);
  assert.equal(a.invoke('/health').handled, false);
});
test('APK 管理接口：读写方法分离，只有白名单模式可切换', () => {
  const a = api();
  assert.deepEqual(a.invoke('/__native/status').data, { pin: '4321' });
  assert.equal(a.invoke('/__native/stop').code, 404);
  assert.equal(a.invoke('/__native/mode/other', 'POST').code, 404);
  a.invoke('/__native/mode/lan', 'POST'); a.invoke('/__native/mode/internet', 'POST');
  a.invoke('/__native/retry', 'POST'); a.invoke('/__native/stop', 'POST');
  assert.deepEqual(a.calls, ['lan', 'internet', 'retry', 'saved']);
});
test('APK 管理接口：切网更新地址并拒绝非法 IP', () => {
  const a = api();
  assert.equal(a.invoke('/__native/network/192.168.1.12', 'POST').code, 200);
  assert.equal(a.invoke('/__native/network/none', 'POST').code, 200);
  assert.equal(a.invoke('/__native/network/999.1.1.1', 'POST').code, 400);
  assert.equal(a.invoke('/__native/network/example.test', 'POST').code, 404);
  assert.deepEqual(a.calls, ['192.168.1.12', '']);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
function manager(start) {
  const changes = [], scheduled = [];
  const timers = { setTimeout(fn) { const t = { fn, cancelled: false }; scheduled.push(t); return t; }, clearTimeout(t) { t.cancelled = true; } };
  const value = createTunnelManager({ port: 3000, startTunnel: start, onChange: (s) => changes.push(s), timers });
  return { value, changes, scheduled };
}
function child() { const c = new EventEmitter(); c.kill = () => { c.killed = true; c.emit('exit', 0); }; return c; }
test('APK 公网连接：连通后公布链接，中断立即撤销并自动重试', async () => {
  let calls = 0; const children = [];
  const m = manager(async () => { calls++; const c = child(); children.push(c); return { url: 'https://room.trycloudflare.com', child: c }; });
  m.value.start(); m.value.start(); await tick();
  assert.equal(calls, 1); assert.equal(m.value.status().state, 'online');
  children[0].emit('exit', 1);
  assert.deepEqual(m.value.status(), { state: 'retrying', url: null });
  m.scheduled.at(-1).fn(); await tick();
  assert.equal(calls, 2); assert.equal(m.value.status().state, 'online');
  m.value.stop(); assert.ok(children[1].killed);
});
test('APK 公网连接：失败不保留旧链接，停止后不再自动启动', async () => {
  let calls = 0;
  const m = manager(async () => { calls++; throw new Error('private failure'); });
  m.value.start(); await tick(); assert.equal(m.value.status().state, 'retrying');
  assert.ok(!JSON.stringify(m.changes).includes('private failure'));
  m.value.stop(); assert.equal(m.scheduled.at(-1).cancelled, true);
  assert.deepEqual(m.value.status(), { state: 'off', url: null }); assert.equal(calls, 1);
});
test('APK 公网连接：重试取消旧请求，迟到进程不能覆盖新链接', async () => {
  const pending = [], signals = [];
  const m = manager((_port, { signal }) => { signals.push(signal); return new Promise((resolve) => pending.push(resolve)); });
  m.value.start(); m.value.retry(); assert.equal(signals[0].aborted, true);
  const old = child(), current = child();
  pending[1]({ url: 'https://new.trycloudflare.com', child: current }); await tick();
  pending[0]({ url: 'https://old.trycloudflare.com', child: old }); await tick();
  assert.ok(old.killed); assert.equal(m.value.status().url, 'https://new.trycloudflare.com');
  m.value.stop(); assert.ok(current.killed);
});
test('APK 公网连接：切回局域网后，尚未完成的公网进程也被回收', async () => {
  let resolve;
  const m = manager(() => new Promise((r) => { resolve = r; }));
  m.value.start(); m.value.stop(); const c = child(); resolve({ url: 'https://late.trycloudflare.com', child: c });
  await tick(); assert.ok(c.killed); assert.equal(m.value.status().state, 'off');
});
