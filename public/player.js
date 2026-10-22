'use strict';

/* 手机私密屏：只渲染 /state/seat/:id 那一份视图。 */

const appEl = document.getElementById('app');

const P = {
  mode: 'guest', // guest | player
  tab: 'board',
  sel: [],
  selKey: '',
  nameInput: '',
  joinRendered: false,
  lastPendingKey: '',
  view: null,
  roles: null,
  connected: true,
  // 夜里默认静音：不震动，靠屏幕自己切到操作页
  vibrate: false,
  nightLock: null,
};

/* -------------------------------- 启动 -------------------------------- */

function boot() {
  P.vibrate = App.store.get('btc.vibrate', '0') === '1';
  const seat = Number(App.store.get('btc.seat', '') || 0);
  const token = App.store.get('btc.token', '');
  if (seat && token) {
    startPlayer(seat, token);
  } else {
    startGuest();
  }
  render();
}

function startPlayer(seat, token) {
  P.mode = 'player';
  P.joinRendered = false;
  App.start({
    role: 'player',
    seat,
    token,
    onWelcome: (m) => {
      if (m.roles && m.roles.length) P.roles = m.roles;
    },
    onView: (v) => {
      P.view = v;
      P.connected = true;
      onNewView(v);
    },
    onStatus: (ok) => {
      P.connected = ok;
      render();
    },
    onNeedClaim: () => {
      App.toast('座位信息失效了，重新选一个座位');
      startGuest(true);
    },
  });
}

function startGuest(force) {
  P.mode = 'guest';
  P.joinRendered = false;
  const opts = {
    role: 'guest',
    seat: null,
    token: null,
    onWelcome: (m) => {
      // 入座后服务端会补发一份带角色表的 welcome，这里收下来
      if (m.roles && m.roles.length) P.roles = m.roles;
    },
    onView: (v) => {
      P.view = v;
      P.connected = true;
      render();
    },
    onStatus: (ok) => {
      P.connected = ok;
      render();
    },
  };
  if (force) App.restart(opts);
  else App.start(opts);
}

/* -------------------------------- 渲染 -------------------------------- */

function onNewView(v) {
  const pending = v.night && v.night.pending;
  if (pending) {
    const key = `${v.pub.round}|${pending.type}|${pending.prompt}`;
    if (key !== P.selKey) {
      P.selKey = key;
      P.sel = [];
    }
    if (key !== P.lastPendingKey) {
      P.lastPendingKey = key;
      // 默认静音；只在本人主动打开震动时才震
      if (P.vibrate && navigator.vibrate) {
        try {
          navigator.vibrate(pending.type === 'choose' ? [180, 80, 180] : [120]);
        } catch {
          /* ignore */
        }
      }
    }
  } else {
    P.lastPendingKey = '';
  }
  render();
}

function render() {
  if (!P.view || !P.view.me) {
    P.mode = 'guest';
    renderGuest(P.view);
    return;
  }
  P.mode = 'player';
  const v = P.view;
  if (v.night && v.night.pending) {
    // 轮到你了就强制回到操作页，不管刚才在看哪个页签
    P.tab = 'board';
    appEl.innerHTML = frame(v, nightAction(v));
    App.tick();
    updateNightLock();
    return;
  }
  let body = '';
  if (P.tab === 'info') body = infoBody(v);
  else if (P.tab === 'me') body = meBody(v);
  else if (P.tab === 'note') body = noteBody(v);
  else body = boardBody(v);
  appEl.innerHTML = frame(v, body);
  App.tick();
  updateNightLock();
}

/**
 * 夜里把屏幕常亮（白天释放）。手机拿在手里的时候，
 * 亮屏是唯一的提示，震动默认关掉。
 */
async function updateNightLock() {
  const night = !!(P.view && P.view.pub && P.view.pub.phase === 'night');
  const want = night && document.visibilityState === 'visible' && 'wakeLock' in navigator;
  if (want && !P.nightLock) {
    try {
      P.nightLock = await navigator.wakeLock.request('screen');
      P.nightLock.addEventListener('release', () => {
        P.nightLock = null;
      });
    } catch {
      P.nightLock = null;
    }
  } else if (!want && P.nightLock) {
    try {
      await P.nightLock.release();
    } catch {
      /* ignore */
    }
    P.nightLock = null;
  }
}

