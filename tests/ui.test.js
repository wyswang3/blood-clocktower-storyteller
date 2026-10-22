'use strict';

/**
 * 前端渲染测试：不开浏览器，把页面脚本丢进 vm 里跑，
 * 用引擎产出的真实视图喂给渲染函数，检查生成的 HTML。
 *
 * 目的不是"长得对不对"（那要真机看），是"点开会不会白屏、按钮在不在、
 * 渲染出来的 HTML 里有没有混进别人的身份"。
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { loadPage, setRoles, roleChoices } = require('./harness');
const { Game } = require('../engine/game');
const { publicView, seatView } = require('../engine/state');
const { ROLES } = require('../engine/roles');

function playNight(g) {
  for (let i = 0; i < 60; i++) {
    const p = g.night && g.night.pending;
    if (!p) break;
    if (p.type === 'info') g.submitNight(p.seat, {});
    else g.submitNight(p.seat, { targets: p.options.slice(0, p.max).map((o) => o.seat) });
  }
}

function newGame(seed = 12345) {
  const g = new Game({ seed, playerCount: 7 });
  for (let s = 1; s <= 7; s++) g.claim(s, null, '玩家' + s);
  g.start();
  for (let s = 1; s <= 7; s++) g.confirm(s);
  return g;
}

function dayGame(seed) {
  const g = newGame(seed);
  g.beginNight(1);
  playNight(g);
  g.beginNominations();
  g.nominate(2, 5);
  g.castVote(1, true);
  return g;
}

/** 把游戏推到指定阶段，给"每个阶段都有下一步可点"的测试用 */
function viewAt(kind) {
  if (kind === 'lobby') {
    const g = new Game({ seed: 31, playerCount: 7 });
    for (let s = 1; s <= 7; s++) g.claim(s, null, '玩家' + s);
    return { g, pub: publicView(g) };
  }
  const g = newGame(31);
  if (kind === 'reveal') return { g, pub: publicView(g) };
  g.beginNight(1);
  if (kind === 'night') return { g, pub: publicView(g) };
  playNight(g);
  if (kind === 'discuss') return { g, pub: publicView(g) };
  g.beginNominations();
  if (kind === 'nominate') return { g, pub: publicView(g) };
  // 别提名贞洁烈女，不然当场处决、根本没有投票阶段
  const target = g.players.find((p) => p.alive && p.role !== 'virgin' && p.seat !== 1);
  g.nominate(1, target.seat);
  if (kind === 'vote') return { g, pub: publicView(g) };
  if (g.day.vote) {
    for (const p of g.players.filter((x) => x.alive)) {
      if (g.day.vote) g.castVote(p.seat, false);
    }
    if (g.day.vote) g.closeVote();
  }
  g.endNominations();
  return { g, pub: publicView(g) };
}

const ROLE_NAMES = Object.values(ROLES).map((r) => r.name);

test('平板：大厅页渲染出加入地址和全部座位', () => {
  const host = loadPage('public/host.js');
  const g = newGame(1);
  const html = host.lobbyScreen(publicView(g));
  assert.match(html, /192\.168\.1\.5:3000\/player/);
  assert.match(html, /开始游戏/);
  const seats = (html.match(/seat-row/g) || []).length;
  assert.strictEqual(seats, 7, '七个座位都要出现在大厅');
});

test('平板：白天页有棋盘、票数和倒计时', () => {
  const host = loadPage('public/host.js');
  const g = dayGame(2);
  const html = host.dayScreen(publicView(g));
  assert.match(html, /第 1 天/);
  assert.match(html, /投票中/);
  assert.match(html, /2号 提名 5号/);
  assert.match(html, /data-deadline=/);
  const tiles = (html.match(/class="seat[ "]/g) || []).length;
  assert.strictEqual(tiles, 7, '七张座位卡');
});

test('平板：白天页不出现任何人的身份', () => {
  const host = loadPage('public/host.js');
  for (let seed = 1; seed <= 20; seed++) {
    const g = dayGame(seed);
    const html = host.dayScreen(publicView(g));
    for (const name of ROLE_NAMES) {
      assert.ok(!html.includes(name), `seed=${seed} 白天页出现了身份名 ${name}`);
    }
  }
});

