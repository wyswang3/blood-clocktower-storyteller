'use strict';

const { getRole, TYPE, TYPE_LABEL, idsByType, ALL_IDS } = require('./roles');
const { pick, shuffle, mulberry32 } = require('./util');

/**
 * 当前官方公开通用夜序筛选暗流涌动角色（2026-10-22 核对）。
 * https://github.com/ThePandemoniumInstitute/botc-release/blob/main/resources/data/nightsheet.json
 * 与旧实体版的间谍、掘墓人位置不同；版本依据见 docs/04_暗流涌动规则核对.md。
 *
 * 第一夜（含最前面的阵营信息）：
 *   Minion Info → Demon Info → 投毒者 → 洗衣妇 → 图书管理员 →
 *   调查员 → 厨师 → 共情者 → 占卜师 → 管家 → 间谍
 * 其他夜：
 *   投毒者 → 僧侣 → 红唇女郎 → 小恶魔 → 守鸦人 →
 *   共情者 → 占卜师 → 掘墓人 → 管家 → 间谍
 *
 * 小恶魔第一夜不发动击杀；7 人以上仍会在阵营信息环节醒来。
 *
 * 几条不能动的先后关系（改顺序会直接改规则）：
 *   - 投毒者永远第一个：毒要当晚生效，后面所有人（含间谍看到的魔典）都得带着毒。
 *   - 僧侣在小恶魔之前：守护要赶在击杀之前落位。
 *   - 间谍在夜末：魔典包含当晚已发生的行动和状态。
 *   - 小恶魔在守鸦人/共情者/占卜师/管家之前：他们看到的是"杀完之后"的场面。
 *   - 红唇女郎的位置只是提醒位（她不睁眼），接管时机在恶魔死的那一刻。
 */
const FIRST_NIGHT = [
  'poisoner', 'washerwoman', 'librarian', 'investigator',
  'chef', 'empath', 'fortune_teller', 'butler', 'spy',
];
const OTHER_NIGHTS = [
  'poisoner', 'monk', 'scarlet_woman', 'imp',
  'ravenkeeper', 'empath', 'fortune_teller', 'undertaker', 'butler', 'spy',
];

const ACTION = {
  poisoner: { type: 'choose', prompt: '选择一名玩家下毒（可选自己或死者）', target: 'any', min: 1, max: 1 },
  monk: { type: 'choose', prompt: '选择一名玩家保护（不能是自己，可选死者）', target: 'anyNotSelf', min: 1, max: 1 },
  butler: { type: 'choose', prompt: '选择你的主人（不能是自己，可选死者）', target: 'anyNotSelf', min: 1, max: 1 },
  imp: { type: 'choose', prompt: '选择一名玩家杀害（可选死者；选自己尝试传位）', target: 'any', min: 1, max: 1 },
  fortune_teller: { type: 'choose', prompt: '选择两名不同玩家（可选自己或死者）', target: 'any', min: 2, max: 2 },
  ravenkeeper: { type: 'choose', prompt: '你死了。选择一名玩家查看身份', target: 'any', min: 1, max: 1 },
  washerwoman: { type: 'info' },
  librarian: { type: 'info' },
  investigator: { type: 'info' },
  chef: { type: 'info' },
  empath: { type: 'info' },
  undertaker: { type: 'info' },
  spy: { type: 'info' },
};

/* ------------------------- 身份登记（说书人视角） ------------------------- */

/** 间谍可被当作好人；隐士可被当作邪恶。固定策略，不每次随机，便于复盘。 */
function registerEvil(game, seat) {
  const p = game.players[seat - 1];
  if (!p) return false;
  if (!game.isImpaired(seat)) {
    if (p.role === 'recluse') return !game._varyRegistrations || game.rng() < 0.5;
    if (p.role === 'spy') return !!game._varyRegistrations && game.rng() < 0.5;
  }
  return getRole(p.role).type === TYPE.MINION || getRole(p.role).type === TYPE.DEMON;
}

function registerDemon(game, seat) {
  const p = game.players[seat - 1];
  if (!p) return false;
  return p.role === 'imp' || (p.role === 'recluse' && !game.isImpaired(seat) &&
    (!game._varyRegistrations || game.rng() < 0.5));
}

function registerTownsfolk(game, seat) {
  const p = game.players[seat - 1];
  if (!p) return false;
  if (p.role === 'spy' && !game.isImpaired(seat)) return !game._varyRegistrations || game.rng() < 0.5;
  return getRole(p.role).type === TYPE.TOWNSFOLK;
}

