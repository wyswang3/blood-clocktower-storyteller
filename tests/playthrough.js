'use strict';

/**
 * 走查：像一个真玩家那样，把一整局从头点到尾。
 *
 * 和 sim.js 的区别：sim 只看数据不变量；这里每一帧都真的调页面渲染函数，
 * 确认玩家此刻真的有东西可看、有按钮可点：
 *   - 自己的身份和技能
 *   - 全部角色表（22 个角色 + 技能）
 *   - 夜里的操作页（看牌 / 选人）
 *   - 白天的提名、投票、怀疑、推理
 *   - 平板每个阶段的下一步
 * 顺手统计每个人要掏几次手机、整局大概多长。
 *
 * 用法：node tests/playthrough.js [seed]
 */

const { Game } = require('../engine/game');
const { publicView, seatView } = require('../engine/state');
const { loadPage, setRoles, roleChoices } = require('./harness');

const NAMES = ['阿青', '小满', '老陈', '二丫', '阿康', '豆豆', '大伟'];

function check(cond, msg) {
  if (!cond) throw new Error('走查失败：' + msg);
}

/** 用游戏自己的随机源，同一个 seed 每次走查结果一样 */
function pickRandom(g, arr) {
  if (!arr.length) return null;
  return arr[Math.floor(g.rng() * arr.length)];
}

function hostScreen(host, v) {
  switch (v.phase) {
    case 'lobby':
      return host.lobbyScreen(v);
    case 'reveal':
      return host.revealScreen(v);
    case 'night':
      return host.nightScreen(v);
    case 'ended':
      return host.endScreen(v);
    default:
      return host.dayScreen(v);
  }
}

function playerTabs(player, v) {
  const tabs = {
    board: player.frame(v, player.boardBody(v)),
    note: player.frame(v, player.noteBody(v)),
    info: player.frame(v, player.infoBody(v)),
    me: player.frame(v, player.meBody(v)),
  };
  if (v.night && v.night.pending) tabs.action = player.frame(v, player.nightAction(v));
  return tabs;
}