test('平板：夜晚页只说天黑了', () => {
  const host = loadPage('public/host.js');
  const g = newGame(3);
  g.beginNight(1);
  const html = host.nightScreen(publicView(g));
  assert.match(html, /天黑了/);
  for (const name of ROLE_NAMES) assert.ok(!html.includes(name), '夜晚页出现了身份名 ' + name);
});

test('平板：结束页亮牌', () => {
  const host = loadPage('public/host.js');
  const g = dayGame(4);
  g.kill(3, 'night');
  g.phase = 'ended';
  g.winner = 'good';
  g.winReason = 'demon-dead';
  const html = host.endScreen(publicView(g));
  assert.match(html, /好人胜利/);
  assert.match(html, /reveal-table/);
  assert.match(html, /tl-row/, '复盘要有时间线');
  assert.match(html, /reveal-thumb/, '复盘要有立绘缩略图');
  assert.match(html, /3号/, '时间线里要有死的人');
  for (const p of g.players) assert.ok(html.includes(ROLES[p.role].name), '结束页应该亮出所有人的身份');
});

test('手机：信息卡渲染 + 确认按钮', () => {
  const player = loadPage('public/player.js');
  const g = newGame(5);
  g.beginNight(1);
  const p = g.night.pending;
  assert.strictEqual(p.type, 'info', '第一夜第一步应该是给情报');
  const v = seatView(g, p.seat);
  const html = player.nightAction(v);
  assert.match(html, /我看到了/);
  assert.match(html, /info-card/);
});