/* ------------------------------- 夜间步骤 ------------------------------- */

function buildSteps(game, n) {
  const order = n === 1 ? FIRST_NIGHT : OTHER_NIGHTS;
  const steps = [];
  // 第一夜最开始：邪恶阵营互相见面（官方流程表的 Minion Info / Demon Info）
  // 爪牙先醒、恶魔后醒，跟实体夜间流程表一致
  if (n === 1 && game.players.length >= 7) {
    const evil = game.players.filter((p) => {
      if (!p.alive) return false;
      const t = getRole(p.role).type;
      return t === TYPE.MINION || t === TYPE.DEMON;
    });
    const minions = evil.filter((p) => getRole(p.role).type === TYPE.MINION);
    const demons = evil.filter((p) => getRole(p.role).type === TYPE.DEMON);
    for (const p of [...minions, ...demons]) {
      steps.push({ role: 'team', seat: p.seat, type: 'info', info: 'team' });
    }
  }
  for (const rid of order) {
    if (rid === 'scarlet_woman') {
      steps.push({ role: rid, type: 'check' });
      continue;
    }
    if (rid === 'ravenkeeper') {
      // 守鸦人只在今夜死亡时醒来
      for (const p of game.players) {
        if (p.believed === rid) {
          steps.push({ role: rid, seat: p.seat, type: 'choose', whenDead: true, ...ACTION[rid] });
        }
      }
      continue;
    }
    for (const p of game.players) {
      if (p.believed !== rid) continue;
      if (!p.alive) continue;
      const action = ACTION[rid];
      if (!action) continue;
      steps.push({ role: rid, seat: p.seat, ...action });
    }
  }
  return steps;
}

function makePending(game, step) {
  if (step.type === 'info') {
    const cards = infoCards(game, step);
    const pending = {
      seat: step.seat,
      type: 'info',
      step: step.role,
      prompt: '',
      cards,
    };
    // 情报发放可以交给说书人裁量；团队信息（爪牙/恶魔互相认）永远自动
    if (game.wantsStorytellerInfo(step)) {
      const id = game.makeInfoRequest({
        seat: step.seat,
        step: step.role,
        cards,
        context: { night: game.round, info: step.info || null },
      });
      pending.cards = [];
      pending.awaiting = true;
      pending.requestId = id;
      pending.fallbackCards = cards;
    }
    return pending;
  }
  return {
    seat: step.seat,
    type: 'choose',
    step: step.role,
    prompt: step.prompt,
    min: step.min,
    max: step.max,
    options: targetOptions(game, step),
  };
}

function targetOptions(game, step) {
  if (step.target === 'anyNotSelf') return game.players.filter((p) => p.seat !== step.seat).map((p) => slimOption(game, p));
  if (step.target === 'alive') {
    return game.players.filter((p) => p.alive).map((p) => slimOption(game, p));
  }
  if (step.target === 'aliveNotSelf') {
    return game.players.filter((p) => p.alive && p.seat !== step.seat).map((p) => slimOption(game, p));
  }
  return game.players.map((p) => slimOption(game, p));
}

function slimOption(game, p) {
  // 当夜死亡尚未宣告，普通行动的选人列表也不能提前泄露。
  const unannounced = game.night && game.night.deadTonight.includes(p.seat);
  return { seat: p.seat, name: p.name, alive: p.alive || !!unannounced };
}

/** 推进到下一个需要玩家操作的步骤；走完就天亮。 */
function advance(game, notice = null) {
  const night = game.night;
  if (!night) return;
  if (night.abort) {
    game.dawn();
    return;
  }
  while (night.index < night.steps.length) {
    const step = night.steps[night.index];
    if (step.type === 'check') {
      game.scarletCheck();
      night.index++;
      continue;
    }
    const p = game.players[step.seat - 1];
    if (step.whenDead) {
      if (!night.deadTonight.includes(step.seat)) {
        night.index++;
        continue;
      }
    } else if (!p.alive || (step.role !== 'team' && p.believed !== step.role)) {
      night.index++;
      continue;
    }
    const pending = makePending(game, step);
    if (pending) {
      night.pending = pending;
      night.pendingAt = Date.now();
      game.emit(notice);
      return;
    }
    night.index++;
  }
  game.night.pending = null;
  game.dawn();
}

