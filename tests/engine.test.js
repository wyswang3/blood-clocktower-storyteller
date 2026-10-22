'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Game } = require('../engine/game');
const { buildSetup, setupFromRoles, composition, allCompositions } = require('../engine/setup');
const { ROLES, getRole, idsByType } = require('../engine/roles');
const { FIRST_NIGHT, OTHER_NIGHTS, advance } = require('../engine/night');
const nightMod = require('../engine/night');
const { seatView, publicView, storytellerView } = require('../engine/state');
const dayMod = require('../engine/day');

/* ------------------------------ 工具 ------------------------------ */

test('酒鬼假身份：5–15 人随机和指定板子都只能给未在场镇民，永不给外来者', () => {
  let randomDrunks = 0;
  for (let count = 5; count <= 15; count++) {
    const comp = composition(count, true);
    const roles = [
      ...idsByType('townsfolk').slice(0, comp.townsfolk),
      'drunk', ...idsByType('outsider').filter((id) => id !== 'drunk').slice(0, comp.outsider - 1),
      'baron', ...idsByType('minion').filter((id) => id !== 'baron').slice(0, comp.minion - 1), 'imp',
    ];
    for (let seed = 1; seed <= 100; seed++) {
      const rng = () => require('../engine/util').mulberry32(seed * 17 + count);
      for (const setup of [buildSetup(count, rng(), { baron: true }), setupFromRoles(roles, rng())]) {
        const seat = setup.roles.indexOf('drunk');
        if (seat < 0) continue;
        randomDrunks++;
        const disguise = setup.believed[seat];
        assert.strictEqual(getRole(disguise).type, 'townsfolk', `${count}人/seed${seed}`);
        assert.ok(!setup.roles.includes(disguise));
        assert.ok(!idsByType('outsider').includes(disguise));
      }
    }
  }
  assert.ok(randomDrunks > 1100, '同时覆盖了指定板子和确实抽到酒鬼的随机发牌');
});

/** 直接指定身份开局，跳过随机发牌，方便造场景。 */
function gameWithRoles(roles) {
  const g = new Game({ seed: 1, playerCount: roles.length });
  for (let s = 1; s <= roles.length; s++) g.claim(s, null, 'P' + s);
  g.players.forEach((p, i) => {
    p.role = roles[i];
    p.believed = roles[i];
    p.alive = true;
    p.joined = true;
  });
  g.phase = 'reveal';
  return g;
}

/** 提交当前等待项，并把随后那张"已记录"也确认掉。 */
function act(g, targets) {
  const p = g.night.pending;
  assert.ok(p, '现在没有等待项');
  const r = g.submitNight(p.seat, targets ? { targets } : {});
  assert.ok(r.ok, '提交失败: ' + (r.error || ''));
  if (
    g.night &&
    g.night.pending &&
    g.night.pending.type === 'info' &&
    g.night.pending.seat === p.seat
  ) {
    const r2 = g.submitNight(p.seat, {});
    assert.ok(r2.ok, '确认失败: ' + (r2.error || ''));
  }
}

/** 走到指定角色的步骤（把前面的步骤随便点掉）。 */
function advanceTo(g, role) {
  for (let i = 0; i < 40; i++) {
    const p = g.phase === 'night' && g.night && g.night.pending;
    if (!p) return null;
    if (p.step === role) return p;
    if (p.type === 'choose') act(g, p.options.slice(0, p.max).map((o) => o.seat));
    else act(g);
  }
  return null;
}

/* ------------------------------ 配比与发牌 ------------------------------ */

test('配比表：标准人数与男爵改写', () => {
  assert.deepStrictEqual(composition(7, false), { townsfolk: 5, outsider: 0, minion: 1, demon: 1 });
  assert.deepStrictEqual(composition(7, true), { townsfolk: 3, outsider: 2, minion: 1, demon: 1 });
  assert.deepStrictEqual(composition(5, false), { townsfolk: 3, outsider: 0, minion: 1, demon: 1 });
  assert.deepStrictEqual(composition(5, true), { townsfolk: 1, outsider: 2, minion: 1, demon: 1 });
  assert.deepStrictEqual(composition(15, false), { townsfolk: 9, outsider: 2, minion: 3, demon: 1 });
});

test('配比表：每个人数加起来都对，且不超角色池', () => {
  const pool = {
    townsfolk: idsByType('townsfolk').length,
    outsider: idsByType('outsider').length,
    minion: idsByType('minion').length,
  };
  for (const row of allCompositions()) {
    for (const key of ['normal', 'baron']) {
      const c = row[key];
      assert.strictEqual(c.townsfolk + c.outsider + c.minion + c.demon, row.players, `${row.players}/${key}`);
      assert.ok(c.townsfolk >= 1 && c.townsfolk <= pool.townsfolk, '镇民数量不合法');
      assert.ok(c.outsider <= pool.outsider, '外来者不够');
      assert.ok(c.minion <= pool.minion, '爪牙不够');
    }
  }
});

test('发牌：200 局随机，身份不重复、数量对、红鲱鱼合法、酒鬼假身份合法', () => {
  for (let i = 0; i < 200; i++) {
    const n = 5 + (i % 11);
    const seed = 1000 + i * 13;
    const s = buildSetup(n, require('../engine/util').mulberry32(seed), {});
    assert.strictEqual(s.roles.length, n);

    const byType = { townsfolk: 0, outsider: 0, minion: 0, demon: 0 };
    for (const r of s.roles) byType[getRole(r).type]++;
    assert.deepStrictEqual(
      { townsfolk: byType.townsfolk, outsider: byType.outsider, minion: byType.minion, demon: byType.demon },
      s.comp,
      `seed=${seed} 数量对不上`
    );

    assert.strictEqual(new Set(s.roles).size, n, `seed=${seed} 出现重复身份`);
    assert.strictEqual(byType.demon, 1);

    const drunkSeat = s.roles.indexOf('drunk');
    if (drunkSeat >= 0) {
      const fake = s.believed[drunkSeat];
      assert.strictEqual(getRole(fake).type, 'townsfolk', '酒鬼以为自己是个镇民');
      assert.ok(!s.roles.includes(fake), '酒鬼的假身份不能是真身份之一');
    } else {
      assert.deepStrictEqual(s.believed, s.roles);
    }

    if (s.redHerring != null) {
      const r = s.roles[s.redHerring - 1];
      const t = getRole(r).type;
      assert.ok(t === 'townsfolk' || t === 'outsider', '红鲱鱼必须是好人');
    }
  }
});

/* ------------------------------ 夜序 ------------------------------ */

test('夜序表：第一夜没有恶魔、僧侣、掘墓人、守鸦人', () => {
  assert.ok(!FIRST_NIGHT.includes('imp'));
  assert.ok(!FIRST_NIGHT.includes('monk'));
  assert.ok(!FIRST_NIGHT.includes('undertaker'));
  assert.ok(!FIRST_NIGHT.includes('ravenkeeper'));
  assert.ok(FIRST_NIGHT.includes('poisoner'));
  assert.ok(FIRST_NIGHT.includes('butler'));
});

test('夜序表：其他夜有恶魔和僧侣，投毒者永远第一个', () => {
  assert.strictEqual(OTHER_NIGHTS[0], 'poisoner');
  assert.ok(OTHER_NIGHTS.includes('imp'));
  assert.ok(OTHER_NIGHTS.includes('monk'));
  assert.ok(OTHER_NIGHTS.indexOf('monk') < OTHER_NIGHTS.indexOf('imp'), '僧侣要在恶魔之前');
});

