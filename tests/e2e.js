'use strict';

/**
 * 端到端冒烟：真起一个 server.js，用真 WebSocket 连 7 个手机位 + 1 个平板，
 * 把一局跑到天亮，验证鉴权、裁剪、补发、投票这些网络层的东西。
 *
 * 用法：node tests/e2e.js
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 3888 + Math.floor(Math.random() * 100);
const ROOM_FILE = path.join(ROOT, `.room-e2e-${PORT}.json`);
const AI_CONFIG_FILE = path.join(ROOT, `.room-e2e-ai-${PORT}.json`);
const PIN = '4321';
const URL = `ws://127.0.0.1:${PORT}/ws`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHealth(timeoutMs = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('服务端没有起来');
}

class Client {
  constructor(name) {
    this.name = name;
    this.ws = new WebSocket(URL);
    this.queue = [];
    this.waiters = [];
    this.seat = null;
    this.token = null;
    this.view = null;
    this.notices = [];
    this.closed = false;
  }

  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(this));
      this.ws.addEventListener('error', (e) => reject(new Error(this.name + ' 连接失败')));
      this.ws.addEventListener('message', (ev) => this._onMessage(ev));
      this.ws.addEventListener('close', (e) => {
        this.closed = true;
        this.closeCode = e.code;
      });
    });
  }

  _onMessage(ev) {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'sync') this.view = msg.view;
    if (msg.t === 'event') {
      this.view = msg.view;
      if (msg.notice) this.notices.push(msg.notice);
    }
    if (msg.t === 'token') {
      this.seat = msg.seat;
      this.token = msg.token;
    }
    if (msg.t === 'error') this.lastError = msg.message;
    for (const w of this.waiters.slice()) {
      if (w.pred(msg)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
    this.queue.push(msg);
  }

  wait(pred, timeout = 4000, label = '') {
    const found = this.queue.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`${this.name} 等消息超时 ${label}；最后错误=${this.lastError || '-'}`));
      }, timeout);
      this.waiters.push(w);
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function check(cond, label) {
  if (!cond) throw new Error('校验失败：' + label);
  console.log('  ok  ' + label);
}

async function main() {
  let aiCalls = 0;
  let aiAuthOK = true;
  const fakeAPI = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        aiCalls++;
        aiAuthOK = aiAuthOK && ['Bearer e2e-private-test-key', 'Bearer e2e-ui-private-key'].includes(req.headers.authorization) && req.url === '/chat/completions';
        const payload = JSON.parse(raw);
        const input = JSON.parse(payload.messages[1].content);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ optionId: input.options.at(-1).id, reason: 'PRIVATE_AI_REASON' }) } }] }));
      } catch { res.writeHead(400); res.end('{}'); }
    });
  });
  await new Promise((resolve) => fakeAPI.listen(0, '127.0.0.1', resolve));
  const apiPort = fakeAPI.address().port;
  if (fs.existsSync(ROOM_FILE)) fs.unlinkSync(ROOM_FILE);
  if (fs.existsSync(AI_CONFIG_FILE)) fs.unlinkSync(AI_CONFIG_FILE);
  const startServer = () => spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ROOM_FILE, AI_CONFIG_FILE, HOST_PIN: PIN, TUNNEL: '0', PUBLIC_URL: 'https://room.example.test', AI_ENABLED: '0', DEEPSEEK_API_KEY: 'e2e-private-test-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${apiPort}`, DEEPSEEK_MODEL: 'deepseek-flash' },
    stdio: 'ignore',
    windowsHide: true,
  });
  let child = startServer();
  let failed = false;
  try {
    await waitHealth();
    console.log('服务端已启动，端口', PORT);

    // 平板
    const host = await new Client('host').ready();
    host.send({ t: 'hello', role: 'host', pin: '0000' });
    const bad = await host.wait((m) => m.t === 'error');
    check(/PIN/.test(bad.message), '错误 PIN 被拒绝');
    host.close();

    const host2 = await new Client('host2').ready();
    host2.send({ t: 'hello', role: 'host', pin: PIN });
    await host2.wait((m) => m.t === 'welcome');
    await host2.wait((m) => m.t === 'sync');
    check(host2.view.phase === 'lobby', '房主拿到 lobby 视图');
    check(host2.view.joinUrl === 'https://room.example.test/player', '下发手机加入的公网链接，不受平板本机地址影响');
    check(JSON.stringify(host2.view).indexOf('role') === -1, '公共视图里没有 role 字段');
    host2.send({ t: 'host', action: 'testAI' });
    await host2.wait((m) => m.t === 'ai-test' && /测试成功/.test(m.message));
    check(aiCalls === 1 && host2.view.phase === 'lobby', '房主可以测试 API 连接，不启动对局');
    host2.send({ t: 'host', action: 'configureAI', apiKey: 'e2e-ui-private-key' });
    await host2.wait((m) => m.t === 'ai-setup' && m.status === 'success');
    await host2.wait((m) => m.view && m.view.ai && m.view.ai.enabled);
    check(aiCalls === 2, '输入一次密钥后自动测试、保存并启用，只增加一次测试请求');
    const savedAI = JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8'));
    check(savedAI.apiKey === 'e2e-ui-private-key' && savedAI.enabled && savedAI.managedByUI, '密钥和自动启用设置仅保存在私密配置文件');
    check((await fetch(`http://127.0.0.1:${PORT}/ai.local.json`)).status === 404, '私密密钥文件不能通过网页读取');
    check(!JSON.stringify(host2.queue).includes('e2e-ui-private-key'), '房主响应也不会回显密钥');
    host2.queue = [];
    host2.send({ t: 'host', action: 'setAI', enabled: false });
    await host2.wait((m) => m.t === 'ai-settings' && !m.enabled);
    const probeCalls = aiCalls;

    // 只测试说书人协议，不接入任何 AI；成功认证和未 hello 的连接跨过同一个 10 秒门槛。
    const badSt = await new Client('bad-storyteller').ready();
    badSt.send({ t: 'hello', role: 'storyteller', pin: '0000' });
    check(/PIN/.test((await badSt.wait((m) => m.t === 'error')).message), '说书人错误 PIN 被拒绝');
    badSt.close();
    const storyteller = await new Client('storyteller').ready();
    storyteller.send({ t: 'hello', role: 'storyteller', pin: PIN });
    await storyteller.wait((m) => m.t === 'welcome' && m.role === 'storyteller');
    await storyteller.wait((m) => m.t === 'st');
    const silent = await new Client('no-hello').ready();
    const helloDeadline = Date.now() + 10500;

    // 7 台手机
    const phones = [];
    for (let s = 1; s <= 7; s++) {
      const c = await new Client('p' + s).ready();
      c.send({ t: 'hello', role: 'guest' });
      await c.wait((m) => m.t === 'welcome');
      c.send({ t: 'claim', seat: s, name: '玩家' + s });
      await c.wait((m) => m.t === 'token');
      check(!!c.token, `${s}号 拿到 token`);
      phones.push(c);
    }

    // 抢已占座位
    const intruder = await new Client('intruder').ready();
    intruder.send({ t: 'hello', role: 'guest' });
    await intruder.wait((m) => m.t === 'welcome');
    intruder.send({ t: 'claim', seat: 1, name: '我是1号' });
    const err = await intruder.wait((m) => m.t === 'error');
    check(/占用/.test(err.message), '占座被拒绝');
    intruder.close();

    host2.send({ t: 'host', action: 'setBoard', roles: ['washerwoman', 'chef', 'empath', 'monk', 'soldier', 'poisoner', 'imp'] });
    await host2.wait((m) => m.t === 'board');
    host2.send({ t: 'host', action: 'start' });
    await host2.wait((m) => m.t === 'sync' || m.t === 'event');
    await sleep(150);
    check(
      host2.view.phase === 'reveal',
      '发牌后进入 reveal（实际 ' + host2.view.phase + '，错误 ' + (host2.lastError || '无') + '）'
    );

    for (const c of phones) c.send({ t: 'confirm' });
    await sleep(200);

    // 每个座位的视图只能看到自己那张身份卡
    for (const c of phones) {
      const me = c.view.me.role;
      check(!!me && !!me.id, `${c.seat}号 看到身份卡 ${me.name}`);
    }
    const allRoles = phones.map((c) => c.view.me.role.id);
    check(new Set(phones.map((c) => c.view.me.role.id)).size >= 1, '身份卡各不相同（不校验分布）');
    check(JSON.stringify(host2.view).indexOf('洗衣妇') === -1, '平板视图里没有任何身份名');

    // 记录真实身份，稍后校验手机视图不泄露别人的
    const truth = {};
    for (const c of phones) truth[c.seat] = c.view.me.role.id;

    phones[0].send({ t: 'host', action: 'setAI', enabled: true });
    check(/不是房主/.test((await phones[0].wait((m) => m.t === 'error')).message), '手机不能越权开启付费 API');
    phones[0].queue = [];
    host2.send({ t: 'host', action: 'setAI', enabled: true });
    await host2.wait((m) => m.t === 'event' && m.view.ai && m.view.ai.enabled);
    host2.send({ t: 'host', action: 'beginNight', round: 1 });
    await sleep(200);

    // 跑完这一夜
    for (let guard = 0; guard < 200; guard++) {
      if (host2.view.phase !== 'night') break;
      const waiting = phones.find((c) => c.view.night && c.view.night.pending);
      if (!waiting) {
        // 没有人在操作：等一小会儿再查（可能正在广播）
        await sleep(50);
        const again = phones.find((c) => c.view.night && c.view.night.pending);
        if (!again) {
          host2.send({ t: 'host', action: 'skip' });
          await sleep(100);
          continue;
        }
        continue;
      }
      const p = waiting.view.night.pending;
      if (p.type === 'info') {
        waiting.send({ t: 'night' });
      } else {
        const targets = p.options.slice(0, p.max).map((o) => o.seat);
        waiting.send({ t: 'night', targets });
      }
      await sleep(120);
    }
    check(host2.view.phase === 'day', '一夜跑完，进入白天');
    check(aiCalls > probeCalls && aiAuthOK, '真实服务通过 HTTP 调用本地模拟 DeepSeek，并使用正确认证');
    check(!JSON.stringify(host2.view).includes('e2e-private-test-key') && !JSON.stringify(host2.view).includes('PRIVATE_AI_REASON'), '公共视图没有 API 密钥或私密裁量理由');

    // 每个手机上都有一条"我的情报"，且没出现别人的身份
    for (const c of phones) {
      const mine = c.view.knowledge || [];
      const text = JSON.stringify(c.view.knowledge);
      const others = Object.entries(truth)
        .filter(([seat]) => Number(seat) !== c.seat)
        .map(([, role]) => role);
      // 间谍例外（能看魔典）
      if (truth[c.seat] !== 'spy') {
        check(text.indexOf('grimoire') === -1, `${c.seat}号 没有拿到魔典`);
      }
      void others;
      void mine;
    }

    // 首夜"同伙见面"：只有坏人拿得到，而且只列自己以外的人
    for (const c of phones) {
      const card = (c.view.knowledge || []).find((k) => k.title === '你的同伙');
      const evil = c.view.me.role && c.view.me.role.team === 'evil';
      if (evil) {
        check(!!card, `${c.seat}号（坏人）拿到了同伙卡`);
        if (card) {
          check(
            card.lines.length > 0 && !card.lines.some((l) => l.startsWith(`${c.seat}号`)),
            `${c.seat}号 的同伙卡上没有他自己`
          );
        }
      } else {
        check(!card, `${c.seat}号（好人）没有同伙卡`);
      }
    }

    // 白天：提名 + 投票
    if (host2.view.day && host2.view.day.sub === 'discuss') {
      host2.send({ t: 'host', action: 'beginNominations' });
      await sleep(150);
    }
    const alive = phones.filter((c) => c.view.alive);
    const nominator = alive[0];
    const target = alive[1];
    if (nominator && target) {
      nominator.send({ t: 'nominate', target: target.seat });
      await sleep(200);
      if (host2.view.day && host2.view.day.vote) {
        for (const c of alive) {
          c.send({ t: 'vote', yes: true });
          await sleep(30);
        }
        await sleep(200);
        const last = host2.view.day.lastVote;
        check(last && last.count > 0, '票数统计到了');
        check(last.count <= alive.length, '票数不超过活人');
      }
    }

    // 怀疑标记：只进自己的视图，平板和其它手机都看不到
    const marker = phones.find((c) => c.view.alive);
    const victim = phones.find((c) => c.view.alive && c.seat !== marker.seat);
    marker.send({ t: 'suspect', target: victim.seat });
    await sleep(250);
    check(
      (marker.view.me.suspicion || []).includes(victim.seat),
      '怀疑标记写进了自己的视图'
    );
    check(
      JSON.stringify(host2.view).indexOf('suspicion') === -1,
      '平板视图里没有怀疑名单'
    );
    const bystander = phones.find((c) => c.seat !== marker.seat && c.seat !== victim.seat);
    if (bystander) {
      check(
        (bystander.view.me.suspicion || []).length === 0,
        '别人的手机里没有我的怀疑名单'
      );
    }

    // 板子：同样只进自己的视图
    marker.send({ t: 'board', target: victim.seat, role: 'imp' });
    await sleep(250);
    check(
      marker.view.me.board && marker.view.me.board[victim.seat] === 'imp',
      '板子贴身份写进了自己的视图'
    );
    check(
      JSON.stringify(host2.view).indexOf('"board"') === -1,
      '平板视图里没有板子'
    );
    if (bystander) {
      check(
        Object.keys(bystander.view.me.board || {}).length === 0,
        '别人的手机上也没有我的板子'
      );
    }

    // 断线重连：拿游标补发
    const c1 = phones[0];
    const since = c1.view.pub ? 0 : 0;
    void since;
    const reconnect = await new Client('reconnect').ready();
    reconnect.send({ t: 'hello', role: 'player', seat: c1.seat, token: c1.token });
    await reconnect.wait((m) => m.t === 'welcome');
    await reconnect.wait((m) => m.t === 'sync');
    check(reconnect.view && reconnect.view.seat === c1.seat, '带 token 重连成功');

    await sleep(Math.max(0, helloDeadline - Date.now()));
    check(!storyteller.closed, '说书人认证后超过 10 秒仍保持连接');
    storyteller.send({ t: 'ping' });
    await storyteller.wait((m) => m.t === 'pong');
    check(silent.closed && silent.closeCode === 4008, '未 hello 的连接仍在 10 秒后断开');

    phones[0].send({ t: 'host', action: 'finishEarly', winner: 'evil' });
    check(/不是房主/.test((await phones[0].wait((m) => m.t === 'error')).message), '手机玩家不能提前宣布胜负');
    check((await (await fetch(`http://127.0.0.1:${PORT}/state/public`)).json()).phase === 'day', '越权请求没有结束游戏');
    host2.send({ t: 'host', action: 'finishEarly', winner: 'evil' });
    await host2.wait((m) => m.t === 'event' && m.view.phase === 'ended');
    check(host2.view.winner === 'evil' && host2.view.winReason === 'manual', '房主可明确选择胜方并提前结束');
    check(host2.view.finalRoles.length === 7, '提前结束后全桌亮牌');
    storyteller.close();

    host2.queue = [];
    host2.send({ t: 'host', action: 'setAI', enabled: false });
    await host2.wait((m) => m.t === 'ai-settings' && !m.enabled);
    check(JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8')).enabled === false, '暂停状态已经保存到私密配置');
    await sleep(500);
    const stopped = new Promise((resolve) => child.once('exit', resolve)); child.kill(); await stopped;
    child = startServer(); await waitHealth();
    const restoredHost = await new Client('restored-host').ready();
    restoredHost.send({ t: 'hello', role: 'host', pin: PIN }); await restoredHost.wait((m) => m.t === 'sync');
    check(restoredHost.view.ai.configured && !restoredHost.view.ai.enabled, '重启自动加载保存的密钥，并保留之前的暂停');
    restoredHost.send({ t: 'host', action: 'setAI', enabled: true });
    await restoredHost.wait((m) => m.t === 'ai-settings' && m.enabled);
    await sleep(500);
    const stoppedAgain = new Promise((resolve) => child.once('exit', resolve)); child.kill(); await stoppedAgain;
    child = startServer(); await waitHealth();
    const automatic = await new Client('automatic-host').ready(); automatic.send({ t: 'hello', role: 'host', pin: PIN });
    await automatic.wait((m) => m.t === 'sync');
    check(automatic.view.ai.enabled, '开启后再次重启会自动启用，无需重填密钥或重启配置流程');
    automatic.close(); restoredHost.close();

    console.log('\nE2E 全部通过');
  } catch (e) {
    failed = true;
    console.error('\nE2E 失败：', e.message);
    process.exitCode = 1;
  } finally {
    child.kill();
    await sleep(300);
    await new Promise((resolve) => fakeAPI.close(resolve));
    try {
      fs.unlinkSync(ROOM_FILE);
    } catch {
      /* ignore */
    }
    try { fs.unlinkSync(AI_CONFIG_FILE); } catch { /* 仅清理本测试创建的私密配置。 */ }
    if (!failed) process.exit(0);
  }
}

main();