function frame(v, body) {
  const pub = v.pub;
  const timer = pub.deadline
    ? `<span class="timer mono" data-deadline="${pub.deadline}"></span>`
    : '';
  return `
    <div class="phone p-${pub.phase}">
      <header class="phone-head">
        <span class="dot ${P.connected ? '' : 'off'}"></span>
        <span class="me">${v.seat}号 ${escapeHtml(v.name)}</span>
        <span class="tiny dim">${phaseText(pub)}</span>
        ${timer}
      </header>
      <main class="phone-body">${body}</main>
      <nav class="phone-tabs">
        <button data-act="tab" data-tab="board" class="${P.tab === 'board' ? 'on' : ''}">局面</button>
        <button data-act="tab" data-tab="note" class="${P.tab === 'note' ? 'on' : ''}">推理</button>
        <button data-act="tab" data-tab="info" class="${P.tab === 'info' ? 'on' : ''}">情报</button>
        <button data-act="tab" data-tab="me" class="${P.tab === 'me' ? 'on' : ''}">身份</button>
      </nav>
    </div>`;
}

/* -------------------------------- 加入页 -------------------------------- */

function renderGuest(view) {
  const v = view || P.view;
  if (!v) {
    appEl.innerHTML = `<div class="waiting" style="height:100%"><div class="big">正在连接…</div><div class="tiny">检查一下是不是连的同一个 Wi-Fi</div></div>`;
    return;
  }
  // 已经坐在座位上了就不要再画加入页（防止 sync 和 join 页来回闪）
  if (v.me) {
    render();
    return;
  }
  const pub = v.seats ? v : v.pub;
  if (!pub || !pub.seats) return;
  if (P.joinRendered) {
    const grid = document.getElementById('join-grid');
    if (grid) grid.innerHTML = joinGrid(pub);
    return;
  }
  appEl.innerHTML = `
    <div class="join">
      <h1>血染钟楼</h1>
      <p>选一个座位，写上你的名字。开局后不能换。</p>
      <div class="join-grid" id="join-grid">${joinGrid(pub)}</div>
      <input id="join-name" maxlength="8" placeholder="你的名字" value="${escapeHtml(P.nameInput)}" />
      <p class="tiny dim" style="margin-top:10px">座位被占了就让房主在平板上释放。</p>
      <p class="tiny dim" style="margin-top:6px"><a href="/connect" style="color:#9b96a6">页面打不开 / 一直连不上？点这里检查</a></p>
    </div>`;
  P.joinRendered = true;
  const input = document.getElementById('join-name');
  if (input) {
    input.addEventListener('input', () => {
      P.nameInput = input.value;
    });
  }
}

function joinGrid(v) {
  return v.seats
    .map((s) => {
      const taken = s.joined;
      return `<button class="join-seat ${taken ? 'taken' : ''}" data-act="claim" data-seat="${s.seat}" ${
        taken ? 'disabled' : ''
      }>
        <span class="no">${s.seat}</span>
        <span class="nm">${taken ? escapeHtml(s.name) : '空'}</span>
      </button>`;
    })
    .join('');
}

/* -------------------------------- 三个页签 -------------------------------- */

function roleCardHtml(role, opts = {}) {
  if (!role) return '';
  const masked = opts.masked !== false;
  const art = role.id
    ? `<img class="role-art" src="/art/roles/${role.id}.jpg" alt="" onerror="this.style.display='none'" />`
    : '';
  const card = `
    <div class="role-card ${role.team}">
      ${art}
      <div class="type">${escapeHtml(role.typeLabel)}</div>
      <div class="name">${escapeHtml(role.name)}</div>
      <div class="en">${escapeHtml(role.en)}</div>
      <div class="brief">${escapeHtml(role.brief)}</div>
    </div>`;
  if (!masked) return card;
  // 按住才显示：旁边的人一偏头也看不到
  return `<div class="hold-wrap">${card}<div class="hold-cover"><span>按住查看身份</span></div></div>`;
}

