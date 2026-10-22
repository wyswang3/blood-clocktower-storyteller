'use strict';

/* 平板公共屏：只渲染 public 视图，页面里没有任何身份字段。 */

const appEl = document.getElementById('app');

const H = {
  view: null,
  drawer: false,
  pin: '',
  pinRejected: false,
  connected: true,
  stuck: false,
  wakeLock: null,
  aiSetupBusy: false,
  aiSetupAllowed: false,
  aiSetupMessage: '',
};

/* 平板别自动锁屏：一局四十分钟，黑屏一次就得解锁一次 */
async function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  if (document.visibilityState !== 'visible') return;
  try {
    H.wakeLock = await navigator.wakeLock.request('screen');
    H.wakeLock.addEventListener('release', () => {
      H.wakeLock = null;
    });
  } catch {
    /* 不支持就算了 */
  }
}

/* -------------------------------- 启动 -------------------------------- */

function boot() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('pin');
  if (fromUrl) {
    H.pin = fromUrl;
    App.store.set('btc.pin', fromUrl);
  } else {
    H.pin = App.store.get('btc.pin', '');
  }
  if (!H.pin) {
    render();
    return;
  }
  connectHost();
  render();
  keepAwake();
}

// 切回前台时重新申请，浏览器会在切后台时自动释放
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
});

// 夜里超过两分钟没人动，就提醒房主可以跳过
setInterval(() => {
  const v = H.view;
  const since = v && v.phase === 'night' && v.night ? v.night.waitingSince : null;
  const stuck = !!since && App.now() - since > 120000;
  if (stuck !== H.stuck) {
    H.stuck = stuck;
    render();
  }
}, 1500);

function connectHost() {
  App.start({
    role: 'host',
    pin: H.pin,
    seat: null,
    token: null,
    onView: (v) => {
      H.view = v;
      H.connected = true;
      render();
    },
    onStatus: (ok) => {
      H.connected = ok;
      render();
    },
    onError: (m) => {
      if (/PIN/.test(m.message || '')) {
        H.pinRejected = true;
        H.pin = '';
        H.view = null;
        App.stopped = true;
        render();
      }
    },
    onAISetup: (m) => {
      H.aiSetupBusy = m.status === 'working';
      H.aiSetupAllowed = m.allowed === true;
      H.aiSetupMessage = m.message || '';
      render();
    },
  });
}

/* -------------------------------- 渲染 -------------------------------- */

function render() {
  const v = H.view;
  if (!v) {
    appEl.className = 'app';
    appEl.innerHTML = !H.pin || H.pinRejected ? pinScreen() : loadingScreen();
    return;
  }
  let body;
  switch (v.phase) {
    case 'lobby':
      body = lobbyScreen(v);
      break;
    case 'reveal':
      body = revealScreen(v);
      break;
    case 'night':
      body = nightScreen(v);
      break;
    case 'ended':
      body = endScreen(v);
      break;
    default:
      body = dayScreen(v);
  }
  appEl.innerHTML = body + drawer(v);
  appEl.className = 'app host-phase-' + v.phase;
  App.tick();
}

function head(v) {
  let timer;
  if (v.deadline) {
    timer = `<div class="host-timer mono" data-deadline="${v.deadline}"></div>`;
  } else if (v.phase === 'lobby') {
    timer = `<div class="host-timer mono dim">${v.joinedCount}/${v.playerCount}</div>`;
  } else if (v.phase === 'night') {
    timer = `<div class="host-timer mono dim">夜间</div>`;
  } else {
    timer = '';
  }
  const sub = v.phase === 'day' ? ' · ' + daySubText(v) : '';
  const roundText = phaseText(v);
  const label = v.phaseLabel && v.phaseLabel !== roundText ? v.phaseLabel : '';
  return `
    <div class="host-head">
      <div class="host-title">
        <span class="host-round">${roundText}</span>
        <span class="host-phase">${label}${sub}</span>
      </div>
      ${timer}
    </div>`;
}

