'use strict';

function aliveCount(game) {
  return game.players.filter((p) => p.alive).length;
}

/** 本轮可回应的座位固定下来；兼容修复前保存的投票，保留已用幽灵票的本轮投票者。 */
function eligibleVoters(game, vote) {
  if (Array.isArray(vote.eligibleSeats)) return vote.eligibleSeats;
  const voted = new Set(vote.votes.map((v) => v.seat));
  return game.players.filter((p) => p.alive || !p.ghostVoteUsed || voted.has(p.seat)).map((p) => p.seat);
}

/**
 * 按官方管家说明，违规票也要计入，避免据此验证身份或醉毒。
 * 管家由私密提醒约束，不能通过公开作废一票来处理。
 */
function countVotes(game, nomination) {
  const yes = [];
  const no = [];
  for (const v of nomination.votes) {
    if (v.yes) yes.push(v.seat);
    else no.push(v.seat);
  }
  return { yes, no, count: yes.length };
}

/** 恶魔死亡：红唇女郎接管。返回是否有人接手。 */
function onDemonDeath(game, aliveBeforeDeath) {
  if (game.winner) return false;
  const sw = game.players.find((p) => p.alive && p.role === 'scarlet_woman');
  if (!sw) return false;
  if (game.isImpaired(sw.seat)) return false;
  if (aliveBeforeDeath < 5) return false;
  game.promoteToImp(sw.seat);
  return true;
}

/** 胜负判定。恶魔先判，因为恶魔一死游戏立刻结束。 */
function checkWin(game) {
  if (game.winner) return game.winner;
  const demonAlive = game.players.some((p) => p.alive && p.role === 'imp');
  if (!demonAlive) {
    game.winner = 'good';
    game.winReason = game.winReason || 'demon-dead';
    return game.winner;
  }
  // 三人残局继续进行，死者保留的幽灵票仍可能帮助好人处决恶魔。
  if (aliveCount(game) <= 2) {
    game.winner = 'evil';
    game.winReason = game.winReason || 'two-alive';
    return game.winner;
  }
  return null;
}

/** 处决一名玩家（含贞洁烈女触发的当场处决、结束时票最高的处决）。 */
function execute(game, seat, reason = 'execution') {
  const p = game.players[seat - 1];
  if (!p) return;
  if (!p.alive) {
    game.addLog(`${seat}号（${p.name}）被处决，但此前已经死亡。`);
    if (game.day) game.day.executed = { seat, role: p.role, reason, died: false };
    return;
  }
  const wasSaint = p.role === 'saint' && !game.isImpaired(seat);
  const wasDemon = p.role === 'imp';
  const aliveBeforeDeath = aliveCount(game);
  game.kill(seat, reason);
  game.addLog(`${seat}号（${p.name}）被处决。`);
  if (game.day) game.day.executed = { seat, role: p.role, reason, died: true };
  if (wasSaint) {
    game.winner = 'evil';
    game.winReason = 'saint';
    return;
  }
  if (wasDemon) onDemonDeath(game, aliveBeforeDeath);
  checkWin(game);
}

/** 一天结束：记下"昨天被处决的人"给掘墓人；镇长三人局判定。 */
function finishDay(game) {
  game.yesterdayExecution = game.day && game.day.executed ? game.day.executed : null;
  if (!game.winner && !game.day.executed && aliveCount(game) === 3) {
    const mayorAlive = game.players.find(
      (p) => p.alive && p.role === 'mayor' && !game.isImpaired(p.seat)
    );
    if (mayorAlive) {
      game.winner = 'good';
      game.winReason = 'mayor';
    }
  }
  checkWin(game);
}

module.exports = {
  aliveCount,
  eligibleVoters,
  countVotes,
  onDemonDeath,
  checkWin,
  execute,
  finishDay,
};