test('夜序：只叫醒在场且活着的角色，顺序与官方表一致', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'washerwoman', 'chef', 'empath', 'butler', 'spy']);
  g.beginNight(1);
  // 前面是"同伙见面"，属于规则信息，不在官方夜序表里
  const steps = g.night.steps.filter((s) => s.info !== 'team').map((s) => s.role);
  assert.deepStrictEqual(steps, ['poisoner', 'washerwoman', 'chef', 'empath', 'butler', 'spy']);
});

test('首夜：坏人互相见面，好人拿不到这张卡', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.beginNight(1);

  // 爪牙先醒（官方流程表 Minion Info 在前），看到恶魔
  assert.strictEqual(g.night.pending.seat, 2);
  assert.strictEqual(g.night.pending.type, 'info');
  act(g);
  let card = g.knowledge[2].pop();
  assert.strictEqual(card.title, '你的同伙');
  assert.match(card.lines.join(' '), /1号.*恶魔/);

  // 然后恶魔醒，看到爪牙
  assert.strictEqual(g.night.pending.seat, 1);
  act(g);
  card = g.knowledge[1].pop();
  assert.match(card.lines.join(' '), /2号.*爪牙/);
  assert.ok(!card.lines.join(' ').includes('投毒者'), '阵营信息不告知爪牙具体角色');

  // 好人没有这张卡
  assert.ok(!g.knowledge[3], '好人第一夜不该有同伙卡');
  const pub = JSON.stringify(publicView(g));
  assert.strictEqual(pub.indexOf('同伙'), -1, '公共视图不能出现同伙');
});

test('夜序：其他夜完整顺序（9 个全角色）', () => {
  const g = gameWithRoles([
    'imp', 'poisoner', 'monk', 'spy', 'scarlet_woman',
    'ravenkeeper', 'undertaker', 'empath', 'fortune_teller',
  ]);
  g.beginNight(2);
  const steps = g.night.steps.map((s) => s.role);
  assert.deepStrictEqual(steps, [
    'poisoner', 'monk', 'scarlet_woman', 'imp',
    'ravenkeeper', 'empath', 'fortune_teller', 'undertaker', 'spy',
  ]);
});

test('夜序：不能动的先后关系', () => {
  assert.strictEqual(OTHER_NIGHTS[0], 'poisoner', '投毒者永远第一个');
  assert.ok(OTHER_NIGHTS.indexOf('monk') < OTHER_NIGHTS.indexOf('imp'), '僧侣要赶在恶魔之前');
  assert.ok(OTHER_NIGHTS.indexOf('spy') > OTHER_NIGHTS.indexOf('poisoner'), '间谍要看得到毒');
  assert.ok(OTHER_NIGHTS.indexOf('spy') > OTHER_NIGHTS.indexOf('imp'), '当前官方公开表中间谍能看见当晚死亡');
  for (const r of ['ravenkeeper', 'undertaker', 'empath', 'fortune_teller', 'butler']) {
    assert.ok(OTHER_NIGHTS.indexOf(r) > OTHER_NIGHTS.indexOf('imp'), `${r} 要在恶魔之后`);
  }
  assert.ok(FIRST_NIGHT.indexOf('spy') > FIRST_NIGHT.indexOf('poisoner'));
  assert.ok(!FIRST_NIGHT.includes('imp'), '小恶魔第一夜不发动击杀');
});

test('夜序：间谍在投毒者之后睁眼，魔典上看得到毒', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'spy', 'empath', 'butler', 'soldier', 'chef']);
  g.beginNight(1);
  const ps = advanceTo(g, 'poisoner');
  assert.ok(ps, '先到投毒者');
  act(g, [4]);

  const spyStep = advanceTo(g, 'spy');
  assert.ok(spyStep, '再到间谍');
  act(g); // 确认魔典

  const card = (g.knowledge[3] || []).find((c) => c.kind === 'grimoire');
  assert.ok(card, '间谍应该拿到魔典');
  const row = card.rows.find((r) => r.seat === 4);
  assert.ok(row.tags.includes('中毒'), '魔典上要看得到刚才下的毒');
});

test('首夜：同伙卡会进自己的情报页，重新看得到', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.beginNight(1);
  act(g); // 爪牙
  act(g); // 恶魔
  const v = seatView(g, 1);
  assert.ok(v.knowledge.some((c) => c.title === '你的同伙'), '情报页里要留着');
  assert.ok(!seatView(g, 3).knowledge.some((c) => c.title === '你的同伙'));
});

test('夜序：死人不会被叫醒（守鸦人除外）', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'washerwoman', 'chef', 'empath', 'butler', 'spy']);
  g.players[2].alive = false; // 洗衣妇死了
  g.beginNight(1);
  const steps = g.night.steps.map((s) => s.role);
  assert.ok(!steps.includes('washerwoman'));
});

test('酒鬼：按假身份的步骤被叫醒，但能力不生效', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'drunk', 'butler', 'chef', 'empath', 'spy']);
  g.players[2].believed = 'monk'; // 酒鬼以为自己是个僧侣
  g.beginNight(2);
  const p = advanceTo(g, 'monk');
  assert.ok(p, '酒鬼应该按僧侣的步骤醒');
  assert.strictEqual(p.seat, 3);
  const before = g.protectedTonight;
  act(g, [1]);
  assert.strictEqual(g.protectedTonight, before, '酒鬼的守护不能生效');
  assert.ok(g.isImpaired(3));
});

/* ------------------------------ 夜间结算 ------------------------------ */

test('投毒：僧侣被毒，守护失效，目标照死', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.beginNight(2);
  // 第一夜不杀人，第二夜：投毒者先动，毒僧侣
  const ps = advanceTo(g, 'poisoner');
  act(g, [3]);
  assert.strictEqual(g.poisoned, 3);
  const ms = advanceTo(g, 'monk');
  assert.ok(ms);
  act(g, [4]); // 僧侣想保护 4 号，但被毒了
  assert.strictEqual(g.protectedTonight, null);
  const imp = advanceTo(g, 'imp');
  assert.ok(imp);
  act(g, [4]);
  assert.strictEqual(g.players[3].alive, false, '被毒僧侣保护的人还是要死');
});

test('僧侣：没被毒时守护生效', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.beginNight(2);
  advanceTo(g, 'poisoner');
  act(g, [1]); // 毒恶魔自己（没意义，但合法）
  advanceTo(g, 'monk');
  act(g, [4]);
  assert.strictEqual(g.protectedTonight, 4);
  advanceTo(g, 'imp');
  act(g, [4]);
  assert.strictEqual(g.players[3].alive, true, '被守护的人不该死');
});

test('士兵：夜里免疫恶魔', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.beginNight(2);
  advanceTo(g, 'poisoner');
  act(g, [1]);
  advanceTo(g, 'monk');
  act(g, [2]);
  advanceTo(g, 'imp');
  act(g, [6]); // 杀士兵
  assert.strictEqual(g.players[5].alive, true);
});

test('小恶魔传位：自刀后有爪牙接手，游戏继续', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.beginNight(2);
  advanceTo(g, 'poisoner');
  act(g, [5]); // 毒管家（别毒恶魔，毒了恶魔这夜就杀不了人）
  advanceTo(g, 'monk');
  act(g, [4]);
  advanceTo(g, 'imp');
  act(g, [1]); // 小恶魔杀自己
  assert.strictEqual(g.players[0].alive, false);
  assert.strictEqual(g.players[1].role, 'imp', '投毒者应该成为新恶魔');
  assert.strictEqual(g.winner, null, '还有恶魔，游戏不该结束');
});