/** 酒鬼到结束时才看到这一条 */
function fooledNote(me) {
  if (!me || !me.wasFooled || !me.trueRole) return '';
  return `<div class="fooled-note">你其实是 <b>${escapeHtml(me.trueRole.name)}</b>。
    你以为的那个身份，从头到尾都没生效过。</div>`;
}

function boardBody(v) {
  const pub = v.pub;
  const me = v.me;

  if (pub.phase === 'lobby') {
    return `<div class="waiting">
      <div class="big">已就座</div>
      <div>等房主开始游戏</div>
      <div class="tiny">座位：${v.seat}号 · 已就座 ${pub.joinedCount || 0}/${pub.playerCount || 0}</div>
    </div>`;
  }

  if (pub.phase === 'reveal') {
    return `<div class="stack">
      ${roleCardHtml(me.role)}
      ${
        me.confirmed
          ? '<div class="center dim" style="padding:10px">已确认，等房主开始第一夜。</div>'
          : '<button class="btn primary big" data-act="confirm-role">我知道了</button>'
      }
    </div>`;
  }

  if (pub.phase === 'night') {
    return `<div class="waiting">
      <div class="big">夜晚</div>
      <div>${v.alive ? '手机拿在手里，别让旁边的人看' : '你已死亡，今晚不用睁眼'}</div>
      <div class="tiny">${v.alive ? '轮到你时屏幕会自己切到操作页' : '天亮后可以继续说话'}</div>
    </div>`;
  }

  if (pub.phase === 'ended') {
    const good = pub.winner === 'good';
    const mine = (pub.finalRoles || []).find((r) => r.seat === v.seat);
    const won = mine ? (good ? mine.team === 'good' : mine.team === 'evil') : false;
    const tl = (pub.timeline || [])
      .map(
        (t) =>
          `<div class="tl-row"><span class="tl-when">第 ${t.round} ${t.where === '夜里' ? '夜' : '天'}</span>
           <span class="tl-who">${t.seat}号 ${escapeHtml(t.name)}</span>
           <span class="tl-how">${escapeHtml(t.how)}</span></div>`
      )
      .join('');
    const roles = (pub.finalRoles || [])
      .map(
        (r) =>
          `<div class="tl-row"><span class="tl-who">${r.seat}号 ${escapeHtml(r.name)}</span>
           <span class="tl-how">${escapeHtml(r.role)} · ${escapeHtml(r.typeLabel)}</span></div>`
      )
      .join('');
    return `<div class="stack center" style="padding-top:18px">
      <div class="big-num" style="font-size:2rem">${won ? '你赢了' : '你输了'}</div>
      <div class="dim">${good ? '好人胜利' : '坏人胜利'} · ${escapeHtml(pub.winReasonLabel || '')}</div>
      ${fooledNote(me)}
      ${roleCardHtml(me.role)}
      ${roles ? `<div class="timeline" style="width:100%;text-align:left"><div class="tiny dim" style="margin-bottom:4px">全场身份</div>${roles}</div>` : ''}
      ${tl ? `<div class="timeline" style="width:100%;text-align:left">${tl}</div>` : ''}
      <button class="btn" data-act="tab" data-tab="info">看我这一局的情报</button>
    </div>`;
  }

  return dayBody(v);
}

