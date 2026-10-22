'use strict';

const { storytellerView } = require('../engine/state');
const { informationOptions } = require('../engine/night');

/** 进程内适配器：不需要第二台设备、账号或额外 WebSocket 客户端。 */
function createAIStoryteller({ game, client, configured = false, configError = null }) {
  let enabled = false;
  let state = configError ? 'config-error' : configured ? 'ready' : 'unconfigured';
  let active = null;
  let disposed = false;

  const status = () => ({ configured, enabled, state });
  const cancelActive = () => { if (active) active.abort.abort(); active = null; };
  const live = (task) => !disposed && enabled && active === task && game.stRequest === task.request && game.infoMode === 'storyteller';
  const record = (task, outcome, extra = {}) => {
    game.aiDecisions.push({ requestId: task.request.id, round: game.round, seat: task.request.seat, step: task.request.step, outcome, ...extra });
    if (game.aiDecisions.length > 100) game.aiDecisions.shift();
  };

  function pump() {
    if (active && game.stRequest !== active.request) {
      cancelActive();
      if (state === 'working') {
        state = game.phase === 'night' && game.night?.pending && !game.night.pending.awaiting ? 'fallback' : 'ready';
        game.emit();
      }
    }
    if (disposed || !enabled || game.infoMode !== 'storyteller' || !game.stRequest || active) return;
    const task = { request: game.stRequest, abort: new AbortController() };
    active = task;
    state = 'working';
    // 同一个 emit 会发出多份视图；active 在广播前设置，确保只调用一次。
    game.emit();
    Promise.resolve().then(async () => {
      if (!live(task)) return;
      const options = informationOptions(game, task.request);
      // 没有可裁量空间时直接给固定结果，不为确定答案调用模型。
      const decision = options.length === 1
        ? { optionId: options[0].id, reason: '引擎仅提供一个合法结果' }
        : await client.choose({ view: storytellerView(game), request: task.request, options, history: game.aiDecisions.slice(-20), signal: task.abort.signal });
      if (!live(task)) return;
      const chosen = options.find((option) => option.id === decision.optionId);
      if (!chosen) throw new Error('AI_OPTION_INVALID');
      record(task, 'selected', { optionId: chosen.id, cards: chosen.cards, reason: decision.reason });
      state = 'ready';
      game.resolveInfoRequest(task.request.id, chosen.cards);
    }).catch((error) => {
      if (!live(task)) return;
      const code = /^AI_(HTTP_\d+|NETWORK_ERROR|TIMEOUT|RESPONSE_INVALID|OPTION_INVALID)$/.test(error.code || '') ? error.code : 'AI_RESPONSE_INVALID';
      record(task, 'fallback', { code });
      state = 'fallback';
      game.autoStorytellerInfo();
    }).finally(() => { if (active === task) active = null; });
  }

  const unsubscribe = game.subscribe(pump);
  function setEnabled(value) {
    if (disposed) return { ok: false, error: 'AI 接口已关闭' };
    if (value && !configured) return { ok: false, error: '请先在平板服务端配置有效的 DeepSeek 密钥和接口地址' };
    if (enabled === !!value) return { ok: true };
    enabled = !!value;
    state = enabled ? 'ready' : 'paused';
    if (enabled) {
      game.storytellerConnected();
      game.setInfoMode('storyteller');
      pump();
    } else {
      cancelActive();
      game.storytellerDisconnected();
      if (game.stRequest) game.autoStorytellerInfo();
      game.setInfoMode('auto');
    }
    return { ok: true };
  }
  return {
    status, setEnabled,
    dispose() {
      if (disposed) return;
      if (enabled) setEnabled(false);
      disposed = true;
      cancelActive();
      unsubscribe();
    },
  };
}

module.exports = { createAIStoryteller };