test('投毒：恶魔被毒，这一夜杀不了人', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.beginNight(2);
  advanceTo(g, 'poisoner');
  act(g, [1]); // 毒恶魔
  advanceTo(g, 'monk');
  act(g, [4]);
  advanceTo(g, 'imp');
  act(g, [4]);
  assert.strictEqual(g.players[3].alive, true, '被毒的恶魔杀不了人');
});

test('小恶魔传位：没有爪牙可接，好人直接赢', () => {
  const g = gameWithRoles(['imp', 'soldier', 'mayor', 'empath', 'virgin', 'slayer', 'saint']);
  g.beginNight(2);
  advanceTo(g, 'imp');
  act(g, [1]);
  assert.strictEqual(g.winner, 'good');
});

test('守鸦人：夜里被杀会被唤醒并看一个人的身份', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'ravenkeeper', 'empath', 'butler', 'soldier', 'chef']);
  g.beginNight(2);
  advanceTo(g, 'poisoner');
  act(g, [5]);
  advanceTo(g, 'imp');
  act(g, [3]); // 杀守鸦人
  const rk = advanceTo(g, 'ravenkeeper');
  assert.ok(rk, '守鸦人应该醒');
  assert.strictEqual(rk.seat, 3);
  act(g, [2]);
  const card = g.knowledge[3].pop();
  assert.ok(card.lines.join('').length > 0);
});

/* ------------------------------ 白天与胜负 ------------------------------ */

test('处决：投死小恶魔，好人赢', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.phase = 'day';
  g.round = 1;
  g.day = { sub: 'nominate', deadline: null, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };
  g.nominate(2, 1);
  for (const p of g.players.filter((p) => p.alive)) g.castVote(p.seat, true);
  g.endNominations();
  assert.strictEqual(g.players[0].alive, false);
  assert.strictEqual(g.winner, 'good');
  assert.strictEqual(g.phase, 'ended');
});

test('红唇女郎：恶魔死了且还有 5 人存活，她变成恶魔', () => {
  const g = gameWithRoles(['imp', 'scarlet_woman', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.phase = 'day';
  g.round = 1;
  g.day = { sub: 'nominate', deadline: null, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };
  g.nominate(3, 1);
  for (const p of g.players.filter((p) => p.alive)) g.castVote(p.seat, true);
  g.endNominations();
  assert.strictEqual(g.players[0].alive, false);
  assert.strictEqual(g.players[1].role, 'imp', '红唇女郎接手');
  assert.strictEqual(g.winner, null);
});

test('红唇女郎：死到只剩 4 人时不再接手，好人赢', () => {
  const g = gameWithRoles(['imp', 'scarlet_woman', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.players[3].alive = false;
  g.players[4].alive = false;
  g.players[5].alive = false; // 4 人存活（含恶魔）
  g.phase = 'day';
  g.round = 1;
  g.day = { sub: 'nominate', deadline: null, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };
  g.nominate(2, 1);
  for (const p of g.players.filter((p) => p.alive)) g.castVote(p.seat, true);
  g.endNominations();
  assert.strictEqual(g.players[1].role, 'scarlet_woman', '人不够，不接管');
  assert.strictEqual(g.winner, 'good');
});

test('圣徒：被处决，坏人赢', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'saint', 'empath', 'butler', 'soldier', 'chef']);
  g.phase = 'day';
  g.round = 1;
  g.day = { sub: 'nominate', deadline: null, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };
  g.nominate(4, 3);
  for (const p of g.players.filter((p) => p.alive)) g.castVote(p.seat, true);
  g.endNominations();
  assert.strictEqual(g.winner, 'evil');
  assert.strictEqual(g.winReason, 'saint');
});

test('贞洁烈女：被镇民提名，提名者当场处决', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'virgin', 'empath', 'butler', 'soldier', 'chef']);
  g.phase = 'day';
  g.round = 1;
  g.day = { sub: 'nominate', deadline: null, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };
  const r = g.nominate(5, 3); // 5 号管家（外来者）提名贞洁烈女
  assert.ok(r.ok);
  assert.strictEqual(g.players[4].alive, true, '外来者提名不触发');
  assert.ok(g.day.vote, '没有触发，正常进入投票');
});

test('贞洁烈女：镇民提名立刻处决，白天结束', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'virgin', 'empath', 'butler', 'soldier', 'chef']);
  g.players[2].believed = 'virgin';
  g.phase = 'day';
  g.round = 1;
  g.day = { sub: 'nominate', deadline: null, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };
  const r = g.nominate(4, 3); // 4 号共情者（镇民）提名
  assert.ok(r.virgin);
  assert.strictEqual(g.players[3].alive, false, '提名者当场被处决');
  assert.strictEqual(g.day.sub, 'ended');
});

test('镇长：剩 3 人且当天没人被处决，好人赢', () => {
  const g = gameWithRoles(['imp', 'mayor', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.players[3].alive = false;
  g.players[4].alive = false;
  g.players[5].alive = false;
  g.players[6].alive = false; // 剩 1 恶魔 + 镇长 + 僧侣
  g.phase = 'day';
  g.round = 1;
  g.day = { sub: 'nominate', deadline: null, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };
  g.endNominations();
  assert.strictEqual(g.winner, 'good');
  assert.strictEqual(g.winReason, 'mayor');
});

test('只剩两人存活，坏人赢', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.players[2].alive = false;
  g.players[3].alive = false;
  g.players[4].alive = false;
  g.players[5].alive = false;
  g.players[6].alive = false;
  g.phase = 'night';
  g.round = 2;
  g.night = { number: 2, steps: [], index: 0, pending: null, deadTonight: [], abort: false };
  g.dawn();
  assert.strictEqual(g.winner, 'evil');
});

/* ------------------------------ 计票与管家 ------------------------------ */

test('管家：误投的票正常计入，仅私密提醒，不公开验证身份', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.butlerMaster = 3;
  g.phase = 'day';
  g.round = 1;
  g.day = { sub: 'nominate', deadline: null, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };
  g.nominate(2, 1);
  g.castVote(5, true); // 管家投同意
  g.castVote(3, false); // 主人投反对
  g.castVote(4, true);
  const r = g.closeVote();
  assert.ok(r.ok);
  assert.strictEqual(g.day.lastVote.count, 2, '官方要求不作废管家误投的票');
  assert.ok(!('butlerVoided' in g.day.lastVote));
  assert.match(g.alerts[5].at(-1).text, /管家规则/);
  assert.ok(!JSON.stringify(publicView(g)).includes('管家'));
});

test('管家：主人投了同意，自己的票就有效', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.butlerMaster = 3;
  g.phase = 'day';
  g.round = 1;
  g.day = { sub: 'nominate', deadline: null, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };
  g.nominate(2, 1);
  g.castVote(5, true);
  g.castVote(3, true);
  g.closeVote();
  assert.strictEqual(g.day.lastVote.count, 2);
});

/* ------------------------------ 视图隔离 ------------------------------ */

test('视图：酒鬼屏幕上永远看不到"酒鬼"两个字', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const g = new Game({ seed, playerCount: 7 });
    for (let s = 1; s <= 7; s++) g.claim(s, null, 'P' + s);
    const setupRes = g.start();
    if (!setupRes.ok) continue;
    const drunk = g.players.find((p) => p.role === 'drunk');
    if (!drunk) continue;
    const v = seatView(g, drunk.seat);
    assert.strictEqual(v.me.role.id, drunk.believed);
    assert.ok(!JSON.stringify(v).includes('酒鬼'), `seed=${seed} 酒鬼漏了`);
  }
});

