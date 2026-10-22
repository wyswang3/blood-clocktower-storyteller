'use strict';

// 规则依据与逐角色审计见 docs/04_暗流涌动规则核对.md。
const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../engine/game');
const { setupFromRoles, buildSetup } = require('../engine/setup');
const { getRole } = require('../engine/roles');
const { publicView, seatView } = require('../engine/state');
const night = require('../engine/night');
const day = require('../engine/day');
const { mulberry32 } = require('../engine/util');

function board(roles = ['imp', 'poisoner', 'monk', 'mayor', 'ravenkeeper', 'empath', 'fortune_teller']) {
  const g = new Game({ seed: 123, playerCount: roles.length });
  g.players.forEach((p, i) => Object.assign(p, { role: roles[i], believed: roles[i], joined: true, name: 'P' + p.seat }));
  g.phase = 'reveal';
  return g;
}
function jump(g, role) {
  assert.ok(g.night, '必须先进入夜晚');
  const index = g.night.steps.findIndex((s) => s.role === role);
  assert.ok(index >= 0, '需要此角色的夜间步骤：' + role);
  g.night.index = index; g.night.pending = null;
  night.advance(g);
  assert.equal(g.night.pending.step, role);
  return g.night.pending;
}
function choose(g, role, targets) {
  const p = jump(g, role);
  assert.equal(g.submitNight(p.seat, { targets }).ok, true);
}
function openDay(g) {
  g.phase = 'night'; g.round = 1; g.night = { deadTonight: [] }; g.dawn();
  return g;
}
function acknowledgeAll(g) {
  let turns = 0;
  while (g.phase === 'night' && ++turns < 60) {
    const p = g.night.pending;
    assert.ok(p);
    if (p.type === 'info') assert.equal(g.submitNight(p.seat, {}).ok, true);
    else g.skipNight();
  }
  assert.ok(turns < 60);
}

test('首夜与其他夜完整顺序匹配已核对的官方公开表快照', () => {
  const reference = require('./fixtures/official-tb-night-order.json');
  assert.deepEqual(night.FIRST_NIGHT, reference.firstNight);
  assert.deepEqual(night.OTHER_NIGHTS, reference.otherNight);
});

test('间谍在夜末看到当晚死亡、守护、主人和首夜配对标记；标记重启后仍在', () => {
  const g = board(['imp', 'spy', 'washerwoman', 'chef', 'empath', 'butler', 'monk']);
  g.demonBluffs = ['soldier', 'saint', 'slayer']; g.beginNight(1);
  jump(g, 'washerwoman'); g.submitNight(3, {});
  assert.ok(g.infoReminders.washerwoman);
  const restored = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert.deepEqual(restored.infoReminders, g.infoReminders);
  const spy = jump(g, 'spy').cards[0];
  assert.ok(spy.rows.some((r) => r.tags.some((t) => t.includes('洗衣妇正确标记'))));
  assert.match(spy.lines.join(' '), /恶魔伪装提示/);
  assert.doesNotMatch(JSON.stringify(seatView(g, 4)), /正确标记|恶魔伪装提示/);
  acknowledgeAll(g); g.endDay(); g.beginNight(2);
  choose(g, 'monk', [4]); choose(g, 'imp', [3]);
  g.submitNight(1, {}); // 继续到后置信息，期间不再改动当晚行动。
  const card = jump(g, 'spy').cards[0];
  assert.ok(card.rows[2].tags.includes('死亡'));
  assert.ok(card.rows[3].tags.includes('僧侣保护'));
});

test('间谍接到传位后不再以旧身份看魔典，也不在同夜再击杀', () => {
  const g = board(['imp', 'spy', 'chef', 'empath', 'monk', 'soldier', 'washerwoman']);
  g.beginNight(2); choose(g, 'imp', [1]); g.submitNight(1, {});
  acknowledgeAll(g);
  assert.equal(g.players[1].role, 'imp'); assert.equal(g.deaths.length, 1);
  assert.equal((g.knowledge[2] || []).some((c) => c.kind === 'grimoire'), false);
});

