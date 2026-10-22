'use strict';

// 隧道恢复不重开游戏；切网和重试时清除旧链接，迟到的子进程立即回收。
function createTunnelManager({ startTunnel, port, onChange, retryMs = 10000, timers = globalThis }) {
  let generation = 0, enabled = false, child = null, timer = null, controller = null;
  let state = { state: 'off', url: null };
  function publish(next) { state = next; onChange({ ...state }); }
  function cancel() {
    generation++;
    if (controller) controller.abort();
    controller = null;
    if (timer) timers.clearTimeout(timer);
    timer = null;
    const old = child; child = null;
    if (old) { try { old.kill(); } catch {} }
  }
  function schedule() {
    if (!enabled) return;
    timer = timers.setTimeout(() => { timer = null; attempt(); }, retryMs);
    if (timer && timer.unref) timer.unref();
  }
  async function attempt() {
    cancel();
    const mine = generation;
    controller = new AbortController();
    publish({ state: 'connecting', url: null });
    try {
      const result = await startTunnel(port, { signal: controller.signal });
      if (!enabled || mine !== generation) { result.child.kill(); return; }
      child = result.child;
      // 不展示 cloudflared 的原始错误、路径或凭据。
      child.once('exit', () => {
        if (mine !== generation || !enabled) return;
        child = null;
        publish({ state: 'retrying', url: null });
        schedule();
      });
      publish({ state: 'online', url: result.url });
    } catch {
      if (!enabled || mine !== generation) return;
      publish({ state: 'retrying', url: null });
      schedule();
    }
  }
  return {
    start() { if (enabled) return; enabled = true; attempt(); },
    retry() { enabled = true; attempt(); },
    stop() { enabled = false; cancel(); publish({ state: 'off', url: null }); },
    status() { return { ...state }; },
  };
}

module.exports = { createTunnelManager };