test('视图：公共视图任何阶段都不含身份字段', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.beginNight(1);
  const pub = JSON.stringify(publicView(g));
  for (const r of Object.values(ROLES)) {
    assert.ok(!pub.includes(r.name), '公共视图出现 ' + r.name);
  }
});

test('视图：间谍情报里有魔典，别人没有', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'spy', 'empath', 'butler', 'soldier', 'chef']);
  g.beginNight(1);
  const spyStep = advanceTo(g, 'spy');
  assert.ok(spyStep);
  act(g);
  const spyView = seatView(g, 3);
  const cards = spyView.knowledge;
  assert.ok(cards.some((c) => c.kind === 'grimoire'), '间谍应该拿到魔典');
  // 别人在这一夜没拿到魔典
  const other = seatView(g, 2);
  assert.ok(!(other.knowledge || []).some((c) => c.kind === 'grimoire'));
});

test('中毒者：视图里没有任何"你中毒了"的字段', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.beginNight(2);
  advanceTo(g, 'poisoner');
  act(g, [4]);
  const v = seatView(g, 4);
  assert.ok(!JSON.stringify(v).includes('中毒'), '不能告诉玩家他中毒了');
  assert.strictEqual(g.poisoned, 4);
});

test('重开一局：保留座位与 token，清空身份', () => {
  const g = new Game({ seed: 5, playerCount: 7 });
  for (let s = 1; s <= 7; s++) g.claim(s, null, 'P' + s);
  g.start();
  const tokens = g.players.map((p) => p.token);
  g.reset(7, true);
  assert.deepStrictEqual(g.players.map((p) => p.token), tokens);
  assert.strictEqual(g.phase, 'lobby');
  assert.ok(g.players.every((p) => p.role === null));
});

/* ------------------------------ 新加的几个小功能 ------------------------------ */

test('计时：改讨论时长会立刻重置当前讨论倒计时', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.phase = 'day';
  g.round = 1;
  g.day = { sub: 'discuss', deadline: Date.now() + 300000, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };
  const before = g.day.deadline;
  g.setTimers({ discussMs: 180000 });
  assert.strictEqual(g.settings.discussMs, 180000);
  assert.ok(g.day.deadline < before, '倒计时应该变短');
  assert.ok(g.day.deadline > Date.now() + 170000);
});

test('计时：投票时长只影响下一轮，不打断正在进行的投票', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.phase = 'day';
  g.round = 1;
  g.day = { sub: 'nominate', deadline: null, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };
  g.nominate(2, 1);
  const deadline = g.day.vote.deadline;
  g.setTimers({ voteMs: 90000 });
  assert.strictEqual(g.day.vote.deadline, deadline, '正在投的这轮不改');
  assert.strictEqual(g.settings.voteMs, 90000);
});

test('酒鬼：对局结束才亮真身份', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'drunk', 'empath', 'butler', 'soldier', 'chef']);
  g.players[2].believed = 'monk';
  g.phase = 'reveal';
  const before = seatView(g, 3);
  assert.strictEqual(before.me.role.id, 'monk', '进行中显示的是他以为的身份');
  assert.strictEqual(before.me.wasFooled, false);
  assert.strictEqual(before.me.trueRole, null, '没结束不许把真身份发下去');

  g.phase = 'ended';
  g.winner = 'good';
  g.winReason = 'demon-dead';
  const after = seatView(g, 3);
  assert.strictEqual(after.me.role.id, 'drunk');
  assert.ok(after.me.wasFooled);
  assert.strictEqual(after.me.trueRole.id, 'drunk');
});

test('酒鬼以外的人：结束时拿到的真身份就是自己的身份', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.phase = 'ended';
  g.winner = 'good';
  const v = seatView(g, 2);
  assert.strictEqual(v.me.role.id, 'poisoner');
  assert.strictEqual(v.me.wasFooled, false);
});

test('怀疑标记：只进自己的视图，不进公共视图，也不进别人视图', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.phase = 'day';
  g.round = 1;
  g.day = { sub: 'discuss', deadline: Date.now() + 60000, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };

  assert.ok(g.toggleSuspicion(1, 3).ok);
  assert.ok(g.toggleSuspicion(1, 5).ok);
  assert.ok(g.toggleSuspicion(2, 3).ok);
  assert.deepStrictEqual(g.suspicionOf(1), [3, 5]);
  assert.deepStrictEqual(g.suspicionOf(2), [3]);
  assert.deepStrictEqual(g.suspicionOf(3), []);

  // 再点一次是取消
  g.toggleSuspicion(1, 5);
  assert.deepStrictEqual(g.suspicionOf(1), [3]);

  const own = seatView(g, 1);
  assert.deepStrictEqual(own.me.suspicion, [3]);
  const other = seatView(g, 2);
  assert.deepStrictEqual(other.me.suspicion, [3], '2号 只看到自己的名单');
  const pub = JSON.stringify(publicView(g));
  assert.ok(!pub.includes('suspicion'), '公共视图不能有怀疑标记');

  // 聚合快照只给说书人层：3号 被 1 和 2 怀疑
  const snap = g.storytellerSnapshot();
  assert.strictEqual(snap.suspicion[3], 2);
  assert.strictEqual(snap.suspicion[5], 0);
  assert.strictEqual(snap.markedBy, 2);

  // 怀疑不是投票：票数一点没动
  assert.strictEqual(g.day.nominations.length, 0);
  assert.strictEqual(g.day.vote, null);
});

test('怀疑标记：不能怀疑自己，重开一局清空', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  assert.strictEqual(g.toggleSuspicion(1, 1).ok, false);
  g.toggleSuspicion(1, 2);
  g.reset(7, true);
  assert.deepStrictEqual(g.suspicionOf(1), []);
});

test('板子：贴身份、改身份、清回未知、非法输入', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  assert.ok(g.setBoardGuess(1, 3, 'poisoner').ok);
  assert.deepStrictEqual(g.boardOf(1), { 3: 'poisoner' });

  g.setBoardGuess(1, 3, 'imp'); // 改了
  assert.deepStrictEqual(g.boardOf(1), { 3: 'imp' });

  g.setBoardGuess(1, 3, null); // 清回未知
  assert.deepStrictEqual(g.boardOf(1), {});

  assert.strictEqual(g.setBoardGuess(1, 1, 'imp').ok, false, '不能给自己贴');
  assert.strictEqual(g.setBoardGuess(1, 3, 'nobody').ok, false, '不存在的角色要拒绝');
  assert.strictEqual(g.setBoardGuess(99, 3, 'imp').ok, false, '不存在的座位要拒绝');
});

test('板子：只有本人看得到，公共视图里没有', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.setBoardGuess(1, 3, 'poisoner');
  g.setBoardGuess(2, 4, 'imp');

  assert.deepStrictEqual(seatView(g, 1).me.board, { 3: 'poisoner' });
  assert.deepStrictEqual(seatView(g, 2).me.board, { 4: 'imp' }, '别人只看得到自己的板子');
  assert.deepStrictEqual(seatView(g, 3).me.board, {});

  const pub = publicView(g);
  assert.ok(!('board' in pub), '公共视图不能有板子');
  assert.strictEqual(JSON.stringify(pub).indexOf('poisoner'), -1);
});

