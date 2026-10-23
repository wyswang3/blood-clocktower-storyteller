'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const files = ['先读我.html', 'DeepSeek配置.html', '官方规则核对验证_20261022.html', '易用性更新验证_20261022.html', '安卓安装包验证_20261023.html',
  ...fs.readdirSync(path.join(ROOT, 'docs')).filter((name) => name.endsWith('.html')).map((name) => 'docs/' + name)];
let links = 0;
for (const file of files) {
  const full = path.join(ROOT, file), html = fs.readFileSync(full, 'utf8');
  if (html.includes('\uFFFD') || !html.includes(version)) throw new Error('编码或版本异常：' + file);
  const stack = [], voids = new Set(['meta','link','hr','br','input','img']);
  for (const token of html.matchAll(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi)) {
    const tag = token[1].toLowerCase();
    if (voids.has(tag)) continue;
    if (token[0].startsWith('</')) { if (stack.pop() !== tag) throw new Error('HTML 不平衡：' + file); }
    else stack.push(tag);
  }
  if (stack.length) throw new Error('HTML 未闭合：' + file);
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = match[1].replaceAll('&amp;', '&');
    if (/^https?:/.test(href)) continue;
    const [relative, anchor] = decodeURI(href).split('#');
    const target = relative ? path.resolve(path.dirname(full), relative) : full;
    if (!fs.existsSync(target)) throw new Error('本地链接不存在：' + file + ' -> ' + relative);
    if (anchor && !fs.readFileSync(target, 'utf8').includes('id="' + anchor + '"')) throw new Error('本地锚点不存在：' + file);
    links++;
  }
}
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'ai.config.example.json')));
if (config.apiKey !== '' || config.enabled !== false) throw new Error('配置模板不能包含密钥或默认启用');
const result = { version, htmlFiles: files.length, localLinks: links, balancedHTML: true, exampleKeyEmpty: true };
fs.mkdirSync(path.join(ROOT, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'artifacts/apk-docs-verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
