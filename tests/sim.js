'use strict';

/**
 * 模拟对局：脚本假装 7 个（或 5-15 个）客户端，自动跑完整一局。
 * 每收到一帧服务端视图就校验一次不变量 —— 这是"信息隔离"唯一靠得住的验证方式。
 *
 * 用法：node tests/sim.js [局数] [人数]
 */

const { Game } = require('../engine/game');
const { ROLES } = require('../engine/roles');

const ROLE_IDS = new Set(Object.keys(ROLES));
const ROLE_NAMES = new Set(Object.values(ROLES).map((r) => r.name));

/** 这些路径下出现角色名是合法的：自己的身份、自己的情报、给自己的提醒。 */
const ALLOWED_SEAT_PATHS = [
  /^\/me\/role\//,
  /^\/me\/trueRole\//,
  /^\/me\/board\//,
  /^\/knowledge\//,
  /^\/night\/pending\/cards\//,
  /^\/alerts\//,
  /^\/pub\/finalRoles\//,
];

function allowedSeatPath(path) {
  return ALLOWED_SEAT_PATHS.some((re) => re.test(path));
}

function scanStrings(value, path, out) {
  if (typeof value === 'string') {
    out.push([path, value]);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanStrings(v, `${path}/${i}`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) scanStrings(value[k], `${path}/${k}`, out);
  }
  return out;
}

function containsRole(text) {
  // 杀手是公开宣称：日志里"宣称自己是杀手""杀手能力"都不算泄密
  const t = text.replace(/杀手能力/g, '能力').replace(/宣称自己是杀手/g, '宣称开枪');
  if (ROLE_NAMES.has(t) || ROLE_IDS.has(t)) return true;
  for (const name of ROLE_NAMES) if (t.includes(name)) return true;
  return false;
}

const PUBLIC_SEAT_KEYS = new Set([
  'seat', 'name', 'alive', 'joined', 'connected', 'confirmed', 'hasNominated', 'nominated', 'voted',
]);

class Checker {
  constructor(game) {
    this.game = game;
    this.violations = [];
    this.frames = 0;
  }

  add(kind, detail) {
    if (this.violations.length < 40) this.violations.push({ kind, detail });
  }

  checkEvent(evt) {
    this.frames++;
    const g = this.game;
    if (evt.kind === 'public') {
      this.checkPublic(evt.view);
    } else if (evt.kind === 'seat') {
      this.checkPublic(evt.view.pub);
      this.checkSeat(evt.view, evt.seat);
    }
  }

  checkPublic(pub) {
    if (!pub || !pub.seats) return this.add('public-empty', 'public 视图缺字段');
    if ('suspicion' in pub) this.add('suspicion-leak', '公共视图出现了怀疑名单');
    if ('board' in pub) this.add('board-leak', '公共视图出现了私人板子');
    const n = this.game.players.length;
    if (pub.seats.length !== n) this.add('seat-count', `pub seats=${pub.seats.length} 实际=${n}`);
    for (const s of pub.seats) {
      for (const k of Object.keys(s)) {
        if (!PUBLIC_SEAT_KEYS.has(k)) this.add('public-seat-key', `座位 ${s.seat} 多了字段 ${k}`);
      }
    }
    const strings = scanStrings(pub, '', []);
    // 游戏结束后整桌亮牌，公开视图出现身份是设计内的
    if (pub.phase !== 'ended') {
      for (const [path, text] of strings) {
        if (containsRole(text)) this.add('public-role-leak', `${path} = ${text}`);
      }
    }
    if (pub.day && pub.day.vote) {
      const vote = pub.day.vote;
      if (vote.voted > vote.eligible || vote.eligible > n) this.add('vote-overflow', '回应人数超过本轮可投票人数');
      if (vote.yes + vote.no > vote.voted) this.add('vote-overflow2', '票数超过回应人数');
    }
    // 死亡即时影响引擎；夜间死亡到黎明才向公共屏公布。
    const aliveCount = this.game.players.filter((p) => p.alive ||
      (this.game.phase === 'night' && this.game.night && this.game.night.deadTonight.includes(p.seat))).length;
    const pubAlive = pub.seats.filter((s) => s.alive).length;
    if (aliveCount !== pubAlive) this.add('alive-mismatch', `服务端 ${aliveCount} 公开 ${pubAlive}`);
    if (pub.seats.filter((s) => s.alive).length + pub.seats.filter((s) => !s.alive).length !== n) {
      this.add('alive-sum', '活人 + 死人 != 总人数');
    }
  }