test('板子：说书人快照里有 beliefs 和 consensus', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.setBoardGuess(1, 3, 'imp');
  g.setBoardGuess(2, 3, 'imp');
  g.setBoardGuess(4, 5, 'poisoner');

  const snap = g.storytellerSnapshot();
  assert.deepStrictEqual(snap.beliefs[1], { 3: 'imp' });
  assert.deepStrictEqual(snap.beliefs[4], { 5: 'poisoner' });
  assert.strictEqual(snap.consensus[3].imp, 2, '两个人都认为 3 号是恶魔');
  assert.strictEqual(snap.consensus[5].poisoner, 1);
  assert.strictEqual(snap.boardsBy, 3);

  g.reset(7, true);
  assert.deepStrictEqual(g.boardOf(1), {}, '重开清空');
});

test('夜间等待：视图里带了开始等待的时间戳', () => {
  const g = new Game({ seed: 11, playerCount: 7 });
  for (let s = 1; s <= 7; s++) g.claim(s, null, 'P' + s);
  assert.ok(g.start().ok);
  for (let s = 1; s <= 7; s++) g.confirm(s);
  g.beginNight(1);
  const pub = publicView(g);
  assert.ok(pub.night.waiting);
  assert.ok(typeof pub.night.waitingSince === 'number');
  assert.ok(Math.abs(pub.night.waitingSince - Date.now()) < 5000);
});

test('复盘时间线：只在结束后出现，且不含身份', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'monk', 'empath', 'butler', 'soldier', 'chef']);
  g.round = 1;
  g.kill(4, 'night');
  g.day = { sub: 'nominate', deadline: null, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };
  g.phase = 'day';
  assert.strictEqual(publicView(g).timeline, null, '进行中不该有');
  g.winner = 'good';
  g.winReason = 'demon-dead';
  g.phase = 'ended';
  const pub = publicView(g);
  assert.strictEqual(pub.timeline.length, 1);
  assert.strictEqual(pub.timeline[0].seat, 4);
  assert.strictEqual(pub.timeline[0].where, '夜里');
  for (const r of Object.values(ROLES)) {
    assert.ok(!JSON.stringify(pub.timeline).includes(r.name), '时间线里不该有身份');
  }
});

/* ------------------------------ 2026-10 实测后补的回归 ------------------------------ */

test('胜负：一好人、一爪牙、一恶魔的三人残局继续，直到只剩两人', () => {
  const g = gameWithRoles(['imp', 'baron', 'monk', 'soldier', 'chef', 'empath', 'butler']);
  g.kill(4, 'night');
  g.kill(5, 'night');
  g.kill(6, 'night');
  // 4 人：imp + baron + monk + butler，好人 2 > 恶魔 1，还得继续
  assert.strictEqual(dayMod.checkWin(g), null);
  g.kill(7, 'night');
  // 3 人：imp + baron + monk，仍可借助幽灵票处决恶魔，不能提前判负。
  assert.strictEqual(dayMod.checkWin(g), null);
  assert.strictEqual(g.winReason, null);
  g.kill(3, 'night');
  assert.strictEqual(dayMod.checkWin(g), 'evil');
  assert.strictEqual(g.winReason, 'two-alive');
  assert.strictEqual(publicView(g).winReasonLabel, '只剩两名玩家存活');
});

test('投票：票型写进公开记录，处决结果也写', () => {
  const g = gameWithRoles(['imp', 'monk', 'soldier', 'chef', 'empath', 'butler', 'washerwoman']);
  g.phase = 'day';
  g.round = 1;
  g.day = { sub: 'discuss', deadline: Date.now() + 60000, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };
  assert.ok(g.beginNominations().ok);
  assert.ok(g.nominate(1, 2).ok);
  g.castVote(1, true);
  g.castVote(2, false);
  g.castVote(3, true);
  g.castVote(4, true);
  g.castVote(5, false);
  g.castVote(6, true);
  g.castVote(7, true);
  assert.strictEqual(g.day.vote, null, '七个人投完自动截止');
  assert.deepStrictEqual(g.day.lastVote.yes, [1, 3, 4, 6, 7]);
  assert.deepStrictEqual(g.day.lastVote.no, [2, 5]);
  assert.strictEqual(publicView(g).day.lastVote.votes.length, 7);

  assert.ok(g.endNominations().ok);
  assert.strictEqual(g.players[1].alive, false, '2 号被处决');
  const log = g.log.map((x) => x.text).join('\n');
  assert.ok(/票型：同意 1、3、4、6、7；反对 2、5。/.test(log), '票型要进公开记录');
  assert.ok(/2号（P2）被处决。/.test(log), '处决结果要进公开记录');
});

test('投票：不过半数不处决', () => {
  const g = gameWithRoles(['imp', 'monk', 'soldier', 'chef', 'empath', 'butler', 'washerwoman']);
  g.phase = 'day';
  g.round = 1;
  g.day = { sub: 'discuss', deadline: Date.now() + 60000, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };
  g.beginNominations();
  g.nominate(1, 2);
  g.castVote(1, true);
  g.castVote(2, true);
  g.castVote(3, true);
  g.castVote(4, false);
  g.castVote(5, false);
  g.castVote(6, false);
  g.castVote(7, false);
  assert.ok(g.endNominations().ok);
  assert.strictEqual(g.players[1].alive, true, '3 票不到 4 票门槛，不能处决');
  assert.ok(g.log.some((x) => x.text.includes('未达到 4 票')));
});

test('夜间确认后，情报只入账一张', () => {
  const g = gameWithRoles(['butler', 'imp', 'monk', 'soldier', 'chef', 'empath', 'washerwoman']);
  g.beginNight(2);
  // 直接跳到管家那一步，免得前面的恶魔把人杀了
  g.night.index = g.night.steps.findIndex((s) => s.role === 'butler');
  g.night.pending = null;
  advance(g);
  const p = g.night.pending;
  assert.ok(p && p.step === 'butler', '应该轮到管家');
  assert.ok(g.submitNight(1, { targets: [2] }).ok);
  assert.ok(g.submitNight(1, {}).ok, '点「我看到了」');
  const cards = g.knowledge[1] || [];
  assert.strictEqual(cards.length, 1, '不能重复入账两张');
  assert.strictEqual(cards[0].title, '已记录');
});

/* ------------------------------ 公开开枪 / 票型 ------------------------------ */

function openDay(roles) {
  const g = gameWithRoles(roles);
  g.phase = 'day';
  g.round = 1;
  g.day = {
    sub: 'discuss',
    deadline: Date.now() + 60000,
    vote: null,
    lastVote: null,
    nominations: [],
    nominators: [],
    nominatedSeats: [],
    executed: null,
  };
  return g;
}

test('公开开枪：谁都能宣称，但不是杀手打不死恶魔', () => {
  const g = openDay(['imp', 'monk', 'soldier', 'chef', 'empath', 'butler', 'washerwoman']);
  // 3 号士兵不是杀手，照样能公开宣称开枪
  const r = g.slayerShoot(3, 1);
  assert.ok(r.ok);
  assert.strictEqual(r.hit, false);
  assert.strictEqual(g.players[0].alive, true, '假杀手打不死恶魔');
  assert.strictEqual(g.slayerUsed, false, '假开枪不能消费真杀手的能力');
  const log = g.log.map((x) => x.text).join('\n');
  assert.ok(log.includes('3号 宣称自己是杀手，对 1号 开枪。'), '公开记录要写谁宣称打了谁');
  assert.ok(log.includes('什么也没发生。'));
  // 假宣称不受真实的一次性能力限制。
  assert.strictEqual(g.slayerShoot(3, 2).ok, true);
});