for (const count of [5, 6]) test(`${count} 人局：不发同伙信息或恶魔伪装提示`, () => {
  const g = board(['imp', 'poisoner', 'chef', 'empath', 'soldier', 'saint'].slice(0, count));
  g.beginNight(1);
  assert.equal(g.night.steps.some((s) => s.role === 'team'), false);
  assert.equal(buildSetup(count, mulberry32(10)).demonBluffs.length, 0);
  acknowledgeAll(g);
  assert.equal(Object.values(g.knowledge).flat().some((c) => c.title === '你的同伙'), false);
});

test('7–15 人两条发牌路径：三个不同善良伪装均未在场，排除酒鬼手持牌', () => {
  for (let count = 7; count <= 15; count++) for (let seed = 1; seed <= 20; seed++) {
    const setup = buildSetup(count, mulberry32(seed));
    for (const s of [setup, setupFromRoles(setup.roles, mulberry32(seed))]) {
      assert.equal(s.demonBluffs.length, 3); assert.equal(new Set(s.demonBluffs).size, 3);
      for (const id of s.demonBluffs) {
        assert.ok(['townsfolk', 'outsider'].includes(getRole(id).type));
        assert.equal(s.roles.includes(id), false); assert.equal(s.believed.includes(id), false);
      }
    }
  }
});

test('阵营信息只给爪牙类别和恶魔座位，只有恶魔拿到三个伪装', () => {
  const g = new Game({ playerCount: 10, seed: 4 });
  const roles = ['imp', 'poisoner', 'spy', 'washerwoman', 'chef', 'empath', 'monk', 'slayer', 'soldier', 'mayor'];
  assert.equal(g.setBoard(roles).ok, true); assert.equal(g.start({ force: true }).ok, true);
  const restored = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert.deepEqual(restored.demonBluffs, g.demonBluffs);
  g.beginNight(1);
  const cards = {};
  for (let i = 0; i < 3; i++) {
    const p = g.night.pending; cards[p.seat] = p.cards;
    assert.equal(g.submitNight(p.seat, {}).ok, true);
  }
  assert.match(JSON.stringify(cards[1]), /不在场/);
  for (const seat of [2, 3]) assert.doesNotMatch(JSON.stringify(cards[seat]), /不在场|投毒者|间谍/);
  assert.doesNotMatch(JSON.stringify(publicView(g)), /不在场|投毒者|间谍/);
  assert.equal(seatView(g, 4).knowledge.length, 0);
});

test('红鲱鱼可以是占卜师本人，选定后不因其死亡或重启而改变', () => {
  const roles = ['fortune_teller', 'chef', 'empath', 'monk', 'soldier', 'poisoner', 'imp'];
  const setup = setupFromRoles(roles, () => 0);
  assert.equal(setup.redHerring, 1);
  const g = board(roles); g.redHerring = 1; g.kill(1);
  const restored = Game.fromJSON(g.toJSON()); assert.equal(restored.redHerring, 1);
  restored.players[0].alive = true; restored.beginNight(2);
  choose(restored, 'fortune_teller', [1, 2]);
  assert.match(restored.night.pending.cards[0].lines.at(-1), /其中有人/);
});

for (const role of ['poisoner', 'monk', 'butler', 'imp', 'fortune_teller', 'ravenkeeper']) {
  test(`${role}：目标允许死者，自选只受角色自己的禁止约束`, () => {
    const g = board(['imp', 'poisoner', 'monk', 'butler', 'fortune_teller', 'ravenkeeper', 'chef']);
    g.kill(7); g.beginNight(2);
    if (role === 'ravenkeeper') { g.kill(6); g.night.deadTonight.push(6); }
    const p = jump(g, role); assert.ok(p.options.some((o) => o.seat === 7));
    assert.equal(p.options.some((o) => o.seat === p.seat), !['monk', 'butler'].includes(role));
    if (['monk', 'butler'].includes(role)) {
      assert.equal(g.submitNight(p.seat, { targets: [p.seat] }).ok, false);
    }
    const targets = role === 'fortune_teller' ? [7, 5] : [7];
    assert.equal(g.submitNight(p.seat, { targets }).ok, true);
  });
}