test('手机：选人页渲染出目标和确认按钮', () => {
  const player = loadPage('public/player.js');
  let found = null;
  for (let seed = 1; seed <= 30 && !found; seed++) {
    const g = newGame(seed);
    g.beginNight(1);
    for (let i = 0; i < 20; i++) {
      const p = g.night && g.night.pending;
      if (!p) break;
      if (p.type === 'choose') {
        found = { g, p };
        break;
      }
      g.submitNight(p.seat, {});
    }
  }
  assert.ok(found, '没找到有选人步骤的夜晚');
  const v = seatView(found.g, found.p.seat);
  const html = player.nightAction(v);
  assert.match(html, /确认/);
  assert.match(html, /data-act="pick"/);
  assert.match(html, new RegExp(found.p.prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('手机：白天的提名与投票按钮', () => {
  const player = loadPage('public/player.js');
  const g = dayGame(6);
  const v = seatView(g, 3);
  const html = player.dayBody(v);
  assert.match(html, /投票中/);
  assert.match(html, /同意/);
  assert.match(html, /反对/);
});

test('平板：每个阶段的说书人抽屉里都有对应的下一步', () => {
  const host = loadPage('public/host.js');
  const cases = [
    ['lobby', 'start'],
    ['reveal', 'begin-night'],
    ['night', 'skip'],
    ['discuss', 'begin-nominations'],
    ['nominate', 'end-nominations'],
    ['vote', 'close-vote'],
    ['ended', 'next-night'],
  ];
  for (const [kind, act] of cases) {
    const { pub } = viewAt(kind);
    const html = host.drawer(pub);
    assert.ok(
      html.includes(`data-act="${act}"`),
      `${kind} 阶段抽屉里找不到 ${act}，玩家/房主会卡死`
    );
  }
});

test('平板：白天每个子阶段都能渲染出棋盘，不会白屏', () => {
  const host = loadPage('public/host.js');
  for (const kind of ['discuss', 'nominate', 'vote', 'ended']) {
    const { pub } = viewAt(kind);
    const html = host.dayScreen(pub);
    assert.ok(html.includes('board'), `${kind} 阶段没有棋盘`);
    assert.strictEqual((html.match(/class="seat[ "]/g) || []).length, 7, `${kind} 阶段座位卡不齐`);
  }
});

test('手机：白天投票阶段，没投的人有按钮，投过的人有记录', () => {
  const player = loadPage('public/player.js');
  const { g } = viewAt('vote');
  const voter = g.players.find(
    (p) => p.alive && !g.day.vote.votes.some((v) => v.seat === p.seat)
  );
  const html = player.dayBody(seatView(g, voter.seat));
  assert.match(html, /data-act="vote"/, '没投票的人应该看到按钮');

  g.castVote(voter.seat, true);
  const html2 = player.dayBody(seatView(g, voter.seat));
  assert.match(html2, /你投了/, '投过的人应该看到记录，而不是又一组按钮');
  assert.ok(!/data-act="vote"/.test(html2));
});

test('手机：推理页列出其它座位，自己不进去', () => {
  const player = loadPage('public/player.js');
  const g = newGame(13);
  const v = seatView(g, 1);
  const html = player.noteBody(v);
  assert.strictEqual((html.match(/data-act="board-pick"/g) || []).length, 6, '七个座位去掉自己');
  assert.ok(!/data-seat="1"/.test(html), '推理页上不该有自己');
  assert.match(html, /未知/);
  assert.match(html, /别人手机上看不到/);
  assert.match(html, /不改变任何规则判定/);
});

test('手机：白天有怀疑标记，且默认是空的', () => {
  const player = loadPage('public/player.js');
  const g = dayGame(12);
  const v = seatView(g, 3);
  const html = player.dayBody(v);
  assert.match(html, /data-act="suspect"/);
  assert.match(html, /只有你看得到/);
  assert.ok(!/<button class="sus on"/.test(html), '一开始不该有标记');
  g.toggleSuspicion(3, 5);
  const html2 = player.dayBody(seatView(g, 3));
  assert.match(html2, /class="sus on" data-act="suspect" data-seat="5"/);
});

test('手机：身份卡就是自己的身份，且不含别人的', () => {
  const player = loadPage('public/player.js');
  const g = dayGame(7);
  for (let seat = 1; seat <= 7; seat++) {
    const v = seatView(g, seat);
    const html = player.roleCardHtml(v.me.role);
    assert.ok(html.includes(v.me.role.name), '身份卡上要有自己的身份');
    const others = g.players.filter((p) => p.seat !== seat).map((p) => ROLES[p.role].name);
    for (const name of others) {
      // 自己的身份卡里出现别人的身份名 = 泄漏（同名角色不会重复，所以直接判）
      if (name === v.me.role.name) continue;
      assert.ok(!html.includes(name), `座位 ${seat} 的身份卡里出现了别人身份 ${name}`);
    }
  }
});

test('手机：加入页列出座位、已占的置灰', () => {
  const player = loadPage('public/player.js');
  const g = newGame(8);
  g.releaseSeat(3);
  const html = player.joinGrid(publicView(g));
  assert.strictEqual((html.match(/join-seat/g) || []).length, 7);
  assert.match(html, /disabled/);
  assert.match(html, /data-act="claim" data-seat="3"/);
});

test('手机：已经拿到座位视图时不会把加入页画回来', () => {
  const player = loadPage('public/player.js');
  const g = newGame(9);
  assert.doesNotThrow(() => player.renderGuest(seatView(g, 1)));
  assert.doesNotThrow(() => player.renderGuest(publicView(g)));
});

test('手机：身份卡默认盖住，按住才显示', () => {
  const player = loadPage('public/player.js');
  const g = newGame(10);
  const card = player.roleCardHtml(seatView(g, 1).me.role);
  assert.match(card, /hold-wrap/);
  assert.match(card, /hold-cover/);
  assert.match(card, /\/art\/roles\//, '身份卡要带立绘');
  const open = player.roleCardHtml(seatView(g, 1).me.role, { masked: false });
  assert.ok(!open.includes('hold-cover'));
});

test('手机关：情报页能把魔典渲染成表格', () => {
  const player = loadPage('public/player.js');
  const html = player.cardBody({
    kind: 'grimoire',
    title: '魔典',
    rows: [{ seat: 1, name: '甲', role: '洗衣妇', tags: ['中毒'] }],
  });
  assert.match(html, /<table class="grimoire">/);
  assert.match(html, /洗衣妇/);
  assert.match(html, /中毒/);
});

test('手机：白天每个人都看得到公开开枪入口', () => {
  const player = loadPage('public/player.js');
  const { g } = viewAt('nominate');
  for (let seat = 1; seat <= 7; seat++) {
    const html = player.dayBody(seatView(g, seat));
    assert.match(html, /公开开枪/, `座位 ${seat} 没有开枪入口`);
    assert.match(html, /data-act="slayer"/, `座位 ${seat} 没有开枪按钮`);
  }
});

test('手机：死者可被提名且标记已死亡；使用过杀手能力后仍保留相同宣称入口', () => {
  const player = loadPage('public/player.js');
  const g = newGame(12); g.beginNight(1); playNight(g);
  const actor = g.players.find((p) => p.role !== 'virgin');
  const target = g.players.find((p) => p.seat !== actor.seat);
  g.kill(target.seat); g.beginNominations(); g.slayerShots[actor.seat] = true;
  const html = player.dayBody(seatView(g, actor.seat));
  assert.match(html, new RegExp('data-act="nominate" data-seat="' + target.seat + '"'));
  assert.match(html, /已死亡/);
  assert.match(html, /公开开枪/);
});

test('手机：管家投票提醒不随中毒泄露能力失效，也不公开作废其票', () => {
  const player = loadPage('public/player.js');
  const { g } = viewAt('nominate');
  g.players[1].role = 'butler'; g.players[1].believed = 'butler'; g.butlerMaster = 3;
  g.kill(3); g.poisoned = 2;
  const nominee = g.players.find((p) => p.seat !== 1 && p.role !== 'virgin');
  g.nominate(1, nominee.seat);
  const html = player.dayBody(seatView(g, 2));
  assert.match(html, /主人死亡后仍须/); assert.doesNotMatch(html, /你的.*票.*不算/);
});

test('手机：情报页有提名与票型', () => {
  const player = loadPage('public/player.js');
  const g = newGame(21);
  g.beginNight(1);
  playNight(g);
  g.beginNominations();
  const target = g.players.find((p) => p.alive && p.role !== 'virgin' && p.seat !== 2);
  g.nominate(2, target.seat);
  g.castVote(1, true);
  g.closeVote();
  const v = seatView(g, 1);
  const html = player.infoBody(v);
  assert.match(html, /提名与票型/);
  assert.match(html, new RegExp(`2号 提名 ${target.seat}号`));
  assert.match(html, /同意 1/);
});

test('手机：死人有一张幽灵票，投完按钮消失', () => {
  const player = loadPage('public/player.js');
  const g = newGame(22);
  g.beginNight(1);
  playNight(g);
  g.kill(4, 'night');
  g.beginNominations();
  g.nominate(2, 3);
  const dead = seatView(g, 4);
  const html = player.dayBody(dead);
  assert.match(html, /幽灵票/, '死亡横幅要说明还有幽灵票');
  assert.match(html, /data-act="vote"/, '死人应该能投幽灵票');
  assert.ok(g.castVote(4, true).ok);
  const html2 = player.dayBody(seatView(g, 4));
  assert.match(html2, /幽灵票已经用掉了/);
  assert.ok(!/data-act="vote"/.test(html2), '投完就不能再投');
});

test('平板：大厅有复制和分享链接', () => {
  const host = loadPage('public/host.js');
  const { g } = viewAt('lobby');
  const html = host.lobbyScreen(publicView(g));
  assert.match(html, /data-act="copy"/);
  assert.match(html, /data-act="share"/);
  assert.match(html, /\/player/);
});

test('手机：死者反对后显示幽灵票保留，下一轮仍能投', () => {
  const player = loadPage('public/player.js');
  const g = newGame(22);
  g.beginNight(1); playNight(g); g.kill(4, 'night');
  g.beginNominations(); g.nominate(2, 3);
  assert.ok(g.castVote(4, false).ok);
  const html = player.dayBody(seatView(g, 4));
  assert.match(html, /幽灵票保留/);
  assert.ok(!/幽灵票已用|幽灵票已经用掉了/.test(html));
  assert.ok(!/data-act="vote"/.test(html), '本轮已回应，不能重复投');
  g.closeVote(); g.nominate(1, 2);
  assert.match(player.dayBody(seatView(g, 4)), /data-act="vote"/, '下一轮可以使用保留的票');
});

test('平板：仅在白天或夜间提供手动提前结束入口', () => {
  const host = loadPage('public/host.js');
  for (const phase of ['lobby', 'reveal', 'night', 'discuss']) {
    const { pub } = viewAt(phase);
    assert.strictEqual(/data-act="finish-early"/.test(host.drawer(pub)), phase === 'night' || phase === 'discuss');
  }
});

test('平板：提前结束需有效胜方和二次确认，取消或输错不发送操作', async () => {
  for (const [answer, confirm, winner] of [[null, true, null], ['乱填', true, null], ['好人', false, null], ['好人', true, 'good'], ['坏人', true, 'evil']]) {
    const host = loadPage('public/host.js');
    const app = vm.runInContext('App', host);
    const sent = [];
    let confirmations = 0;
    app.ask = async () => answer;
    app.confirm = async () => { confirmations++; return confirm; };
    app.raw = (msg) => { sent.push(msg); return true; };
    app.toast = () => {};
    const click = host.document.getElementById('app').listeners.click[0];
    await click({ target: { closest: () => ({ getAttribute: () => 'finish-early' }) } });
    assert.strictEqual(confirmations, answer === '好人' || answer === '坏人' ? 1 : 0);
    assert.strictEqual(sent.length, winner ? 1 : 0);
    if (winner) assert.deepStrictEqual(JSON.parse(JSON.stringify(sent[0])), { t: 'host', action: 'finishEarly', winner });
  }
});

test('平板：从本机打开也显示可跨网络分享的房间链接', () => {
  const host = loadPage('public/host.js');
  host.location.origin = 'http://127.0.0.1:3000';
  const { pub } = viewAt('lobby');
  pub.joinUrl = 'https://room.example.test/player';
  assert.strictEqual(host.playerLink(pub), pub.joinUrl);
  const html = host.lobbyScreen(pub);
  assert.match(html, /https:\/\/room\.example\.test\/player/);
  assert.ok(!html.includes('127.0.0.1'));
});

test('平板：地址尚未就绪时不分享 localhost，局域网地址仍可分享', () => {
  const host = loadPage('public/host.js');
  host.location.origin = 'http://127.0.0.1:3000';
  assert.strictEqual(host.playerLink({ joinUrl: null }), '');
  assert.strictEqual(host.playerLink({ joinUrl: 'http://192.168.1.8:3000/player' }), 'http://192.168.1.8:3000/player');
});

test('平板：AI 未配置时禁用开关，已启用时可暂停，回退状态有说明', () => {
  const host = loadPage('public/host.js');
  const { pub } = viewAt('lobby');
  pub.ai = { configured: false, enabled: false, state: 'unconfigured' };
  assert.match(host.drawer(pub), /data-act="toggle-ai" disabled/);
  assert.match(host.drawer(pub), /data-act="test-ai" disabled/);
  pub.ai = { configured: true, enabled: true, state: 'fallback' };
  const html = host.drawer(pub);
  assert.match(html, /暂停 AI/);
  assert.match(html, /已自动发情报/);
  assert.ok(!/data-act="toggle-ai" disabled/.test(html));
  assert.match(html, /测试连接（1 次调用）/);
});

test('平板：AI 开关只发送启用状态，不经网页传密钥', async () => {
  const host = loadPage('public/host.js');
  const app = vm.runInContext('App', host);
  vm.runInContext('H.view = { ai: { configured: true, enabled: false } }', host);
  const messages = [];
  app.raw = (msg) => { messages.push(msg); return true; };
  const click = host.document.getElementById('app').listeners.click[0];
  await click({ target: { closest: () => ({ getAttribute: () => 'toggle-ai' }) } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(messages)), [{ t: 'host', action: 'setAI', enabled: true }]);
});

test('平板：大厅直接提供连接按钮，不连接 AI 也能开局', () => {
  const host = loadPage('public/host.js'); const { pub } = viewAt('lobby');
  pub.ai = { configured: false, enabled: false };
  const html = host.lobbyScreen(pub);
  assert.match(html, /data-act="setup-ai"/); assert.match(html, /连接 DeepSeek/);
  assert.match(html, /不连接也能开始游戏/); assert.match(html, /data-act="start"/);
  assert.doesNotMatch(html, /api\.deepseek\.com|deepseek-flash|apiKey/);
});

test('平板：只在明确确认后提交密钥，不存到浏览器、不发送端点或模型', async () => {
  for (const key of [null, 'https://example.test', 'fake-private-key']) {
    const host = loadPage('public/host.js'); const app = vm.runInContext('App', host); const { pub } = viewAt('lobby');
    vm.runInContext('H.view = ' + JSON.stringify(pub) + '; H.aiSetupAllowed = true;', host);
    const sent = []; let stored = 0; let options;
    app.ask = async (_title, opts) => { options = opts; return key; };
    app.raw = (m) => { sent.push(m); return true; }; app.store.set = () => stored++; app.toast = () => {};
    await host.document.getElementById('app').listeners.click[0]({ target: { closest: () => ({ getAttribute: () => 'setup-ai' }) } });
    assert.equal(options.secret, true); assert.equal(options.okLabel, '保存并连接'); assert.match(options.text, /计费/);
    assert.equal(stored, 0); assert.equal(sent.length, key === 'fake-private-key' ? 1 : 0);
    if (sent.length) assert.deepStrictEqual(JSON.parse(JSON.stringify(sent[0])), { t: 'host', action: 'configureAI', apiKey: key });
    assert.ok(!JSON.stringify(vm.runInContext('H', host)).includes('fake-private-key'));
  }
});

test('平板：密钥输入是密码框，确认后清空并移除输入控件', async () => {
  const host = loadPage('public/host.js'); const app = vm.runInContext('App', host);
  const input = { value: '', focus() {}, select() {} }; let html = '', removed = false; const listeners = {};
  const mask = { set innerHTML(value) { html = value; }, querySelector: () => input, addEventListener: (type, fn) => { listeners[type] = fn; }, remove: () => { removed = true; } };
  host.document.createElement = () => mask; host.document.body.appendChild = () => {};
  const result = app.ask('连接 DeepSeek', { secret: true, maxlength: 512 });
  assert.match(html, /type="password"/); assert.match(html, /autocomplete="off"/);
  input.value = 'fake-private-key'; listeners.keydown({ key: 'Enter' });
  assert.equal(await result, 'fake-private-key'); assert.equal(input.value, ''); assert.equal(removed, true);
  assert.doesNotMatch(html, /fake-private-key/);
});

test('平板：不安全页面不打开密钥框；断线发送失败可以重新尝试', async () => {
  const host = loadPage('public/host.js'); const app = vm.runInContext('App', host); const { pub } = viewAt('lobby');
  vm.runInContext('H.view = ' + JSON.stringify(pub), host);
  let asked = 0, alerted = 0;
  app.alert = async () => alerted++; app.ask = async () => { asked++; return 'fake-private-key'; }; app.raw = () => false;
  const click = host.document.getElementById('app').listeners.click[0]; const event = { target: { closest: () => ({ getAttribute: () => 'setup-ai' }) } };
  await click(event); assert.equal(asked, 0); assert.equal(alerted, 1);
  vm.runInContext('H.aiSetupAllowed = true', host); await click(event);
  assert.equal(vm.runInContext('H.aiSetupBusy', host), false); assert.match(vm.runInContext('H.aiSetupMessage', host), /断开/);
});

test('平板：连接中的重复点击被阻止；重连状态可恢复，服务端消息以文本显示', async () => {
  const host = loadPage('public/host.js'); const app = vm.runInContext('App', host); const { pub } = viewAt('lobby');
  vm.runInContext('H.view = ' + JSON.stringify(pub), host);
  app.start = (opts) => Object.assign(app, opts); host.connectHost();
  app.incoming(JSON.stringify({ t: 'ai-setup', status: 'working', allowed: true, message: '正在连接' }));
  assert.equal(vm.runInContext('H.aiSetupBusy', host), true);
  app.ask = async () => { throw Error('重复点击不应再次打开输入框'); };
  await host.document.getElementById('app').listeners.click[0]({ target: { closest: () => ({ getAttribute: () => 'setup-ai' }) } });
  app.incoming(JSON.stringify({ t: 'ai-setup', status: 'success', allowed: true, message: '<script>unsafe</script>' }));
  assert.equal(vm.runInContext('H.aiSetupBusy', host), false);
  assert.match(host.lobbyScreen(pub), /&lt;script&gt;/); assert.doesNotMatch(host.lobbyScreen(pub), /<script>unsafe/);
});