test('公开开枪：真杀手打中恶魔，恶魔死、能力用掉', () => {
  const g = openDay(['imp', 'slayer', 'soldier', 'chef', 'empath', 'butler', 'washerwoman']);
  const r = g.slayerShoot(2, 1);
  assert.ok(r.ok);
  assert.strictEqual(r.hit, true);
  assert.strictEqual(g.players[0].alive, false);
  assert.strictEqual(g.slayerUsed, true);
  assert.strictEqual(g.winner, 'good');
  const log = g.log.map((x) => x.text).join('\n');
  assert.ok(log.includes('1号 死亡。'), '只公布死亡，不公布身份');
  assert.ok(!log.includes('是恶魔'), '不能写"是恶魔"（隐士也可能被当作恶魔）');
});

test('公开开枪：打到被当作恶魔的隐士，不触发红唇女郎接管', () => {
  const g = openDay(['imp', 'slayer', 'monk', 'chef', 'recluse', 'butler', 'scarlet_woman']);
  const r = g.slayerShoot(2, 5);
  assert.ok(r.ok);
  assert.strictEqual(r.hit, true);
  assert.strictEqual(g.players[4].alive, false, '隐士按恶魔结算，死了');
  assert.strictEqual(g.players[6].role, 'scarlet_woman', '真恶魔还活着，红唇女郎不能接管');
  assert.strictEqual(g.players[0].alive, true);
  assert.strictEqual(g.winner, null);
});

test('票型历史：跨天保留，处决标记跟着那轮票', () => {
  const g = openDay(['imp', 'monk', 'soldier', 'chef', 'empath', 'butler', 'washerwoman']);
  g.beginNominations();
  g.nominate(1, 2);
  g.castVote(1, true);
  g.castVote(3, true);
  g.castVote(4, true);
  g.castVote(5, true);
  g.castVote(6, false);
  g.castVote(7, false);
  g.castVote(2, false);
  g.endNominations();

  const pub = publicView(g);
  assert.strictEqual(pub.voteHistory.length, 1);
  const h = pub.voteHistory[0];
  assert.strictEqual(h.round, 1);
  assert.strictEqual(h.nominator, 1);
  assert.strictEqual(h.nominee, 2);
  assert.strictEqual(h.count, 4);
  assert.deepStrictEqual(h.yes, [1, 3, 4, 5]);
  assert.deepStrictEqual(h.no, [2, 6, 7]);
  assert.strictEqual(h.executed, true);

  // 跨天：新的一天提名，历史不丢
  g.phase = 'day';
  g.round = 2;
  g.day = { sub: 'discuss', deadline: Date.now() + 60000, vote: null, lastVote: null, nominations: [], nominators: [], nominatedSeats: [], executed: null };
  g.beginNominations();
  g.nominate(3, 4);
  g.castVote(1, true);
  g.castVote(3, true);
  g.castVote(4, false);
  g.castVote(5, true);
  g.castVote(6, false);
  g.castVote(7, true);
  g.castVote(2, false);
  assert.strictEqual(publicView(g).voteHistory.length, 2);
  assert.strictEqual(publicView(g).voteHistory[0].round, 1, '第一天那轮还在');
});

test('幽灵票：死人整局只能投一次', () => {
  const g = openDay(['imp', 'monk', 'soldier', 'chef', 'empath', 'butler', 'washerwoman']);
  g.kill(3, 'night');
  g.beginNominations();
  g.nominate(1, 2);
  assert.ok(g.castVote(3, true).ok, '死人还有一张幽灵票');
  assert.strictEqual(g.castVote(3, false).ok, false, '同一轮不能再投');
  g.closeVote();
  assert.deepStrictEqual(g.day.lastVote.yes, [3]);
  g.nominate(4, 5);
  assert.strictEqual(g.castVote(3, true).ok, false, '下一轮幽灵票已经用掉');
  assert.ok(!g.day.vote.votes.some((v) => v.seat === 3));
});

test('三人残局：活好人加一张幽灵票仍可处决恶魔获胜', () => {
  const g = openDay(['imp', 'baron', 'chef', 'empath', 'monk', 'soldier', 'washerwoman']);
  for (const seat of [4, 5, 6, 7]) g.kill(seat, 'night');
  for (const seat of [5, 6, 7]) g.players[seat - 1].ghostVoteUsed = true;
  assert.strictEqual(dayMod.checkWin(g), null);
  g.beginNominations();
  g.nominate(3, 1);
  for (const [seat, yes] of [[4, true], [3, true], [1, false], [2, false]]) assert.ok(g.castVote(seat, yes).ok);
  assert.strictEqual(g.day.lastVote.count, 2);
  g.endNominations();
  assert.strictEqual(g.winner, 'good');
  assert.strictEqual(g.phase, 'ended');
});

for (const aliveBefore of [4, 5, 6]) {
  for (const cause of ['execution', 'slayer']) {
    test(`红唇女郎：${cause} 前 ${aliveBefore} 人，按死亡前人数判断接管`, () => {
      const g = openDay(['imp', 'scarlet_woman', 'slayer', 'chef', 'empath', 'monk', 'soldier']);
      for (let seat = aliveBefore + 1; seat <= 7; seat++) g.kill(seat, 'night');
      if (cause === 'slayer') assert.ok(g.slayerShoot(3, 1).ok);
      else dayMod.execute(g, 1);
      assert.strictEqual(g.players[0].alive, false);
      assert.strictEqual(g.players[1].role, aliveBefore >= 5 ? 'imp' : 'scarlet_woman');
      assert.strictEqual(g.winner, aliveBefore >= 5 ? null : 'good');
    });
  }
}

test('红唇女郎：死亡前有五人，但她中毒时不能接管', () => {
  const g = openDay(['imp', 'scarlet_woman', 'slayer', 'chef', 'empath', 'monk', 'soldier']);
  g.kill(6, 'night'); g.kill(7, 'night');
  g.poisoned = 2;
  dayMod.execute(g, 1);
  assert.strictEqual(g.players[1].role, 'scarlet_woman');
  assert.strictEqual(g.winner, 'good');
});

test('幽灵票：反对保留票，下一轮同意才消耗', () => {
  const g = openDay(['imp', 'monk', 'soldier', 'chef', 'empath', 'butler', 'washerwoman']);
  g.kill(7, 'night');
  g.beginNominations(); g.nominate(1, 2);
  assert.ok(g.castVote(7, false).ok);
  assert.strictEqual(g.players[6].ghostVoteUsed, false);
  assert.strictEqual(seatView(g, 7).day.vote.canVote, false, '每轮只能回应一次');
  g.closeVote();
  g.nominate(2, 3);
  assert.strictEqual(seatView(g, 7).day.vote.canVote, true);
  assert.ok(g.castVote(7, true).ok);
  assert.strictEqual(g.players[6].ghostVoteUsed, true);
});

