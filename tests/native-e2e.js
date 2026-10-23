'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const ROOT = path.join(__dirname, '..');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('APK 真实服务：本机管理、网卡兜底、切网、隐私隔离与保存后恢复', { timeout: 15000 }, async () => {
  const artifacts = path.resolve(ROOT, 'artifacts'); fs.mkdirSync(artifacts, { recursive: true });
  const directory = fs.mkdtempSync(path.join(artifacts, 'native-e2e-'));
  const probe = net.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  const token = randomBytes(32).toString('hex');
  let child, logs = '';
  const url = `http://127.0.0.1:${port}`;
  async function start(pin) {
    child = spawn(process.execPath, ['server.js'], { cwd: ROOT,
      env: { ...process.env, PORT: String(port), HOST_PIN: pin, ROOM_FILE: path.join(directory, 'room.json'),
        AI_CONFIG_FILE: path.join(directory, 'ai.local.json'), BTC_NATIVE_TOKEN: token, BTC_LAN_IP: '192.168.30.12',
        TUNNEL: '0', PUBLIC_URL: '', AI_ENABLED: '0', DEEPSEEK_API_KEY: '' }, stdio: ['ignore','pipe','pipe'] });
    child.stdout.on('data', (text) => { logs += text; }); child.stderr.on('data', (text) => { logs += text; });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(url + '/health')).ok) return; } catch {} await pause(100); }
    throw new Error('native server did not start');
  }
  async function stop() { if (!child || child.exitCode !== null) return; const exited = new Promise((r) => child.once('exit', r)); child.kill(); await exited; }
  const request = (route, method = 'GET', headers = {}) => fetch(url + route, { method, headers: { 'X-Btc-Native': token, ...headers } });
  try {
    await start('4321');
    const first = await (await request('/__native/status')).json();
    assert.equal(first.pin, '4321'); assert.equal(first.joinUrl, `http://192.168.30.12:${port}/player`);
    assert.equal((await fetch(url + '/__native/status')).status, 403);
    const proxiedCode = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: '/__native/status', headers: { Host: 'external.trycloudflare.com', 'X-Btc-Native': token } },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
    });
    assert.equal(proxiedCode, 403);
    assert.equal((await request('/__native/stop', 'GET')).status, 404);
    await request('/__native/network/192.168.31.20', 'POST');
    const changed = await (await request('/__native/status')).json();
    assert.equal(changed.joinUrl, `http://192.168.31.20:${port}/player`);
    const pub = await (await fetch(url + '/state/public')).json();
    assert.equal(pub.joinUrl, changed.joinUrl); assert.ok(!Object.hasOwn(pub, 'pin'));
    assert.ok(!JSON.stringify(pub).includes(token));
    assert.equal((await fetch(url + '/ai.local.json')).status, 404);
    assert.ok(!logs.includes('4321')); assert.ok(!logs.includes(token));
    await request('/__native/stop', 'POST');
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'room.json'), 'utf8')).pin, '4321');
    await stop(); await start('9999');
    assert.equal((await (await request('/__native/status')).json()).pin, '4321');
    assert.equal((await (await fetch(url + '/state/public')).json()).phase, 'lobby');
  } finally {
    await stop();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(artifacts + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
