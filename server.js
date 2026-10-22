'use strict';

/**
 * 血染钟楼 · 无人说书人
 * 入口：HTTP 静态托管 + REST 状态接口 + WebSocket 推送
 *
 * 单进程、单房间、零依赖。`node server.js` 即可。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { Game } = require('./engine/game');
const { publicView, seatView, storytellerView } = require('./engine/state');
const { ROLES, TYPE_LABEL } = require('./engine/roles');
const { attachWebSocket } = require('./lib/ws');
const tunnel = require('./lib/tunnel');
const { loadAIConfig, createDeepSeekClient } = require('./lib/deepseek');
const { createAIStoryteller } = require('./lib/ai-storyteller');

const PORT = Number(process.env.PORT) || 3000;
const WANT_TUNNEL = process.env.TUNNEL === '1' || process.argv.includes('--tunnel');
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const STATE_FILE = process.env.ROOM_FILE || path.join(ROOT, 'room.json');
let joinUrl = null;
let localJoinUrl = null;
let ai = null;
let aiTestRunning = false;

/* ------------------------------ 房间与持久化 ------------------------------ */

let game;
let pin;
let saveTimer = null;

function newPin() {
  return String(1000 + Math.floor(Math.random() * 9000));
}

/** 板子上可选的身份清单（静态数据，不含任何对局信息） */
const ROLE_CHOICES = Object.values(ROLES).map((r) => ({
  id: r.id,
  name: r.name,
  type: r.type,
  typeLabel: TYPE_LABEL[r.type],
  brief: r.brief,
}));

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && data.game) {
      game = Game.fromJSON(data.game);
      pin = data.pin || newPin();
      console.log('[room] 已从 room.json 恢复上一局（阶段：' + game.phase + '）');
      return;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[room] room.json 读取失败：' + e.message);
  }
  game = new Game({ playerCount: 7 });
  pin = process.env.HOST_PIN || newPin();
}