for (const restore of ['none', 'saved', 'legacy']) {
  test(`幽灵票：先投同意也不能提前关闭，进度分母固定（${restore}）`, () => {
    let g = openDay(['imp', 'monk', 'soldier', 'chef', 'empath', 'butler', 'washerwoman']);
    g.kill(7, 'night');
    g.beginNominations(); g.nominate(1, 2);
    assert.ok(g.castVote(7, true).ok);
    if (restore !== 'none') {
      const saved = JSON.parse(JSON.stringify(g.toJSON()));
      if (restore === 'legacy') delete saved.day.vote.eligibleSeats;
      g = Game.fromJSON(saved);
    }
    assert.strictEqual(publicView(g).day.vote.eligible, 7);
    for (let seat = 1; seat <= 5; seat++) assert.ok(g.castVote(seat, false).ok);
    assert.ok(g.day.vote, '6号尚未回应，投票不能提前关闭');
    assert.strictEqual(publicView(g).day.vote.voted, 6);
    assert.strictEqual(publicView(g).day.vote.eligible, 7);
    assert.ok(seatView(g, 6).day.vote.canVote);
    assert.ok(g.castVote(6, false).ok);
    assert.strictEqual(g.day.vote, null);
    assert.deepStrictEqual(g.day.lastVote.yes, [7]);
    assert.deepStrictEqual(g.day.lastVote.notVoted, []);
  });
}

test('幽灵票：超时未投、手动结束均不消耗，只有同意消耗', () => {
  const g = openDay(['imp', 'monk', 'soldier', 'chef', 'empath', 'butler', 'washerwoman']);
  g.kill(6, 'night'); g.kill(7, 'night');
  g.beginNominations(); g.nominate(1, 2);
  g.castVote(6, false);
  assert.ok(g.checkTimers(g.day.vote.deadline));
  assert.strictEqual(g.players[5].ghostVoteUsed, false);
  assert.strictEqual(g.players[6].ghostVoteUsed, false);
  assert.ok(g.day.lastVote.notVoted.includes(7));
  g.nominate(2, 3); g.castVote(6, true); g.closeVote();
  assert.strictEqual(g.players[5].ghostVoteUsed, true);
  assert.strictEqual(g.players[6].ghostVoteUsed, false);
  g.nominate(3, 4);
  assert.strictEqual(publicView(g).day.vote.eligible, 6, '后续轮次排除已用票的死者');
  assert.strictEqual(g.castVote(6, true).ok, false);
});

test('提前结束：标准三人残局不自动判负，由房主明确指定胜方并记录', () => {
  const g = openDay(['imp', 'baron', 'chef', 'empath', 'monk', 'soldier', 'washerwoman']);
  for (const seat of [4, 5, 6, 7]) { g.kill(seat, 'night'); g.players[seat - 1].ghostVoteUsed = true; }
  assert.strictEqual(dayMod.checkWin(g), null, '没有幽灵票也不套用自动提前判定');
  assert.strictEqual(g.finishEarly('unknown').ok, false);
  assert.strictEqual(g.phase, 'day');
  g.beginNominations(); g.nominate(3, 1);
  assert.ok(g.finishEarly('evil').ok);
  assert.strictEqual(g.phase, 'ended');
  assert.strictEqual(g.day.vote, null);
  assert.strictEqual(g.winReason, 'manual');
  assert.strictEqual(publicView(g).finalRoles.length, 7);
  assert.match(publicView(g).winReasonLabel, /房主提前宣布/);
  assert.strictEqual(Game.fromJSON(g.toJSON()).winner, 'evil');
  assert.strictEqual(g.finishEarly('good').ok, false, '不能覆盖已结束的结果');
});

test('提前结束：夜间也能宣布好人胜，清除待处理请求和计时', () => {
  const g = gameWithRoles(['imp', 'poisoner', 'chef', 'empath', 'monk', 'soldier', 'washerwoman']);
  g.setInfoMode('storyteller'); g.storytellerConnected(); g.beginNight(1);
  advanceTo(g, 'washerwoman');
  assert.ok(g.stRequest);
  assert.ok(g.finishEarly('good').ok);
  assert.strictEqual(g.winner, 'good');
  assert.strictEqual(g.night, null);
  assert.strictEqual(g.stRequest, null);
  assert.strictEqual(g._stTimer, null);
});

test('提前结束：未开局不能宣布胜负', () => {
  const g = new Game();
  assert.strictEqual(g.finishEarly('evil').ok, false);
  g.start({ force: true });
  assert.strictEqual(g.finishEarly('good').ok, false);
});

test('提名限制：每人每天仅提名一次、被提名一次，不能自提或并发提名', () => {
  const g = openDay(['imp', 'poisoner', 'chef', 'empath', 'monk', 'soldier', 'washerwoman']);
  g.beginNominations();
  assert.strictEqual(g.nominate(1, 1).ok, false);
  assert.deepStrictEqual(g.day.nominators, [], '非法提名不消耗次数');
  assert.ok(g.nominate(1, 2).ok);
  assert.strictEqual(g.nominate(3, 4).ok, false, '本轮投票未结束，不能并发开票');
  g.closeVote();
  assert.strictEqual(g.nominate(1, 3).ok, false, '同一人不能重复提名');
  assert.strictEqual(g.nominate(3, 2).ok, false, '同一人不能重复被提名');
  assert.strictEqual(seatView(g, 1).day.canNominate, false);
  const targets = seatView(g, 3).day.targets.map((p) => p.seat);
  assert.ok(!targets.includes(2) && !targets.includes(3), '手机不提供已被提名者或自己');
  const restored = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert.strictEqual(restored.nominate(1, 3).ok, false, '重连/重启不能重置今日次数');
  assert.strictEqual(restored.nominate(3, 2).ok, false);
  assert.ok(restored.nominate(3, 4).ok, '非法请求不消耗合法提名机会');
});

test('提名限制：新的白天重置次数，死亡玩家不能提名', () => {
  const g = openDay(['imp', 'poisoner', 'chef', 'empath', 'monk', 'soldier', 'washerwoman']);
  g.beginNominations(); g.nominate(1, 2); g.closeVote(); g.endNominations();
  g.beginNight(2);
  while (g.phase === 'night') g.skipNight();
  g.beginNominations();
  assert.ok(g.nominate(1, 2).ok, '新一天可以再次提名同一目标');
  g.closeVote(); g.kill(3, 'night');
  assert.strictEqual(g.nominate(3, 4).ok, false);
});

test('配板子：合法名单能发牌，酒鬼假身份不在场', () => {
  const g = new Game({ seed: 1, playerCount: 7 });
  for (let s = 1; s <= 7; s++) g.claim(s, null, 'P' + s);
  const board = ['washerwoman', 'chef', 'empath', 'monk', 'soldier', 'poisoner', 'imp'];
  assert.ok(g.setBoard(board).ok);
  assert.ok(g.start().ok);
  assert.deepStrictEqual(g.players.map((p) => p.role), board);
  assert.strictEqual(g.baron, false);
  assert.strictEqual(g.composition.townsfolk, 5);
});

test('配板子：男爵变体 + 酒鬼假身份', () => {
  const g = new Game({ seed: 2, playerCount: 7 });
  for (let s = 1; s <= 7; s++) g.claim(s, null, 'P' + s);
  const board = ['washerwoman', 'chef', 'empath', 'drunk', 'butler', 'baron', 'imp'];
  assert.ok(g.setBoard(board).ok);
  assert.ok(g.start().ok);
  assert.strictEqual(g.baron, true);
  assert.strictEqual(g.composition.townsfolk, 3);
  assert.strictEqual(g.players[3].role, 'drunk');
  assert.ok(!board.includes(g.players[3].believed), '酒鬼以为自己是本局没在场的镇民');
});