/** 玩家提交。返回 {ok, error?} */
function submit(game, seat, payload) {
  const night = game.night;
  if (!night || !night.pending) return { ok: false, error: '现在没有需要你操作的事项' };
  const pending = night.pending;
  if (pending.seat !== seat) return { ok: false, error: '还没轮到你' };

  if (pending.type === 'info') {
    if (pending.awaiting) return { ok: false, error: '情报还在准备，请稍候' };
    rememberPair(game, pending);
    // 情报类角色（洗衣妇/厨师/间谍/掘墓人……）也要把卡存进"我的情报"
    const knowledge = game.knowledge[seat] || (game.knowledge[seat] = []);
    for (const c of pending.cards || []) {
      knowledge.push({ id: game.nextKnowledgeId(), night: night.number, ...c });
      if (knowledge.length > 40) knowledge.shift();
    }
    night.pending = null;
    night.index++;
    advance(game);
    return { ok: true };
  }

  const raw = payload && (payload.targets || (payload.target != null ? [payload.target] : []));
  const targets = Array.isArray(raw) ? raw.map((x) => Number(x)) : [];
  const err = validateTargets(pending, targets);
  if (err) return { ok: false, error: err };

  const cards = resolveChoice(game, pending, targets);
  if (game.winner) {
    game.finishGame();
    return { ok: true };
  }
  // 卡片先挂在 pending 上，等玩家点「我看到了」再入账；
  // 这里如果先 push 一次，ack 时会再 push 一次，情报页就会重复两张。
  const info = { seat, type: 'info', step: pending.step, prompt: '', cards };
  // 占卜师/守鸦人这种"选完才出结果"的信息，也交给说书人裁量
  if ((pending.step === 'fortune_teller' || pending.step === 'ravenkeeper') && game.wantsStorytellerInfo({ role: pending.step })) {
    const id = game.makeInfoRequest({
      seat,
      step: pending.step,
      cards,
      context: { night: game.round, targets },
    });
    info.cards = [];
    info.awaiting = true;
    info.requestId = id;
    info.fallbackCards = cards;
  }
  night.pending = info;
  night.pendingAt = Date.now();
  game.emit();
  return { ok: true };
}

function validateTargets(pending, targets) {
  if (targets.length < pending.min || targets.length > pending.max) {
    return `需要选择 ${pending.min} 名玩家`;
  }
  const allowed = new Set(pending.options.map((o) => o.seat));
  if (new Set(targets).size !== targets.length) return '不能重复选择同一名玩家';
  for (const t of targets) {
    if (!Number.isInteger(t) || !allowed.has(t)) return '目标不合法';
  }
  return null;
}

function resolveChoice(game, pending, targets) {
  const seat = pending.seat;
  switch (pending.step) {
    case 'poisoner': {
      if (!game.isImpaired(seat)) game.poisoned = targets[0];
      return [noteCard('下毒目标已记录')];
    }
    case 'monk': {
      if (!game.isImpaired(seat)) game.protectedTonight = targets[0];
      return [noteCard('守护目标已记录')];
    }
    case 'butler': {
      game.butlerMaster = targets[0];
      return [noteCard('主人已记录')];
    }
    case 'imp':
      return impKill(game, seat, targets[0]);
    case 'fortune_teller':
      return [fortuneTellerCard(game, seat, targets)];
    case 'ravenkeeper':
      return [ravenkeeperCard(game, seat, targets[0])];
    default:
      return [noteCard('已记录')];
  }
}

function impKill(game, actorSeat, target) {
  const night = game.night;
  // 恶魔被毒：这一夜杀不了人（包括传位）
  if (game.isImpaired(actorSeat)) return [noteCard('已记录')];
  const protectedByDemon = (seat) => game.protectedTonight === seat ||
    (game.players[seat - 1].role === 'soldier' && !game.isImpaired(seat));
  if (!game.players[target - 1].alive || protectedByDemon(target)) return [noteCard('已记录')];
  // 镇长可选择不转移，或转移给任意另一人（包括死者和受保护者）。
  // 由引擎自动裁量，模型没有直接改写死亡的权限。
  if (game.players[target - 1].role === 'mayor' && !game.isImpaired(target)) {
    target = pick(game.players, game.rng).seat;
    if (!game.players[target - 1].alive || protectedByDemon(target)) return [noteCard('已记录')];
  }
  const aliveBeforeDeath = game.aliveCount();
  game.kill(target, target === actorSeat ? 'selfkill' : 'night');
  night.deadTonight.push(target);
  if (target === actorSeat) {
    // 红唇自己的能力优先于小恶魔任意挑选爪牙的传位。
    const { onDemonDeath, checkWin } = require('./day');
    if (onDemonDeath(game, aliveBeforeDeath)) { checkWin(game); return [noteCard('已记录')]; }
    const minions = game.players.filter((p) => p.alive && getRole(p.role).type === TYPE.MINION);
    if (minions.length) {
      const heir = pick(minions, game.rng);
      game.promoteToImp(heir.seat);
      checkWin(game);
      return [noteCard('已记录')];
    }
    game.winner = 'good';
    game.winReason = 'demon-dead';
    night.abort = true;
    return [noteCard('已记录')];
  }
  require('./day').checkWin(game);
  return [noteCard('已记录')];
}

