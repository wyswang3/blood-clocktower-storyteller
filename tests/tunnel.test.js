'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseTunnelUrl, findCloudflared, missingCloudflaredHint } = require('../lib/tunnel');

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
