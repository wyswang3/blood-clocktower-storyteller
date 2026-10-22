'use strict';

const { roleCard, getRole, teamOf, TYPE_LABEL } = require('./roles');
const { aliveCount, countVotes, eligibleVoters } = require('./day');

/**
 * 视图裁剪：这里是整套系统的命门。
 * 所有给前端的数据都在这里生成，前端没有任何身份数据来源。
 * 只要不在这两个函数里塞东西，前端就不可能出现别人的身份。
 */

const PHASE_LABEL = {
  lobby: '准备中',
  reveal: '查看身份',
  night: '夜晚',
  day: '白天',
  ended: '结束',
};

const WIN_LABEL = {
  'demon-dead': '恶魔已死',
  'two-alive': '只剩两名玩家存活',
  manual: '全桌确认，房主提前宣布',
  saint: '圣徒被处决',
  mayor: '镇长三人生存且无人被处决',
};

function deadlineOf(g) {
  if (!g.day) return null;
  if (g.day.vote) return g.day.vote.deadline;
  if (g.day.sub === 'discuss') return g.day.deadline;
  return null;
}

function slimSeat(p) {
  return { seat: p.seat, name: p.name, alive: p.alive, joined: p.joined };
}

function announcedAlive(g, p) {
  return p.alive || !!(g.phase === 'night' && g.night && g.night.deadTonight.includes(p.seat));
}

function publicView(g) {
  const d = g.day;
  const seats = g.players.map((p) => ({
    seat: p.seat,
    name: p.name,
    alive: announcedAlive(g, p),
    joined: p.joined,
    connected: !!p.connected,
    confirmed: !!p.confirmed,
    hasNominated: !!(d && d.nominators.includes(p.seat)),
    nominated: !!(d && d.nominatedSeats.includes(p.seat)),
    voted: !!(d && d.vote && d.vote.votes.some((v) => v.seat === p.seat)),
  }));

  const day = d
    ? {
        sub: d.sub,
        deadline: d.deadline,
        threshold: Math.ceil(aliveCount(g) / 2),
        vote: d.vote
          ? {
              nominator: d.vote.nominator,
              nominee: d.vote.nominee,
              deadline: d.vote.deadline,
              yes: countYes(g, d.vote),
              no: d.vote.votes.filter((v) => !v.yes).length,
              voted: d.vote.votes.length,
              alive: aliveCount(g),
              eligible: eligibleVoters(g, d.vote).length,
              threshold: Math.ceil(aliveCount(g) / 2),
              votes: d.vote.votes.map((v) => ({ seat: v.seat, yes: !!v.yes })),
            }
          : null,
        lastVote: d.lastVote,
        nominations: d.nominations.map((n) => ({
          nominator: n.nominator,
          nominee: n.nominee,
          count: n.count,
          yes: n.yes || [],
          no: n.no || [],
          votes: n.votes || [],
        })),
        executed: d.executed
          ? { seat: d.executed.seat, name: g.players[d.executed.seat - 1] ? g.players[d.executed.seat - 1].name : '' }
          : null,
        onTheBlock: bestNomination(d),
      }
    : null;

  return {
    v: 1,
    phase: g.phase,
    phaseLabel: PHASE_LABEL[g.phase] || g.phase,
    round: g.round,
    now: Date.now(),
    deadline: deadlineOf(g),
    playerCount: g.players.length,
    seats,
    joinedCount: g.players.filter((p) => p.joined).length,
    confirmedCount: g.players.filter((p) => p.confirmed).length,
    night: {
      active: g.phase === 'night',
      waiting: !!(g.night && g.night.pending),
      waitingSince: g.night && g.night.pending ? g.night.pendingAt || null : null,
    },
    day,
    voteHistory: g.voteHistory || [],
    infoMode: g.infoMode || 'auto',
    storytellerOnline: g.storytellerOnline || 0,
    log: g.log.slice(-60),
    config: { allowBaron: !!(g.config && g.config.allowBaron) },
    settings: { discussMs: g.settings.discussMs, voteMs: g.settings.voteMs },
    winner: g.winner,
    winReason: g.winReason,
    winReasonLabel: g.winReason ? WIN_LABEL[g.winReason] || g.winReason : null,
    // 游戏结束后给复盘用的时间线；进行中为 null
    timeline:
      g.phase === 'ended'
        ? g.deaths.map((d) => {
            const atNight = d.cause === 'night' || d.cause === 'selfkill';
            const killed = atNight || d.cause === 'slayer';
            return {
              round: d.round,
              seat: d.seat,
              name: g.players[d.seat - 1] ? g.players[d.seat - 1].name : '',
              how: killed ? '死亡' : '被处决',
              where: atNight ? '夜里' : '白天',
            };
          })
        : null,
    // 游戏结束后整桌亮牌，方便复盘；进行中这里是 null
    finalRoles:
      g.phase === 'ended'
        ? g.players.map((p) => ({
            seat: p.seat,
            name: p.name,
            id: p.role,
            role: getRole(p.role).name,
            typeLabel: TYPE_LABEL[getRole(p.role).type],
            team: teamOf(p.role),
          }))
        : null,
  };
}