test('小恶魔攻击死者：不重复死亡，不唤醒旧的守鸦人', () => {
  const g = board(); g.kill(5); g.beginNight(2);
  choose(g, 'imp', [5]);
  assert.deepEqual(g.night.deadTonight, []); assert.equal(g.deaths.length, 1);
  acknowledgeAll(g); assert.equal(g.knowledge[5], undefined);
});

test('僧侣保护小恶魔：阻止自杀及传位，红唇也不接管', () => {
  const g = board(['imp', 'scarlet_woman', 'monk', 'chef', 'empath', 'soldier', 'mayor']);
  g.beginNight(2); choose(g, 'monk', [1]); choose(g, 'imp', [1]);
  assert.equal(g.players[0].alive, true); assert.equal(g.players[1].role, 'scarlet_woman');
  assert.deepEqual(g.night.deadTonight, []);
});

test('自刀时五人以上的健康红唇必须接管，不随机交给其他爪牙', () => {
  const g = board(['imp', 'poisoner', 'scarlet_woman', 'chef', 'empath', 'soldier', 'washerwoman']);
  g.beginNight(2); g.rng = () => 0;
  choose(g, 'imp', [1]);
  assert.equal(g.players[2].role, 'imp'); assert.equal(g.players[1].role, 'poisoner');
  assert.equal(g.players[0].alive, false);
  acknowledgeAll(g); assert.equal(g.deaths.length, 1, '新恶魔同夜不再击杀');
});

test('中毒红唇不强制接管，但仍是合法的小恶魔传位爪牙', () => {
  const g = board(['imp', 'poisoner', 'scarlet_woman', 'chef', 'empath', 'soldier', 'washerwoman']);
  g.beginNight(2); choose(g, 'poisoner', [3]); g.rng = () => 0.99;
  choose(g, 'imp', [1]); assert.equal(g.players[2].role, 'imp'); assert.equal(g.isImpaired(3), true);
});

for (const count of [4, 5]) test(`红唇按死亡前 ${count} 人计数`, () => {
  const g = board(['imp', 'scarlet_woman', 'chef', 'empath', 'soldier', 'monk', 'mayor']);
  openDay(g); for (let s = count + 1; s <= 7; s++) g.kill(s);
  day.execute(g, 1);
  assert.equal(g.players[1].role, count >= 5 ? 'imp' : 'scarlet_woman');
  assert.equal(g.winner, count >= 5 ? null : 'good');
});

test('投毒者夜里死亡，毒在后置信息角色醒来前立即解除', () => {
  const g = board(); g.beginNight(2); choose(g, 'poisoner', [6]);
  assert.equal(g.isImpaired(6), true); choose(g, 'imp', [2]);
  assert.equal(g.poisoned, null); assert.equal(g.isImpaired(6), false);
});

test('投毒者接过自刀传位后旧毒解除', () => {
  const g = board(); g.beginNight(2); choose(g, 'poisoner', [4]); choose(g, 'imp', [1]);
  assert.equal(g.players[1].role, 'imp'); assert.equal(g.poisoned, null);
});

test('毒延续整个白天、黄昏消失；投毒者自选不导致递归或无效请求', () => {
  const g = board(); g.beginNight(1); choose(g, 'poisoner', [2]);
  assert.equal(g.isImpaired(2), true); acknowledgeAll(g); assert.equal(g.isImpaired(2), true);
  g.endDay(); g.beginNight(2); assert.equal(g.poisoned, null);
});

test('僧侣死亡后持续保护立即消失', () => {
  const g = board(); g.beginNight(2); choose(g, 'monk', [6]);
  assert.equal(g.protectedTonight, 6); choose(g, 'imp', [3]); assert.equal(g.protectedTonight, null);
});

