'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadAIConfig, createDeepSeekClient } = require('../lib/deepseek');
const { createAIStoryteller } = require('../lib/ai-storyteller');
const { Game } = require('../engine/game');
const { publicView, seatView } = require('../engine/state');
const { informationOptions } = require('../engine/night');

const config = () => loadAIConfig({ env: { DEEPSEEK_API_KEY: 'test-private-key' } });
const options = [{ id: 'option-0', cards: [{ title: 'test', lines: ['合法结果'] }] }];
const response = (content, reason = 'stop') => ({ ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: reason, message: { content } }] }) });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeGame() {
  const g = new Game({ seed: 17, playerCount: 7 });
  for (let seat = 1; seat <= 7; seat++) g.claim(seat, null, '玩家' + seat);
  assert.ok(g.setBoard(['washerwoman', 'chef', 'empath', 'monk', 'soldier', 'poisoner', 'imp']).ok);
  assert.ok(g.start().ok);
  return g;
}

function firstRequest(g) {
  g.beginNight(1);
  for (let i = 0; i < 20 && g.night?.pending?.step !== 'washerwoman'; i++) g.skipNight();
  assert.ok(g.stRequest, '洗衣妇情报应等待裁量');
}

test('AI 配置：缺密钥默认关闭，配置状态不自动执行调用', () => {
  const c = loadAIConfig({ env: {} });
  assert.equal(c.configured, false);
  assert.equal(c.enabled, false);
  assert.equal(config().model, 'deepseek-flash');
});

test('AI 配置：拒绝非本机明文地址和带凭据的 URL，限制超时', () => {
  for (const base of ['http://example.com', 'https://key@example.com', 'https://example.com?key=test']) {
    assert.equal(loadAIConfig({ env: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: base } }).configured, false);
  }
  const c = loadAIConfig({ env: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: 'http://127.0.0.1:3899/v1/', AI_TIMEOUT_MS: '999999' } });
  assert.equal(c.configured, true);
  assert.equal(c.baseUrl, 'http://127.0.0.1:3899/v1');
  assert.equal(c.timeoutMs, 12000);
});

test('AI 配置：读取本机文件、兼容 BOM、环境变量优先，坏文件不阻止游戏', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-ai-config-'));
  const filePath = path.join(folder, 'ai.local.json');
  try {
    fs.writeFileSync(filePath, '\uFEFF' + JSON.stringify({ enabled: true, apiKey: 'file-key', model: 'file-model' }));
    const c = loadAIConfig({ filePath, env: { DEEPSEEK_MODEL: 'env-model' } });
    assert.equal(c.apiKey, 'file-key'); assert.equal(c.enabled, true); assert.equal(c.model, 'env-model');
    for (const invalid of ['null', '[]', '{bad']) {
      fs.writeFileSync(filePath, invalid);
      const bad = loadAIConfig({ filePath, env: {} });
      assert.equal(bad.configured, false);
      assert.equal(bad.error, 'AI_CONFIG_INVALID');
    }
  } finally { fs.unlinkSync(filePath); fs.rmdirSync(folder); }
});

test('DeepSeek 请求：正确端点、认证、JSON 格式，只采用白名单结果', async () => {
  let sent;
  const client = createDeepSeekClient(config(), { fetchImpl: async (url, init) => {
    sent = { url, init };
    return response(JSON.stringify({ optionId: 'option-0', reason: '保持线索可追索', cards: [{ title: '任意伪造内容' }] }));
  } });
  const selected = await client.choose({ view: { players: [] }, request: { id: 1 }, options });
  assert.equal(sent.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(sent.init.headers.Authorization, 'Bearer test-private-key');
  const body = JSON.parse(sent.init.body);
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.thinking.type, 'disabled');
  assert.equal(body.stream, false);
  assert.equal(body.messages.length, 2);
  assert.ok(!sent.init.body.includes('test-private-key'));
  assert.deepEqual(selected, { optionId: 'option-0', reason: '保持线索可追索' });
});