/* ------------------------------- 情报卡 ------------------------------- */

function noteCard(text) {
  return { title: '已记录', lines: [text] };
}

/** 邪恶阵营互相认识：只有坏人拿得到，进自己的情报页 */
function teamCard(game, seat) {
  const me = game.players[seat - 1];
  const mates = game.players.filter((p) => {
    if (p.seat === seat) return false;
    const t = getRole(p.role).type;
    return t === TYPE.MINION || t === TYPE.DEMON;
  });
  const demon = getRole(me.role).type === TYPE.DEMON;
  const lines = mates.map((p) => `${p.seat}号（${p.name}） 是 ${getRole(p.role).type === TYPE.DEMON ? '恶魔' : '爪牙'}`);
  if (demon) lines.push('不在场的三个善良角色：' + (game.demonBluffs || []).map((id) => getRole(id).name).join('、') + '。');
  return {
    title: '你的同伙',
    lines: lines.length ? lines : ['这局只有你一个坏人。'],
  };
}

function infoCards(game, step) {
  const seat = step.seat;
  // 第一夜的"同伙见面"：规则给的信息，不受中毒影响
  if (step.info === 'team') return [teamCard(game, seat)];
  const impaired = game.isImpaired(seat);
  switch (step.role) {
    case 'washerwoman':
      return [pairCard(game, seat, TYPE.TOWNSFOLK, impaired, '洗衣妇')];
    case 'librarian':
      return [pairCard(game, seat, TYPE.OUTSIDER, impaired, '图书管理员')];
    case 'investigator':
      return [pairCard(game, seat, TYPE.MINION, impaired, '调查员')];
    case 'chef':
      return [chefCard(game, impaired)];
    case 'empath':
      return [empathCard(game, seat, impaired)];
    case 'undertaker':
      return [undertakerCard(game, impaired)];
    case 'spy':
      return [spyCard(game, seat, impaired)];
    default:
      return [noteCard('已记录')];
  }
}

function seatLabel(game, seat) {
  const p = game.players[seat - 1];
  return `${seat}号（${p.name}）`;
}

/** 已实际发出的首夜配对标记属于魔典；候选预览不能修改这份记录。 */
function rememberPair(game, pending) {
  if (!['washerwoman', 'librarian', 'investigator'].includes(pending.step)) return;
  const card = pending.cards && pending.cards[0];
  if (!card || !Array.isArray(card.lines)) return;
  const seats = [...String(card.lines[0]).matchAll(/(?:^| 或 )(\d+)号（/g)].map((m) => Number(m[1]));
  const roleId = ALL_IDS.find((id) => card.lines[1] && card.lines[1].includes('是 ' + getRole(id).name + '（'));
  if (seats.length !== 2 || !roleId || seats.some((s) => !game.players[s - 1])) return;
  const type = getRole(roleId).type;
  const correct = seats.find((s) => {
    const p = game.players[s - 1];
    if (p.role === roleId) return true;
    if (game.isImpaired(s)) return false;
    return (p.role === 'spy' && [TYPE.TOWNSFOLK, TYPE.OUTSIDER].includes(type)) ||
      (p.role === 'recluse' && [TYPE.MINION, TYPE.DEMON].includes(type));
  }) || seats[0];
  game.infoReminders[pending.step] = { viewer: pending.seat, roleId, correct, wrong: seats.find((s) => s !== correct) };
}

/**
 * 身份登记：间谍按好人/镇民登记，隐士按邪恶/爪牙或恶魔登记（固定策略）。
 * 洗衣妇/调查员这类"看到某人是什么类型"的能力要按登记结果找人，不能只看真身份。
 */