  checkSeat(view, seat) {
    const g = this.game;
    const p = g.players[seat - 1];
    if (view.seat !== seat) this.add('seat-view-mismatch', `${view.seat} != ${seat}`);
    if (!p.believed) return;
    if (!view.me || !view.me.role) return this.add('seat-role-missing', `座位 ${seat} 没有身份卡`);
    // 进行中看的是"他以为的身份"；结束后亮的是真身份（酒鬼就是在这时候翻的）
    const expected = view.pub && view.pub.phase === 'ended' ? p.role : p.believed;
    if (view.me.role.id !== expected) {
      this.add('seat-role-wrong', `座位 ${seat} 显示 ${view.me.role.id}，应为 ${expected}`);
    }
    // 没结束就不许把真身份亮出来
    if (view.pub && view.pub.phase !== 'ended' && view.me.trueRole) {
      this.add('early-reveal', `座位 ${seat} 还没结束就拿到了真身份`);
    }
    // 除自己的身份/情报/提醒外，视图里不该出现任何角色名
    const strings = scanStrings(view, '', []);
    const pubEnded = view.pub && view.pub.phase === 'ended';
    for (const [path, text] of strings) {
      if (allowedSeatPath(path)) continue;
      if (pubEnded && path.startsWith('/pub/')) continue;
      if (containsRole(text)) this.add('seat-role-leak', `座位 ${seat} ${path} = ${text}`);
    }
    // 魔典只有间谍能拿到。只看"当前这一手"：间谍被传位成恶魔后，
    // 之前看过的魔典仍然留在他的情报里，那是合法的历史记录。
    const pendingGrimoire =
      !!view.night && !!view.night.pending && (view.night.pending.cards || []).some((c) => c.kind === 'grimoire');
    if (pendingGrimoire && p.believed !== 'spy') {
      this.add('grimoire-leak', `座位 ${seat} 当前身份 ${p.believed} 拿到了魔典`);
    }
    this.checkOperable(view, seat, p);
  }

  /** 可操作性：这一帧玩家/房主是不是真的有下一步可点，会不会卡死 */
  checkOperable(view, seat, p) {
    const g = this.game;
    const pub = view.pub;
    const pending = view.night && view.night.pending;

    // 夜里：每个"等玩家操作"的步骤，必须给得出足够的选项目标
    if (pending) {
      if (pending.type === 'choose') {
        const opts = pending.options || [];
        if (opts.length < pending.max) {
          this.add('dead-end-choice', `座位 ${seat} 只能选 ${opts.length} 个，但要求 ${pending.max} 个`);
        }
        if (opts.length === 0) this.add('dead-end-empty', `座位 ${seat} 没有任何可选目标`);
      }
      // 醒着的必须活着；唯一的例外是守鸦人（今夜刚死，死的那个可以醒）
      if (!p.alive) {
        const diedTonight = g.deaths.some(
          (d) =>
            d.seat === seat &&
            d.round === g.round &&
            (d.cause === 'night' || d.cause === 'selfkill')
        );
        if (!diedTonight) this.add('dead-wakes', `座位 ${seat} 已经死了却被叫醒`);
      }
    }

    // 夜里每帧都必须有人在操作，不然就是卡死
    if (pub.phase === 'night' && g.night && !g.night.pending) {
      this.add('night-stuck', '夜里没有等待项，也没进入白天');
    }

    // 白天投票：活着的人必须能投，或者已经投过
    if (pub.phase === 'day' && pub.day && pub.day.vote && p.alive) {
      const mine = view.day && view.day.vote;
      if (!mine) {
        this.add('vote-view-missing', `座位 ${seat} 投票开着但没有投票界面`);
      } else if (!mine.canVote && mine.myVote == null) {
        this.add('vote-dead-end', `座位 ${seat} 既不能投也查不到投票记录`);
      }
    }

    // 白天提名：活着、没提名过的人，必须拿得到可选目标（除非所有人都被提名过了）
    if (pub.phase === 'day' && pub.day && pub.day.sub === 'nominate' && p.alive) {
      const d = view.day || {};
      if (d.canNominate && (d.targets || []).length === 0) {
        this.add('nominate-dead-end', `座位 ${seat} 可以提名，但没有可选目标`);
      }
    }
  }
}