function loadingScreen() {
  return `<div class="waiting" style="height:100%"><div class="big">连接说书人服务…</div><div class="tiny">如果一直停在这里，检查平板和电脑是不是同一个 Wi-Fi</div><div class="tiny"><a href="/connect" style="color:#9b96a6">打开连接检查</a></div></div>`;
}

function pinScreen() {
  return `
    <div class="center stack" style="max-width:420px;margin:auto;padding:26px;width:100%">
      <h1 style="letter-spacing:.2em">说书人</h1>
      <p class="dim">输入启动服务时控制台打印的四位 PIN。</p>
      <input id="pin-input" inputmode="numeric" maxlength="8" autocomplete="off"
        style="width:100%;padding:16px;font-size:24px;text-align:center;letter-spacing:.4em;
        background:#17171f;border:1px solid #3a3a4a;border-radius:12px;color:#ece9e4" />
      <button class="btn primary big" data-act="pin-submit">进入</button>
    </div>`;
}

function seatList(v) {
  return v.seats
    .map(
      (s) => `
      <div class="seat-row ${s.joined ? 'on' : ''}">
        <span class="no">${s.seat}</span>
        <button class="grow name-btn" data-act="rename" data-seat="${s.seat}"
          title="点一下改名字">${escapeHtml(s.name)}</button>
        ${
          s.joined && v.phase === 'lobby'
            ? `<button class="btn ghost tiny" data-act="release" data-seat="${s.seat}" style="padding:.3em .6em">释放</button>`
            : ''
        }
        <span class="st ${s.joined ? 'tag green' : 'tag'}">${s.joined ? '已连接' : '空'}</span>
      </div>`
    )
    .join('');
}

function lobbyScreen(v) {
  const ready = v.joinedCount >= v.playerCount;
  const link = playerLink(v);
  return `
    <div class="host">
      ${head(v)}
      <div class="lobby">
        <div>
          <h1>血染钟楼 · 无人说书人</h1>
          <p class="dim">平板放桌子中间当公共屏，每人用自己的手机看私密信息。</p>
          <div class="url">${escapeHtml(link || '等待房间地址；本地开局请查看平板的 Wi-Fi IP。')}</div>
          <p class="tiny dim" style="margin-top:10px">打开房间链接选座位。公网链接可各用流量或 Wi-Fi，局域网链接需连同一网络。</p>
          <div class="row wrap" style="margin-top:12px">
            <button class="btn" data-act="copy">复制链接</button>
            <button class="btn" data-act="share">分享链接</button>
          </div>
          <div class="row wrap" style="margin-top:20px">
            <button class="btn primary big" data-act="start">开始游戏</button>
            <button class="btn" data-act="drawer">设置</button>
          </div>
          <div class="card" style="padding:14px;margin-top:16px" aria-live="polite">
            <div>AI 夜间情报：${escapeHtml(aiLabel(v.ai))}</div>
            <div class="row wrap" style="margin-top:10px">
              <button class="btn" data-act="setup-ai" ${H.aiSetupBusy ? 'disabled' : ''}>${H.aiSetupBusy ? '正在连接…' : v.ai && v.ai.configured ? '更换 DeepSeek 密钥' : '连接 DeepSeek'}</button>
              ${v.ai && v.ai.configured ? `<button class="btn" data-act="toggle-ai" ${H.aiSetupBusy ? 'disabled' : ''}>${v.ai.enabled ? '暂停 AI' : '启用 AI'}</button>` : ''}
            </div>
            <p class="tiny dim">可选：点按钮粘贴 API Key，自动保存并连接；不连接也能开始游戏。</p>
            ${H.aiSetupMessage ? `<p class="tiny">${escapeHtml(H.aiSetupMessage)}</p>` : ''}
          </div>
          <p class="tiny dim" style="margin-top:10px">
            ${ready ? '全部座位都连上了' : `还有 ${v.playerCount - v.joinedCount} 个座位没人加入`}
          </p>
        </div>
        <div class="seat-list">${seatList(v)}</div>
      </div>
    </div>`;
}

