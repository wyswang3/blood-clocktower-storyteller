'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseTunnelUrl, findCloudflared, missingCloudflaredHint } = require('../lib/tunnel');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('隧道：从 cloudflared 日志里认出公网地址', () => {
  assert.strictEqual(
    parseTunnelUrl('2026-10-22T01:00:00Z INF |  https://brave-cat-fox.trycloudflare.com  |'),
    'https://brave-cat-fox.trycloudflare.com'
  );
  assert.strictEqual(
    parseTunnelUrl('Your quick Tunnel has been created! Visit it at https://a1-b2-c3.trycloudflare.com'),
    'https://a1-b2-c3.trycloudflare.com'
  );
  assert.strictEqual(parseTunnelUrl('INF | https://example.com'), null);
  assert.strictEqual(parseTunnelUrl(''), null);
});

test('隧道：安卓安装提示使用 Termux，Windows 使用 winget', () => {
  assert.match(missingCloudflaredHint('android'), /pkg install cloudflared/);
  assert.match(missingCloudflaredHint('win32'), /winget install/);
});

test('隧道：找不到 cloudflared 时给的是可执行的提示', () => {
  const bin = findCloudflared();
  assert.strictEqual(typeof bin, 'string');
  assert.ok(bin.length > 0);
});

function tunnelHarness() {
  const child = new EventEmitter(); child.kill = () => { child.killed = true; child.emit('exit', 0); };
  let log = ''; const timers = [], polls = [];
  const context = { module: { exports: {} }, __dirname: path.join(__dirname, '..', 'lib'),
    process: { platform: 'android', pid: 42, env: {} },
    require(id) {
      if (id === 'node:fs') return { existsSync: () => false, writeFileSync() {}, readFileSync: () => log, unlinkSync() {} };
      if (id === 'node:child_process') return { spawn: () => child };
      return require(id);
    },
    setTimeout(fn) { const timer = { fn }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    setInterval(fn) { const poll = { fn }; polls.push(poll); return poll; },
    clearInterval(poll) { if (poll) poll.cleared = true; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/tunnel.js'), 'utf8'), context);
  return { start: context.module.exports.startTunnel, child, timers, polls, log(text) { log = text; } };
}

test('APK 隧道：必须看到连接注册成功才公布公网地址', async () => {
  const h = tunnelHarness(); let resolved = false;
  const started = h.start(3000, { waitForConnection: true }).then((value) => { resolved = true; return value; });
  h.log('https://generated.trycloudflare.com'); h.polls[0].fn(); await Promise.resolve();
  assert.strictEqual(resolved, false);
  h.log('https://generated.trycloudflare.com\nRegistered tunnel connection connIndex=0'); h.polls[0].fn();
  assert.strictEqual((await started).url, 'https://generated.trycloudflare.com');
  assert.strictEqual(h.timers[0].cleared, true); assert.strictEqual(h.polls[0].cleared, true);
});
test('APK 隧道：切网取消必须结束尚未连通的子进程并清理轮询', async () => {
  const h = tunnelHarness(), controller = new AbortController();
  const started = h.start(3000, { signal: controller.signal });
  controller.abort(); await assert.rejects(started, /已取消/);
  assert.strictEqual(h.child.killed, true); assert.strictEqual(h.polls[0].cleared, true);
});
test('APK 隧道：超时结束进程，错误提示不含私密路径', async () => {
  const h = tunnelHarness(); const started = h.start(3000, { logFile: '/private/app/log.txt' });
  h.timers[0].fn(); await assert.rejects(started, (error) => /检查网络/.test(error.message) && !error.message.includes('/private'));
  assert.strictEqual(h.child.killed, true);
});
