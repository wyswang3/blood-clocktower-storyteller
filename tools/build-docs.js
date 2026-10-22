'use strict';

// 零依赖：Markdown 是维护源，生成可离线阅读的 HTML；不读取任何私密配置或存档。
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const sources = ['docs/01_平板主人安装与测试.md', 'docs/02_玩家使用说明.md', 'docs/03_技术手册与进度.md', 'DeepSeek配置.md', 'docs/04_暗流涌动规则核对.md', '官方规则核对验证_20261022.md', '易用性更新验证_20261022.md'];
const generated = new Set(sources.map((p) => path.resolve(root, p)));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const style = `:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f3f5f9;color:#202b3b;font:16px/1.85 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}main{max-width:1000px;margin:30px auto;padding:36px 46px;background:white;border:1px solid #dfe5ee;border-radius:16px}nav{font-size:14px;color:#627086;border-bottom:1px solid #e4e8ef;padding-bottom:14px;margin-bottom:24px}nav a{margin-right:16px}a{color:#245fa9;text-decoration:underline;text-underline-offset:3px}h1{font-size:30px;line-height:1.4;color:#142f53;margin:0 0 18px}h2{font-size:22px;line-height:1.5;margin:34px 0 12px;border-bottom:1px solid #e2e8f0;padding-bottom:8px}h3{font-size:18px;margin-top:24px}p{margin:12px 0}li{margin:6px 0}code{font:14px/1.65 ui-monospace,Consolas,monospace;background:#edf1f7;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}pre{background:#182a40;color:#f1f5fc;padding:17px 20px;border-radius:10px;overflow:auto;white-space:pre;line-height:1.65}pre code{background:none;color:inherit;padding:0;overflow-wrap:normal}blockquote{margin:18px 0;padding:10px 18px;border-left:4px solid #819ab9;background:#f0f5fb;color:#405670}.table-wrap{overflow:auto;margin:18px 0}table{width:100%;border-collapse:collapse;font-size:14px;line-height:1.7}th,td{border:1px solid #dce3ec;text-align:left;vertical-align:top;padding:10px 13px}th{background:#edf2f8;white-space:nowrap}tr:nth-child(even){background:#fafbfd}.cards{display:grid;gap:16px;margin:25px 0}.card{display:block;border:1px solid #d7e1ed;border-radius:12px;padding:20px 24px;text-decoration:none;background:#fafcfe}.card strong{display:block;font-size:20px;margin-bottom:4px}.card span{color:#52647b}.meta{color:#617089;font-size:14px}footer{margin-top:35px;padding-top:15px;border-top:1px solid #dfe5ee;font-size:13px;color:#6d7b8d}@media(max-width:650px){body{background:white}main{margin:0;padding:22px 18px;border:0;border-radius:0}h1{font-size:26px}nav a{display:inline-block;margin-bottom:6px}th,td{min-width:100px}pre{padding:12px;font-size:13px}}@media print{@page{size:A4;margin:16mm}body{background:white;font-size:11pt}main{max-width:none;margin:0;padding:0;border:0}nav{display:none}h2,h3{break-after:avoid}table,pre{break-inside:avoid}a{color:inherit}.table-wrap{overflow:visible}pre{white-space:pre-wrap}footer{font-size:9pt}}`;