function saveNow() {
  try {
    const tmp = STATE_FILE + '.tmp';
    const payload = JSON.stringify({ pin, savedAt: Date.now(), game: game.toJSON() });
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[room] 保存失败：' + e.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 400);
}

/* -------------------------------- 客户端 -------------------------------- */

/** @type {Set<{conn:any, channel:string|null, role:string, seat:number|null}>} */
const clients = new Set();

function sendTo(conn, obj) {
  // 房间链接是连接信息，不进入游戏存档；平板从本机打开时也能分享正确的手机地址。
  if ((obj.t === 'sync' || obj.t === 'event') && obj.view) {
    obj = { ...obj, view: withJoinUrl(obj.view) };
  }
  conn.send(obj);
}

function withJoinUrl(view) {
  const aiStatus = ai ? ai.status() : { configured: false, enabled: false, state: 'unconfigured' };
  if (view.pub) return { ...view, pub: { ...view.pub, joinUrl, ai: aiStatus } };
  return { ...view, joinUrl, ai: aiStatus };
}

function channelView(channel) {
  if (channel === 'public') return publicView(game);
  if (channel && channel.startsWith('seat:')) {
    const seat = Number(channel.slice(5));
    return seatView(game, seat);
  }
  return null;
}

function syncClient(c, since) {
  const view = channelView(c.channel);
  if (since && Number.isFinite(since)) {
    const missed = game.eventsSince(c.channel, since).slice(-300);
    for (const evt of missed) sendTo(c.conn, { t: 'event', ...evt });
  }
  sendTo(c.conn, { t: 'sync', view, since: game.seq });
}

function broadcast(evt) {
  for (const c of clients) {
    if (c.channel && evt.ch.includes(c.channel)) {
      sendTo(c.conn, { t: 'event', ...evt });
    }
  }
}

function storytellerClients() {
  const out = [];
  for (const c of clients) if (c.role === 'storyteller') out.push(c);
  return out;
}

/** 说书人（AI）看到的是整本魔典 + 待裁量请求，只发给带 PIN 的连接 */
function broadcastStoryteller() {
  const sts = storytellerClients();
  if (!sts.length) return;
  const view = storytellerView(game);
  for (const c of sts) sendTo(c.conn, { t: 'st', view });
}

// 每帧视图都带 seq，断线重连带游标只补缺失段
loadState();
game.subscribe((evt) => {
  broadcast(evt);
  broadcastStoryteller();
  scheduleSave();
});

const aiConfig = loadAIConfig({ filePath: path.join(ROOT, 'ai.local.json'), env: process.env });
const aiClient = createDeepSeekClient(aiConfig);
ai = createAIStoryteller({ game, client: aiClient, configured: aiConfig.configured, configError: aiConfig.error });
if (aiConfig.enabled) {
  const result = ai.setEnabled(true);
  if (!result.ok) console.warn('[AI] 尚未配置有效的接口，继续使用自动情报。');
}

/* -------------------------------- HTTP -------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(res, filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

function readBody(req, cb) {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 8192) {
      req.destroy();
    }
  });
  req.on('end', () => {
    try {
      cb(raw ? JSON.parse(raw) : {});
    } catch {
      cb(null);
    }
  });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  // pathname 保留百分号编码，中文文件名要先解回来再去找文件
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }

  if (p === '/health') return sendJson(res, 200, { ok: true, phase: game.phase, round: game.round });

  // 文档里的两个状态接口（REST）。座位接口必须带 token，否则谁都能拉到别人的身份。
  if (p === '/state/public') return sendJson(res, 200, withJoinUrl(publicView(game)));
  const m = p.match(/^\/state\/seat\/(\d+)$/);
  if (m) {
    const seat = Number(m[1]);
    const token = url.searchParams.get('token') || '';
    const player = game.players[seat - 1];
    if (!player || !player.token || player.token !== token) {
      return sendJson(res, 403, { error: '座位号或 token 不对' });
    }
    return sendJson(res, 200, withJoinUrl(seatView(game, seat)));
  }

  if (p === '/' || p === '/host') return serveStatic(res, path.join(PUBLIC_DIR, 'host.html'));
  if (p === '/player') return serveStatic(res, path.join(PUBLIC_DIR, 'player.html'));
  if (p === '/j') return serveStatic(res, path.join(PUBLIC_DIR, 'player.html'));
  if (p === '/connect') return serveStatic(res, path.join(PUBLIC_DIR, 'connect.html'));
  if (p === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (p.startsWith('/') && /\.(js|css|svg|png|jpe?g|webp|txt|json|webmanifest)$/.test(p)) {
    return serveStatic(res, path.join(PUBLIC_DIR, p.slice(1)));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

/* -------------------------------- WebSocket -------------------------------- */

function handleMessage(c, msg) {
  if (!msg || typeof msg !== 'object') return;
  c.conn.isAlive = true;

  switch (msg.t) {
    case 'hello':
      return handleHello(c, msg);

    case 'claim': {
      if (c.role !== 'guest') return sendTo(c.conn, { t: 'error', message: '已经加入过了' });
      const res = game.claim(Number(msg.seat), msg.token, msg.name);
      if (!res.ok) return sendTo(c.conn, { t: 'error', message: res.error });
      c.channel = 'seat:' + msg.seat;
      c.role = 'player';
      c.helloComplete = true;
      c.seat = Number(msg.seat);
      game.setConnected(c.seat, true);
      // 新入座也要下发角色表：前端只在 welcome 里收这份数据
      sendTo(c.conn, { t: 'welcome', role: 'player', seat: c.seat, now: Date.now(), roles: ROLE_CHOICES });
      sendTo(c.conn, { t: 'token', seat: c.seat, token: res.token });
      return syncClient(c, null);
    }

    case 'confirm': {
      if (c.role !== 'player') return;
      const r = game.confirm(c.seat);
      if (!r.ok) sendTo(c.conn, { t: 'error', message: r.error });
      return;
    }

    case 'night': {
      if (c.role !== 'player') return;
      const r = game.submitNight(c.seat, { targets: msg.targets });
      if (!r.ok) sendTo(c.conn, { t: 'error', message: r.error });
      return;
    }

    case 'nominate': {
      if (c.role !== 'player') return;
      const r = game.nominate(c.seat, Number(msg.target));
      if (!r.ok) sendTo(c.conn, { t: 'error', message: r.error });
      return;
    }

    case 'suspect': {
      if (c.role !== 'player') return;
      const r = game.toggleSuspicion(c.seat, Number(msg.target));
      if (!r.ok) sendTo(c.conn, { t: 'error', message: r.error });
      return;
    }

    case 'board': {
      if (c.role !== 'player') return;
      const r = game.setBoardGuess(c.seat, Number(msg.target), msg.role || null);
      if (!r.ok) sendTo(c.conn, { t: 'error', message: r.error });
      return;
    }

    case 'vote': {
      if (c.role !== 'player') return;
      const r = game.castVote(c.seat, !!msg.yes);
      if (!r.ok) sendTo(c.conn, { t: 'error', message: r.error });
      return;
    }

    case 'slayer': {
      if (c.role !== 'player') return;
      const r = game.slayerShoot(c.seat, Number(msg.target));
      if (!r.ok) sendTo(c.conn, { t: 'error', message: r.error });
      return;
    }

    case 'rename': {
      if (c.role !== 'player') return;
      const r = game.rename(c.seat, msg.name);
      if (!r.ok) sendTo(c.conn, { t: 'error', message: r.error });
      return;
    }

    case 'st-info': {
      // AI 说书人交卷：{ t:'st-info', id, cards:[{title,lines|kind,rows}, ...] }
      if (c.role !== 'storyteller') return sendTo(c.conn, { t: 'error', message: '不是说书人' });
      const r = game.resolveInfoRequest(msg.id, msg.cards);
      if (!r.ok) sendTo(c.conn, { t: 'error', message: r.error });
      return;
    }

    case 'host': {
      if (c.role !== 'host') return sendTo(c.conn, { t: 'error', message: '不是房主' });
      return handleHost(c, msg);
    }

    case 'ping':
      return sendTo(c.conn, { t: 'pong', now: Date.now() });

    default:
      return sendTo(c.conn, { t: 'error', message: '未知消息类型：' + msg.t });
  }
}

function handleHello(c, msg) {
  const since = Number(msg.since);
  if (msg.role === 'host') {
    if (String(msg.pin) !== pin) {
      sendTo(c.conn, { t: 'error', message: '房主 PIN 不对' });
      return c.conn.close(4003, 'bad pin');
    }
    c.role = 'host';
    c.helloComplete = true;
    c.channel = 'public';
    sendTo(c.conn, { t: 'welcome', role: 'host', now: Date.now() });
    return syncClient(c, since);
  }

  if (msg.role === 'storyteller') {
    if (String(msg.pin) !== pin) {
      sendTo(c.conn, { t: 'error', message: '说书人 PIN 不对' });
      return c.conn.close(4003, 'bad pin');
    }
    c.role = 'storyteller';
    c.helloComplete = true;
    c.channel = null;
    sendTo(c.conn, { t: 'welcome', role: 'storyteller', now: Date.now() });
    game.storytellerConnected();
    sendTo(c.conn, { t: 'st', view: storytellerView(game) });
    return;
  }

  if (msg.role === 'player') {
    const seat = Number(msg.seat);
    const p = game.players[seat - 1];
    if (!p || !p.token || p.token !== msg.token) {
      sendTo(c.conn, { t: 'need-claim', message: '这个座位还没加入，或者 token 过期了' });
      return;
    }
    p.joined = true;
    c.role = 'player';
    c.helloComplete = true;
    c.seat = seat;
    c.channel = 'seat:' + seat;
    game.setConnected(seat, true);
    sendTo(c.conn, { t: 'welcome', role: 'player', seat, now: Date.now(), roles: ROLE_CHOICES });
    return syncClient(c, since);
  }

  c.role = 'guest';
  c.helloComplete = true;
  c.channel = 'public';
  sendTo(c.conn, { t: 'welcome', role: 'guest', now: Date.now() });
  return syncClient(c, since);
}

function handleHost(c, msg) {
  let r = { ok: true };
  switch (msg.action) {
    case 'start':
      r = game.start({ force: !!msg.force });
      break;
    case 'setBoard':
      // 说书人 / AI 配板子：roles 按座位顺序，长度必须等于人数
      r = game.setBoard(msg.roles);
      if (r.ok) sendTo(c.conn, { t: 'board', roles: r.board.roles });
      break;
    case 'getBoard':
      sendTo(c.conn, {
        t: 'board',
        roles: game.customBoard ? game.customBoard.roles.slice() : null,
      });
      break;
    case 'clearBoard':
      r = game.clearBoard();
      if (r.ok) sendTo(c.conn, { t: 'board', roles: null });
      break;
    case 'setInfoMode':
      r = game.setInfoMode(msg.mode);
      break;
    case 'setAI':
      if (typeof msg.enabled !== 'boolean') r = { ok: false, error: 'AI 开关必须是 true 或 false' };
      else r = ai.setEnabled(msg.enabled);
      break;
    case 'testAI':
      return testAIConnection(c);
    case 'beginNight':
      r = game.beginNight(Number(msg.round) || game.round + 1);
      break;
    case 'skip':
      r = game.skipNight();
      break;
    case 'beginNominations':
      r = game.beginNominations();
      break;
    case 'closeVote':
      r = game.closeVote();
      break;
    case 'endNominations':
      r = game.endNominations();
      break;
    case 'endDay':
      game.endDay();
      break;
    case 'finishEarly':
      r = game.finishEarly(msg.winner);
      break;
    case 'reset':
      game.reset(Number(msg.count) || game.players.length, true);
      game.emit();
      break;
    case 'setCount':
      r = game.setPlayerCount(Number(msg.count));
      break;
    case 'release':
      r = game.releaseSeat(Number(msg.seat));
      break;
    case 'rename':
      r = game.rename(Number(msg.seat), msg.name);
      break;
    case 'allowBaron':
      game.config.allowBaron = !!msg.value;
      game.emit();
      break;
    case 'setTimers':
      r = game.setTimers({ discussMs: msg.discussMs, voteMs: msg.voteMs });
      break;
    default:
      r = { ok: false, error: '未知房主操作：' + msg.action };
  }
  if (!r || !r.ok) sendTo(c.conn, { t: 'error', message: (r && r.error) || '操作失败' });
  return r;
}

async function testAIConnection(c) {
  if (!aiConfig.configured) return sendTo(c.conn, { t: 'ai-test', message: '请先在平板配置有效的 DeepSeek 密钥。' });
  if (aiTestRunning) return sendTo(c.conn, { t: 'ai-test', message: '已经在测试连接，请稍等。' });
  aiTestRunning = true;
  sendTo(c.conn, { t: 'ai-test', message: '正在测试 DeepSeek，将发起一次 API 请求…' });
  try {
    await aiClient.choose({ view: {}, request: { purpose: 'connection-test' }, options: [{ id: 'test-ok', cards: [{ title: '连接测试', lines: ['接口连通'] }] }] });
    sendTo(c.conn, { t: 'ai-test', message: 'DeepSeek 连接测试成功，可以启用 AI。' });
  } catch (e) {
    const message = e.code === 'AI_HTTP_401' ? '认证失败，请检查密钥。' : e.code === 'AI_HTTP_402' ? '账户余额不足。' : e.code === 'AI_HTTP_429' ? '接口限流，请稍后再试。' : '测试失败，请检查网络、接口地址和模型配置。';
    sendTo(c.conn, { t: 'ai-test', message });
  } finally { aiTestRunning = false; }
}

attachWebSocket(server, (conn) => {
  const c = { conn, channel: null, role: 'guest', seat: null, helloComplete: false };
  clients.add(c);
  conn.on('close', () => {
    clients.delete(c);
    if (c.role === 'player' && c.seat) game.setConnected(c.seat, false);
    if (c.role === 'storyteller') game.storytellerDisconnected();
  });
  conn.on('message', (msg) => {
    try {
      handleMessage(c, msg);
    } catch (e) {
      console.error('[ws] 处理消息出错', e);
      sendTo(conn, { t: 'error', message: '服务端错误' });
    }
  });
  // 10 秒内不 hello 就当无效连接
  setTimeout(() => {
    if (!c.helloComplete) {
      sendTo(conn, { t: 'error', message: '连接超时' });
      conn.close(4008, 'no hello');
    }
  }, 10000);
});

/* -------------------------------- 定时任务 -------------------------------- */

setInterval(() => {
  if (game.checkTimers(Date.now())) scheduleSave();
}, 1000);

setInterval(() => {
  for (const c of clients) {
    if (!c.conn.isAlive) {
      c.conn.close(4001, 'timeout');
      clients.delete(c);
      continue;
    }
    c.conn.ping();
  }
}, 30000);

/* -------------------------------- 启动 -------------------------------- */

function lanAddresses() {
  const out = [];
  let interfaces;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    // 部分安卓设备禁止枚举网卡，不能因此阻止游戏服务启动。
    console.warn('[network] 无法自动读取局域网 IP，请在设备的 Wi-Fi 设置中查看。');
    return out;
  }
  for (const [name, list] of Object.entries(interfaces)) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, score: addrScore(name, a.address) });
    }
  }
  out.sort((x, y) => y.score - x.score);
  return out;
}

