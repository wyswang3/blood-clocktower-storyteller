'use strict';

const { TYPE, ROLES, idsByType, getRole } = require('./roles');
const { shuffle, pick, pickMany } = require('./util');

/**
 * 暗流涌动标准配比 [镇民, 外来者, 爪牙, 恶魔]
 * 5人 3/0/1/1，7人 5/0/1/1，男爵在场各减 2 镇民、加 2 外来者。
 */
const BASE = {
  5: [3, 0, 1, 1],
  6: [3, 1, 1, 1],
  7: [5, 0, 1, 1],
  8: [5, 1, 1, 1],
  9: [5, 2, 1, 1],
  10: [7, 0, 2, 1],
  11: [7, 1, 2, 1],
  12: [7, 2, 2, 1],
  13: [9, 0, 3, 1],
  14: [9, 1, 3, 1],
  15: [9, 2, 3, 1],
};

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 15;
/** 男爵出现概率（房主可在开局前关掉）。 */
const BARON_CHANCE = 0.35;

/** 酒鬼假身份的唯一入口：只允许本局未使用的镇民。 */
function drunkDisguise(roles, rng) {
  const pool = idsByType(TYPE.TOWNSFOLK).filter((id) => !roles.includes(id));
  if (!pool.length) throw new Error('酒鬼没有可用的镇民假身份');
  const id = pick(pool, rng);
  if (!ROLES[id] || ROLES[id].type !== TYPE.TOWNSFOLK) throw new Error('酒鬼假身份必须是镇民');
  return id;
}

/** 恶魔的三个善良伪装角色；酒鬼拿到的镇民牌也不能用作提示。 */
function demonBluffs(roles, believed, playerCount, rng) {
  if (playerCount < 7) return [];
  const used = new Set([...roles, ...believed]);
  return pickMany([...idsByType(TYPE.TOWNSFOLK), ...idsByType(TYPE.OUTSIDER)].filter((id) => !used.has(id)), 3, rng);
}

function composition(playerCount, withBaron) {
  const base = BASE[playerCount];
  if (!base) throw new Error('人数必须在 5-15 之间: ' + playerCount);
  let [t, o, m, d] = base;
  if (withBaron) {
    t -= 2;
    o += 2;
  }
  if (t < 1) throw new Error('配比不合法：男爵会把镇民压到 0');
  if (o > idsByType(TYPE.OUTSIDER).length) throw new Error('配比不合法：外来者不够');
  return { townsfolk: t, outsider: o, minion: m, demon: d };
}

/**
 * 发牌。
 * @returns {{roles:string[], believed:string[], redHerring:number|null, baron:boolean, comp:object}}
 *   roles[seat-1] 是真身份；believed[seat-1] 是该玩家屏幕上显示的身份（只有酒鬼二者不同）。
 */
function buildSetup(playerCount, rng = Math.random, opts = {}) {
  if (playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    throw new Error('人数必须在 5-15 之间: ' + playerCount);
  }
  let withBaron;
  if (opts.baron === true) withBaron = true;
  else if (opts.baron === false) withBaron = false;
  else withBaron = playerCount >= 6 && rng() < BARON_CHANCE;

  const comp = composition(playerCount, withBaron);

  const minionPool = idsByType(TYPE.MINION).filter((id) => id !== 'baron');
  const pickedMinions = withBaron
    ? ['baron', ...pickMany(minionPool, comp.minion - 1, rng)]
    : pickMany(minionPool, comp.minion, rng);

  const pickedTownsfolk = pickMany(idsByType(TYPE.TOWNSFOLK), comp.townsfolk, rng);
  const pickedOutsiders = pickMany(idsByType(TYPE.OUTSIDER), comp.outsider, rng);

  const bag = shuffle(
    [...pickedTownsfolk, ...pickedOutsiders, ...pickedMinions, ...Array(comp.demon).fill('imp')],
    rng
  );

  const roles = bag.slice();
  const believed = bag.slice();

  // 酒鬼：屏幕上显示一个本局没有的镇民，真实身份藏在服务端。
  const drunkSeat = roles.indexOf('drunk');
  if (drunkSeat >= 0) {
    believed[drunkSeat] = drunkDisguise(roles, rng);
  }

  // 红鲱鱼：一名好人（不是恶魔），占卜师会把他当作恶魔。
  const goodSeats = roles
    .map((r, i) => ({ r, seat: i + 1 }))
    .filter((x) => {
      const t = getRole(x.r).type;
      return t === TYPE.TOWNSFOLK || t === TYPE.OUTSIDER;
    })
    .map((x) => x.seat);
  const redHerring = goodSeats.length ? pick(goodSeats, rng) : null;

  return {
    roles,
    believed,
    redHerring,
    demonBluffs: demonBluffs(roles, believed, playerCount, rng),
    baron: withBaron,
    comp,
  };
}