function dayBody(v) {
  const pub = v.pub;
  const d = v.day;
  const pubDay = pub.day;
  const parts = [];

  if (!v.alive) {
    parts.push(
      `<div class="dead-banner">你已死亡：可以继续说话，不能提名或用能力；${
        v.me.ghostVote ? '本局还有一张幽灵票，仅投同意时消耗。' : '幽灵票已经用掉了。'
      }</div>`
    );
  }

  if (pubDay && pubDay.vote) {
    const vote = pubDay.vote;
    parts.push(`
      <div class="card" style="padding:16px">
        <div class="tiny dim">投票中 · 还剩 <span class="mono" data-deadline="${vote.deadline}"></span></div>
        <div style="font-size:1.3rem;font-weight:800;margin:6px 0 2px">
          ${vote.nominator}号 提名 <span style="color:#e98b93">${vote.nominee}号</span>
        </div>
        <div class="tiny">同意 <b style="color:#8fce9b">${vote.yes || 0}</b> · 反对 <b style="color:#e98b93">${vote.no || 0}</b>
          · 处决门槛 ${vote.threshold || '?'} 票</div>
        <div class="tiny dim">已有 ${vote.voted} / ${vote.eligible || vote.alive} 人回应（存活 ${vote.alive} 人）</div>
        ${
          d && d.vote && d.vote.canVote
            ? `<div class="vote-bar">
                 <button class="btn yes" data-act="vote" data-yes="1">同意</button>
                 <button class="btn no" data-act="vote" data-yes="0">反对</button>
               </div>`
            : d && d.vote && d.vote.myVote != null
            ? `<div class="center dim" style="margin-top:14px">你投了：${d.vote.myVote ? '同意' : '反对'}${
                !v.alive ? (d.vote.myVote ? '（幽灵票已用）' : '（幽灵票保留）') : ''
              }</div>`
            : ''
        }
        ${d && d.vote && d.vote.note ? `<div class="tiny" style="color:#e8a04a;margin-top:10px">${escapeHtml(d.vote.note)}</div>` : ''}
      </div>`);
  } else if (pubDay && pubDay.lastVote) {
    const lv = pubDay.lastVote;
    parts.push(`
      <div class="card" style="padding:14px 16px">
        <div class="tiny dim">上一轮</div>
        <div>${lv.nominator}号 提名 ${lv.nominee}号：<b>${lv.count}</b> 票同意
          <span class="tiny dim">（同意 ${(lv.yes || []).length} / 反对 ${(lv.no || []).length}）</span></div>
      </div>`);
  }

  if (d && d.sub === 'nominate' && d.canNominate) {
    const targets = d.targets || [];
    parts.push(`
      <div class="card" style="padding:16px">
        <div class="tiny dim" style="margin-bottom:10px">提名一个人</div>
        <div class="pick-grid">
          ${targets
            .map(
              (t) => `<button class="pick" data-act="nominate" data-seat="${t.seat}">
                <span class="no">${t.seat}</span>
                <span class="grow">${escapeHtml(t.name)}</span>
                ${!t.alive ? '<span class="tiny dim">已死亡</span>' : ''}
              </button>`
            )
            .join('') || '<div class="dim tiny">没有可提名的人</div>'}
        </div>
      </div>`);
  } else if (d && d.hasNominated && d.sub === 'nominate') {
    parts.push('<div class="center dim tiny" style="padding:10px">你今天已经提名过了。</div>');
  } else if (d && d.sub === 'nominate' && !pubDay.vote && v.alive) {
    parts.push(
      '<div class="center dim tiny" style="padding:10px">今天能提名的人都已经上过台了，等房主结束提名。</div>'
    );
  }

  if (d && d.slayer && d.slayer.available) {
    parts.push(`
      <div class="card" style="padding:16px;border-color:rgba(184,53,63,.5)">
        <div class="tiny dim">公开开枪 · 全桌可见</div>
        <div class="tiny dim" style="margin:4px 0 8px">
          宣称自己是杀手，对一名玩家开枪。真杀手打中恶魔才会死；其他人开枪什么也不会发生，但全桌都会看到你打了谁。
        </div>
        <div class="pick-grid">
          ${d.slayer.targets
            .map(
              (t) => `<button class="pick" data-act="slayer" data-seat="${t.seat}">
                <span class="no">${t.seat}</span><span class="grow">${escapeHtml(t.name)}</span>
                ${!t.alive ? '<span class="tiny dim">已死亡</span>' : ''}
              </button>`
            )
            .join('')}
        </div>
      </div>`);
  }

  if (pubDay && pubDay.executed) {
    parts.push(
      `<div class="center" style="padding:10px;font-size:1.1rem">今天被处决：<b>${pubDay.executed.seat}号${
        pubDay.executed.name ? '（' + escapeHtml(pubDay.executed.name) + '）' : ''
      }</b></div>`
    );
  }

  if (pubDay && pubDay.nominations && pubDay.nominations.length) {
    parts.push(`
      <div class="card" style="padding:14px 16px">
        <div class="tiny dim" style="margin-bottom:6px">今天的提名</div>
        ${pubDay.nominations
          .map(
            (n) =>
              `<div class="tiny" style="padding:3px 0">${n.nominator}号 → ${n.nominee}号：${n.count} 票（同意 ${
                (n.yes || []).length
              } / 反对 ${(n.no || []).length}）</div>`
          )
          .join('')}
      </div>`);
  }

  const sus = new Set(v.me.suspicion || []);
  const seats = pub.seats
    .map(
      (s) =>
        `<span class="tag ${s.alive ? '' : 'blood'} ${sus.has(s.seat) ? 'suspected' : ''}" style="margin:2px 4px 2px 0">${s.seat} ${escapeHtml(
          s.name
        )}${s.alive ? '' : ' ✝'}${sus.has(s.seat) ? ' ◆' : ''}</span>`
    )
    .join('');
  parts.push(`<div style="margin-top:4px">${seats}</div>`);

  // 私人怀疑标记：只有自己看得到，规则上不影响任何东西
  const aliveSeats = pub.seats.filter((s) => s.alive);
  parts.push(`
    <div class="card" style="padding:14px 16px">
      <div class="tiny dim" style="margin-bottom:8px">我的怀疑 · 只有你看得到</div>
      <div class="sus-row">
        ${aliveSeats
          .map(
            (s) =>
              `<button class="sus ${sus.has(s.seat) ? 'on' : ''}" data-act="suspect" data-seat="${s.seat}">
                 ${s.seat}<span class="sus-nm">${escapeHtml(s.name)}</span>
               </button>`
          )
          .join('')}
      </div>
      <div class="tiny dim" style="margin-top:8px">点一下标记，再点取消。放心，别人看不到，也不会算进投票。</div>
    </div>`);

  if (!parts.length) {
    parts.push('<div class="waiting"><div class="big">白天</div><div>听房主说</div></div>');
  }
  return `<div class="stack">${parts.join('')}</div>`;
}