/** 虚拟网卡、VPN 的地址对手机没用，排后面；私有网段、无线网卡排前面。 */
function addrScore(name, address) {
  let s = 0;
  if (/^192\.168\./.test(address)) s += 12;
  else if (/^10\./.test(address)) s += 10;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) s += 8;
  else s -= 5;
  if (/wi-?fi|wlan|无线|以太网|ethernet/i.test(name)) s += 4;
  if (/vEthernet|vmware|virtualbox|hyper-v|tailscale|zerotier|radmin|hamachi|npcap|wsl|loopback|bluetooth|vpn|tap/i.test(name)) {
    s -= 20;
  }
  if (/^169\.254\./.test(address)) s -= 50;
  return s;
}

function printBanner() {
  const nets = lanAddresses();
  const host = nets.length ? nets[0].address : '<设备的局域网IP>';
  const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  localJoinUrl = nets.length ? `http://${host}:${PORT}/player` : null;
  joinUrl = publicUrl ? `${publicUrl}/player` : localJoinUrl;
  const label = publicUrl ? '公网地址' : '局域网地址';
  const lines = [
    '',
    '  血染钟楼 · 无人说书人',
    '  ────────────────────────────────────────────',
    `  本机（平板）    http://127.0.0.1:${PORT}/host?pin=${pin}`,
    `  ${label}（平板）  ${publicUrl || `http://${host}:${PORT}`}/host?pin=${pin}`,
    `  ${label}（手机）  ${publicUrl || `http://${host}:${PORT}`}/player`,
    `  连接检查页      ${publicUrl || `http://${host}:${PORT}`}/connect`,
    `  房主 PIN        ${pin}`,
    '',
  ];
  if (publicUrl) {
    lines.push('  用公网地址时：平板和手机可以不在同一个网络，但需要服务器能上公网。');
    lines.push('  这个地址谁拿到谁都能打开页面，别发到群里；房主操作还有 PIN 挡着。');
    lines.push('');
  }
  if (nets.length > 1 && !publicUrl) {
    lines.push('  其他网卡（如果上面那个连不上，换一个试）：');
    for (const n of nets.slice(1)) lines.push(`    ${n.address}  (${n.name})`);
    lines.push('');
  }
  lines.push(`  状态已持久化到 ${STATE_FILE}`);
  lines.push('  按 Ctrl+C 停止；手机连不上先开 /connect 或看 dev.md。');
  lines.push('');
  console.log(lines.join('\n'));
}