function registersAs(game, p, type) {
  const trueType = getRole(p.role).type;
  if (trueType === type) return true;
  if (game.isImpaired(p.seat)) return false;
  if (p.role === 'spy' && (type === TYPE.TOWNSFOLK || type === TYPE.OUTSIDER)) return !game._varyRegistrations || game.rng() < 0.5;
  if (p.role === 'recluse' && (type === TYPE.MINION || type === TYPE.DEMON)) return !game._varyRegistrations || game.rng() < 0.5;
  return false;
}

/** 登记成某类型时，桌上会显示成哪个角色名（间谍/隐士挑一个不在场的） */
function registeredName(game, p, type) {
  if (getRole(p.role).type === type) return getRole(p.role).name;
  return getRole(pick(idsByType(type), game.rng)).name;
}

function pairCard(game, viewerSeat, type, impaired, title) {
  const typeLabel = TYPE_LABEL[type];
  const candidates = impaired ? [] : game.players.filter((p) => registersAs(game, p, type));
  if (type === TYPE.OUTSIDER && !impaired) {
    if (!candidates.length) return { title, lines: ['本局没有外来者。'] };
  }
  let a;
  let b;
  let roleName;
  if (impaired) {
    roleName = getRole(pick(idsByType(type), game.rng)).name;
    const pool = game.players;
    const shuffled = shuffle(pool, game.rng);
    a = shuffled[0];
    b = shuffled[1];
  } else {
    const holder = pick(candidates, game.rng);
    if (!holder) return { title, lines: ['（本局没有符合条件的目标）'] };
    roleName = registeredName(game, holder, type);
    const others = game.players.filter((p) => p.seat !== holder.seat);
    const other = pick(others, game.rng);
    a = holder;
    b = other;
  }
  if (!a || !b) return { title, lines: ['（人数不足，无法配对）'] };
  const two = shuffle([a, b], game.rng);
  return {
    title,
    lines: [
      `${two[0].seat}号（${two[0].name}） 或 ${two[1].seat}号（${two[1].name}）`,
      `其中一人是 ${roleName}（${typeLabel}）。`,
    ],
  };
}

function countEvilPairs(game) {
  const n = game.players.length;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const a = i + 1;
    const b = (i + 1) % n + 1;
    if (registerEvil(game, a) && registerEvil(game, b)) count++;
  }
  return count;
}

function chefCard(game, impaired) {
  const count = impaired ? Math.floor(game.rng() * 3) : countEvilPairs(game);
  const text = count === 0 ? '没有邪恶玩家相邻。' : `有 ${count} 对邪恶玩家相邻。`;
  return { title: '厨师', lines: [text] };
}

function aliveNeighbours(game, seat) {
  const n = game.players.length;
  const out = [];
  for (const dir of [-1, 1]) {
    let idx = seat;
    for (let step = 0; step < n; step++) {
      idx = ((idx - 1 + dir + n) % n) + 1;
      if (idx === seat) break;
      const p = game.players[idx - 1];
      if (p.alive) {
        if (!out.some((o) => o.seat === idx)) out.push({ seat: idx });
        break;
      }
    }
  }
  return out;
}

function empathCard(game, seat, impaired) {
  const neighbours = aliveNeighbours(game, seat);
  let count;
  if (impaired) {
    count = Math.floor(game.rng() * (neighbours.length + 1));
  } else {
    count = neighbours.filter((nb) => registerEvil(game, nb.seat)).length;
  }
  const text =
    count === 0
      ? '你两侧最近的存活邻居中，没有邪恶的。'
      : `你两侧最近的存活邻居中，有 ${count} 人是邪恶的。`;
  return { title: '共情者', lines: [text] };
}

function undertakerCard(game, impaired) {
  const last = game.yesterdayExecution;
  if (!last || last.died === false) return { title: '掘墓人', lines: ['昨天没有人因处决死亡。'] };
  let name;
  if (impaired) {
    name = getRole(pick(ALL_IDS, game.rng)).name;
  } else {
    name = registeredRole(game, game.players[last.seat - 1], last.role);
  }
  return { title: '掘墓人', lines: [`昨天被处决的是 ${seatLabel(game, last.seat)}。`, `他的角色是 ${name}。`] };
}