/* -------------------------------- 我的推理 -------------------------------- */

function roleName(id) {
  if (!id || !P.roles) return null;
  const r = P.roles.find((x) => x.id === id);
  return r ? r.name : null;
}

function noteBody(v) {
  const board = v.me.board || {};
  const others = v.pub.seats.filter((s) => s.seat !== v.seat);
  return `<div class="stack">
    <div class="card" style="padding:14px 16px">
      <div class="row" style="justify-content:space-between;align-items:center">
        <div class="tiny dim">我的推理 · 别人手机上看不到</div>
        <button class="btn tiny" data-act="role-sheet">角色表</button>
      </div>
      <div class="tiny dim" style="margin-top:6px">
        把心里的猜测记在号码上，帮你盘清楚谁是谁。不参与投票，也不改变任何规则判定。
      </div>
    </div>
    <div class="board-list">
      ${others
        .map((s) => {
          const name = roleName(board[s.seat]);
          return `<button class="board-row ${s.alive ? '' : 'dead'}" data-act="board-pick" data-seat="${s.seat}">
            <span class="no">${s.seat}</span>
            <span class="nm">${escapeHtml(s.name)}${s.alive ? '' : ' ✝'}</span>
            <span class="guess ${name ? '' : 'empty'}">${name ? escapeHtml(name) : '未知'}</span>
            <span class="arrow">›</span>
          </button>`;
        })
        .join('')}
    </div>
    <div class="tiny dim center" style="padding:6px">
      点完立刻保存，换手机重新连上也还在。
    </div>
  </div>`;
}

const ROLE_GROUPS = [
  ['镇民', 'townsfolk'],
  ['外来者', 'outsider'],
  ['爪牙', 'minion'],
  ['恶魔', 'demon'],
];