for (const rid of ['spy', 'recluse']) test(`${rid}：醉毒禁用误登记，但死后健康时仍可误登记`, () => {
  const g = board(['imp', 'poisoner', 'spy', 'recluse', 'chef', 'empath', 'soldier']);
  const seat = rid === 'spy' ? 3 : 4;
  assert.equal(night.registerEvil(g, seat), rid === 'recluse');
  g.poisoned = seat;
  assert.equal(night.registerEvil(g, seat), rid === 'spy');
  assert.equal(night.registerDemon(g, seat), false);
  assert.equal(night.registerTownsfolk(g, seat), false);
  assert.equal(night.registersAs(g, g.players[seat - 1], rid === 'spy' ? 'townsfolk' : 'minion'), false);
  g.kill(seat); g.poisoned = null;
  assert.equal(night.registerEvil(g, seat), rid === 'recluse');
});

for (const rid of ['spy', 'recluse']) test(`掘墓人和守鸦人：${rid} 允许合法的死后角色登记候选，中毒后只报真实角色`, () => {
  const g = board(['imp', 'poisoner', 'undertaker', 'ravenkeeper', rid, 'chef', 'empath']);
  g.kill(5); g.yesterdayExecution = { seat: 5, role: rid, died: true }; g.round = 2;
  for (const step of ['undertaker', 'ravenkeeper']) {
    const request = { id: 7, seat: step === 'undertaker' ? 3 : 4, step, truth: [], context: { targets: [5] } };
    const pool = night.informationOptions(g, request).slice(1).map((o) => o.cards[0].lines.at(-1));
    assert.ok(pool.some((s) => s.includes(getRole(rid).name)));
    assert.ok(pool.some((s) => !s.includes(getRole(rid).name)));
    g.poisoned = 5;
    assert.ok(night.informationOptions(g, request).slice(1).every((o) => o.cards[0].lines.at(-1).includes(getRole(rid).name)));
    g.poisoned = null;
  }
});

test('洗衣妇是唯一镇民时，可以把自己列为配对的正确目标', () => {
  const g = board(['imp', 'baron', 'washerwoman', 'saint', 'butler']); g.beginNight(1);
  const p = jump(g, 'washerwoman');
  assert.match(p.cards[0].lines[0], /3号/); assert.match(p.cards[0].lines[1], /洗衣妇/);
});

test('图书管理员可以把间谍登记为外来者；健康候选不能出现无合法目标的空卡', () => {
  const g = board(['imp', 'spy', 'librarian', 'chef', 'empath', 'monk', 'soldier']); g.beginNight(1);
  const p = jump(g, 'librarian'); assert.match(p.cards[0].lines[0], /2号/);
  const options = night.informationOptions(g, { id: 1, seat: 3, step: 'librarian', truth: p.cards });
  assert.ok(options.every((o) => !JSON.stringify(o).includes('没有符合条件')));
});

for (const rid of ['washerwoman', 'librarian', 'investigator', 'chef']) test(`${rid}：仅在首夜发信息，第二夜不重复醒来`, () => {
  const g = board(['imp', 'poisoner', rid, 'empath', 'soldier', 'monk', 'butler']);
  assert.ok(night.buildSteps(g, 1).some((s) => s.role === rid));
  assert.equal(night.buildSteps(g, 2).some((s) => s.role === rid), false);
});

test('厨师按圆桌首尾相邻计算成对数量，并受隐士、间谍当时健康状态影响', () => {
  const g = board(['imp', 'poisoner', 'recluse', 'chef', 'empath', 'soldier', 'spy']);
  assert.equal(night.countEvilPairs(g), 2, '三人连续邪恶为两对');
  g.poisoned = 3; assert.equal(night.countEvilPairs(g), 1, '中毒隐士不再误登记');
  g.poisoned = 7; assert.equal(night.countEvilPairs(g), 3, '中毒间谍按真邪恶，包括首尾一对');
});

test('共情者跳过死者读取两侧最近存活邻居，死亡改变结果', () => {
  const g = board(['imp', 'poisoner', 'empath', 'monk', 'soldier', 'chef', 'washerwoman']);
  g.kill(2); g.kill(4); g.beginNight(2);
  assert.deepEqual(night.aliveNeighbours(g, 3).map((p) => p.seat), [1, 5]);
  assert.match(jump(g, 'empath').cards[0].lines[0], /有 1 人/);
  g.players[6].role = 'poisoner'; g.kill(1);
  assert.deepEqual(night.aliveNeighbours(g, 3).map((p) => p.seat), [7, 5]);
  assert.match(jump(g, 'empath').cards[0].lines[0], /有 1 人/);
});