function countYes(g, vote) {
  // 公开票数用同一套计票规则，避免"显示 5 票实际算 4 票"
  return countVotes(g, { votes: vote.votes }).count;
}

function bestNomination(d) {
  if (!d || !d.nominations.length) return null;
  let best = null;
  for (const n of d.nominations) {
    if (n.threshold != null && n.count < n.threshold) continue;
    if (!best || n.count > best.count) best = n;
  }
  if (!best || best.count === 0) return null;
  const tied = d.nominations.filter((n) => n.count === best.count && (n.threshold == null || n.count >= n.threshold));
  return { seat: best.nominee, count: best.count, tied: tied.length > 1 };
}

function pendingForSeat(g, seat) {
  const p = g.night && g.night.pending;
  if (!p || p.seat !== seat) return null;
  return {
    type: p.type,
    prompt: p.prompt,
    options: p.options || [],
    min: p.min || 0,
    max: p.max || 0,
    cards: p.cards || [],
    awaiting: !!p.awaiting,
  };
}

function dayForSeat(g, p) {
  const d = g.day;
  if (!d || g.phase !== 'day') return null;
  const seat = p.seat;
  // 存活者可以提名死者；本桌禁止自提，且每人每天最多被提名一次。
  const candidates = p.alive
    ? g.players.filter((x) => x.seat !== seat && !d.nominatedSeats.includes(x.seat))
    : [];
  // 没人可选的时候就不该给"可以提名"的界面，否则玩家点开是空的
  const canNominate =
    p.alive &&
    d.sub === 'nominate' &&
    !d.vote &&
    !d.nominators.includes(seat) &&
    candidates.length > 0;

  const targets = canNominate ? candidates.map(slimSeat) : [];

  let vote = null;
  if (d.vote) {
    const mine = d.vote.votes.find((v) => v.seat === seat);
    let note = null;
    if (p.believed === 'butler' && p.alive) {
      const master = g.butlerMaster;
      const masterVoted = d.vote.votes.find((v) => v.seat === master && v.yes);
      if (master && !masterVoted) {
        note = `你的主人 ${master}号 还没投同意票，请勿投同意。主人死亡后仍须等他使用幽灵票；误投的票正常计入。`;
      }
    }
    if (!p.alive && !p.ghostVoteUsed) {
      note = '你已死亡：投同意会消耗唯一的幽灵票；反对或不投不会消耗。';
    }
    vote = {
      open: true,
      nominator: d.vote.nominator,
      nominee: d.vote.nominee,
      nominatorName: g.players[d.vote.nominator - 1] ? g.players[d.vote.nominator - 1].name : '',
      nomineeName: g.players[d.vote.nominee - 1] ? g.players[d.vote.nominee - 1].name : '',
      deadline: d.vote.deadline,
      yes: countYes(g, d.vote),
      no: d.vote.votes.filter((v) => !v.yes).length,
      threshold: Math.ceil(aliveCount(g) / 2),
      canVote: (p.alive || !p.ghostVoteUsed) && !mine,
      myVote: mine ? mine.yes : null,
      ghost: !p.alive && !p.ghostVoteUsed,
      note,
    };
  }

  // 公开开枪：每个人都有按钮，谁都可以宣称自己是杀手；界面不泄露谁是真杀手
  let slayer = null;
  if (p.alive && d.sub !== 'ended') {
    slayer = {
      available: true,
      targets: g.players.map(slimSeat),
    };
  }

  return {
    sub: d.sub,
    canNominate,
    hasNominated: d.nominators.includes(seat),
    hasBeenNominated: d.nominatedSeats.includes(seat),
    targets,
    vote,
    slayer,
    butler:
      p.believed === 'butler'
        ? { master: g.butlerMaster, masterName: g.butlerMaster ? g.players[g.butlerMaster - 1].name : null }
        : null,
    note: !p.alive
      ? p.ghostVoteUsed
        ? '你已死亡：可以继续发言，不能提名、用能力；幽灵票已经用掉了。'
        : '你已死亡：可以继续发言，不能提名或用能力；本局还有一张幽灵票，投票时可以用一次。'
      : null,
  };
}