function randomChoice(game, arr) {
  if (!arr.length) return null;
  return arr[Math.floor(game.rng() * arr.length)];
}

function botPlay(game, opts = {}) {
  const maxSteps = opts.maxSteps || 900;
  const stats = opts.stats || { nights: 0, steps: 0 };
  let steps = 0;
  let shots = 0;

  const startNight = (n) => {
    game.beginNight(n);
    stats.nights++;
    if (game.night) stats.steps += game.night.steps.length;
  };

  while (steps++ < maxSteps) {
    if (game.phase === 'ended') return { ok: true, steps };
    if (game.phase === 'reveal') {
      startNight(1);
      continue;
    }
    if (game.phase === 'night') {
      const p = game.night && game.night.pending;
      if (!p) return { ok: false, steps, error: '夜晚没有等待项却没结束' };
      if (p.type === 'info') {
        game.submitNight(p.seat, {});
        continue;
      }
      const count = p.min + Math.floor(game.rng() * (p.max - p.min + 1));
      let pool = p.options.map((o) => o.seat);
      // 真人很少自刀，机器人也别老是自刀，不然"恶魔第几轮死"的统计全被搅乱
      if (p.prompt && p.prompt.includes('传位') && game.rng() < 0.9) {
        pool = pool.filter((s) => s !== p.seat);
      }
      const targets = [];
      while (targets.length < count && pool.length) {
        const pickIdx = Math.floor(game.rng() * pool.length);
        targets.push(pool.splice(pickIdx, 1)[0]);
      }
      const res = game.submitNight(p.seat, { targets });
      if (!res.ok) return { ok: false, steps, error: '夜间提交失败: ' + res.error };
      continue;
    }
    if (game.phase === 'day') {
      const d = game.day;
      if (d.sub === 'discuss') {
        if (!shots && game.rng() < 0.3) {
          const slayer = game.players.find((x) => x.alive && x.believed === 'slayer');
          if (slayer && !game.slayerUsed) {
            const targets = game.players.filter((x) => x.alive && x.seat !== slayer.seat);
            const t = randomChoice(game, targets);
            if (t) {
              shots++;
              game.slayerShoot(slayer.seat, t.seat);
            }
          }
        }
        game.beginNominations();
        continue;
      }
      if (d.sub === 'nominate') {
        if (game.rng() < 0.3) {
          game.endNominations();
          continue;
        }
        const nominators = game.players.filter(
          (x) => x.alive && !d.nominators.includes(x.seat)
        );
        const targets = game.players.filter(
          (x) => x.alive && !d.nominatedSeats.includes(x.seat)
        );
        let picked = null;
        for (let tries = 0; tries < 20 && !picked; tries++) {
          const a = randomChoice(game, nominators);
          const b = randomChoice(game, targets);
          if (a && b && a.seat !== b.seat) picked = [a, b];
        }
        if (!picked) {
          game.endNominations();
          continue;
        }
        const res = game.nominate(picked[0].seat, picked[1].seat);
        if (!res.ok) return { ok: false, steps, error: '提名失败: ' + res.error };
        continue;
      }
      if (d.sub === 'vote') {
        const voters = game.players.filter((x) => x.alive || !x.ghostVoteUsed);
        for (const v of voters) {
          if (!game.day || !game.day.vote) break;
          if (game.day.vote.votes.some((x) => x.seat === v.seat)) continue;
          game.castVote(v.seat, game.rng() < 0.55);
        }
        if (game.day && game.day.vote) game.closeVote();
        continue;
      }
      if (d.sub === 'ended') {
        startNight(game.round + 1);
        continue;
      }
      return { ok: false, steps, error: '未知白天子阶段: ' + d.sub };
    }
    return { ok: false, steps, error: '未知阶段: ' + game.phase };
  }
  return { ok: false, steps, error: '步数超限，游戏没结束' };
}