test('配板子：配比不对 / 重复 / 男爵没开都会被拒绝', () => {
  const g = new Game({ seed: 3, playerCount: 7 });
  for (let s = 1; s <= 7; s++) g.claim(s, null, 'P' + s);
  assert.strictEqual(g.setBoard(['washerwoman', 'chef', 'empath', 'monk', 'soldier']).ok, false, '人数不对');
  assert.strictEqual(
    g.setBoard(['washerwoman', 'chef', 'empath', 'monk', 'monk', 'poisoner', 'imp']).ok,
    false,
    '角色重复'
  );
  assert.strictEqual(
    g.setBoard(['washerwoman', 'chef', 'empath', 'monk', 'soldier', 'imp', 'imp']).ok,
    false,
    '恶魔两个'
  );
  g.config.allowBaron = false;
  assert.strictEqual(
    g.setBoard(['washerwoman', 'chef', 'empath', 'drunk', 'butler', 'baron', 'imp']).ok,
    false,
    '没开男爵'
  );
  assert.strictEqual(g.customBoard, null, '失败的板子不能留下');
});

/* ------------------------------ 技能判定：登记 / 干扰 ------------------------------ */

test('登记：间谍可被当作镇民，隐士可被当作爪牙', () => {
  const g = gameWithRoles(['imp', 'spy', 'recluse', 'washerwoman', 'chef', 'monk', 'butler']);
  const spy = g.players[1];
  const recluse = g.players[2];
  assert.strictEqual(nightMod.registersAs(g, spy, 'townsfolk'), true);
  assert.strictEqual(nightMod.registersAs(g, spy, 'outsider'), true, '间谍也允许登记外来者');
  assert.strictEqual(nightMod.registersAs(g, recluse, 'minion'), true);
  assert.strictEqual(nightMod.registersAs(g, recluse, 'townsfolk'), false);
});

test('中毒干扰：僧侣被毒，守护不写入', () => {
  const g = gameWithRoles(['imp', 'monk', 'soldier', 'chef', 'empath', 'butler', 'washerwoman']);
  g.beginNight(2);
  g.night.index = g.night.steps.findIndex((s) => s.role === 'monk');
  g.night.pending = null;
  advance(g);
  const p = g.night.pending;
  assert.strictEqual(p.step, 'monk');
  g.poisoned = p.seat;
  assert.ok(g.submitNight(p.seat, { targets: [3] }).ok);
  assert.strictEqual(g.protectedTonight, null, '被毒的僧侣守护不生效');
});

test('中毒干扰：士兵被毒，恶魔能刀死他', () => {
  const g = gameWithRoles(['imp', 'monk', 'soldier', 'chef', 'empath', 'butler', 'washerwoman']);
  g.beginNight(2);
  g.night.index = g.night.steps.findIndex((s) => s.role === 'imp');
  g.night.pending = null;
  advance(g);
  const p = g.night.pending;
  assert.strictEqual(p.step, 'imp');
  g.poisoned = 3; // 士兵
  assert.ok(g.submitNight(p.seat, { targets: [3] }).ok);
  assert.strictEqual(g.players[2].alive, false, '被毒的士兵挡不住刀');
  assert.ok(g.night.deadTonight.includes(3));
});

test('中毒干扰：小恶魔被毒，杀不了人', () => {
  const g = gameWithRoles(['imp', 'monk', 'soldier', 'chef', 'empath', 'butler', 'washerwoman']);
  g.beginNight(2);
  g.night.index = g.night.steps.findIndex((s) => s.role === 'imp');
  g.night.pending = null;
  advance(g);
  const p = g.night.pending;
  g.poisoned = p.seat;
  assert.ok(g.submitNight(p.seat, { targets: [3] }).ok);
  assert.strictEqual(g.players[2].alive, true, '被毒的小恶魔刀不动');
});

test('死亡干扰：死了的僧侣今晚不睁眼', () => {
  const g = gameWithRoles(['imp', 'monk', 'soldier', 'chef', 'empath', 'butler', 'washerwoman']);
  g.kill(2, 'night');
  g.beginNight(2);
  assert.strictEqual(advanceTo(g, 'monk'), null, '死人没有僧侣步骤');
});

/* ------------------------------ 情报交给说书人裁量 ------------------------------ */

test('说书人裁量：情报先挂起，交卷后才发给玩家', () => {
  const g = gameWithRoles(['washerwoman', 'imp', 'monk', 'soldier', 'chef', 'butler', 'empath']);
  g.infoMode = 'storyteller';
  g.storytellerOnline = 1;
  g.beginNight(1);
  g.night.index = g.night.steps.findIndex((s) => s.role === 'washerwoman');
  g.night.pending = null;
  advance(g);
  const p = g.night.pending;
  assert.strictEqual(p.step, 'washerwoman');
  assert.strictEqual(p.awaiting, true);
  assert.deepStrictEqual(p.cards, []);
  assert.ok(g.stRequest && g.stRequest.id === p.requestId);
  assert.strictEqual(seatView(g, 1).night.pending.awaiting, true);

  const cards = [{ title: '说书人给的情报', lines: ['1号 或 2号，其中一人是 厨师。'] }];
  assert.ok(g.resolveInfoRequest(g.stRequest.id, cards).ok);
  assert.strictEqual(g.night.pending.awaiting, false);
  assert.strictEqual(g.night.pending.cards[0].title, '说书人给的情报');
  assert.strictEqual(g.stRequest, null);
});

test('说书人裁量：超时/掉线自动回退到引擎答案', () => {
  const g = gameWithRoles(['washerwoman', 'imp', 'monk', 'soldier', 'chef', 'butler', 'empath']);
  g.infoMode = 'storyteller';
  g.storytellerOnline = 1;
  g.beginNight(1);
  g.night.index = g.night.steps.findIndex((s) => s.role === 'washerwoman');
  g.night.pending = null;
  advance(g);
  const truth = g.stRequest.truth;
  assert.ok(Array.isArray(truth) && truth.length);
  assert.ok(g.autoStorytellerInfo().ok);
  assert.deepStrictEqual(g.night.pending.cards, truth);
  assert.strictEqual(g.night.pending.awaiting, false);
});

test('说书人裁量：占卜师选完先挂起，等说书人给有/没有', () => {
  const g = gameWithRoles(['imp', 'fortune_teller', 'monk', 'soldier', 'chef', 'butler', 'washerwoman']);
  g.infoMode = 'storyteller';
  g.storytellerOnline = 1;
  g.beginNight(2);
  g.night.index = g.night.steps.findIndex((s) => s.role === 'fortune_teller');
  g.night.pending = null;
  advance(g);
  const p = g.night.pending;
  assert.strictEqual(p.step, 'fortune_teller');
  assert.ok(g.submitNight(p.seat, { targets: [2, 3] }).ok);
  assert.strictEqual(g.night.pending.awaiting, true);
  assert.strictEqual(g.stRequest.step, 'fortune_teller');
  const cards = [{ title: '占卜师', lines: ['其中有人是恶魔。'] }];
  assert.ok(g.resolveInfoRequest(g.stRequest.id, cards).ok);
  assert.strictEqual(g.night.pending.cards[0].lines[0], '其中有人是恶魔。');
});

test('说书人视图有整本魔典，公共视图没有', () => {
  const g = gameWithRoles(['washerwoman', 'imp', 'monk', 'soldier', 'chef', 'butler', 'empath']);
  g.phase = 'day';
  const st = storytellerView(g);
  assert.strictEqual(st.players[0].role, 'washerwoman');
  assert.strictEqual(st.players[1].role, 'imp');
  assert.ok(!JSON.stringify(publicView(g)).includes('washerwoman'), '公共视图里不能有身份');
});