test('占卜师能查到死去的旧小恶魔；中毒隐士不再额外触发恶魔结果', () => {
  const g = board(['imp', 'imp', 'fortune_teller', 'recluse', 'soldier', 'chef', 'empath']);
  g.kill(1); g.beginNight(2); choose(g, 'fortune_teller', [1, 5]);
  assert.match(g.night.pending.cards[0].lines.at(-1), /其中有人/);
  g.poisoned = 4; choose(g, 'fortune_teller', [4, 5]);
  assert.match(g.night.pending.cards[0].lines.at(-1), /其中没有/);
});

test('掘墓人读取因处决死亡的真酒鬼角色，不误报其镇民假身份', () => {
  const g = openDay(board(['imp', 'poisoner', 'undertaker', 'drunk', 'chef', 'monk', 'soldier']));
  g.players[3].believed = 'empath'; day.execute(g, 4); g.endDay(); g.beginNight(2);
  const p = jump(g, 'undertaker'); assert.match(p.cards[0].lines.at(-1), /酒鬼/);
});

test('圣徒中毒被处决不触发落败；夜杀不触发圣徒，男爵死亡不撤回配比', () => {
  const g = openDay(board(['imp', 'poisoner', 'saint', 'chef', 'empath', 'monk', 'soldier']));
  g.poisoned = 3; day.execute(g, 3); assert.equal(g.winner, null);
  const other = board(['imp', 'baron', 'saint', 'chef', 'empath', 'monk', 'soldier']);
  other.baron = true; other.composition = { townsfolk: 3, outsider: 2, minion: 1, demon: 1 };
  other.beginNight(2); choose(other, 'imp', [3]); assert.equal(other.winner, null);
  other.kill(2); assert.equal(other.baron, true); assert.equal(other.composition.outsider, 2);
});

for (const disguise of ['slayer', 'virgin', 'soldier']) test(`酒鬼以为自己是 ${disguise}，不会产生该镇民的真实效果`, () => {
  const g = board(['imp', 'poisoner', 'drunk', 'chef', 'empath', 'monk', 'washerwoman']);
  g.players[2].believed = disguise;
  if (disguise === 'soldier') {
    g.beginNight(2); choose(g, 'imp', [3]); assert.equal(g.players[2].alive, false);
  } else {
    openDay(g);
    if (disguise === 'slayer') {
      assert.equal(g.slayerShoot(3, 1).hit, false); assert.equal(g.players[0].alive, true);
    } else {
      g.beginNominations(); g.nominate(4, 3); assert.equal(g.players[3].alive, true);
    }
  }
});

test('中毒杀手使用仍消耗一次性能力；中毒镇长不能在三人日终获胜', () => {
  const g = openDay(board(['imp', 'slayer', 'mayor', 'chef', 'empath', 'monk', 'poisoner']));
  g.poisoned = 2; assert.equal(g.slayerShoot(2, 1).hit, false); assert.equal(g.slayerUsed, true);
  g.poisoned = null; assert.equal(g.slayerShoot(2, 1).hit, false);
  for (const s of [4, 5, 6, 7]) g.kill(s);
  g.poisoned = 3; g.endDay(); assert.equal(g.winner, null);
});

for (const target of [2, 3, 4, 5]) test(`镇长夜间裁量目标 ${target}：可不转移、可转给守鸦人、士兵或死者`, () => {
  const g = board(['imp', 'mayor', 'ravenkeeper', 'soldier', 'chef', 'empath', 'fortune_teller']);
  g.kill(5); g.beginNight(2); g.rng = () => (target - 0.5) / 7;
  choose(g, 'imp', [2]);
  const expected = target === 2 || target === 3 ? [target] : [];
  assert.deepEqual(g.night.deadTonight, expected);
  if (target === 3) { g.submitNight(1, {}); assert.equal(g.night.pending.step, 'ravenkeeper'); }
});