/** 本局剧本的全部角色与技能，跟实体角色表背面一样 */
function roleSheetHtml() {
  if (!P.roles || !P.roles.length) {
    return '<div class="dim center" style="padding:24px">角色表还没加载</div>';
  }
  return ROLE_GROUPS.map(
    ([label, type]) => `
      <div class="pick-group">
        <div class="pick-label">${label}</div>
        ${P.roles
          .filter((r) => r.type === type)
          .map(
            (r) => `<div class="r-row">
              <span class="r-name">${escapeHtml(r.name)}</span>
              <span class="r-brief">${escapeHtml(r.brief || '')}</span>
            </div>`
          )
          .join('')}
      </div>`
  ).join('');
}

function openRoleSheet() {
  if (!P.roles || !P.roles.length) {
    App.toast('角色表还没加载，等一下再试');
    return;
  }
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal sheet role-sheet">
      <h2>角色表</h2>
      <p>《暗流涌动》的全部角色与技能。你只知道自己是哪一张，其余靠推理。</p>
      ${roleSheetHtml()}
      <div class="actions"><button class="btn" data-close="1">收起</button></div>
    </div>`;
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-close]')) mask.remove();
  });
  document.body.appendChild(mask);
}

function openRolePicker(target) {
  if (!P.roles || !P.roles.length) {
    App.toast('角色表还没加载，等一下再试');
    return;
  }
  const v = P.view;
  const cur = (v.me.board || {})[target] || null;
  const groups = [
    ['镇民', 'townsfolk'],
    ['外来者', 'outsider'],
    ['爪牙', 'minion'],
    ['恶魔', 'demon'],
  ];
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal sheet">
      <h2>${target}号 · ${escapeHtml(seatName(v.pub, target))}</h2>
      <p>你觉得他是什么身份？</p>
      ${groups
        .map(
          ([label, type]) => `
        <div class="pick-group">
          <div class="pick-label">${label}</div>
          <div class="pick-roles">
            ${P.roles
              .filter((r) => r.type === type)
              .map(
                (r) =>
                  `<button class="role-chip ${cur === r.id ? 'on' : ''}" data-role="${r.id}">${escapeHtml(
                    r.name
                  )}</button>`
              )
              .join('')}
          </div>
        </div>`
        )
        .join('')}
      <div class="actions">
        <button class="btn ghost" data-role="">未知</button>
        <button class="btn" data-close="1">取消</button>
      </div>
    </div>`;
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-close]')) {
      mask.remove();
      return;
    }
    const chip = e.target.closest('[data-role]');
    if (!chip) return;
    const role = chip.getAttribute('data-role');
    if (!App.raw({ t: 'board', target, role: role || null })) App.toast('连接断了，正在重连…');
    mask.remove();
  });
  document.body.appendChild(mask);
}

function infoBody(v) {
  const cards = (v.knowledge || []).slice().reverse();
  const log = (v.pub.log || []).slice().reverse();
  const history = (v.pub.voteHistory || []).slice().reverse();
  const historyHtml = history.length
    ? `<div class="card" style="padding:14px 16px">
        <div class="tiny dim" style="margin-bottom:8px">提名与票型 · 全桌公开</div>
        ${history
          .map(
            (h) => `<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)">
              <div class="tiny">第 ${h.round} 天 · ${h.nominator}号 提名 ${h.nominee}号：
                <b>${h.count}</b> 票${h.executed ? ' · <span style="color:#e98b93">被处决</span>' : ''}</div>
              <div class="tiny dim">同意 ${(h.yes || []).join('、') || '无'}；反对 ${(h.no || []).join('、') || '无'}${
                (h.notVoted || []).length ? '；未投 ' + h.notVoted.join('、') : ''
              }</div>
            </div>`
          )
          .join('')}
      </div>`
    : '';
  return `<div class="stack">
    ${
      cards.length
        ? cards
            .map(
              (c) => `<div class="info-card">
                <h3>第 ${c.night || '?'} 夜 · ${escapeHtml(c.title || '情报')}</h3>
                ${cardBody(c)}
              </div>`
            )
            .join('')
        : '<div class="center dim" style="padding:30px 0">还没有情报</div>'
    }
    ${historyHtml}
    <div class="card" style="padding:14px 16px">
      <div class="tiny dim" style="margin-bottom:6px">公开记录 · 最新在上</div>
      ${log.map((e) => `<div class="log-line">${escapeHtml(e.text)}</div>`).join('')}
    </div>
  </div>`;
}