function revealScreen(v) {
  return `
    <div class="host">
      ${head(v)}
      <div class="host-main solo">
        <div class="center stack" style="margin:auto">
          <h1 style="letter-spacing:.18em;margin:0">发牌完成</h1>
          <p class="dim">各自在手机上看自己的身份，看完点「我知道了」。</p>
          <div class="big-num">${v.confirmedCount} <span class="dim" style="font-size:1.4rem">/ ${v.playerCount}</span></div>
          <button class="btn primary big" data-act="begin-night">开始第一夜</button>
        </div>
      </div>
      <div class="host-foot"><span>${v.confirmedCount === v.playerCount ? '所有人都确认了' : '等人确认中'}</span></div>
      <button class="btn ghost" data-act="drawer" style="position:fixed;right:20px;bottom:20px;color:#a39daf">说书人</button>
    </div>`;
}

function nightScreen(v) {
  return `
    <div class="night-screen">
      <div class="moon">☾</div>
      <h1>天黑了</h1>
      <p>请按顺序查看手机</p>
      ${v.night.waiting ? '<div class="wait dot-pulse">等待手机操作</div>' : ''}
      ${
        H.stuck && v.night.waiting
          ? `<div class="stuck-card">
               <div>已经等了两分多钟，可能有人没看手机。</div>
               <button class="btn" data-act="skip">跳过当前等待</button>
             </div>`
          : ''
      }
      <button class="btn ghost" data-act="drawer" style="position:fixed;right:20px;bottom:20px;color:#a39daf">说书人</button>
    </div>`;
}

function seatTile(s, v) {
  const d = v.day;
  const onblock = d && d.onTheBlock && d.onTheBlock.seat === s.seat;
  const nominee = d && d.vote && d.vote.nominee === s.seat;
  const cls = ['seat'];
  if (!s.alive) cls.push('dead');
  if (nominee) cls.push('nominee');
  if (onblock) cls.push('onblock');
  const badges = [];
  if (!s.joined) badges.push('<span class="tag">无手机</span>');
  if (s.hasNominated) badges.push('<span class="tag">已提名</span>');
  if (s.nominated) badges.push('<span class="tag blood">被提名</span>');
  if (d && d.vote && s.voted) badges.push('<span class="tag green">已投票</span>');
  if (!s.alive) badges.push('<span class="tag blood">死亡</span>');
  let strip = '';
  if (nominee && d && d.vote && d.vote.alive > 0) {
    const yp = (d.vote.yes / d.vote.alive) * 100;
    strip = `<div class="vote-strip"><div class="y" style="width:${yp}%"></div><div class="n" style="width:${
      100 - yp
    }%"></div></div>`;
  }
  return `
    <div class="${cls.join(' ')}">
      ${onblock ? `<span class="corner">最高 ${d.onTheBlock.count} 票</span>` : ''}
      <div>
        <div class="seat-no">${s.seat}</div>
        <div class="seat-name">${escapeHtml(s.name)}</div>
      </div>
      <div class="seat-badges">${badges.join('')}</div>
      ${strip}
    </div>`;
}