/** 这个人数下所有可能的配比（给测试和文档用）。 */
function allCompositions() {
  const out = [];
  for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
    out.push({ players: n, normal: composition(n, false), baron: composition(n, true) });
  }
  return out;
}

/**
 * 校验一份"配板子"名单：长度、角色存在、不重复、类型配比合法。
 * @param {string[]} roles 按座位顺序排的角色 id
 * @param {number} playerCount
 * @param {{allowBaron?: boolean}} opts
 */
function validateBoard(roles, playerCount, opts = {}) {
  if (!Array.isArray(roles)) return { ok: false, error: '板子必须是角色 id 数组' };
  if (roles.length !== playerCount) {
    return { ok: false, error: `板子要 ${playerCount} 张，现在 ${roles.length} 张` };
  }
  const seen = new Set();
  const counts = { townsfolk: 0, outsider: 0, minion: 0, demon: 0 };
  for (const id of roles) {
    const role = ROLES[id];
    if (!role) return { ok: false, error: `没有这个角色：${id}` };
    if (seen.has(id)) return { ok: false, error: `同一个角色不能放两张：${role.name}` };
    seen.add(id);
    counts[role.type]++;
  }
  if (counts.demon !== 1) return { ok: false, error: `恶魔必须正好 1 个，现在 ${counts.demon} 个` };

  const withBaron = seen.has('baron');
  if (withBaron && opts.allowBaron === false) {
    return { ok: false, error: '当前设置不允许男爵' };
  }
  const target = withBaron ? composition(playerCount, true) : composition(playerCount, false);
  const bad = ['townsfolk', 'outsider', 'minion', 'demon'].filter((k) => counts[k] !== target[k]);
  if (bad.length) {
    return {
      ok: false,
      error:
        `配比不对：需要 ${target.townsfolk}/${target.outsider}/${target.minion}/${target.demon}` +
        `（镇民/外来者/爪牙/恶魔），现在是 ${counts.townsfolk}/${counts.outsider}/${counts.minion}/${counts.demon}`,
    };
  }
  return { ok: true, counts, baron: withBaron };
}

/**
 * 按指定板子发牌（说书人/AI 配板用）。
 * 酒鬼的假身份从"本局没在场的镇民"里挑；红鲱鱼照旧从好人里挑。
 */
function setupFromRoles(roles, rng = Math.random) {
  const check = validateBoard(roles, roles.length);
  if (!check.ok) throw new Error(check.error);
  const believed = roles.slice();
  const drunkSeat = roles.indexOf('drunk');
  if (drunkSeat >= 0) {
    believed[drunkSeat] = drunkDisguise(roles, rng);
  }
  const goodSeats = roles
    .map((r, i) => ({ r, seat: i + 1 }))
    .filter((x) => {
      const t = getRole(x.r).type;
      return t === TYPE.TOWNSFOLK || t === TYPE.OUTSIDER;
    })
    .map((x) => x.seat);
  return {
    roles: roles.slice(),
    believed,
    redHerring: goodSeats.length ? pick(goodSeats, rng) : null,
    demonBluffs: demonBluffs(roles, believed, roles.length, rng),
    baron: check.baron,
    comp: check.counts,
  };
}

module.exports = {
  BASE,
  MIN_PLAYERS,
  MAX_PLAYERS,
  BARON_CHANCE,
  composition,
  buildSetup,
  allCompositions,
  validateBoard,
  setupFromRoles,
};
