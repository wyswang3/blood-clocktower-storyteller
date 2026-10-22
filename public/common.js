'use strict';

/**
 * 前端公共层：WebSocket 连接、断线重连、服务端时钟、toast、确认框、倒计时。
 * 这里没有任何身份数据 —— 所有内容都来自服务端裁剪好的 view。
 */

const App = {
  ws: null,
  view: null,
  seq: 0,
  role: 'guest',
  seat: null,
  token: null,
  pin: null,
  offset: 0,
  retry: 0,
  connected: false,
  stopped: false,
  onView: null,
  onStatus: null,
  onNeedClaim: null,
  onWelcome: null,
  onError: null,
  lastNoticeSeq: 0,
  timers: [],

  /* ------------------------------ 存储 ------------------------------ */

  store: {
    get(k, d) {
      try {
        const v = window.localStorage.getItem(k);
        return v == null ? d : v;
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* 隐私模式忽略 */
      }
    },
    del(k) {
      try {
        window.localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    },
  },

  /* ------------------------------ 启动 ------------------------------ */

  start(opts) {
    Object.assign(this, opts);
    this.stopped = false;
    this.connect();
    if (!this._ticker) {
      this._ticker = setInterval(() => this.tick(), 250);
    }
  },

  connect() {
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    let ws;
    try {
      ws = new WebSocket(proto + location.host + '/ws');
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.retry = 0;
      this.raw({
        t: 'hello',
        role: this.role,
        seat: this.seat,
        token: this.token,
        pin: this.pin,
        since: this.seq || undefined,
      });
    });
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      this.incoming(ev.data);
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.setConnected(false);
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      /* close 会跟着来 */
    });
  },

  /** 换身份重连（游客 ↔ 玩家），先掐掉旧连接再连。 */
  restart(opts) {
    Object.assign(this, opts);
    this.stopped = false;
    this.seq = 0;
    this.lastNoticeSeq = 0;
    this.offset = 0;
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
    this.connect();
  },

  scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(5000, 400 * Math.pow(1.6, this.retry++));
    setTimeout(() => this.connect(), delay);
  },

  raw(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  },

  incoming(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.t === 'welcome') {
      this.setConnected(true);
      if (this.onWelcome) this.onWelcome(msg);
      return;
    }
    if (msg.t === 'sync') {
      this.apply(msg.view, msg.since);
      this.setConnected(true);
      return;
    }
    if (msg.t === 'event') {
      if (Number.isFinite(msg.seq) && msg.seq > this.seq) {
        this.apply(msg.view, msg.seq);
        if (msg.notice && msg.seq > this.lastNoticeSeq) {
          this.lastNoticeSeq = msg.seq;
          this.toast(msg.notice);
        }
      }
      return;
    }
    if (msg.t === 'token') {
      this.seat = msg.seat;
      this.token = msg.token;
      this.role = 'player';
      this.store.set('btc.seat', String(msg.seat));
      this.store.set('btc.token', msg.token);
      this.setConnected(true);
      return;
    }
    if (msg.t === 'need-claim') {
      this.store.del('btc.token');
      this.store.del('btc.seat');
      this.seat = null;
      this.token = null;
      this.role = 'guest';
      if (this.onNeedClaim) this.onNeedClaim();
      return;
    }
    if (msg.t === 'error') {
      this.toast(msg.message);
      if (this.onError) this.onError(msg);
      return;
    }
    if (msg.t === 'ai-test') {
      this.toast(msg.message, 6000);
      return;
    }
  },

  apply(view, seq) {
    if (!view) return;
    this.view = view;
    if (Number.isFinite(seq)) this.seq = seq;
    if (Number.isFinite(view.now)) {
      this.offset = view.now - Date.now();
    }
    if (this.onView) this.onView(view);
  },

  setConnected(ok) {
    if (this.connected === ok) return;
    this.connected = ok;
    if (this.onStatus) this.onStatus(ok);
  },

  /** iOS 切后台回来：连接可能已经死了，立刻重连。 */
  poke() {
    if (this.stopped) return;
    if (!this.ws || this.ws.readyState !== 1) {
      this.retry = 0;
      this.connect();
    } else {
      this.raw({ t: 'ping' });
    }
  },

  now() {
    return Date.now() + this.offset;
  },

  /* ------------------------------ 倒计时 ------------------------------ */

  tick() {
    const now = this.now();
    const nodes = document.querySelectorAll('[data-deadline]');
    for (const el of nodes) {
      const d = Number(el.getAttribute('data-deadline'));
      if (!d) {
        el.textContent = '--:--';
        continue;
      }
      const left = Math.max(0, d - now);
      el.textContent = fmtClock(left);
      el.classList.toggle('warn', left > 0 && left <= 30000);
      el.classList.toggle('out', left === 0);
    }
  },

  /* ------------------------------ 提示 ------------------------------ */

  toast(text, ms = 3200) {
    const box = document.getElementById('toasts');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = text;
    box.appendChild(div);
    setTimeout(() => {
      div.style.opacity = '0';
      div.style.transition = 'opacity .3s';
      setTimeout(() => div.remove(), 320);
    }, ms);
  },

  confirm(title, text, okLabel = '确定', cancelLabel = '取消') {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `
        <div class="modal">
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(text || '')}</p>
          <div class="actions">
            <button class="btn ghost" data-r="0">${escapeHtml(cancelLabel)}</button>
            <button class="btn primary" data-r="1">${escapeHtml(okLabel)}</button>
          </div>
        </div>`;
      const close = (v) => {
        mask.remove();
        resolve(v);
      };
      mask.addEventListener('click', (e) => {
        if (e.target === mask) return close(false);
        const btn = e.target.closest('[data-r]');
        if (!btn) return;
        close(btn.getAttribute('data-r') === '1');
      });
      document.body.appendChild(mask);
    });
  },

  alert(title, text) {
    return this.confirm(title, text, '知道了', '');
  },

  /** 带输入框的确认框。返回输入的字符串，取消返回 null。 */
  ask(title, opts = {}) {
    const text = opts.text || '';
    const placeholder = opts.placeholder || '';
    const value = opts.value == null ? '' : String(opts.value);
    const maxlength = opts.maxlength || 8;
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `
        <div class="modal">
          <h2>${escapeHtml(title)}</h2>
          ${text ? `<p>${escapeHtml(text)}</p>` : ''}
          <input class="modal-input" maxlength="${maxlength}" value="${escapeHtml(value)}"
            placeholder="${escapeHtml(placeholder)}" />
          <div class="actions">
            <button class="btn ghost" data-r="0">取消</button>
            <button class="btn primary" data-r="1">${escapeHtml(opts.okLabel || '确定')}</button>
          </div>
        </div>`;
      const input = mask.querySelector('.modal-input');
      const close = (v) => {
        mask.remove();
        resolve(v);
      };
      mask.addEventListener('click', (e) => {
        if (e.target === mask) return close(null);
        const btn = e.target.closest('[data-r]');
        if (!btn) return;
        if (btn.getAttribute('data-r') === '1') {
          const v = input ? input.value.trim() : '';
          close(v || null);
        } else {
          close(null);
        }
      });
      mask.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const v = input ? input.value.trim() : '';
          close(v || null);
        }
      });
      document.body.appendChild(mask);
      setTimeout(() => {
        if (input) {
          input.focus();
          input.select();
        }
      }, 60);
    });
  },
};