test('镇长中毒不能转移；受僧侣保护的镇长不触发转移', () => {
  for (const protection of [false, true]) {
    const g = board(); g.beginNight(2); g.rng = () => 0.7;
    if (protection) g.protectedTonight = 4; else g.poisoned = 4;
    choose(g, 'imp', [4]);
    assert.equal(g.players[3].alive, protection); assert.deepEqual(g.night.deadTonight, protection ? [] : [4]);
  }
});

test('夜间死亡未到黎明不向公共、其他手机或选人列表泄露；守鸦人仍私下行动', () => {
  const g = board(); g.beginNight(2); choose(g, 'imp', [5]);
  assert.equal(g.players[4].alive, false);
  for (const s of [1, 5, 6]) {
    const view = seatView(g, s);
    assert.equal(view.pub.seats[4].alive, true);
    assert.equal(seatView(g, 5).me.alive, true);
    assert.equal(view.me.ghostVote, false);
  }
  g.submitNight(1, {}); assert.equal(g.night.pending.step, 'ravenkeeper');
  assert.equal(g.night.pending.options.find((o) => o.seat === 5).alive, true);
  acknowledgeAll(g); assert.equal(publicView(g).seats[4].alive, false);
});

for (const impaired of [false, true]) test(`管家私密约束不根据中毒状态消失（impaired=${impaired}），死主人仍受限制`, () => {
  const g = openDay(board(['imp', 'butler', 'chef', 'empath', 'monk', 'soldier', 'washerwoman']));
  g.butlerMaster = 3; g.kill(3); if (impaired) g.poisoned = 2;
  g.beginNominations(); g.nominate(4, 1);
  assert.match(seatView(g, 2).day.vote.note, /主人死亡后仍须/);
  g.castVote(3, true); assert.equal(seatView(g, 2).day.vote.note, null);
  assert.equal(g.players[2].ghostVoteUsed, true);
});

test('死管家可自由用幽灵票；不会收到管家能力提醒', () => {
  const g = openDay(board(['imp', 'butler', 'chef', 'empath', 'monk', 'soldier', 'washerwoman']));
  g.kill(2); g.butlerMaster = 3; g.beginNominations(); g.nominate(4, 1);
  assert.doesNotMatch(seatView(g, 2).day.vote.note, /你的主人/);
  g.castVote(2, true); g.closeVote(); assert.equal(g.day.lastVote.count, 1);
  assert.equal(g.alerts[2], undefined);
});

test('死者可被提名和处决：不重复死亡、不触发圣徒，阻止镇长无处决胜，掘墓人无死者角色', () => {
  const g = openDay(board(['imp', 'mayor', 'chef', 'saint', 'undertaker', 'monk', 'poisoner']));
  for (const s of [4, 5, 6, 7]) g.kill(s);
  g.beginNominations(); assert.ok(seatView(g, 3).day.targets.some((p) => p.seat === 4));
  assert.equal(g.nominate(3, 4).ok, true);
  g.castVote(1, true); g.castVote(2, true); g.closeVote(); g.endNominations();
  assert.equal(g.day.executed.died, false); assert.equal(g.winner, null);
  assert.equal(g.deaths.length, 4); assert.equal(g.yesterdayExecution.died, false);
  g.players[4].alive = true; g.beginNight(2);
  const p = jump(g, 'undertaker'); assert.match(p.cards[0].lines[0], /没有人因处决死亡/);
});

test('死亡贞洁烈女没有能力；中毒的首次提名仍消耗其机会', () => {
  for (const dead of [false, true]) {
    const g = openDay(board(['imp', 'virgin', 'chef', 'empath', 'monk', 'soldier', 'poisoner']));
    if (dead) g.kill(2); else g.poisoned = 2;
    g.beginNominations(); const r = g.nominate(3, 2);
    assert.equal(r.ok, true); assert.equal(!!r.virgin, false); assert.equal(g.players[2].alive, true);
    if (!dead) assert.equal(g.virginUsed, true);
  }
});