function cardBody(c) {
  if (c.kind === 'grimoire' && c.rows) {
    return `<table class="grimoire">${c.rows
      .map(
        (r) => `<tr>
          <td class="n">${r.seat}</td>
          <td>${escapeHtml(r.name)}</td>
          <td class="r">${escapeHtml(r.role)}</td>
          <td class="t">${escapeHtml((r.tags || []).join(' '))}</td>
        </tr>`
      )
      .join('')}</table>`;
  }
  return (c.lines || []).map((l) => `<div class="line">${escapeHtml(l)}</div>`).join('');
}

function meBody(v) {
  const me = v.me;
  const pub = v.pub;
  const revealPrompt =
    pub.phase === 'reveal'
      ? me.confirmed
        ? '<div class="center dim" style="padding:10px">已确认，等房主开始第一夜。</div>'
        : '<button class="btn primary big" data-act="confirm-role">我知道了</button>'
      : '';
  return `<div class="stack">
    ${fooledNote(me)}
    ${roleCardHtml(me.role)}
    ${revealPrompt}
    <div class="card" style="padding:16px">
      <div class="row" style="justify-content:space-between">
        <span class="dim">座位</span><b>${v.seat}号 · ${escapeHtml(v.name)}</b>
      </div>
      <div class="row" style="justify-content:space-between;margin-top:8px">
        <span class="dim">状态</span><b>${v.alive ? '存活' : '已死亡'}</b>
      </div>
      <div class="row" style="justify-content:space-between;margin-top:8px">
        <span class="dim">阶段</span><b>${phaseText(pub)}</b>
      </div>
      ${v.day && v.day.butler ? `<div class="row" style="justify-content:space-between;margin-top:8px">
        <span class="dim">你的主人</span><b>${v.day.butler.master ? v.day.butler.master + '号 ' + escapeHtml(v.day.butler.masterName || '') : '还没选'}</b>
      </div>` : ''}
    </div>
    <button class="btn ghost" data-act="toggle-vibrate">轮到时震动：${P.vibrate ? '开' : '关（默认静音）'}</button>
    <button class="btn ghost" data-act="leave">换座位（清本机身份）</button>
  </div>`;
}

/* -------------------------------- 夜间操作 -------------------------------- */

function nightAction(v) {
  const p = v.night.pending;
  if (!p) return '';
  if (p.type === 'info') {
    if (p.awaiting) {
      return `<div class="night-panel">
        <div class="hint">只给你看</div>
        <div class="dim" style="padding:14px 0">说书人正在准备情报…</div>
        <div class="tiny dim">不用点，好了会自动出现</div>
      </div>`;
    }
    return `<div class="night-panel">
      <div class="hint">只给你看</div>
      ${(p.cards || []).map((c) => `<div class="info-card"><h3>${escapeHtml(c.title || '')}</h3>${cardBody(c)}</div>`).join('')}
      <button class="btn primary big" data-act="ack">我看到了</button>
    </div>`;
  }
  return `<div class="night-panel">
    <div class="hint">轮到你了</div>
    <div style="font-size:1.3rem;font-weight:800">${escapeHtml(p.prompt || '')}</div>
    <div class="pick-grid">
      ${(p.options || [])
        .map(
          (o) => `<button class="pick ${P.sel.includes(o.seat) ? 'sel' : ''} ${o.alive === false ? 'dead' : ''}"
            data-act="pick" data-seat="${o.seat}">
            <span class="no">${o.seat}</span>
            <span class="grow">${escapeHtml(o.name)}</span>
            ${P.sel.includes(o.seat) ? '<span class="tag blood">已选</span>' : ''}
          </button>`
        )
        .join('')}
    </div>
    <button class="btn primary big" data-act="submit-night" ${P.sel.length < p.min ? 'disabled' : ''}>
      确认${p.max > 1 ? `（${P.sel.length}/${p.max}）` : ''}
    </button>
  </div>`;
}

