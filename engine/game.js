'use strict';

const crypto = require('node:crypto');
const { buildSetup, setupFromRoles, validateBoard, MIN_PLAYERS, MAX_PLAYERS } = require('./setup');
const { ROLES } = require('./roles');
const nightMod = require('./night');
const dayMod = require('./day');
const stateMod = require('./state');
const { mulberry32 } = require('./util');

function newToken() {
  return crypto.randomBytes(12).toString('hex');
}

function cleanName(name) {
  const s = String(name == null ? '' : name).replace(/[<>\r\n\t]/g, '').trim().slice(0, 8);
  return s || null;
}

class Game {
  constructor(opts = {}) {
    this.seed = opts.seed || (Date.now() ^ Math.floor(Math.random() * 1e9));
    this.rng = mulberry32(this.seed);
    this.listeners = new Set();
    this.seq = 0;
    this.events = [];
    this.log = [];
    this.logId = 0;
    this.knowledge = {};
    this.alerts = {};
    this.alertId = 0;
    this.knowledgeId = 0;
    this.deaths = [];
    this.settings = { discussMs: 5 * 60 * 1000, voteMs: 60 * 1000 };
    this.config = { allowBaron: true };
    this.players = [];
    this.phase = 'lobby';
    this.round = 0;
    this.winner = null;
    this.winReason = null;
    this.night = null;
    this.day = null;
    this.deaths = [];
    // 情报模式：auto=引擎自动发；storyteller=发给 AI 说书人裁量，超时/掉线自动回退
    this.infoMode = 'auto';
    this.storytellerOnline = 0;
    this.stRequest = null;
    this.stRequestId = 0;
    this.stInfoTimeoutMs = 15000;
    this._stTimer = null;
    this.reset(opts.playerCount || 7, true);
  }

  /* ------------------------------ 订阅与广播 ------------------------------ */

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(notice = null) {
    const pub = stateMod.publicView(this);
    this._dispatch({ ch: ['public'], kind: 'public', view: pub, notice });
    for (const p of this.players) {
      if (!p.joined) continue;
      this._dispatch({
        ch: ['seat:' + p.seat],
        kind: 'seat',
        seat: p.seat,
        view: stateMod.seatView(this, p.seat),
        notice,
      });
    }
  }

  _dispatch(evt) {
    evt.seq = ++this.seq;
    this.events.push(evt);
    if (this.events.length > 2000) this.events.splice(0, 500);
    for (const fn of this.listeners) {
      try {
        fn(evt);
      } catch (e) {
        console.error('[listener]', e);
      }
    }
  }

  /** 重连补发：只给这个频道、seq 之后的事件。 */
  eventsSince(channel, since) {
    if (!Number.isFinite(since)) return [];
    return this.events.filter((e) => e.ch.includes(channel) && e.seq > since);
  }

  addLog(text) {
    this.log.push({ id: ++this.logId, text, ts: Date.now() });
    if (this.log.length > 300) this.log.shift();
  }

  alert(seat, text) {
    if (!this.alerts[seat]) this.alerts[seat] = [];
    this.alerts[seat].push({ id: ++this.alertId, text, ts: Date.now() });
    if (this.alerts[seat].length > 20) this.alerts[seat].shift();
  }

  nextKnowledgeId() {
    return ++this.knowledgeId;
  }

  /* -------------------------------- 生命周期 -------------------------------- */

