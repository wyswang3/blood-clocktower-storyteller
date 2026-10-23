'use strict';
// 从私密 Actions 附件按 ZIP 索引只取正式 APK 和签名工具，避免下载重复的测试 APK。
// 凭据与带时效签名的下载地址仅留在内存，不输出、不写文件。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const runId = process.argv[2];
if (!/^\d+$/.test(runId || '')) throw new Error('请提供安卓构建编号');
const BASE = 'https://api.github.com/repos/wyswang3/blood-clocktower-storyteller';
let stage = '读取凭据';
async function fetchWithRetry(url, options) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status < 500 || attempt === 2) return response;
      if (response.body) await response.body.cancel();
    } catch (error) { if (attempt === 2) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
}
async function main() {
  const credentials = spawnSync('git', ['credential','fill'], { input: 'protocol=https\nhost=github.com\nusername=wyswang3\n\n', encoding: 'utf8', windowsHide: true });
  if (credentials.status !== 0) throw new Error('credentials');
  const secret = Object.fromEntries(credentials.stdout.trim().split(/\r?\n/).map((line) => { const split = line.indexOf('='); return [line.slice(0,split),line.slice(split+1)]; }));
  credentials.stdout = '';
  if (!secret.password) throw new Error('credentials');
  const headers = { Authorization: 'Bearer ' + secret.password, Accept: 'application/vnd.github+json', 'User-Agent': 'blood-clocktower-maintenance' };
  async function api(route) { const r = await fetchWithRetry(BASE + route, { headers }); if (!r.ok) throw new Error('api'); return r.json(); }
  stage = '核实私密仓库';
  if (!(await api('')).private) throw new Error('not private');
  const run = await api('/actions/runs/' + runId);
  const artifacts = await api('/actions/runs/' + runId + '/artifacts');
  const asset = artifacts.artifacts.find((item) => item.name === 'android-build' && !item.expired);
  if (!asset) throw new Error('missing build');
  stage = '获取附件地址';
  const redirect = await fetchWithRetry(asset.archive_download_url, { headers, redirect: 'manual' });
  const location = redirect.headers.get('location');
  if (redirect.status !== 302 || !location || !location.startsWith('https://')) throw new Error('redirect');
  delete headers.Authorization; delete secret.password;
  async function range(start, end) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetchWithRetry(location, { headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(120000) });
      if (response.status !== 206) throw new Error('range not supported');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === end - start + 1) return bytes;
    }
    throw new Error('incomplete range');
  }
  stage = '读取附件索引';
  const head = await fetchWithRetry(location, { method: 'HEAD' });
  const total = Number(head.headers.get('content-length'));
  if (!head.ok || !Number.isSafeInteger(total) || total < 22) throw new Error('archive length');
  const tail = await range(Math.max(0, total - 65557), total - 1);
  let endOffset = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) if (tail.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
  if (endOffset < 0) throw new Error('zip index');
  let length = tail.readUInt32LE(endOffset + 12), offset = tail.readUInt32LE(endOffset + 16);
  if (length === 0xffffffff || offset === 0xffffffff) {
    if (endOffset < 20 || tail.readUInt32LE(endOffset - 20) !== 0x07064b50) throw new Error('zip64 locator');
    const recordOffset = Number(tail.readBigUInt64LE(endOffset - 12));
    const record = await range(recordOffset, recordOffset + 55);
    if (record.readUInt32LE(0) !== 0x06064b50) throw new Error('zip64 record');
    length = Number(record.readBigUInt64LE(40)); offset = Number(record.readBigUInt64LE(48));
  }
  if (length > 8 * 1024 * 1024 || !Number.isSafeInteger(offset)) throw new Error('zip index limit');
  const index = await range(offset, offset + length - 1), selected = [];
  for (let p = 0; p + 46 <= index.length;) {
    if (index.readUInt32LE(p) !== 0x02014b50) throw new Error('zip entry');
    const nameLength = index.readUInt16LE(p + 28), extraLength = index.readUInt16LE(p + 30), commentLength = index.readUInt16LE(p + 32);
    const name = index.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    const base = name.split('/').pop();
    if (['app-release-unsigned.apk','apksigner.jar','apk-metadata.txt'].includes(base)) {
      const entry = { name: base, method: index.readUInt16LE(p + 10), crc: index.readUInt32LE(p + 16), compressed: index.readUInt32LE(p + 20), size: index.readUInt32LE(p + 24), offset: index.readUInt32LE(p + 42) };
      if ([entry.size,entry.compressed,entry.offset].includes(0xffffffff)) {
        let extra = p + 46 + nameLength;
        while (extra + 4 <= p + 46 + nameLength + extraLength) {
          const tag = index.readUInt16LE(extra), size = index.readUInt16LE(extra + 2);
          if (tag === 1) { let q = extra + 4; for (const key of ['size','compressed','offset']) if (entry[key] === 0xffffffff) { entry[key] = Number(index.readBigUInt64LE(q)); q += 8; } break; }
          extra += 4 + size;
        }
      }
      selected.push(entry);
    }
    p += 46 + nameLength + extraLength + commentLength;
  }
  if (!selected.some((entry) => entry.name === 'app-release-unsigned.apk')) throw new Error('missing release APK');
  const directory = path.join(ROOT, 'artifacts', 'android-selected-' + runId); fs.mkdirSync(directory, { recursive: true });
  const files = [];
  for (const entry of selected) {
    stage = '下载 ' + entry.name;
    if (entry.compressed > 512 * 1024 * 1024 || entry.size > 512 * 1024 * 1024) throw new Error('entry limit');
    const local = await range(entry.offset, entry.offset + 29);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('local entry');
    const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const chunkSize = 4 * 1024 * 1024, chunks = new Array(Math.ceil(entry.compressed / chunkSize)); let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, chunks.length) }, async () => {
      while (next < chunks.length) { const part = next++; chunks[part] = await range(start + part * chunkSize, start + Math.min((part + 1) * chunkSize, entry.compressed) - 1); }
    }));
    const compressed = Buffer.concat(chunks);
    const content = entry.method === 0 ? compressed : entry.method === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: entry.size }) : null;
    if (!content || content.length !== entry.size || (zlib.crc32 && zlib.crc32(content) !== entry.crc)) throw new Error('entry checksum');
    fs.writeFileSync(path.join(directory, entry.name), content);
    files.push({ name: entry.name, bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
  }
  const record = { runId, sourceCommit: run.head_sha, conclusion: run.conclusion, directory, files };
  fs.writeFileSync(path.join(directory, 'source.json'), JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
}
main().catch((error) => { const reason = /^[a-zA-Z0-9 ]{1,70}$/.test(error.message) ? error.message : error.name; console.error('安卓附件下载失败：' + stage + ' (' + reason + ')。凭据与下载地址未输出。'); process.exitCode = 1; });