function sidePanel(v) {
  const d = v.day;
  const bits = [];
  if (d && d.vote) {
    bits.push(`
      <div class="vote-panel">
        <div class="side-title">投票中</div>
        <div style="margin-top:6px">${d.vote.nominator}号 提名 ${d.vote.nominee}号</div>
        <div class="vote-nums">
          <span class="n y">${d.vote.yes}</span><span class="dim">同意</span>
          <span class="n n2">${d.vote.no}</span><span class="dim">反对</span>
        </div>
        <div class="tiny dim">已投 ${d.vote.voted} / ${d.vote.alive}</div>
        <div class="host-timer mono" data-deadline="${d.vote.deadline}"></div>
      </div>`);
  } else if (d && d.lastVote) {
    bits.push(`
      <div class="vote-panel">
        <div class="side-title">上一轮投票</div>
        <div style="margin-top:6px">${d.lastVote.nominator}号 提名 ${d.lastVote.nominee}号</div>
        <div class="vote-nums"><span class="n y">${d.lastVote.count}</span><span class="dim">票同意</span></div>
        ${d.lastVote.butlerVoided ? '<div class="tiny dim">管家的票未计入（主人没投同意）</div>' : ''}
      </div>`);
  }
  if (d && d.onTheBlock) {
    bits.push(`
      <div class="vote-panel">
        <div class="side-title">当前最高</div>
        <div style="margin-top:6px;font-size:1.4rem;font-weight:800">
          ${d.onTheBlock.seat}号 <span class="dim" style="font-size:1rem">${d.onTheBlock.count} 票</span>
          ${d.onTheBlock.tied ? '<span class="tag blood">并列</span>' : ''}
        </div>
      </div>`);
  }
  if (d && d.executed) {
    bits.push(`<div class="vote-panel"><div class="side-title">今日处决</div><div style="margin-top:6px;font-size:1.3rem;font-weight:800">${d.executed.seat}号</div></div>`);
  }
  const logs = v.log
    .slice(-30)
    .reverse()
    .map((e) => `<div class="entry">${escapeHtml(e.text)}</div>`)
    .join('');
  return `<div class="side">${bits.join('')}<div class="log">${logs}</div></div>`;
}

function dayScreen(v) {
  return `
    <div class="host">
      ${head(v)}
      <div class="host-main">
        <div class="board n${v.playerCount}">${v.seats.map((s) => seatTile(s, v)).join('')}</div>
        ${sidePanel(v)}
      </div>
      <div class="host-foot">
        <span>${v.day && v.day.sub === 'discuss' ? '讨论时间结束就可以开始提名' : ''}</span>
        <button class="gear" data-act="drawer" title="说书人操作">⚙</button>
      </div>
    </div>`;
}

function endScreen(v) {
  const good = v.winner === 'good';
  const table = (v.finalRoles || [])
    .map(
      (r) => `
      <div class="cell ${r.team}">
        ${r.id ? `<img class="reveal-thumb" src="/art/roles/${r.id}.jpg" alt="" onerror="this.style.display='none'" />` : ''}
        <div class="r">${r.seat}号 ${escapeHtml(r.name)}</div>
        <div class="s">${escapeHtml(r.role)} · ${escapeHtml(r.typeLabel)}</div>
      </div>`
    )
    .join('');
  const timeline = (v.timeline || [])
    .map(
      (t) =>
        `<div class="tl-row"><span class="tl-when">第 ${t.round} ${t.where === '夜里' ? '夜' : '天'}</span>
         <span class="tl-who">${t.seat}号 ${escapeHtml(t.name)}</span>
         <span class="tl-how">${escapeHtml(t.how)}</span></div>`
    )
    .join('');
  return `
    <div class="host">
      ${head(v)}
      <div class="host-main solo">
        <div class="end-screen">
          <div class="verdict ${good ? 'good' : 'evil'}">${good ? '好人胜利' : '坏人胜利'}</div>
          <div class="why">${escapeHtml(v.winReasonLabel || '')}</div>
          <div class="reveal-table">${table}</div>
          ${timeline ? `<div class="timeline">${timeline}</div>` : ''}
          <button class="btn primary big" data-act="reset">再来一局</button>
        </div>
      </div>
    </div>`;
}