function runGame(seed, playerCount = 7) {
  const game = new Game({ seed, playerCount });
  for (let s = 1; s <= playerCount; s++) game.claim(s, null, '玩家' + s);
  const checker = new Checker(game);
  game.subscribe((evt) => checker.checkEvent(evt));
  const start = game.start();
  if (!start.ok) throw new Error('开局失败: ' + start.error);
  const demonSeat = game.players.find((p) => p.role === 'imp').seat;
  for (let s = 1; s <= playerCount; s++) game.confirm(s);
  const stats = { nights: 0, steps: 0 };
  const out = botPlay(game, { stats });
  if (!out.ok) checker.add('bot-stuck', out.error || '未知');
  if (game.phase !== 'ended') checker.add('no-winner', '游戏没有结束');
  if (game.phase === 'ended' && !['good', 'evil'].includes(game.winner)) {
    checker.add('bad-winner', String(game.winner));
  }
  const demonDeath = game.deaths.find((d) => d.seat === demonSeat);
  return {
    seed,
    playerCount,
    winner: game.winner,
    winReason: game.winReason,
    rounds: game.round,
    roles: game.players.map((p) => p.role),
    baron: !!game.baron,
    steps: out.steps,
    frames: checker.frames,
    violations: checker.violations,
    nights: stats.nights,
    nightSteps: stats.steps,
    demonSeat,
    // 原始恶魔第几轮死的；没死就是 null（坏人赢或换了人）
    demonDeathRound: demonDeath ? demonDeath.round : null,
    demonDeathHow: demonDeath ? demonDeath.cause : null,
  };
}

function runMany(count, playerCount = 7) {
  const results = [];
  for (let i = 0; i < count; i++) {
    results.push(runGame(9000 + i * 37, playerCount));
  }
  return results;
}

function summarize(results) {
  const bad = results.filter((r) => r.violations.length);
  const byKind = {};
  for (const r of results) for (const v of r.violations) byKind[v.kind] = (byKind[v.kind] || 0) + 1;
  const wins = { good: 0, evil: 0 };
  for (const r of results) wins[r.winner] = (wins[r.winner] || 0) + 1;

  // 节奏：原始恶魔第几轮死、一局几夜、一夜多少步
  const demonRounds = results.map((r) => r.demonDeathRound).filter((x) => x != null);
  const hist = {};
  for (const x of demonRounds) hist[x] = (hist[x] || 0) + 1;
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const byHow = {};
  for (const r of results) {
    if (!r.demonDeathHow) continue;
    byHow[r.demonDeathHow] = (byHow[r.demonDeathHow] || 0) + 1;
  }
  // 真正有参考价值的是"被投票处决"那一档：夜里死只有自刀一种可能
  const voted = results.filter((r) => r.demonDeathHow === 'vote').map((r) => r.demonDeathRound);
  const votedHist = {};
  for (const x of voted) votedHist[x] = (votedHist[x] || 0) + 1;

  return {
    games: results.length,
    badGames: bad.length,
    winners: wins,
    byKind,
    avgFrames: Math.round(results.reduce((a, r) => a + r.frames, 0) / results.length),
    avgRounds: avg(results.map((r) => r.rounds)).toFixed(1),
    demonKilledRate: demonRounds.length ? `${demonRounds.length}/${results.length}` : `0/${results.length}`,
    demonDeathRound: {
      avg: avg(demonRounds).toFixed(1),
      median: median(demonRounds),
      hist,
    },
    demonDeathHow: byHow,
    demonVoteRound: {
      games: voted.length,
      avg: avg(voted).toFixed(1),
      median: median(voted),
      hist: votedHist,
    },
    nightSteps: {
      perNight: avg(results.map((r) => (r.nights ? r.nightSteps / r.nights : 0))).toFixed(1),
      totalPerGame: avg(results.map((r) => r.nightSteps)).toFixed(1),
    },
  };
}

module.exports = { runGame, runMany, summarize, botPlay, Checker };

if (require.main === module) {
  const count = Number(process.argv[2]) || 100;
  const players = Number(process.argv[3]) || 7;
  const t0 = Date.now();
  const results = runMany(count, players);
  const s = summarize(results);
  console.log(JSON.stringify(s, null, 2));
  if (s.badGames) {
    const first = results.find((r) => r.violations.length);
    console.log('第一局问题用例:', JSON.stringify(first, null, 2));
  }
  console.log(`耗时 ${Date.now() - t0} ms`);
  process.exit(s.badGames ? 1 : 0);
}