function seatView(g, seat) {
  const p = g.players[seat - 1];
  // 真身份只有对局结束后才亮出来：酒鬼到这一刻才知道自己是酒鬼
  const ended = g.phase === 'ended';
  const believedCard = p.believed ? roleCard(p.believed) : null;
  const trueCard = p.role ? roleCard(p.role) : null;
  return {
    seat,
    name: p.name,
    alive: announcedAlive(g, p),
    joined: p.joined,
    now: Date.now(),
    pub: publicView(g),
    me: {
      seat,
      name: p.name,
      alive: announcedAlive(g, p),
      confirmed: !!p.confirmed,
      ghostVoteUsed: !!p.ghostVoteUsed,
      ghostVote: !announcedAlive(g, p) && !p.ghostVoteUsed,
      role: ended ? trueCard : believedCard,
      wasFooled: !!(ended && p.role && p.believed && p.role !== p.believed),
      trueRole: ended ? trueCard : null,
      // 只有本人的视图里才有这份名单；公共视图和其它座位都看不到
      suspicion: (g.suspicion && g.suspicion[seat]) ? g.suspicion[seat].slice() : [],
      board: { ...((g.board && g.board[seat]) || {}) },
    },
    alerts: (g.alerts[seat] || []).slice(-8),
    knowledge: g.knowledge[seat] || [],
    night: {
      active: g.phase === 'night',
      myTurn: !!(g.night && g.night.pending && g.night.pending.seat === seat),
      pending: pendingForSeat(g, seat),
    },
    day: dayForSeat(g, p),
  };
}

/**
 * 说书人（AI）专用视图：整本魔典 + 待裁量的情报请求。
 * 只发给带 PIN 的 storyteller 连接，绝不能进公共视图。
 */
function storytellerView(g) {
  return {
    now: Date.now(),
    phase: g.phase,
    round: g.round,
    winner: g.winner,
    winReason: g.winReason,
    infoMode: g.infoMode,
    players: g.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      role: p.role,
      believed: p.believed,
      alive: p.alive,
      joined: p.joined,
      poisoned: g.poisoned === p.seat,
      drunk: p.role === 'drunk',
      ghostVoteUsed: !!p.ghostVoteUsed,
    })),
    night: g.night
      ? {
          number: g.night.number,
          index: g.night.index,
          pending: g.night.pending
            ? {
                seat: g.night.pending.seat,
                type: g.night.pending.type,
                step: g.night.pending.step,
                prompt: g.night.pending.prompt,
                awaiting: !!g.night.pending.awaiting,
              }
            : null,
        }
      : null,
    day: g.day ? { sub: g.day.sub, vote: g.day.vote ? { nominator: g.day.vote.nominator, nominee: g.day.vote.nominee } : null } : null,
    request: g.stRequest ? { ...g.stRequest } : null,
    log: g.log.slice(-40),
  };
}

module.exports = {
  PHASE_LABEL,
  WIN_LABEL,
  publicView,
  seatView,
  storytellerView,
  deadlineOf,
};
