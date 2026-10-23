'use strict';
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
function git(args,input){const r=spawnSync('git',args,{cwd:root,input,encoding:null,windowsHide:true,maxBuffer:128*1024*1024});if(r.status!==0)throw new Error('Git 审核读取失败');return r.stdout;}
const objects=git(['-c','core.quotePath=false','rev-list','--objects','--all']).toString('utf8').trim().split('\n').map(s=>({id:s.slice(0,40),name:s.slice(41)}));
const names=new Map(objects.map(o=>[o.id,o.name]));
const metadata=git(['cat-file','--batch-check'],objects.map(o=>o.id).join('\n')+'\n').toString('utf8').trim().split('\n');
const ids=metadata.filter(s=>/^[a-f0-9]{40} blob \d+$/.test(s)).map(s=>s.slice(0,40));
const batch=git(['cat-file','--batch'],ids.join('\n')+'\n');
const findings=[];let offset=0,textBlobs=0;
const patterns=[['provider-key',/\bsk-[A-Za-z0-9_-]{24,}\b/],['github-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/]];
while(offset<batch.length){const end=batch.indexOf(10,offset);if(end<0)throw new Error('对象边界异常');const header=batch.subarray(offset,end).toString('ascii').match(/^([a-f0-9]{40}) blob (\d+)$/);if(!header)throw new Error('对象头异常');const size=Number(header[2]),content=batch.subarray(end+1,end+1+size);offset=end+size+2;if(content.subarray(0,8192).includes(0))continue;textBlobs++;const text=content.toString('utf8');for(const [kind,pattern] of patterns){if(pattern.test(text))findings.push({kind,path:names.get(header[1]),blob:header[1]});}}
const historicalPaths=git(['-c','core.quotePath=false','log','--all','--name-only','--pretty=format:','-z']).toString('utf8').split(/[\0\r\n]+/).filter(Boolean);
const sensitivePaths=[...new Set(historicalPaths)].filter(p=>/(^|\/)(?:ai\.local\.json[^/]*|room[^/]*\.json|\.room[^/]*|[^/]+\.(?:jks|keystore)|password\.dpapi|\.env|local\.properties)$/.test(p));
const result={commits:Number(git(['rev-list','--all','--count']).toString().trim()),blobs:ids.length,textBlobs,credentialPatternFindings:findings,sensitiveHistoricalPaths:sensitivePaths,passed:!findings.length&&!sensitivePaths.length,note:'模式扫描与文件路径核查，不能证明不存在所有类型的秘密；结果不打印匹配值。'};
fs.writeFileSync(path.join(root,'artifacts','public-repository-audit.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.passed)process.exitCode=1;
