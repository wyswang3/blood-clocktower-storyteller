'use strict';

/**
 * 可选的公网隧道：调用本机的 cloudflared，把 127.0.0.1:PORT 映射成一个
 * https://xxx.trycloudflare.com 地址，平板和手机就可以不在同一个网络。
 *
 * 不下载、不捆绑：没装 cloudflared 就报一条人话，让用户去装。
 * 用 --logfile 写日志再从文件里读地址，避免依赖子进程管道。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

function parseTunnelUrl(text) {
  const m = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return m ? m[0] : null;
}

function findCloudflared() {
  const fromEnv = process.env.CLOUDFLARED_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const local = path.join(__dirname, '..', 'bin', exe);
  if (fs.existsSync(local)) return local;
  return 'cloudflared';
}

/**
 * 启动隧道并等到公网地址出现。
 * @returns {Promise<{url:string, child:import('node:child_process').ChildProcess, logFile:string}>}
 */
function startTunnel(port, opts = {}) {
  return new Promise((resolve, reject) => {
    const bin = findCloudflared();
    const logFile = opts.logFile || path.join(os.tmpdir(), `btc-tunnel-${process.pid}.log`);
    try {
      fs.writeFileSync(logFile, '');
    } catch {
      /* 日志写不了也不影响隧道本身 */
    }

    let child;
    try {
      child = spawn(
        bin,
        ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate', '--logfile', logFile],
        { stdio: 'ignore', windowsHide: true }
      );
    } catch (e) {
      reject(new Error('启动 cloudflared 失败：' + e.message));
      return;
    }

    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (err) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(err);
      } else {
        resolve(value);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`20 秒内没拿到公网地址，看日志 ${logFile}`));
    }, 20000);

    child.on('error', (e) => {
      const hint =
        e && e.code === 'ENOENT'
          ? missingCloudflaredHint()
          : e.message;
      finish(new Error(hint));
    });
    child.on('exit', (code) => {
      finish(new Error(`cloudflared 退出了（code ${code}），看日志 ${logFile}`));
    });

    const poll = setInterval(() => {
      let text = '';
      try {
        text = fs.readFileSync(logFile, 'utf8');
      } catch {
        return;
      }
      const url = parseTunnelUrl(text);
      if (url) finish(null, { url, child, logFile });
    }, 500);

    if (poll.unref) poll.unref();
  });
}

function missingCloudflaredHint(platform = process.platform) {
  const install = platform === 'win32'
    ? 'winget install --id Cloudflare.cloudflared'
    : platform === 'android' || process.env.TERMUX_VERSION
    ? 'pkg install cloudflared'
    : '按 Cloudflare 官方说明安装 cloudflared';
  return `没找到 cloudflared。请先执行：${install}，再用 --tunnel 启动。`;
}

module.exports = { parseTunnelUrl, findCloudflared, startTunnel, missingCloudflaredHint };
