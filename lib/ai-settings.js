'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { loadAIConfig } = require('./deepseek');

function validateKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return /^[A-Za-z0-9_-]{8,512}$/.test(key) ? key : null;
}

/** 网页只提交密钥；地址和模型由服务端预置，不接受网页传入。 */
function configFromKey(apiKey, env = process.env) {
  return { ...loadAIConfig({ env: {
    DEEPSEEK_API_KEY: apiKey,
    DEEPSEEK_BASE_URL: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    DEEPSEEK_MODEL: env.DEEPSEEK_MODEL || 'deepseek-flash',
    AI_TIMEOUT_MS: env.AI_TIMEOUT_MS || '12000', AI_ENABLED: '1',
  } }), managedByUI: true };
}

function writeAISettings(filePath, config, { fsImpl = fs } = {}) {
  let previous = {};
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) previous = parsed;
  } catch (e) { if (e.code && e.code !== 'ENOENT') throw new Error('AI_SAVE_FAILED'); }
  const temporary = filePath + '.tmp-' + crypto.randomBytes(8).toString('hex');
  try {
    fsImpl.writeFileSync(temporary, JSON.stringify({ ...previous,
      apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model,
      timeoutMs: config.timeoutMs, enabled: !!config.enabled, managedByUI: true,
    }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fsImpl.renameSync(temporary, filePath);
  } catch {
    try { fsImpl.unlinkSync(temporary); } catch { /* 不输出含密钥的写入参数。 */ }
    throw new Error('AI_SAVE_FAILED');
  }
}

function connectionError(error) {
  const code = error && error.code;
  if (code === 'AI_HTTP_401') return '密钥没有通过验证，请重新复制完整的 API Key。';
  if (code === 'AI_HTTP_402') return 'DeepSeek 账户余额不足，请充值后再试。';
  if (code === 'AI_HTTP_429') return 'DeepSeek 暂时繁忙，请稍后再试。';
  if (code === 'AI_TIMEOUT') return '连接超时，请检查平板网络后再试。';
  return '暂时连不上 DeepSeek，请检查平板网络和密钥，稍后重试。';
}

module.exports = { validateKey, configFromKey, writeAISettings, connectionError };