function play(seed) {
  const g = new Game({ seed, playerCount: 7 });
  for (let s = 1; s <= 7; s++) g.claim(s, null, NAMES[s - 1]);
  const started = g.start();
  check(started.ok, '开局失败：' + started.error);
  for (let s = 1; s <= 7; s++) g.confirm(s);

  const host = loadPage('public/host.js');
  const player = loadPage('public/player.js');
  setRoles(player, roleChoices());

  const attention = {};
  for (let s = 1; s <= 7; s++) attention[s] = 0;
  const lines = [];
  let nightSteps = 0;
  let nights = 0;

  // ---- 发牌：每个人都要能看见自己的身份和技能 ----
  for (let s = 1; s <= 7; s++) {
    const v = seatView(g, s);
    const tabs = playerTabs(player, v);
    check(v.me.role, `${s}号 没有身份卡`);
    check(tabs.me.includes(v.me.role.name), `${s}号 的「身份」页看不到自己的角色名`);
    check(tabs.me.includes(v.me.role.brief.slice(0, 8)), `${s}号 的「身份」页看不到技能说明`);
    check(tabs.me.includes('hold-cover'), `${s}号 的身份卡没有防偷看遮罩`);
    check(tabs.note.includes('data-act="board-pick"'), `${s}号 的「推理」页打不开`);
    check(tabs.note.includes('data-act="role-sheet"'), `${s}号 的「推理」页没有角色表入口`);
    check(tabs.board.length > 0, `${s}号 的「局面」页是空的`);
    check(tabs.info.length > 0, `${s}号 的「情报」页是空的`);
  }

  // ---- 角色表：22 个角色 + 技能 ----
  const sheet = player.roleSheetHtml();
  for (const r of roleChoices()) {
    check(sheet.includes(r.name), `角色表里没有「${r.name}」`);
    check(sheet.includes(r.brief.slice(0, 8)), `角色表里「${r.name}」没有技能说明`);
  }
  check((sheet.match(/r-row/g) || []).length === 22, '角色表不是 22 行');

  // ---- 平板：发牌页 ----
  check(host.revealScreen(publicView(g)).includes('data-act="begin-night"'), '平板发牌页没有开始按钮');

  // ---- 主循环 ----
  let guard = 0;
  let votes = 0;
  let nominations = 0;
  while (g.phase !== 'ended' && guard++ < 400) {
    if (g.phase === 'reveal') {
      g.beginNight(1);
      nights++;
      nightSteps += g.night.steps.length;
      lines.push(`第 1 夜 · ${g.night.steps.length} 个步骤`);
      continue;
    }

    if (g.phase === 'night') {
      const p = g.night.pending;
      check(!!p, '夜里没有等待项（卡死）');
      const v = seatView(g, p.seat);
      const tabs = playerTabs(player, v);
      check(!!tabs.action, `${p.seat}号 轮到了，但操作页渲染不出来`);
      if (p.type === 'info') {
        check(tabs.action.includes('data-act="ack"'), `${p.seat}号 的情报卡没有"我看到了"按钮`);
      } else {
        check(tabs.action.includes('data-act="submit-night"'), `${p.seat}号 的选人页没有确认按钮`);
        check((p.options || []).length >= p.max, `${p.seat}号 可选项不够，点不下去`);
      }
      attention[p.seat]++;
      const cards = p.cards || [];
      const justAck = p.type === 'info' && cards.length === 1 && cards[0].title === '已记录';
      lines.push(
        `  轮到 ${p.seat}号（${p.type === 'choose' ? '选人' : justAck ? '确认' : '看情报'}）`
      );

      if (p.type === 'info') {
        g.submitNight(p.seat, {});
      } else {
        // 别自刀，真人不会；其余随机选，不然投毒者会天天毒同一个人
        const pool = p.options.filter(
          (o) => !(p.prompt || '').includes('传位') || o.seat !== p.seat
        );
        const from = pool.length ? pool : p.options;
        const targets = [];
        const rest = from.slice();
        while (targets.length < p.max && rest.length) {
          const chosen = pickRandom(g, rest);
          rest.splice(rest.indexOf(chosen), 1);
          targets.push(chosen.seat);
        }
        const r = g.submitNight(p.seat, { targets });
        check(r.ok, `夜间提交失败：${r.error}`);
      }
      continue;
    }

    if (g.phase === 'day') {
      const d = g.day;

      if (d.sub === 'discuss') {
        // 天亮后每个人都要有能看的局面
        for (const pl of g.players.filter((x) => x.alive)) {
          const tabs = playerTabs(player, seatView(g, pl.seat));
          check(tabs.board.includes('data-act="suspect"'), `${pl.seat}号 白天没有怀疑入口`);
        }
        const hostHtml = hostScreen(host, publicView(g));
        check(hostHtml.includes('board'), '平板白天没有棋盘');
        lines.push(`第 ${g.round} 天 · 讨论`);
        g.beginNominations();
        continue;
      }

      if (d.sub === 'nominate') {
        // 找一个合法提名
        const nominators = g.players.filter((x) => x.alive && !d.nominators.includes(x.seat));
        const targets = g.players.filter((x) => x.alive && !d.nominatedSeats.includes(x.seat));
        let pair = null;
        for (const a of nominators) {
          const b = targets.find((x) => x.seat !== a.seat);
          if (b) {
            pair = [a, b];
            break;
          }
        }
        if (!pair) {
          g.endNominations();
          continue;
        }
        const v = seatView(g, pair[0].seat);
        const tabs = playerTabs(player, v);
        check(tabs.board.includes('data-act="nominate"'), `${pair[0].seat}号 能提名却没有提名按钮`);
        g.nominate(pair[0].seat, pair[1].seat);
        nominations++;
        attention[pair[0].seat]++;
        lines.push(`  提名：${pair[0].seat}号 → ${pair[1].seat}号`);
        continue;
      }

      if (d.sub === 'vote') {
        const nominee = d.vote.nominee;
        for (const pl of g.players.filter((x) => x.alive)) {
          const v = seatView(g, pl.seat);
          const tabs = playerTabs(player, v);
          const voted = d.vote.votes.some((x) => x.seat === pl.seat);
          check(
            voted ? tabs.board.includes('你投了') : tabs.board.includes('data-act="vote"'),
            `${pl.seat}号 投票界面不对（voted=${voted}）`
          );
        }
        for (const pl of g.players.filter((x) => x.alive)) {
          if (g.day.vote) g.castVote(pl.seat, g.rng() < 0.65);
          votes++;
        }
        if (g.day.vote) g.closeVote();
        lines.push(`  投票：目标是 ${nominee}号`);
        continue;
      }

      if (d.sub === 'ended') {
        lines.push(`  结算：${d.executed ? d.executed.seat + '号 被处决' : '无人被处决'}`);
        g.beginNight(g.round + 1);
        nights++;
        nightSteps += g.night.steps.length;
        lines.push(`第 ${g.round} 夜 · ${g.night.steps.length} 个步骤`);
        continue;
      }
      throw new Error('走查失败：未知白天阶段 ' + d.sub);
    }
    throw new Error('走查失败：未知阶段 ' + g.phase);
  }

  check(g.phase === 'ended', '游戏没有结束（步数超限）');

  // ---- 结算页 ----
  const endHost = host.endScreen(publicView(g));
  check(endHost.includes('reveal-table'), '平板结算页没有亮牌');
  check(endHost.includes('data-act="reset"'), '平板结算页没有重开按钮');
  for (let s = 1; s <= 7; s++) {
    const v = seatView(g, s);
    const tabs = playerTabs(player, v);
    check(tabs.board.includes('你赢了') || tabs.board.includes('你输了'), `${s}号 结算页没有输赢结论`);
  }

  return { g, lines, attention, nightSteps, nights, votes, nominations };
}