for (const [content, finish, code] of [['', 'stop', 'AI_RESPONSE_INVALID'], ['invalid json', 'stop', 'AI_RESPONSE_INVALID'], ['{}', 'length', 'AI_RESPONSE_INVALID'], ['{"optionId":"outside"}', 'stop', 'AI_OPTION_INVALID']]) {
  test(`DeepSeek 返回不合法时拒绝：${content || 'empty'}/${finish}`, async () => {
    const client = createDeepSeekClient(config(), { fetchImpl: async () => response(content, finish) });
    await assert.rejects(client.choose({ options }), { code });
  });
}

test('DeepSeek HTTP 错误不输出服务商正文或密钥', async () => {
  const client = createDeepSeekClient(config(), { fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'test-private-key secret body' }) });
  await assert.rejects(client.choose({ options }), (e) => e.code === 'AI_HTTP_401' && !e.message.includes('private-key'));
});

test('DeepSeek 超时中止请求', async () => {
  const c = { ...config(), timeoutMs: 20 };
  const client = createDeepSeekClient(c, { fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })) });
  await assert.rejects(client.choose({ options }), { code: 'AI_TIMEOUT' });
});

test('DeepSeek 网络失败转换为稳定错误，不暴露底层信息', async () => {
  const client = createDeepSeekClient(config(), { fetchImpl: async () => { throw new Error('private request details'); } });
  await assert.rejects(client.choose({ options }), { code: 'AI_NETWORK_ERROR' });
});

test('AI 控制器：多次广播只调一次，实际情报来自引擎候选，日志保持私密', async () => {
  const g = makeGame();
  let calls = 0;
  const ai = createAIStoryteller({ game: g, configured: true, client: { choose: async ({ options: choices, view }) => {
    calls++;
    assert.ok(view.players.every((p) => !('token' in p)));
    return { optionId: choices.at(-1).id, reason: 'PRIVATE_REASON', cards: [{ title: '模型伪造卡片' }] };
  } } });
  try {
    ai.setEnabled(true); firstRequest(g); g.emit(); g.emit();
    await tick();
    assert.equal(calls, 1);
    assert.equal(g.stRequest, null);
    assert.equal(g.night.pending.awaiting, false);
    assert.ok(!JSON.stringify(g.night.pending.cards).includes('模型伪造卡片'));
    assert.equal(g.aiDecisions.length, 1);
    assert.ok(!JSON.stringify(publicView(g)).includes('PRIVATE_REASON'));
    assert.ok(!JSON.stringify(seatView(g, 2)).includes('PRIVATE_REASON'));
    assert.equal(Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON()))).aiDecisions.length, 1);
  } finally { ai.dispose(); }
});

test('AI 控制器：调用失败立即回退，不让夜晚等待满十五秒', async () => {
  const g = makeGame();
  const ai = createAIStoryteller({ game: g, configured: true, client: { choose: async () => { throw Object.assign(new Error('not public'), { code: 'AI_HTTP_429' }); } } });
  try {
    ai.setEnabled(true); firstRequest(g);
    const truth = g.stRequest.truth;
    await tick();
    assert.deepEqual(g.night.pending.cards, truth);
    assert.equal(g.stRequest, null);
    assert.equal(ai.status().state, 'fallback');
    assert.equal(g.aiDecisions[0].code, 'AI_HTTP_429');
  } finally { ai.dispose(); }
});

test('AI 控制器：没有裁量空间的固定情报不调用模型', async () => {
  const g = makeGame(); let calls = 0;
  const ai = createAIStoryteller({ game: g, configured: true, client: { choose: async ({ options: choices }) => { calls++; return { optionId: choices[0].id }; } } });
  try {
    ai.setEnabled(true); firstRequest(g); await tick();
    assert.equal(calls, 1);
    g.submitNight(1, {}); await tick();
    assert.equal(g.night.pending.step, 'chef');
    assert.equal(g.night.pending.awaiting, false);
    assert.equal(calls, 1);
  } finally { ai.dispose(); }
});

test('AI 控制器：引擎先回退时中止旧调用，不残留“正在准备”状态', async () => {
  const g = makeGame(); let complete; let signal;
  const ai = createAIStoryteller({ game: g, configured: true, client: { choose: (input) => { signal = input.signal; return new Promise((resolve) => { complete = resolve; }); } } });
  try {
    ai.setEnabled(true); firstRequest(g); await tick();
    g.autoStorytellerInfo();
    assert.equal(signal.aborted, true);
    assert.equal(ai.status().state, 'fallback');
    complete({ optionId: 'option-0' }); await tick();
    assert.equal(g.aiDecisions.length, 0);
  } finally { ai.dispose(); }
});