function drawer(v) {
  const d = v.day;
  const btns = [];
  if (v.phase === 'lobby') {
    btns.push(`<button class="btn" data-act="count-minus">人数 −</button>`);
    btns.push(`<span class="num">${v.playerCount} 人</span>`);
    btns.push(`<button class="btn" data-act="count-plus">人数 ＋</button>`);
    btns.push(
      `<label class="switch"><input type="checkbox" data-act="toggle-baron" ${
        v.config && v.config.allowBaron ? 'checked' : ''
      } /> 允许男爵</label>`
    );
    btns.push(`<button class="btn primary" data-act="start">开始游戏</button>`);
  }
  if (v.phase === 'reveal') {
    btns.push(`<button class="btn primary" data-act="begin-night">开始第一夜</button>`);
  }
  if (v.phase === 'night') {
    btns.push(
      `<button class="btn" data-act="skip" ${v.night.waiting ? '' : 'disabled'}>跳过当前等待</button>`
    );
  }
  if (v.phase === 'day' && d) {
    if (d.sub === 'discuss') btns.push(`<button class="btn primary" data-act="begin-nominations">开始提名</button>`);
    if (d.sub === 'nominate') btns.push(`<button class="btn primary" data-act="end-nominations">结束提名</button>`);
    if (d.sub === 'vote') btns.push(`<button class="btn" data-act="close-vote">结束投票</button>`);
    if (d.sub === 'ended') btns.push(`<button class="btn primary" data-act="next-night">进入夜晚</button>`);
    if (d.sub === 'discuss' || d.sub === 'nominate') {
      btns.push(`<button class="btn ghost" data-act="end-day">直接结束白天</button>`);
    }
  }
  if (v.phase === 'day' || v.phase === 'night') {
    btns.push(`<button class="btn ghost" data-act="finish-early">提前结束</button>`);
  }
  btns.push(`<button class="btn ghost" data-act="reset">重开一局</button>`);
  btns.push(`<span class="spacer"></span><button class="btn ghost" data-act="close-drawer">收起</button>`);

  const discuss = [180000, 300000, 480000]
    .map(
      (ms) =>
        `<button class="btn tiny ${v.settings && v.settings.discussMs === ms ? 'primary' : ''}"
          data-act="timers" data-discuss="${ms}">${ms / 60000} 分</button>`
    )
    .join('');
  const vote = [30000, 60000, 90000]
    .map(
      (ms) =>
        `<button class="btn tiny ${v.settings && v.settings.voteMs === ms ? 'primary' : ''}"
          data-act="timers" data-vote="${ms}">${ms / 1000} 秒</button>`
    )
    .join('');

  return `
    <div class="drawer ${H.drawer ? 'open' : ''}">
      <h3>说书人操作</h3>
      <div class="drawer-row">${btns.join('')}</div>
      <div class="drawer-row" style="margin-top:12px">
        <span class="tiny dim">讨论</span>${discuss}
        <span class="tiny dim" style="margin-left:10px">投票</span>${vote}
      </div>
      <div class="drawer-row" style="margin-top:12px;color:#9b96a6;font-size:.78rem">
        AI 说书人：${v.storytellerOnline ? '已连接' : '未连接'} ·
        情报：${v.infoMode === 'storyteller' ? '说书人裁量' : '自动发放'}
      </div>
      <div class="drawer-row" style="margin-top:6px">
        <span class="tiny dim">DeepSeek：${escapeHtml(aiLabel(v.ai))}</span>
        <button class="btn tiny" data-act="setup-ai" ${H.aiSetupBusy ? 'disabled' : ''}>${H.aiSetupBusy ? '正在连接…' : v.ai && v.ai.configured ? '更换密钥' : '连接 DeepSeek'}</button>
        <button class="btn tiny" data-act="toggle-ai" ${v.ai && v.ai.configured && !H.aiSetupBusy ? '' : 'disabled'}>${v.ai && v.ai.enabled ? '暂停 AI' : '启用 AI'}</button>
        <button class="btn tiny" data-act="test-ai" ${v.ai && v.ai.configured && !H.aiSetupBusy ? '' : 'disabled'}>测试连接（1 次调用）</button>
      </div>
      ${H.aiSetupMessage ? `<p class="tiny" role="status">${escapeHtml(H.aiSetupMessage)}</p>` : ''}
      <div class="drawer-row" style="margin-top:6px;color:#615d6b;font-size:.78rem">
        平板放桌子中间，这个抽屉防误触、不防作弊。PIN 在平板启动窗口里。
      </div>
    </div>`;
}

