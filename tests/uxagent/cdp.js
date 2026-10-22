'use strict';

/**
 * 极简 CDP 客户端：用 Node 自带的 WebSocket 连无头 Chrome。
 * 只给 ux.js 用，不追求通用。
 */

async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && !/^devtools:/.test(t.url));
  if (!page) throw new Error(`端口 ${port} 上没有可用的页面目标`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 8000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(new Error('CDP 连接失败'));
    });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  async function evalJs(expression) {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面脚本报错：' + (r.exceptionDetails.text || '') + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    }
    return r.result ? r.result.value : undefined;
  }

  async function setMetrics(width, height, dsf, mobile) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: dsf,
      mobile: !!mobile,
    });
  }

  async function screenshot(file) {
    const size = await evalJs('({ w: innerWidth, h: innerHeight })');
    const { data } = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 },
    });
    const fs = require('node:fs');
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  async function goto(url) {
    await send('Page.enable');
    await send('Page.navigate', { url });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const ready = await evalJs('document.readyState');
        if (ready === 'complete') return;
      } catch {
        /* 导航中上下文会销毁，重试 */
      }
    }
  }

  return { send, evalJs, setMetrics, screenshot, goto, close: () => ws.close() };
}

module.exports = { connect };