function main() {
  const seed = Number(process.argv[2]) || 20261022;
  const { g, lines, attention, nightSteps, nights, votes, nominations } = play(seed);

  console.log(`\n=== 7 人一局走查（seed ${seed}）===\n`);
  const roster = g.players
    .map((p) => `${p.seat}号 ${p.name}：${p.believed === p.role ? '' : '（以为自己是 ' + p.believed + '）'}`)
    .join('  ');
  void roster;

  console.log(lines.join('\n'));
  console.log(`\n结局：${g.winner === 'good' ? '好人' : '坏人'}胜利（${g.winReason}），第 ${g.round} 轮`);

  const perSeat = Object.entries(attention)
    .map(([seat, n]) => `${seat}号 ${n} 次`)
    .join('，');
  console.log(`\n每人要掏手机的次数：${perSeat}`);

  // 时间模型：夜间一步 20 秒（串行）；一次提名投票 30 秒（所有人同时投）；讨论一天 5 分钟
  const nightMin = (nightSteps * 20) / 60;
  const voteMin = (nominations * 30) / 60;
  const discussMin = g.round * 5;
  const total = nightMin + voteMin + discussMin;
  console.log(
    `\n时间估算：夜 ${nights} 次共 ${nightSteps} 步 ≈ ${nightMin.toFixed(1)} 分钟；` +
      `提名投票 ${nominations} 次 × 30 秒 ≈ ${voteMin.toFixed(1)} 分钟（同时投，不按人头算）；` +
      `讨论 ${g.round} 天 × 5 分钟 = ${discussMin} 分钟。合计 ≈ ${total.toFixed(0)} 分钟。`
  );
  console.log('（模型假设：夜间一步 20 秒，一次投票 30 秒，讨论各 5 分钟。真人会有出入。）\n');
}

try {
  main();
} catch (e) {
  console.error('\n' + e.message + '\n');
  process.exit(1);
}