test('AI 控制器：暂停中止请求，迟到结果不能覆盖后续步骤', async () => {
  const g = makeGame();
  let complete;
  let requestSignal;
  const ai = createAIStoryteller({ game: g, configured: true, client: { choose: ({ signal }) => { requestSignal = signal; return new Promise((resolve) => { complete = resolve; }); } } });
  try {
    ai.setEnabled(true); firstRequest(g); await tick();
    const truth = g.stRequest.truth;
    ai.setEnabled(false);
    assert.equal(requestSignal.aborted, true);
    assert.equal(g.infoMode, 'auto');
    assert.deepEqual(g.night.pending.cards, truth);
    complete({ optionId: 'option-999', reason: 'late' }); await tick();
    assert.equal(g.aiDecisions.length, 0);
    assert.deepEqual(g.night.pending.cards, truth);
  } finally { ai.dispose(); }
});

test('AI 控制器：跳过夜间等待立即取消旧请求，迟到卡片不进入下一步', async () => {
  const g = makeGame(); let complete; let signal;
  const ai = createAIStoryteller({ game: g, configured: true, client: { choose: (input) => { signal = input.signal; return new Promise((resolve) => { complete = resolve; }); } } });
  try {
    ai.setEnabled(true); firstRequest(g); await tick();
    const oldId = g.stRequest.id;
    g.skipNight();
    assert.equal(signal.aborted, true);
    complete({ optionId: 'option-0', reason: 'skipped' }); await tick();
    assert.equal(g.night.pending.step, 'chef');
    assert.equal(g.aiDecisions.some((entry) => entry.requestId === oldId), false);
  } finally { ai.dispose(); }
});

test('AI 控制器：切回自动模式立即发回退卡并取消请求', async () => {
  const g = makeGame(); let complete; let signal;
  const ai = createAIStoryteller({ game: g, configured: true, client: { choose: (input) => { signal = input.signal; return new Promise((resolve) => { complete = resolve; }); } } });
  try {
    ai.setEnabled(true); firstRequest(g); await tick();
    const truth = g.stRequest.truth;
    g.setInfoMode('auto');
    assert.equal(signal.aborted, true);
    assert.equal(g.stRequest, null);
    assert.deepEqual(g.night.pending.cards, truth);
    complete({ optionId: 'option-0' }); await tick();
    assert.equal(g.aiDecisions.length, 0);
  } finally { ai.dispose(); }
});

test('AI 控制器：重开后迟到结果不能污染新局，即使请求编号重复', async () => {
  const g = makeGame(); let complete;
  const ai = createAIStoryteller({ game: g, configured: true, client: { choose: () => new Promise((resolve) => { complete = resolve; }) } });
  try {
    ai.setEnabled(true); firstRequest(g); await tick();
    g.reset(7, true); g.emit();
    complete({ optionId: 'option-0', reason: 'old-game' }); await tick();
    assert.equal(g.phase, 'lobby');
    assert.equal(g.aiDecisions.length, 0);
    assert.equal(g.stRequest, null);
  } finally { ai.dispose(); }
});

test('AI 候选：生成不会改变酒鬼的真实身份或镇民假身份', () => {
  const g = makeGame();
  g.players[0].role = 'drunk';
  const before = g.players.map((p) => ({ role: p.role, believed: p.believed }));
  const request = { id: 1, seat: 1, step: 'washerwoman', truth: [{ title: '洗衣妇', lines: ['fallback'] }] };
  assert.ok(informationOptions(g, request).length > 1);
  assert.deepEqual(g.players.map((p) => ({ role: p.role, believed: p.believed })), before);
});

test('AI 控制器：未配置时拒绝启用，不改变自动模式', () => {
  const g = makeGame();
  const ai = createAIStoryteller({ game: g, client: {} });
  assert.equal(ai.setEnabled(true).ok, false);
  assert.equal(g.infoMode, 'auto');
  assert.deepEqual(ai.status(), { configured: false, enabled: false, state: 'unconfigured' });
  ai.dispose();
});
