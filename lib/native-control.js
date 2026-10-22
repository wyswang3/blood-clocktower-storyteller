'use strict';

const { timingSafeEqual } = require('node:crypto');

// 只供 APK 的本机 Java 层调用；令牌不进入网页、房间链接和游戏存档。
function nativeAuthorized(req, token) {
  if (!token || token.length < 32) return false;
  const peer = req.socket && req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) return false;
  if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '')) return false;
  const supplied = req.headers['x-btc-native'];
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function createNativeControl({ token, status, retry, setMode, networkChanged, stop }) {
  return function handle(req, res, pathname, sendJson) {
    if (!pathname.startsWith('/__native/')) return false;
    if (!nativeAuthorized(req, token)) {
      sendJson(res, 403, { error: 'forbidden' });
      return true;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'GET' && pathname === '/__native/status') {
      sendJson(res, 200, status());
    } else if (req.method === 'POST' && pathname === '/__native/retry') {
      retry(); sendJson(res, 200, { ok: true });
    } else if (req.method === 'POST' && /^\/__native\/network\/(?:none|(?:\d{1,3}\.){3}\d{1,3})$/.test(pathname)) {
      const ip = pathname.slice(pathname.lastIndexOf('/') + 1);
      if (ip !== 'none' && ip.split('.').some((part) => Number(part) > 255)) sendJson(res, 400, { error: 'invalid address' });
      else { networkChanged(ip === 'none' ? '' : ip); sendJson(res, 200, { ok: true }); }
    } else if (req.method === 'POST' && /^\/__native\/mode\/(internet|lan)$/.test(pathname)) {
      setMode(pathname.endsWith('/internet') ? 'internet' : 'lan');
      sendJson(res, 200, { ok: true });
    } else if (req.method === 'POST' && pathname === '/__native/stop') {
      // 先落盘，再回应；Java 收到成功回应后才结束独立服务进程。
      stop(); sendJson(res, 200, { ok: true });
    } else sendJson(res, 404, { error: 'not found' });
    return true;
  };
}

module.exports = { nativeAuthorized, createNativeControl };