function fortuneTellerCard(game, seat, targets) {
  const [a, b] = targets;
  let yes;
  if (game.isImpaired(seat)) {
    yes = game.rng() < 0.5;
  } else {
    yes =
      registerDemon(game, a) ||
      registerDemon(game, b) ||
      game.redHerring === a ||
      game.redHerring === b;
  }
  return {
    title: '占卜师',
    lines: [
      `你选择了 ${seatLabel(game, a)} 和 ${seatLabel(game, b)}。`,
      yes ? '其中有人是恶魔。' : '其中没有恶魔。',
    ],
  };
}

function ravenkeeperCard(game, seat, target) {
  const p = game.players[target - 1];
  const name = game.isImpaired(seat)
    ? getRole(pick(ALL_IDS, game.rng)).name
    : registeredRole(game, p);
  return { title: '守鸦人', lines: [`你选择了 ${seatLabel(game, target)}。`, `他的角色是 ${name}。`] };
}

function registeredRole(game, p, actual = p.role) {
  // 默认展示真角色；候选预览可涵盖死后仍有效的间谍/隐士登记。
  if (game._varyRegistrations && !game.isImpaired(p.seat) && game.rng() < 0.7) {
    if (actual === 'spy') return getRole(pick([...idsByType(TYPE.TOWNSFOLK), ...idsByType(TYPE.OUTSIDER)], game.rng)).name;
    if (actual === 'recluse') return getRole(pick([...idsByType(TYPE.MINION), ...idsByType(TYPE.DEMON)], game.rng)).name;
  }
  return getRole(actual).name;
}

function spyCard(game, seat, impaired) {
  const rows = game.players.map((p) => {
    const tags = [];
    if (!p.alive) tags.push('死亡');
    if (p.role === 'drunk') tags.push(`以为是 ${getRole(p.believed).name}`);
    if (game.poisoned === p.seat) tags.push('中毒');
    if (game.redHerring === p.seat) tags.push('红鲱鱼');
    if (game.protectedTonight === p.seat) tags.push('僧侣保护');
    if (game.butlerMaster === p.seat) tags.push('管家的主人');
    if (p.role === 'slayer' && game.slayerUsed) tags.push('杀手能力已用');
    if (p.role === 'virgin' && game.virginUsed) tags.push('首次提名已发生');
    for (const [role, mark] of Object.entries(game.infoReminders || {})) {
      if (mark.correct === p.seat) tags.push(`${getRole(role).name}正确标记：${getRole(mark.roleId).name}`);
      if (mark.wrong === p.seat) tags.push(`${getRole(role).name}错误标记`);
    }
    let roleName = getRole(p.role).name;
    if (impaired && game.rng() < 0.35) {
      roleName = getRole(pick(ALL_IDS, game.rng)).name;
    }
    return { seat: p.seat, name: p.name, role: roleName, tags };
  });
  const bluffs = (game.demonBluffs || []).map((id) => getRole(id).name).join('、');
  return { kind: 'grimoire', title: '魔典', lines: ['所有人当前的真实身份（只有你能看到）。',
    ...(bluffs ? ['恶魔伪装提示：' + bluffs] : [])], rows };
}

/** AI 只能选引擎生成的候选卡，不接受模型自由拼接的身份或数字。 */
function informationOptions(game, request) {
  const options = [];
  const seen = new Set();
  const add = (cards) => {
    const key = JSON.stringify(cards);
    if (!seen.has(key)) { seen.add(key); options.push({ id: 'option-' + options.length, cards }); }
  };
  add(request.truth);
  // 独立随机源不改变实际发牌、夜间行动或之后的自动回退答案。
  const preview = Object.create(game);
  preview.rng = mulberry32((game.seed ^ request.id ^ (game.round << 16)) >>> 0);
  preview._varyRegistrations = true;
  for (let i = 0; i < 16; i++) {
    if (request.step === 'fortune_teller') add([fortuneTellerCard(preview, request.seat, request.context.targets)]);
    else if (request.step === 'ravenkeeper') add([ravenkeeperCard(preview, request.seat, request.context.targets[0])]);
    else add(infoCards(preview, { role: request.step, seat: request.seat }));
  }
  return options;
}

module.exports = {
  FIRST_NIGHT,
  OTHER_NIGHTS,
  ACTION,
  buildSteps,
  advance,
  submit,
  registerEvil,
  registerDemon,
  registerTownsfolk,
  registersAs,
  countEvilPairs,
  aliveNeighbours,
  makePending,
  informationOptions,
};