/* -------------------------------- 交互 -------------------------------- */

// 身份卡：按住才显示，松手就盖回去
function clearHold() {
  document.querySelectorAll('.hold-wrap.holding').forEach((w) => w.classList.remove('holding'));
}

appEl.addEventListener('pointerdown', (e) => {
  const w = e.target && e.target.closest ? e.target.closest('.hold-wrap') : null;
  if (w) w.classList.add('holding');
});
appEl.addEventListener('contextmenu', (e) => {
  const w = e.target && e.target.closest ? e.target.closest('.hold-wrap') : null;
  if (w) e.preventDefault();
});
document.addEventListener('pointerup', clearHold);
document.addEventListener('pointercancel', clearHold);

appEl.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.getAttribute('data-act');
  const v = P.view;

  if (act === 'claim') {
    const seat = Number(el.getAttribute('data-seat'));
    const input = document.getElementById('join-name');
    const name = ((input && input.value) || P.nameInput || '').trim();
    P.nameInput = name;
    App.raw({ t: 'claim', seat, name: name || undefined });
    return;
  }

  if (act === 'tab') {
    P.tab = el.getAttribute('data-tab');
    render();
    return;
  }

  if (act === 'suspect') {
    const seat = Number(el.getAttribute('data-seat'));
    if (!App.raw({ t: 'suspect', target: seat })) App.toast('连接断了，正在重连…');
    return;
  }

  if (act === 'board-pick') {
    openRolePicker(Number(el.getAttribute('data-seat')));
    return;
  }

  if (act === 'role-sheet') {
    openRoleSheet();
    return;
  }

  if (act === 'confirm-role') {
    App.raw({ t: 'confirm' });
    return;
  }

  if (act === 'ack') {
    if (!App.raw({ t: 'night' })) App.toast('连接断了，正在重连…');
    return;
  }

  if (act === 'pick') {
    const seat = Number(el.getAttribute('data-seat'));
    const p = v.night.pending;
    if (!p) return;
    if (p.max === 1) {
      P.sel = [seat];
    } else if (P.sel.includes(seat)) {
      P.sel = P.sel.filter((s) => s !== seat);
    } else if (P.sel.length < p.max) {
      P.sel.push(seat);
    }
    render();
    return;
  }

  if (act === 'submit-night') {
    const p = v.night.pending;
    if (!p || P.sel.length < p.min) return;
    const targets = P.sel.slice();
    if (!App.raw({ t: 'night', targets })) App.toast('连接断了，正在重连…');
    return;
  }

  if (act === 'nominate') {
    const seat = Number(el.getAttribute('data-seat'));
    const ok = await App.confirm('提名', `提名 ${seat}号（${seatName(v.pub, seat)}）？`, '提名');
    if (ok) App.raw({ t: 'nominate', target: seat });
    return;
  }

  if (act === 'vote') {
    const yes = el.getAttribute('data-yes') === '1';
    if (!App.raw({ t: 'vote', yes })) App.toast('连接断了，正在重连…');
    return;
  }

  if (act === 'slayer') {
    const seat = Number(el.getAttribute('data-seat'));
    const ok = await App.confirm(
      '公开开枪',
      `你宣称自己是杀手，对 ${seat}号（${seatName(v.pub, seat)}）开枪。全桌都会看到这次开枪；打中恶魔只有真杀手做得到。`,
      '开枪'
    );
    if (ok) App.raw({ t: 'slayer', target: seat });
    return;
  }

  if (act === 'toggle-vibrate') {
    P.vibrate = !P.vibrate;
    App.store.set('btc.vibrate', P.vibrate ? '1' : '0');
    App.toast(P.vibrate ? '轮到你时会震动' : '已静音，靠屏幕提示');
    render();
    return;
  }

  if (act === 'leave') {
    const ok = await App.confirm('换座位', '会清掉这台手机上记住的座位，需要重新选座位。', '清掉');
    if (!ok) return;
    App.store.del('btc.seat');
    App.store.del('btc.token');
    startGuest(true);
    return;
  }
});

document.addEventListener('visibilitychange', updateNightLock);

boot();
