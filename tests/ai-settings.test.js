'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateKey, configFromKey, writeAISettings, connectionError } = require('../lib/ai-settings');
const { loadAIConfig } = require('../lib/deepseek');
const root = path.resolve(__dirname, '..', 'artifacts');
fs.mkdirSync(root, { recursive: true });

function temporary(fn) {
  const folder = fs.mkdtempSync(path.join(root, 'settings-test-'));
  try { fn(path.join(folder, 'ai.local.json'), folder); }
  finally {
    assert.ok(path.resolve(folder).startsWith(root + path.sep));
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

test('一键配置：修剪边缘空格，拒绝代码、网址、空值、控制符和过长密钥', () => {
  assert.equal(validateKey('  fake-private-key  '), 'fake-private-key');
  for (const bad of [null, 3, '', 'short', 'https://api.deepseek.com', 'my key here', 'key\nvalue', 'a'.repeat(513), '<script>alert(1)</script>']) {
    assert.equal(validateKey(bad), null);
  }
});

test('一键配置：自动选择官方地址和默认模型，不接收网页端点参数', () => {
  const c = configFromKey('fake-private-key', {});
  assert.equal(c.baseUrl, 'https://api.deepseek.com'); assert.equal(c.model, 'deepseek-flash');
  assert.equal(c.enabled, true); assert.equal(c.configured, true); assert.equal(c.managedByUI, true);
});

test('一键配置：仅技术人员的服务端环境可以覆盖端点与模型，坏端点仍拒绝', () => {
  const c = configFromKey('fake-private-key', { DEEPSEEK_BASE_URL: 'http://127.0.0.1:1234', DEEPSEEK_MODEL: 'test-model' });
  assert.equal(c.baseUrl, 'http://127.0.0.1:1234'); assert.equal(c.model, 'test-model');
  assert.equal(configFromKey('fake-private-key', { DEEPSEEK_BASE_URL: 'http://unsafe.test' }).configured, false);
});

test('一键配置：真实文件保存后可重新加载，网页选择的密钥与开关优先于旧环境值', () => temporary((file) => {
  fs.writeFileSync(file, JSON.stringify({ note: '保留其他配置', apiKey: 'old-private-key', enabled: false }));
  writeAISettings(file, configFromKey('new-private-key', {}));
  const c = loadAIConfig({ filePath: file, env: { DEEPSEEK_API_KEY: 'old-env-key', AI_ENABLED: '0' } });
  assert.equal(c.apiKey, 'new-private-key'); assert.equal(c.enabled, true); assert.equal(c.managedByUI, true);
  assert.equal(JSON.parse(fs.readFileSync(file)).note, '保留其他配置');
}));

test('暂停与恢复：开关保存在私密文件，重启不会擅自撤销暂停', () => temporary((file) => {
  const c = configFromKey('fake-private-key', {});
  writeAISettings(file, c); writeAISettings(file, { ...c, enabled: false });
  assert.equal(loadAIConfig({ filePath: file, env: { AI_ENABLED: '1' } }).enabled, false);
  writeAISettings(file, { ...c, enabled: true });
  assert.equal(loadAIConfig({ filePath: file, env: {} }).enabled, true);
}));

test('原子保存：替换失败保留原文件、清理临时文件，不把原始异常或密钥外泄', () => temporary((file, folder) => {
  const original = JSON.stringify({ apiKey: 'old-private-key', enabled: false }); fs.writeFileSync(file, original);
  const fsImpl = { ...fs, renameSync() { throw Error('RAW_SECRET_must_not_escape'); } };
  assert.throws(() => writeAISettings(file, configFromKey('new-private-key', {}), { fsImpl }), /^Error: AI_SAVE_FAILED$/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(folder), ['ai.local.json']);
}));

test('原子保存：私密临时文件采用 0600 且不覆盖已有临时文件', () => {
  const calls = [];
  const fsImpl = {
    readFileSync() { throw Object.assign(Error(), { code: 'ENOENT' }); },
    writeFileSync(name, data, options) { calls.push({ name, data, options }); },
    renameSync() {}, unlinkSync() {},
  };
  writeAISettings('ai.local.json', configFromKey('fake-private-key', {}), { fsImpl });
  assert.equal(calls[0].options.mode, 0o600); assert.equal(calls[0].options.flag, 'wx');
  assert.match(calls[0].name, /^ai\.local\.json\.tmp-/);
});

test('私密配置：损坏文件可经明确重新填写修复，读取权限错误不覆盖原文件', () => temporary((file) => {
  fs.writeFileSync(file, '{broken'); writeAISettings(file, configFromKey('fake-private-key', {}));
  assert.equal(loadAIConfig({ filePath: file, env: {} }).configured, true);
  const fsImpl = { readFileSync() { throw Object.assign(Error('private-content'), { code: 'EACCES' }); } };
  assert.throws(() => writeAISettings(file, configFromKey('new-private-key', {}), { fsImpl }), /AI_SAVE_FAILED/);
}));

test('中文错误：区分密钥、余额、限流和超时，不输出服务商正文', () => {
  for (const [code, match] of [['AI_HTTP_401', /密钥/], ['AI_HTTP_402', /余额/], ['AI_HTTP_429', /繁忙/], ['AI_TIMEOUT', /超时/], ['AI_NETWORK_ERROR', /网络/]]) {
    const message = connectionError({ code, message: 'RAW_PRIVATE_RESPONSE' });
    assert.match(message, match); assert.doesNotMatch(message, /RAW_PRIVATE/);
  }
});
