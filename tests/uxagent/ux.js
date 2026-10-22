'use strict';

/**
 * 无头浏览器操作台：给测试代理用的最小命令行。
 *
 *   node tests/uxagent/ux.js <调试端口> state
 *   node tests/uxagent/ux.js <调试端口> click "开始游戏"
 *   node tests/uxagent/ux.js <port> fill "#join-name" "阿猫"
 *   node tests/uxagent/ux.js <port> shot <文件.png>
 *   node tests/uxagent/ux.js <port> hold <毫秒>
 *   node tests/uxagent/ux.js <port> holdshot <文件.png> [毫秒]
 *   node tests/uxagent/ux.js <port> wait <秒> [关键字]
 *   node tests/uxagent/ux.js <port> goto <url>
 *   node tests/uxagent/ux.js <port> eval "<js>"
 *
 * 每个端口对应一个独立的 Chrome 配置目录（一个座位一台手机）。
 */

const path = require('node:path');
const { connect } = require('./cdp');

const PORT = Number(process.argv[2]);
const CMD = process.argv[3];
const ROOT = path.resolve(__dirname, '..', '..');

const PAGE_STATE = `(() => {
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };
  // 抽屉关着的时候只是滑出屏幕，DOM 里还在；屏幕上确实看不见
  const inClosedDrawer = (el) => {
    const d = el.closest('.drawer');
    return !!d && !d.classList.contains('open');
  };
  const mask = document.querySelector('.modal-mask');
  const controls = [];
  for (const el of document.querySelectorAll('[data-act], button, input, textarea, a[href]')) {
    if (!visible(el) || inClosedDrawer(el)) continue;
    if (mask && !el.closest('.modal-mask')) continue; // 弹窗挡住了，点不到
    const r = el.getBoundingClientRect();
    controls.push({
      tag: el.tagName.toLowerCase(),
      text: norm(el.innerText || el.value || el.getAttribute('placeholder') || ''),
      act: el.getAttribute('data-act') || '',
      seat: el.getAttribute('data-seat') || '',
      tab: el.getAttribute('data-tab') || '',
      disabled: !!el.disabled,
      covered: !!el.closest('.hold-wrap'),
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    });
  }
  // 按屏幕上真正看得见的东西拼文字
  const out = [];
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const t = child.textContent.replace(/\\s+/g, ' ').trim();
        if (t) out.push(t);
        continue;
      }
      if (child.nodeType !== 1 || SKIP[child.tagName]) continue;
      const st = getComputedStyle(child);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      if (child.classList.contains('drawer') && !child.classList.contains('open')) continue;
      if (child.classList.contains('hold-wrap') && !child.classList.contains('holding')) {
        out.push('（身份卡盖着：要用 holdshot 按住才看得到）');
        continue;
      }
      walk(child);
    }
  };
  walk(document.body);
  return {
    url: location.href,
    text: out.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim(),
    modal: mask ? mask.innerText.trim() : '',
    toasts: [...document.querySelectorAll('.toast')].map((t) => norm(t.textContent)),
    controls,
  };
})()`;

function fmtState(s) {
  const lines = [];
  lines.push('URL: ' + s.url);
  if (s.modal) {
    lines.push('');
    lines.push('—— 弹窗 ——');
    lines.push(s.modal);
  }
  if (s.toasts && s.toasts.length) {
    lines.push('');
    lines.push('—— 提示 ——');
    for (const t of s.toasts) lines.push('· ' + t);
  }
  lines.push('');
  lines.push('—— 屏幕文字 ——');
  lines.push(s.text || '(空)');
  lines.push('');
  lines.push('—— 可以点的东西 ——');
  let n = 0;
  for (const c of s.controls) {
    n++;
    const bits = [];
    bits.push(`[${c.tag}]`);
    if (c.act) bits.push(`act=${c.act}`);
    if (c.seat) bits.push(`seat=${c.seat}`);
    if (c.tab && c.tab !== c.act) bits.push(`tab=${c.tab}`);
    if (c.disabled) bits.push('(禁用)');
    if (c.covered) bits.push('(被身份卡盖住)');
    bits.push('“' + (c.text || c.tag) + '”');
    lines.push(`${n}. ` + bits.join(' '));
  }
  if (!n) lines.push('(没有可点控件)');
  return lines.join('\n');
}

async function state(page) {
  return page.evalJs(PAGE_STATE);
}