test('杀手可选自己、死者；能力只消费一次，假宣称可重复且界面相同', () => {
  const g = openDay(board(['imp', 'slayer', 'chef', 'empath', 'monk', 'soldier', 'poisoner']));
  g.kill(3);
  assert.equal(g.slayerShoot(2, 3).hit, false); assert.equal(g.slayerUsed, true);
  assert.equal(g.slayerShoot(2, 1).hit, false); assert.equal(g.players[0].alive, true);
  assert.equal(g.slayerShoot(4, 4).ok, true);
  assert.deepEqual(seatView(g, 2).day.slayer, seatView(g, 4).day.slayer);
});

test('杀手可在投票中发动；导致结局时立即清除未完成投票', () => {
  const g = openDay(board(['imp', 'slayer', 'chef', 'empath', 'monk', 'soldier', 'poisoner']));
  g.beginNominations(); g.nominate(3, 4);
  assert.ok(seatView(g, 2).day.slayer);
  assert.equal(g.slayerShoot(2, 1).hit, true); assert.equal(g.phase, 'ended'); assert.equal(g.day.vote, null);
});

test('中毒隐士不被杀手当作恶魔', () => {
  const g = openDay(board(['imp', 'slayer', 'recluse', 'chef', 'empath', 'soldier', 'poisoner']));
  g.poisoned = 3; assert.equal(g.slayerShoot(2, 3).hit, false); assert.equal(g.players[2].alive, true);
});

test('白天死亡不让之前未过门槛的票数事后变成有效处决', () => {
  const g = openDay(board(['imp', 'slayer', 'recluse', 'chef', 'empath', 'soldier', 'poisoner']));
  g.beginNominations(); g.nominate(4, 5);
  for (const s of [1, 2, 4]) g.castVote(s, true);
  g.closeVote(); assert.equal(g.day.nominations[0].threshold, 4);
  assert.equal(g.slayerShoot(2, 3).hit, true); assert.equal(g.aliveCount(), 6);
  g.endNominations(); assert.equal(g.day.executed, null); assert.equal(g.players[4].alive, true);
});

test('夜间剩两人即时结束，不能继续给后置信息；恶魔死优先判好人胜', () => {
  const g = board(['imp', 'chef', 'empath', 'slayer', 'soldier']); g.kill(4); g.kill(5); g.beginNight(2);
  choose(g, 'imp', [2]); assert.equal(g.phase, 'ended'); assert.equal(g.winner, 'evil');
  assert.equal(g.night, null); assert.equal(g.stRequest, null); assert.equal(g.knowledge[3], undefined);
  const good = board(['imp', 'chef', 'empath', 'slayer', 'soldier']);
  good.kill(4); good.kill(5); good.beginNight(2); choose(good, 'imp', [1]);
  assert.equal(good.phase, 'ended'); assert.equal(good.winner, 'good');
});

test('三人局不因人数、票数或阵营比例提前判负；镇长只有日终无处决才赢', () => {
  const g = openDay(board(['imp', 'poisoner', 'mayor', 'chef', 'empath', 'monk', 'soldier']));
  for (const s of [4, 5, 6, 7]) { g.kill(s); g.players[s - 1].ghostVoteUsed = true; }
  assert.equal(day.checkWin(g), null); assert.equal(g.winner, null);
  g.endDay(); assert.equal(g.winReason, 'mayor');
});

test('待裁量信息不能被提前确认，避免越过尚未发放的情报', () => {
  const g = board(['imp', 'poisoner', 'washerwoman', 'chef', 'empath', 'monk', 'soldier']);
  g.infoMode = 'storyteller'; g.storytellerOnline = 1; g.beginNight(1);
  jump(g, 'washerwoman'); const id = g.stRequest.id;
  assert.equal(g.submitNight(3, {}).ok, false); assert.equal(g.stRequest.id, id);
  g.clearInfoTimer();
});

test('角色文案包含镇长转移、死后登记、首夜例外和因处决死亡', () => {
  assert.match(getRole('mayor').brief, /夜间.*代替死亡/);
  for (const role of ['spy', 'recluse']) assert.match(getRole(role).brief, /已经死亡/);
  assert.match(getRole('imp').brief, /第一夜除外/);
  for (const role of ['saint', 'undertaker']) assert.match(getRole(role).brief, /因处决而死亡/);
});