function inline(text, source) {
  const codes = [];
  text = text.replace(/`([^`]+)`/g, (_m, code) => { const id = codes.push('<code>' + esc(code) + '</code>') - 1; return '\u0000' + id + '\u0000'; });
  text = esc(text).replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    href = href.replace(/&amp;/g, '&');
    if (!/^https?:\/\//.test(href)) {
      const resolved = path.resolve(path.dirname(path.join(root, source)), href);
      if (generated.has(resolved)) href = href.replace(/\.md$/, '.html');
    }
    return '<a href="' + esc(encodeURI(href)) + '">' + label + '</a>';
  }).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return text.replace(/\u0000(\d+)\u0000/g, (_m, id) => codes[Number(id)]);
}

function markdown(text, source) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
  const out = []; let paragraph = []; let list = null; let code = null;
  const flush = () => { if (paragraph.length) { out.push('<p>' + inline(paragraph.join(' '), source) + '</p>'); paragraph = []; } };
  const endList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]; const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flush(); endList();
      if (code !== null) { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; }
      else code = [];
      continue;
    }
    if (code !== null) { code.push(line.replace(/^ {3}/, '')); continue; }
    if (!trimmed) { flush(); endList(); continue; }
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { flush(); endList(); out.push(`<h${heading[1].length}>${inline(heading[2], source)}</h${heading[1].length}>`); continue; }
    if (trimmed.startsWith('|') && lines[i + 1]?.trim().match(/^\|?[\s:|-]+\|[\s:|-]*$/)) {
      flush(); endList();
      const header = cells(line); i++;
      const rows = [];
      while (lines[i + 1]?.trim().startsWith('|')) rows.push(cells(lines[++i]));
      out.push('<div class="table-wrap"><table><thead><tr>' + header.map((v) => '<th>' + inline(v, source) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((row) => '<tr>' + row.map((v) => '<td>' + inline(v, source) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (/^---+$/.test(trimmed)) { flush(); endList(); out.push('<hr>'); continue; }
    if (trimmed.startsWith('> ')) { flush(); endList(); out.push('<blockquote>' + inline(trimmed.slice(2), source) + '</blockquote>'); continue; }
    const item = trimmed.match(/^([-*]|\d+\.)\s+(.+)$/);
    if (item) {
      flush(); const kind = /\d/.test(item[1]) ? 'ol' : 'ul';
      if (list !== kind) { endList(); list = kind; out.push(kind === 'ol' ? '<ol start="' + parseInt(item[1], 10) + '">' : '<ul>'); }
      out.push('<li>' + inline(item[2], source) + '</li>'); continue;
    }
    endList(); paragraph.push(trimmed);
  }
  flush(); endList();
  if (code !== null) throw new Error('未闭合代码块：' + source);
  return out.join('\n');
}

function page(title, content, prefix) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title><style>' + style + '</style></head><body><main><nav><a href="' + prefix + '先读我.html">说明首页</a><span>血染钟楼 · v' + esc(version) + '</span></nav>' + content + '<footer>更新日期：2026-10-22 · 本页可离线阅读；以当前程序与验证记录为准。</footer></main></body></html>';
}

for (const source of sources) {
  const text = fs.readFileSync(path.join(root, source), 'utf8');
  const title = text.match(/^#\s+(.+)$/m)[1];
  fs.writeFileSync(path.join(root, source.replace(/\.md$/, '.html')), page(title, markdown(text, source), source.startsWith('docs/') ? '../' : ''), 'utf8');
}
const cards = [
  ['#owner', '平板主人', '从压缩包开始：安装、配置 AI、测试连接和正式开局。'],
  ['#players', '所有玩家', '加入房间、看身份、夜间行动、提名投票和掉线处理。'],
  ['#technical', 'Agent 与技术人员', '当前实现、验证证据、目标、待办和后续维护流程。'],
  ['#rules-audit', '规则核对', '22 角色、当前官方夜序、胜负、操作约定与测试依据。'],
];
const anchors = ['owner', 'players', 'technical', 'ai-config', 'rules-audit', 'regression', 'ease-regression'];
const sections = sources.map((source, i) => {
  let body = markdown(fs.readFileSync(path.join(root, source), 'utf8'), source);
  body = body.replace(/<(\/?)h([1-5])>/g, (_m, slash, level) => '<' + slash + 'h' + (Number(level) + 1) + '>');
  body = body.replace(/href="([^"]+)"/g, (match, href) => {
    if (/^https?:/.test(href)) return match;
    const target = path.resolve(path.dirname(path.join(root, source)), decodeURI(href).replace(/\.html$/, '.md'));
    const index = sources.findIndex((s) => path.resolve(root, s) === target);
    return index >= 0 ? 'href="#' + anchors[index] + '"' : 'href="' + esc(encodeURI(path.relative(root, target).replaceAll('\\', '/'))) + '"';
  });
  return '<section id="' + anchors[i] + '" style="border-top:3px solid #dfe7f1;margin-top:48px;padding-top:24px"><p><a href="#top">返回目录</a></p>' + body + '</section>';
}).join('\n');
const index = '<div id="top"></div><h1>血染钟楼 · 使用与维护说明</h1><p class="meta">版本 ' + esc(version) + ' · 2026-10-22 · 安卓平板 + 每人一部手机</p><p>本文件已包含四份完整手册、AI 配置与本轮验证记录，点目录即可跳转，可离线阅读。程序由平板上的 Termux 启动，游戏界面在浏览器打开。</p><div class="cards">' + cards.map(([href, title, text]) => '<a class="card" href="' + href + '"><strong>' + esc(title) + '</strong><span>' + esc(text) + '</span></a>').join('') + '</div><p><a href="#ai-config">DeepSeek 配置详解</a></p><p>首次安装环境、各用不同网络开局，以及 AI 调用需要互联网。首次可以直接开局；点“连接 DeepSeek”填密钥后，会自动验证、保存并启用，以后会记住开关。</p><p>当前已完成本地模拟与接口测试；真实 DeepSeek 账户、安卓设备和公网运营商链路仍需按指南验收。</p>' + sections;
fs.writeFileSync(path.join(root, '先读我.html'), page('血染钟楼 · 说明入口', index, '').replace('href="先读我.html"', 'href="#top"'), 'utf8');
console.log('已生成 4 份手册、AI 配置、规则验收阅读版和说明首页。');