  reset(n = 7, keepTokens = true) {
    const old = this.players;
    const count = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, n));
    this.players = [];
    for (let i = 0; i < count; i++) {
      const prev = old[i];
      this.players.push({
        seat: i + 1,
        name: keepTokens && prev ? prev.name : `座位${i + 1}`,
        token: keepTokens && prev ? prev.token : null,
        joined: keepTokens && prev ? prev.joined : false,
        connected: false,
        alive: true,
        role: null,
        believed: null,
        confirmed: false,
        deathRound: null,
        ghostVoteUsed: false,
      });
    }
    this.phase = 'lobby';
    this.round = 0;
    this.winner = null;
    this.winReason = null;
    this.night = null;
    this.day = null;
    this.stRequest = null;
    if (this._stTimer) {
      clearTimeout(this._stTimer);
      this._stTimer = null;
    }
    this.poisoned = null;
    this.protectedTonight = null;
    this.butlerMaster = null;
    this.slayerUsed = false;
    // 记录公开宣称；只有真杀手第一次使用会发动能力，之后仍可作假宣称。
    this.slayerShots = {};
    this.customBoard = null;
    this.virginUsed = false;
    this.redHerring = null;
    this.demonBluffs = [];
    this.infoReminders = {};
    this.yesterdayExecution = null;
    this.knowledge = {};
    this.alerts = {};
    this.deaths = [];
    // 提名与票型历史：跨天保留，给情报页复盘用
    this.voteHistory = [];
    // 私密裁量记录只落存档，不进入公共或普通座位视图。
    this.aiDecisions = [];
    // 私人怀疑标记：suspicion[座位] = [被怀疑的座位...]，只有本人和说书人看得到
    this.suspicion = {};
    this.suspicionAt = {};
    // 私人身份板：board[座位] = { 目标座位: 角色id }，同样只有本人和说书人看得到
    this.board = {};
    this.boardAt = {};
    this.startedAt = null;
    this.endedAt = null;
  }

  /** 在板子上给某个座位贴一个身份。roleId 为 null 表示清回"未知"。 */
  setBoardGuess(seat, target, roleId) {
    const p = this.players[seat - 1];
    const t = this.players[target - 1];
    if (!p) return { ok: false, error: '座位不存在' };
    if (!t) return { ok: false, error: '目标不存在' };
    if (seat === target) return { ok: false, error: '板子上不用写自己' };
    if (!this.board[seat]) this.board[seat] = {};
    if (roleId == null || roleId === '' || roleId === 'unknown') {
      delete this.board[seat][target];
    } else {
      if (!ROLES[roleId]) return { ok: false, error: '没有这个角色' };
      this.board[seat][target] = roleId;
    }
    this.boardAt[seat] = Date.now();
    this.emit();
    return { ok: true, board: { ...this.board[seat] } };
  }

  boardOf(seat) {
    return { ...(this.board[seat] || {}) };
  }

  /** 玩家点一下自己的怀疑名单。只影响自己的笔记和说书人的判断，不影响任何规则。 */
  toggleSuspicion(seat, target) {
    const p = this.players[seat - 1];
    const t = this.players[target - 1];
    if (!p) return { ok: false, error: '座位不存在' };
    if (!t) return { ok: false, error: '目标不存在' };
    if (seat === target) return { ok: false, error: '不能怀疑自己' };
    if (!this.suspicion[seat]) this.suspicion[seat] = [];
    const list = this.suspicion[seat];
    const i = list.indexOf(target);
    if (i >= 0) list.splice(i, 1);
    else list.push(target);
    list.sort((a, b) => a - b);
    this.suspicionAt[seat] = Date.now();
    this.emit();
    return { ok: true, list: list.slice() };
  }

  suspicionOf(seat) {
    return (this.suspicion[seat] || []).slice();
  }

  /**
   * 给说书人（将来的 AI 层）看的局势快照。
   * suspicion 只给聚合数；beliefs 是每个人的板子（"他认为谁是啥"），
   * consensus 是汇总（"有几个人认为 3 号是恶魔"）。这两层用途不同：
   * consensus 看局势，beliefs 看谁在带节奏——别拿 beliefs 针对具体的人。
   */
  storytellerSnapshot() {
    const counts = {};
    for (const p of this.players) counts[p.seat] = 0;
    for (const list of Object.values(this.suspicion || {})) {
      for (const t of list) {
        if (counts[t] != null) counts[t]++;
      }
    }
    const beliefs = {};
    const consensus = {};
    for (const p of this.players) {
      const b = this.board[p.seat] || {};
      if (Object.keys(b).length) beliefs[p.seat] = { ...b };
      for (const [target, roleId] of Object.entries(b)) {
        if (!consensus[target]) consensus[target] = {};
        consensus[target][roleId] = (consensus[target][roleId] || 0) + 1;
      }
    }
    return {
      phase: this.phase,
      round: this.round,
      alive: this.players.filter((p) => p.alive).map((p) => p.seat),
      suspicion: counts,
      beliefs,
      consensus,
      markedBy: Object.keys(this.suspicion || {}).length,
      boardsBy: Object.keys(beliefs).length,
      at: Date.now(),
    };
  }

  setPlayerCount(n) {
    if (this.phase !== 'lobby') return { ok: false, error: '开局后不能改人数' };
    const before = this.players.map((p) => ({ name: p.name, token: p.token, joined: p.joined }));
    this.reset(n, false);
    this.players.forEach((p, i) => {
      const b = before[i];
      if (b) {
        p.name = b.name;
        p.token = b.token;
        p.joined = b.joined;
      }
    });
    this.emit();
    return { ok: true };
  }

  rename(seat, name) {
    const p = this.players[seat - 1];
    if (!p) return { ok: false, error: '座位不存在' };
    const n = cleanName(name);
    if (!n) return { ok: false, error: '名字不能为空' };
    p.name = n;
    this.emit();
    return { ok: true };
  }

  claim(seat, token, name) {
    const p = this.players[seat - 1];
    if (!p) return { ok: false, error: '座位不存在' };
    if (token && p.token === token) {
      p.joined = true;
      p.connected = true;
      const n = cleanName(name);
      if (n) p.name = n;
      this.emit();
      return { ok: true, token: p.token };
    }
    if (p.token) return { ok: false, error: '这个座位已经被占用了' };
    p.token = newToken();
    p.joined = true;
    p.connected = true;
    const n = cleanName(name);
    if (n) p.name = n;
    this.emit();
    return { ok: true, token: p.token };
  }

  releaseSeat(seat) {
    const p = this.players[seat - 1];
    if (!p) return { ok: false, error: '座位不存在' };
    p.token = null;
    p.joined = false;
    p.connected = false;
    this.emit();
    return { ok: true };
  }

  setConnected(seat, connected) {
    const p = this.players[seat - 1];
    if (!p) return;
    if (p.connected === connected) return;
    p.connected = connected;
    this.emit();
  }

  isImpaired(seat) {
    const p = this.players[seat - 1];
    if (!p) return false;
    return p.role === 'drunk' || this.poisoned === seat;
  }

  aliveCount() {
    return this.players.filter((p) => p.alive).length;
  }

  kill(seat, cause = 'unknown') {
    const p = this.players[seat - 1];
    if (!p || !p.alive) return false;
    p.alive = false;
    p.deathRound = this.round;
    p.deathCause = cause;
    this.deaths.push({ seat, cause, round: this.round });
    // 持续效果随能力来源死亡立即消失。
    if (p.role === 'poisoner') this.poisoned = null;
    if (p.role === 'monk') this.protectedTonight = null;
    return true;
  }

  promoteToImp(seat) {
    const p = this.players[seat - 1];
    if (p.role === 'poisoner') this.poisoned = null;
    p.role = 'imp';
    p.believed = 'imp';
    this.alert(seat, '你现在是小恶魔。');
  }

  /* -------------------------------- 开局发牌 -------------------------------- */

  /**
   * 配板子：说书人 / AI 在开局前指定本局角色名单（按座位顺序）。
   * 只校验配比与合法性，不把名单写进公共视图；开局后就不能再改。
   */
  setBoard(roles) {
    if (this.phase !== 'lobby') return { ok: false, error: '开局后不能改板子' };
    const check = validateBoard(roles, this.players.length, { allowBaron: this.config.allowBaron });
    if (!check.ok) return check;
    this.customBoard = { roles: roles.slice(), comp: check.counts, baron: check.baron };
    this.addLog('说书人配好了板子。');
    this.emit('说书人配好了板子。');
    return { ok: true, board: this.customBoard };
  }

  clearBoard() {
    if (this.phase !== 'lobby') return { ok: false, error: '开局后不能改板子' };
    this.customBoard = null;
    this.emit();
    return { ok: true };
  }

  /* --------------------------- 情报由谁说（auto / storyteller） --------------------------- */

  setInfoMode(mode) {
    if (mode !== 'auto' && mode !== 'storyteller') {
      return { ok: false, error: '模式只能是 auto 或 storyteller' };
    }
    this.infoMode = mode;
    if (mode === 'auto' && this.stRequest) this.autoStorytellerInfo();
    this.addLog(mode === 'storyteller' ? '情报改成说书人裁量。' : '情报改回自动发放。');
    this.emit(mode === 'storyteller' ? '情报由说书人裁量。' : '情报改回自动发放。');
    return { ok: true, mode };
  }

  /** 这一步情报要不要交给说书人（团队信息永远自动，不经过裁量） */
  wantsStorytellerInfo(step) {
    if (this.infoMode !== 'storyteller') return false;
    if (!this.storytellerOnline) return false;
    if (step && step.info === 'team') return false;
    return true;
  }

  /** 建一条待裁量请求；返回 id，调用方把它挂到 pending 上 */
  makeInfoRequest({ seat, step, cards, context }) {
    const id = ++this.stRequestId;
    const p = this.players[seat - 1];
    this.stRequest = {
      id,
      seat,
      name: p ? p.name : '',
      step,
      night: this.round,
      at: Date.now(),
      truth: cards,
      context: context || null,
    };
    this.armInfoTimer(id);
    return id;
  }

  armInfoTimer(id) {
    if (this._stTimer) clearTimeout(this._stTimer);
    this._stTimer = setTimeout(() => {
      if (this.stRequest && this.stRequest.id === id) this.autoStorytellerInfo();
    }, this.stInfoTimeoutMs);
    if (this._stTimer.unref) this._stTimer.unref();
  }

  clearInfoTimer() {
    if (this._stTimer) {
      clearTimeout(this._stTimer);
      this._stTimer = null;
    }
  }

  /** 说书人交卷：校验格式后发给对应玩家 */
  resolveInfoRequest(id, cards) {
    if (!this.stRequest || this.stRequest.id !== Number(id)) {
      return { ok: false, error: '没有这条情报请求（可能已经超时自动发了）' };
    }
    if (!Array.isArray(cards) || cards.length === 0 || cards.length > 6) {
      return { ok: false, error: 'cards 必须是 1–6 张' };
    }
    for (const c of cards) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) return { ok: false, error: 'cards 格式不对' };
    }
    const p = this.night && this.night.pending;
    if (!p || !p.awaiting || p.requestId !== this.stRequest.id) {
      this.stRequest = null;
      this.clearInfoTimer();
      return { ok: false, error: '这一步已经不需要裁量了' };
    }
    p.cards = cards;
    p.awaiting = false;
    p.fallbackCards = null;
    this.stRequest = null;
    this.clearInfoTimer();
    this.emit();
    return { ok: true };
  }

  /** 超时 / 说书人掉线：用引擎自己算的那份发出去，别卡住整桌 */
  autoStorytellerInfo() {
    const req = this.stRequest;
    if (!req) return { ok: false, error: '没有待裁量的情报' };
    const p = this.night && this.night.pending;
    if (p && p.awaiting && p.requestId === req.id) {
      p.cards = req.truth || [];
      p.awaiting = false;
      p.fallbackCards = null;
    }
    this.stRequest = null;
    this.clearInfoTimer();
    this.emit();
    return { ok: true, auto: true };
  }

  storytellerConnected() {
    this.storytellerOnline++;
    this.emit();
  }

  storytellerDisconnected() {
    this.storytellerOnline = Math.max(0, this.storytellerOnline - 1);
    if (!this.storytellerOnline && this.stRequest) {
      this.autoStorytellerInfo();
      return;
    }
    this.emit();
  }

  /** 进程重启后，把没答完的请求按自动答案收尾 */
  resumePendingInfo() {
    const p = this.night && this.night.pending;
    if (p && p.awaiting) {
      p.cards = p.fallbackCards || [];
      p.awaiting = false;
      p.fallbackCards = null;
    }
    this.stRequest = null;
    this.clearInfoTimer();
  }

  start(opts = {}) {
    if (this.phase !== 'lobby') return { ok: false, error: '已经开局了' };
    const unjoined = this.players.filter((p) => !p.joined);
    if (unjoined.length && !opts.force) {
      return {
        ok: false,
        error: `还有 ${unjoined.length} 个座位没有手机加入：${unjoined.map((p) => p.seat).join('、')}号`,
      };
    }
    const setup = this.customBoard
      ? setupFromRoles(this.customBoard.roles, this.rng)
      : buildSetup(this.players.length, this.rng, this.config.allowBaron ? {} : { baron: false });
    this.players.forEach((p, i) => {
      p.role = setup.roles[i];
      p.believed = setup.believed[i];
      p.alive = true;
      p.confirmed = false;
      p.deathRound = null;
      p.ghostVoteUsed = false;
    });
    this.redHerring = setup.redHerring;
    this.demonBluffs = setup.demonBluffs;
    this.composition = setup.comp;
    this.baron = setup.baron;
    this.phase = 'reveal';
    this.startedAt = Date.now();
    this.addLog('发牌完成，请各自在手机上看自己的身份。');
    this.emit('发牌完成，点「身份」看牌，看完点「我知道了」。');
    return { ok: true };
  }

  confirm(seat) {
    const p = this.players[seat - 1];
    if (!p) return { ok: false, error: '座位不存在' };
    p.confirmed = true;
    this.emit();
    return { ok: true };
  }

  /* -------------------------------- 夜晚 -------------------------------- */

  beginNight(n = this.round + 1) {
    if (this.phase === 'ended') return { ok: false, error: '游戏已结束' };
    if (this.phase !== 'reveal' && this.phase !== 'day') return { ok: false, error: '现在不能进入夜晚' };
    if (this.day) {
      dayMod.finishDay(this);
      if (this.winner) {
        this.finishGame();
        return { ok: false, error: '游戏已结束' };
      }
    }
    this.day = null;
    this.round = n;
    this.phase = 'night';
    this.poisoned = null;
    this.protectedTonight = null;
    this.night = {
      number: n,
      steps: nightMod.buildSteps(this, n),
      index: 0,
      pending: null,
      deadTonight: [],
      abort: false,
    };
    this.addLog(`第 ${n} 夜。天黑了。`);
    nightMod.advance(this, `第 ${n} 夜，天黑了。`);
    return { ok: true };
  }

  submitNight(seat, payload) {
    if (this.phase !== 'night') return { ok: false, error: '现在不是夜晚' };
    return nightMod.submit(this, seat, payload);
  }

  /** 房主"跳过当前等待"：盲跳，不暴露是谁。 */
  skipNight() {
    if (this.phase !== 'night' || !this.night || !this.night.pending) {
      return { ok: false, error: '当前没有等待中的步骤' };
    }
    if (this.stRequest && this.night.pending.requestId === this.stRequest.id) {
      this.stRequest = null;
      this.clearInfoTimer();
    }
    this.night.pending = null;
    this.night.index++;
    this.addLog('说书人跳过了一次夜间等待。');
    nightMod.advance(this);
    return { ok: true };
  }

  scarletCheck() {
    // 红唇女郎接管在恶魔死亡的那一刻已经处理（day.onDemonDeath）。
    // 保留这一步是为了让程序里的夜序和官方夜间流程表一一对应。
  }

  dawn() {
    const n = this.night;
    const dead = n ? n.deadTonight.slice() : [];
    this.night = null;
    this.phase = 'day';
    if (dead.length) {
      this.addLog(
        '天亮了。昨晚死亡：' + dead.map((s) => `${s}号（${this.players[s - 1].name}）`).join('、') + '。'
      );
    } else {
      this.addLog('天亮了。昨晚无人死亡。');
    }
    dayMod.checkWin(this);
    if (this.winner) {
      this.finishGame();
      return;
    }
    this.day = {
      sub: 'discuss',
      deadline: Date.now() + this.settings.discussMs,
      vote: null,
      lastVote: null,
      nominations: [],
      nominators: [],
      nominatedSeats: [],
      executed: null,
    };
    this.emit(
      dead.length
        ? '天亮了。昨晚死亡：' + dead.map((s) => `${s}号`).join('、') + '。'
        : '天亮了。昨晚无人死亡。'
    );
  }

  /* -------------------------------- 白天 -------------------------------- */

  beginNominations() {
    if (this.phase !== 'day' || !this.day) return { ok: false, error: '现在不是白天' };
    if (this.day.sub !== 'discuss') return { ok: false, error: '现在不能开始提名' };
    this.day.sub = 'nominate';
    this.day.deadline = null;
    this.addLog('开始提名。');
    this.emit('讨论结束，开始提名。');
    return { ok: true };
  }

  nominate(seat, target) {
    const d = this.day;
    if (!d || this.phase !== 'day') return { ok: false, error: '现在不能提名' };
    if (d.sub !== 'nominate' || d.vote) return { ok: false, error: '现在不是提名阶段' };
    const p = this.players[seat - 1];
    const t = this.players[target - 1];
    if (!p || !p.alive) return { ok: false, error: '死亡玩家不能提名' };
    if (!t) return { ok: false, error: '目标不合法' };
    if (seat === target) return { ok: false, error: '不能提名自己' };
    if (d.nominators.includes(seat)) return { ok: false, error: '你今天已经提名过了' };
    if (d.nominatedSeats.includes(target)) return { ok: false, error: '他今天已经被提名过了' };

    d.nominators.push(seat);
    d.nominatedSeats.push(target);

    if (t.alive && t.believed === 'virgin' && !this.virginUsed) {
      this.virginUsed = true;
      if (!this.isImpaired(target) && nightMod.registerTownsfolk(this, seat)) {
        this.addLog(`${seat}号 提名了 ${target}号，${seat}号 立即被处决。`);
        dayMod.execute(this, seat, 'virgin');
        this.endDay();
        return { ok: true, virgin: true };
      }
    }

    this.addLog(`${seat}号 提名了 ${target}号。`);
    d.vote = {
      nominator: seat,
      nominee: target,
      votes: [],
      eligibleSeats: this.players.filter((x) => x.alive || !x.ghostVoteUsed).map((x) => x.seat),
      deadline: Date.now() + this.settings.voteMs,
    };
    d.sub = 'vote';
    this.emit(`${seat}号 提名了 ${target}号，开始投票。`);
    return { ok: true };
  }

  castVote(seat, yes) {
    const d = this.day;
    if (!d || !d.vote) return { ok: false, error: '现在没有投票' };
    const p = this.players[seat - 1];
    if (!p) return { ok: false, error: '座位不存在' };
    if (typeof yes !== 'boolean') return { ok: false, error: '投票必须是同意或反对' };
    if (d.vote.votes.some((v) => v.seat === seat)) return { ok: false, error: '你已经投过票了' };
    // 死人只有投同意才消耗幽灵票；本轮反对或不回应都保留到后续提名。
    const eligible = dayMod.eligibleVoters(this, d.vote);
    if (!eligible.includes(seat)) return { ok: false, error: '你不能参与本轮投票' };
    if (!p.alive) {
      if (p.ghostVoteUsed) return { ok: false, error: '你的幽灵票已经用掉了' };
      if (yes) p.ghostVoteUsed = true;
    }
    d.vote.votes.push({ seat, yes: !!yes });
    if (p.alive && p.believed === 'butler' && yes &&
        !d.vote.votes.some((v) => v.seat === this.butlerMaster && v.yes)) {
      this.alert(seat, `请遵守管家规则：只有主人 ${this.butlerMaster || '尚未选择'}号 也投同意时才能投同意。主人死亡后仍须等其使用幽灵票；本次已提交的票正常计入。`);
    }
    if (eligible.every((s) => d.vote.votes.some((v) => v.seat === s))) {
      this.closeVote();
    } else {
      this.emit();
    }
    return { ok: true };
  }

  closeVote() {
    const d = this.day;
    if (!d || !d.vote) return { ok: false, error: '现在没有投票' };
    const v = d.vote;
    const res = dayMod.countVotes(this, v);
    const threshold = Math.ceil(this.aliveCount() / 2);
    const votes = v.votes.map((x) => ({ seat: x.seat, yes: !!x.yes }));
    const yesList = res.yes.slice().sort((a, b) => a - b);
    const noList = res.no.slice().sort((a, b) => a - b);
    const notVoted = this.players
      .filter((p) => dayMod.eligibleVoters(this, v).includes(p.seat) && !v.votes.some((x) => x.seat === p.seat))
      .map((p) => p.seat);
    d.nominations.push({
      nominator: v.nominator,
      nominee: v.nominee,
      count: res.count,
      threshold,
      yes: yesList,
      no: noList,
      votes,
    });
    d.lastVote = {
      nominator: v.nominator,
      nominee: v.nominee,
      count: res.count,
      yes: yesList,
      no: noList,
      notVoted,
      votes,
    };
    d.vote = null;
    d.sub = 'nominate';
    this.voteHistory.push({
      round: this.round,
      nominator: v.nominator,
      nominee: v.nominee,
      count: res.count,
      yes: yesList,
      no: noList,
      notVoted,
      executed: false,
    });
    this.addLog(`${v.nominee}号 获得 ${res.count} 票。`);
    this.addLog(
      `票型：同意 ${yesList.join('、') || '无'}；反对 ${noList.join('、') || '无'}` +
        (notVoted.length ? `；未投 ${notVoted.join('、')}` : '') +
        '。'
    );
    this.emit(`${v.nominee}号 获得 ${res.count} 票（同意 ${yesList.length} / 反对 ${noList.length}）。`);
    return { ok: true };
  }

  endNominations() {
    const d = this.day;
    if (!d || this.phase !== 'day') return { ok: false, error: '现在不是白天' };
    if (d.vote) this.closeVote();
    const threshold = Math.ceil(this.aliveCount() / 2);
    const best = bestOf(d);
    if (!best) {
      this.addLog('今天没有人被提名，没有人被处决。');
      this.emit('今天没有人被提名。');
      this.endDay();
      return { ok: true, executed: null };
    }
    const tied = d.nominations.filter((n) => n.count === best.count && n.count >= (n.threshold || threshold)).length > 1;
    if (tied) {
      this.addLog('最高票并列，没有人被处决。');
      this.emit('最高票并列，没有人被处决。');
      this.endDay();
      return { ok: true, executed: null };
    }
    if (best.count < (best.threshold || threshold)) {
      const needed = best.threshold || threshold;
      this.addLog(`${best.nominee}号 只获得 ${best.count} 票，未达到 ${needed} 票，没有人被处决。`);
      this.emit(`${best.nominee}号 只获得 ${best.count} 票，未过半数，没有人被处决。`);
      this.endDay();
      return { ok: true, executed: null };
    }
    this.addLog(`${best.nominee}号 获得 ${best.count} 票（处决门槛 ${threshold} 票）。`);
    dayMod.execute(this, best.nominee, 'vote');
    const executedVote = [...this.voteHistory]
      .reverse()
      .find((x) => x.round === this.round && x.nominee === best.nominee);
    if (executedVote) executedVote.executed = true;
    if (this.winner) {
      this.finishGame();
      return { ok: true, executed: best.nominee };
    }
    this.emit(`${best.nominee}号 被处决。`);
    this.endDay();
    return { ok: true, executed: best.nominee };
  }

  /**
   * 公开"宣称开枪"：任何人都可以点，全桌都会看到。
   * 只有真杀手（believed=slayer）且能力还没用掉时才会真的结算；其他人打出去什么也不会发生。
   * 这样玩家可以假装杀手，界面也不会通过"有没有按钮"泄露谁是杀手。
   */
  slayerShoot(seat, target) {
    if (this.phase !== 'day' || !this.day) return { ok: false, error: '现在不是白天' };
    const p = this.players[seat - 1];
    if (!p || !p.alive) return { ok: false, error: '死亡玩家不能开枪' };
    if (this.day.sub === 'ended') return { ok: false, error: '白天已经结束' };
    const t = this.players[target - 1];
    if (!t) return { ok: false, error: '目标不合法' };

    this.slayerShots[seat] = true;
    this.addLog(`${seat}号 宣称自己是杀手，对 ${target}号 开枪。`);
    let hit = false;
    if (p.believed === 'slayer' && !this.slayerUsed) {
      this.slayerUsed = true;
      if (t.alive && !this.isImpaired(seat) && nightMod.registerDemon(this, target)) {
        const victim = this.players[target - 1];
        const aliveBeforeDeath = this.aliveCount();
        this.kill(target, 'slayer');
        // 不公布死者的身份：隐士也可能被当作恶魔，公开"是恶魔"会泄露
        this.addLog(`${target}号 死亡。`);
        // 只有真恶魔死了才轮到红唇女郎接管；打到"被当作恶魔"的隐士不算
        if (victim.role === 'imp') dayMod.onDemonDeath(this, aliveBeforeDeath);
        dayMod.checkWin(this);
        hit = true;
      }
    }
    if (!hit) this.addLog('什么也没发生。');
    if (this.winner) {
      this.finishGame();
      return { ok: true, hit };
    }
    this.emit(hit ? `${target}号 死亡。` : '枪响了，什么也没发生。');
    return { ok: true, hit };
  }

  endDay() {
    if (!this.day) return;
    this.day.sub = 'ended';
    this.day.vote = null;
    dayMod.finishDay(this);
    if (this.winner) {
      this.finishGame();
      return;
    }
    this.addLog('白天结束。');
    this.emit('白天结束，准备进入夜晚。');
  }

  checkTimers(now = Date.now()) {
    if (this.phase === 'day' && this.day && this.day.vote && now >= this.day.vote.deadline) {
      this.closeVote();
      return true;
    }
    return false;
  }

  /** 房主调时长。讨论阶段立刻生效，投票时长下一轮生效（不打断正在进行的投票）。 */
  setTimers(opts = {}) {
    const discuss = Number(opts.discussMs);
    const vote = Number(opts.voteMs);
    if (Number.isFinite(discuss) && discuss >= 30000) this.settings.discussMs = discuss;
    if (Number.isFinite(vote) && vote >= 15000) this.settings.voteMs = vote;
    if (this.phase === 'day' && this.day && this.day.sub === 'discuss') {
      this.day.deadline = Date.now() + this.settings.discussMs;
    }
    this.emit();
    return { ok: true };
  }

  finishGame() {
    this.clearInfoTimer();
    this.stRequest = null;
    this.night = null;
    if (this.day) { this.day.vote = null; this.day.sub = 'ended'; }
    this.phase = 'ended';
    this.endedAt = Date.now();
    this.addLog(
      `游戏结束：${this.winner === 'good' ? '好人' : '坏人'}获胜（${
        stateMod.WIN_LABEL[this.winReason] || this.winReason || ''
      }）。`
    );
    this.emit(`游戏结束：${this.winner === 'good' ? '好人' : '坏人'}获胜。`);
  }

  /** 全桌同意后由房主手动宣布，不按隐藏阵营或票数推断提前胜负。 */
  finishEarly(winner) {
    if (this.phase !== 'day' && this.phase !== 'night') return { ok: false, error: '只能在对局进行中提前结束' };
    if (winner !== 'good' && winner !== 'evil') return { ok: false, error: '请选择好人或坏人获胜' };
    this.clearInfoTimer();
    this.stRequest = null;
    this.night = null;
    if (this.day) this.day.vote = null;
    this.winner = winner;
    this.winReason = 'manual';
    this.addLog('房主经全桌确认，提前宣布游戏结束。');
    this.finishGame();
    return { ok: true };
  }

  /* -------------------------------- 持久化 -------------------------------- */

  toJSON() {
    return {
      v: 2,
      seed: this.seed,
      seq: this.seq,
      phase: this.phase,
      round: this.round,
      players: this.players,
      log: this.log,
      logId: this.logId,
      knowledge: this.knowledge,
      alerts: this.alerts,
      alertId: this.alertId,
      knowledgeId: this.knowledgeId,
      deaths: this.deaths,
      winner: this.winner,
      winReason: this.winReason,
      night: this.night,
      day: this.day,
      poisoned: this.poisoned,
      protectedTonight: this.protectedTonight,
      butlerMaster: this.butlerMaster,
      slayerUsed: this.slayerUsed,
      slayerShots: this.slayerShots,
      customBoard: this.customBoard,
      infoMode: this.infoMode,
      voteHistory: this.voteHistory,
      aiDecisions: this.aiDecisions,
      virginUsed: this.virginUsed,
      redHerring: this.redHerring,
      demonBluffs: this.demonBluffs,
      infoReminders: this.infoReminders,
      yesterdayExecution: this.yesterdayExecution,
      suspicion: this.suspicion,
      suspicionAt: this.suspicionAt,
      board: this.board,
      boardAt: this.boardAt,
      settings: this.settings,
      config: this.config,
      composition: this.composition,
      baron: this.baron,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    };
  }

  static fromJSON(data, opts = {}) {
    const g = new Game({ ...opts, playerCount: (data.players || []).length || 7 });
    Object.assign(g, data);
    g.listeners = new Set();
    g.events = [];
    g.slayerShots = g.slayerShots || {};
    g.customBoard = g.customBoard || null;
    g.voteHistory = g.voteHistory || [];
    g.aiDecisions = g.aiDecisions || [];
    g.demonBluffs = g.demonBluffs || [];
    g.infoReminders = g.infoReminders || {};
    g.infoMode = g.infoMode === 'storyteller' ? 'storyteller' : 'auto';
    g.rng = mulberry32(data.seed || 1);
    g.resumePendingInfo();
    return g;
  }
}

function bestOf(d) {
  if (!d.nominations.length) return null;
  let best = null;
  const qualified = d.nominations.filter((n) => n.threshold == null || n.count >= n.threshold);
  for (const n of qualified.length ? qualified : d.nominations) {
    if (!best || n.count > best.count) best = n;
  }
  return best && best.count > 0 ? best : null;
}

module.exports = { Game, bestOf };