let tunnelChild = null;

server.listen(PORT, '0.0.0.0', () => {
  printBanner();
  if (WANT_TUNNEL && !process.env.PUBLIC_URL) {
    console.log('  正在启动 cloudflared 公网隧道…');
    tunnel
      .startTunnel(PORT)
      .then(({ url, child }) => {
        tunnelChild = child;
        joinUrl = `${url}/player`;
        game.emit('公网房间地址已就绪，可复制手机加入链接。');
        child.once('exit', () => {
          joinUrl = localJoinUrl;
          game.emit('公网连接已中断，请检查平板网络并重新启动隧道。');
        });
        console.log(
          [
            '',
            '  ── 公网隧道已就绪 ──────────────────────────',
            `  平板  ${url}/host?pin=${pin}`,
            `  手机  ${url}/player`,
            `  检查  ${url}/connect`,
            '',
            '  平板和手机可以不在同一个网络；这个地址谁拿到都能打开，别外传。',
            '  关掉服务（Ctrl+C）隧道会一起停，下次启动地址会变。',
            '',
          ].join('\n')
        );
      })
      .catch((e) => {
        console.error('\n  公网隧道没起来：' + e.message);
        console.error('  也可以直接用 PUBLIC_URL 环境变量，或部署到有公网的机器，见 远程连接.md\n');
      });
  }
});

process.on('SIGINT', () => {
  ai.dispose();
  saveNow();
  if (tunnelChild) {
    try {
      tunnelChild.kill();
    } catch {
      /* ignore */
    }
  }
  console.log('\n已保存，再见。');
  process.exit(0);
});
process.on('SIGTERM', () => {
  ai.dispose();
  saveNow();
  if (tunnelChild) {
    try {
      tunnelChild.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
});