/* -------------------------------- 交互 -------------------------------- */

function hostAct(action, extra) {
  const ok = App.raw({ t: 'host', action, ...(extra || {}) });
  if (!ok) App.toast('连接断了，正在重连…');
}

function aiLabel(status) {
  if (!status || !status.configured) return '尚未连接，可直接开局';
  if (!status.enabled) return '已配置，未启用';
  return status.state === 'working' ? '正在准备情报' : status.state === 'fallback' ? '本次调用失败，已自动发情报' : '已启用';
}

function playerLink(v = H.view) {
  if (v && v.joinUrl) return v.joinUrl;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(location.origin)) return '';
  return location.origin + '/player';
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      resolve();
    } catch (e) {
      reject(e);
    } finally {
      ta.remove();
    }
  });
}

async function sharePlayerLink() {
  const url = playerLink();
  if (!url) return App.toast('房间地址尚未就绪，请等待公网链接或查看平板的 Wi-Fi IP。');
  if (navigator.share) {
    try {
      await navigator.share({ title: '血染钟楼', text: '打开这个地址选座位', url });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  try {
    await copyText(url);
    App.toast('链接已复制，发到群里就行');
  } catch {
    App.toast('复制失败，手输地址：' + url);
  }
}

appEl.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.getAttribute('data-act');
  const v = H.view;

  if (act === 'pin-submit') {
    const input = document.getElementById('pin-input');
    const pin = (input && input.value || '').trim();
    if (!pin) return;
    H.pin = pin;
    H.pinRejected = false;
    App.store.set('btc.pin', pin);
    render();
    connectHost();
    return;
  }
  if (act === 'copy') {
    if (!playerLink()) return App.toast('房间地址尚未就绪，请等待公网链接或查看平板的 Wi-Fi IP。');
    copyText(playerLink())
      .then(() => App.toast('链接已复制'))
      .catch(() => App.toast('复制失败，手输地址：' + playerLink()));
    return;
  }
  if (act === 'share') {
    sharePlayerLink();
    return;
  }
  if (act === 'drawer') {
    H.drawer = true;
    render();
    return;
  }
  if (act === 'close-drawer') {
    H.drawer = false;
    render();
    return;
  }
  if (act === 'count-plus') return hostAct('setCount', { count: Math.min(15, v.playerCount + 1) });
  if (act === 'count-minus') return hostAct('setCount', { count: Math.max(5, v.playerCount - 1) });
  if (act === 'release') {
    const seat = Number(el.getAttribute('data-seat'));
    if (await App.confirm('释放座位', `释放 ${seat}号，那台手机需要重新选座位。`, '释放')) {
      hostAct('release', { seat });
    }
    return;
  }
  if (act === 'rename') {
    const seat = Number(el.getAttribute('data-seat'));
    const cur = (v.seats.find((s) => s.seat === seat) || {}).name || '';
    const name = await App.ask('改座位名', { text: `${seat} 号`, value: cur, okLabel: '改' });
    if (name) hostAct('rename', { seat, name });
    return;
  }
  if (act === 'timers') {
    const d = el.getAttribute('data-discuss');
    const vt = el.getAttribute('data-vote');
    hostAct('setTimers', {
      discussMs: d ? Number(d) : undefined,
      voteMs: vt ? Number(vt) : undefined,
    });
    return;
  }
  if (act === 'toggle-baron') {
    return hostAct('allowBaron', { value: !(v.config && v.config.allowBaron) });
  }
  if (act === 'start') {
    const missing = v.playerCount - v.joinedCount;
    if (missing > 0) {
      const ok = await App.confirm(
        '还有人没连上',
        `还有 ${missing} 个座位没有手机加入，这些座位上看不到自己的身份。确定现在开始？`,
        '仍然开始'
      );
      if (!ok) return;
      App.raw({ t: 'host', action: 'start', force: true });
      return;
    }
    const r = App.raw({ t: 'host', action: 'start' });
    if (!r) App.toast('连接断了');
    return;
  }
  if (act === 'begin-night') return hostAct('beginNight');
  if (act === 'skip') return hostAct('skip');
  if (act === 'begin-nominations') return hostAct('beginNominations');
  if (act === 'close-vote') return hostAct('closeVote');
  if (act === 'next-night') return hostAct('beginNight', { round: (v.round || 0) + 1 });
  if (act === 'setup-ai') {
    if (H.aiSetupBusy) return;
    if (!H.aiSetupAllowed) return App.alert('请在平板上操作', '请用平板启动窗口显示的本机房主链接填写密钥；使用公网时须打开 HTTPS 房主页面。');
    let key = await App.ask(v.ai && v.ai.configured ? '更换 DeepSeek 密钥' : '连接 DeepSeek', {
      text: '只粘贴 DeepSeek 的 API Key，不需要代码、网址或下载模型。确认后会测试一次接口（按账户规则计费），成功后自动保存并启用。请避开他人视线填写。',
      placeholder: '粘贴 API Key', maxlength: 512, secret: true, okLabel: '保存并连接',
    });
    if (key == null) return;
    key = key.trim();
    if (!/^[A-Za-z0-9_-]{8,512}$/.test(key)) return App.toast('请粘贴完整的 API Key，不要输入代码或空格。');
    H.aiSetupBusy = true; H.aiSetupMessage = '正在连接 DeepSeek，请稍等…';
    const sent = App.raw({ t: 'host', action: 'configureAI', apiKey: key });
    key = null;
    if (!sent) { H.aiSetupBusy = false; H.aiSetupMessage = '连接已断开，请等待恢复后重新填写。'; }
    render();
    return;
  }
  if (act === 'toggle-ai') return hostAct('setAI', { enabled: !(v.ai && v.ai.enabled) });
  if (act === 'test-ai') return hostAct('testAI');
  if (act === 'finish-early') {
    const side = await App.ask('全桌确认后提前结束', {
      text: '请输入“好人”或“坏人”指定获胜方。结束后会公开全员身份。',
      placeholder: '好人 / 坏人', maxlength: 2, okLabel: '下一步',
    });
    if (side == null) return;
    if (side !== '好人' && side !== '坏人') return App.toast('请输入“好人”或“坏人”');
    if (await App.confirm('确认提前结束', `将宣布${side}获胜并公开全员身份。请确认全桌已经同意。`, '确认结束')) {
      hostAct('finishEarly', { winner: side === '好人' ? 'good' : 'evil' });
    }
    return;
  }
  if (act === 'end-day') {
    if (await App.confirm('结束白天', '不会再进行提名和投票，直接进入结算。', '结束白天')) {
      hostAct('endDay');
    }
    return;
  }
  if (act === 'end-nominations') {
    const d = v.day;
    const top = d && d.onTheBlock;
    const text = top
      ? `当前最高是 ${top.seat}号（${top.count} 票）。确认结束提名并结算处决。`
      : '今天还没有有效提名，结束提名后无人被处决。';
    if (await App.confirm('结束提名', text, '结束提名')) hostAct('endNominations');
    return;
  }
  if (act === 'reset') {
    if (await App.confirm('重开一局', '所有人保留座位，重新发牌。', '重开')) {
      hostAct('reset', { count: v.playerCount });
    }
    return;
  }
});

boot();