/* ------------------------------ 小工具 ------------------------------ */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function fmtClock(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function seatName(view, seat) {
  const s = view.seats.find((x) => x.seat === seat);
  return s ? s.name : `${seat}号`;
}

function seatLabel(view, seat) {
  return `${seat}号 · ${seatName(view, seat)}`;
}

function phaseText(view) {
  if (view.phase === 'night') return `第 ${view.round} 夜`;
  if (view.phase === 'day') return `第 ${view.round} 天`;
  if (view.phase === 'reveal') return '发牌';
  if (view.phase === 'ended') return '结束';
  return '准备中';
}

function daySubText(view) {
  const d = view.day;
  if (!d) return '';
  if (d.sub === 'discuss') return '讨论';
  if (d.sub === 'nominate') return '提名';
  if (d.sub === 'vote') return '投票';
  if (d.sub === 'ended') return '白天结束';
  return '';
}

// iOS 键盘弹起时不要顶飞布局；同时兜底老浏览器的 100vh
window.addEventListener('resize', () => {
  document.documentElement.style.setProperty('--vh', window.innerHeight * 0.01 + 'px');
});
document.documentElement.style.setProperty('--vh', window.innerHeight * 0.01 + 'px');

// 切后台再回来：手机锁屏、微信切走都会把 WebSocket 冻死
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') App.poke();
});
window.addEventListener('online', () => App.poke());
window.addEventListener('pageshow', (e) => {
  if (e.persisted) App.poke();
});