async function doClick(page, wanted) {
  const s = await state(page);
  const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const want = norm(wanted);
  // 人点的是看得见的文字；先精确、再包含、再模糊
  const pool = s.controls.filter((c) => !c.disabled && c.tag !== 'input' && c.tag !== 'textarea');
  let hit = pool.find((c) => norm(c.text) === want);
  if (!hit) hit = pool.find((c) => norm(c.text).startsWith(want));
  if (!hit) hit = pool.find((c) => norm(c.text).includes(want));
  if (!hit) {
    const names = pool.map((c) => norm(c.text)).filter(Boolean).slice(0, 40);
    throw new Error('找不到可点的“' + want + '”。当前可点：' + names.join(' | '));
  }
  const res = await page.evalJs(`(() => {
    const want = ${JSON.stringify(want)};
    const norm = (x) => String(x == null ? '' : x).replace(/\\s+/g, ' ').trim();
    const pool = [...document.querySelectorAll('[data-act], button, a[href]')].filter((el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && !el.disabled;
    });
    let hit = pool.find((el) => norm(el.innerText) === want);
    if (!hit) hit = pool.find((el) => norm(el.innerText).startsWith(want));
    if (!hit) hit = pool.find((el) => norm(el.innerText).includes(want));
    if (!hit) return { ok: false };
    hit.scrollIntoView({ block: 'center' });
    hit.click();
    return { ok: true, text: norm(hit.innerText), act: hit.getAttribute('data-act') };
  })()`);
  if (!res || !res.ok) throw new Error('点击失败：' + want);
  return res;
}

async function doFill(page, selector, value) {
  return page.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('找不到输入框 ' + ${JSON.stringify(selector)});
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
}

async function doHold(page, ms) {
  return page.evalJs(`(async () => {
    const w = document.querySelector('.hold-wrap');
    if (!w) throw new Error('这页没有身份卡');
    w.classList.add('holding');
    await new Promise((r) => setTimeout(r, ${Math.max(200, ms || 1200)}));
    const name = w.innerText;
    w.classList.remove('holding');
    return name;
  })()`);
}

async function doWait(page, seconds, needle) {
  const started = Date.now();
  const limit = Math.max(1, seconds || 30) * 1000;
  // 倒计时每秒都在跳，不能算"屏幕变了"，否则 wait 会立刻返回
  const SIG = `(() => {
    const t = document.body.innerText.replace(/\\d{1,2}:\\d{2}/g, 'MM:SS');
    return t.length + '|' + t.slice(0, 600);
  })()`;
  const first = await page.evalJs(SIG);
  while (Date.now() - started < limit) {
    await new Promise((r) => setTimeout(r, 600));
    if (needle) {
      const has = await page.evalJs(`document.body.innerText.includes(${JSON.stringify(needle)})`);
      if (has) return { changed: true, reason: '出现了“' + needle + '”' };
      continue;
    }
    let now;
    try {
      now = await page.evalJs(SIG);
    } catch {
      continue;
    }
    if (now !== first) return { changed: true, reason: '屏幕变了' };
  }
  return { changed: false, reason: '等待超时，屏幕没变化' };
}

(async () => {
  if (!PORT || !CMD) {
    console.error('用法：node tests/uxagent/ux.js <调试端口> <state|click|fill|shot|hold|holdshot|wait|goto|eval> ...');
    process.exit(2);
  }
  const page = await connect(PORT);
  try {
    // 8 号是平板，其余是手机
    if (PORT === 9308) await page.setMetrics(1280, 800, 1, false);
    else await page.setMetrics(390, 844, 2, true);
    await new Promise((r) => setTimeout(r, 300));
    if (CMD === 'state') {
      console.log(fmtState(await state(page)));
    } else if (CMD === 'click') {
      const res = await doClick(page, process.argv.slice(4).join(' '));
      console.log('已点击：' + res.text + (res.act ? '（' + res.act + '）' : ''));
      await new Promise((r) => setTimeout(r, 500));
      console.log(fmtState(await state(page)));
    } else if (CMD === 'fill') {
      const v = await doFill(page, process.argv[4], process.argv.slice(5).join(' '));
      console.log('已填写：' + v);
    } else if (CMD === 'shot') {
      let file = process.argv[4];
      if (!path.isAbsolute(file)) file = path.join(ROOT, file);
      await page.screenshot(file);
      console.log('截图：' + file);
    } else if (CMD === 'hold') {
      const txt = await doHold(page, Number(process.argv[4]) || 1200);
      console.log('按住时看到：\n' + txt);
    } else if (CMD === 'holdshot') {
      let file = process.argv[4];
      if (!path.isAbsolute(file)) file = path.join(ROOT, file);
      await page.evalJs(`document.querySelector('.hold-wrap') && document.querySelector('.hold-wrap').classList.add('holding')`);
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot(file);
      await page.evalJs(`document.querySelector('.hold-wrap') && document.querySelector('.hold-wrap').classList.remove('holding')`);
      console.log('截图（按住身份卡）：' + file);
    } else if (CMD === 'wait') {
      const r = await doWait(page, Number(process.argv[4]) || 30, process.argv[5]);
      console.log('等待结束：' + r.reason);
      console.log(fmtState(await state(page)));
    } else if (CMD === 'goto') {
      await page.goto(process.argv[4]);
      console.log('已打开：' + process.argv[4]);
      await new Promise((r) => setTimeout(r, 1200));
      console.log(fmtState(await state(page)));
    } else if (CMD === 'eval') {
      const v = await page.evalJs(process.argv.slice(4).join(' '));
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    } else {
      console.error('未知命令：' + CMD);
      process.exit(2);
    }
  } finally {
    page.close();
  }
})().catch((e) => {
  console.error('出错了：' + e.message);
  process.exit(1);
});
