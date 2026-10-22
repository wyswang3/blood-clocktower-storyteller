#requires -Version 7.2
param([string]$Version = '0.4.1')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repository = 'wyswang3/blood-clocktower-storyteller'
$api = 'https://api.github.com/repos/' + $repository
$files = @('blood-clocktower-android-ai.zip', 'blood-clocktower-android-ai.zip.manifest.json', ('blood-clocktower-source-v' + $Version + '.zip'), ('blood-clocktower-source-v' + $Version + '.zip.manifest.json'))
foreach ($name in $files) { if (-not (Test-Path -LiteralPath (Join-Path $taskRoot ('artifacts/' + $name)))) { throw ('缺少附件：' + $name) } }
# 只通过系统凭据管理器取值，不显示、不落盘、不把响应正文写入错误日志。
$credentialLines = "protocol=https`nhost=github.com`nusername=wyswang3`n`n" | git credential fill
if ($LASTEXITCODE -ne 0) { throw '无法读取 GitHub 登录' }
$credential = @{}
foreach ($line in $credentialLines) { $parts = $line -split '=', 2; if ($parts.Count -eq 2) { $credential[$parts[0]] = $parts[1] } }
if (-not $credential['password']) { throw '缺少 GitHub 登录' }
$headers = @{ Authorization = 'Bearer ' + $credential['password']; Accept = 'application/vnd.github+json'; 'User-Agent' = 'blood-clocktower-maintenance'; 'X-GitHub-Api-Version' = '2022-11-28' }
function Request-API($method, $uri, $body = $null) {
  try {
    if ($null -eq $body) { return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers }
    return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 6)))
  } catch { throw ('GitHub 操作失败：' + $method + '；响应正文与凭据未输出') }
}
try {
  $repo = Request-API 'Get' $api
  if (-not $repo.private -or -not $repo.permissions.push) { throw '仓库必须是私密且当前账号有写入权限' }
  $localHead = git -C $taskRoot rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw '本地缺少已提交版本' }
  $remote = Request-API 'Get' ($api + '/git/ref/heads/main')
  if ($remote.object.sha -ne $localHead) { throw '远端 main 尚未与本地提交一致' }
  $tag = 'v' + $Version
  $existing = @(Request-API 'Get' ($api + '/releases')) | Where-Object { $_.tag_name -eq $tag }
  if ($existing) { throw '此版本已存在，请先人工核实，脚本不会覆盖正式发布或旧附件' }
  $body = "平板大厅点「连接 DeepSeek」，粘贴 API Key 后自动验证、保存、加载并启用，无需编辑配置或下载模型。暂停状态和密钥在重启后保留。僧侣保持官方规则，允许连续两晚守同一人。`n`n231 项自动测试、100 局模拟和本地七手机联机通过，包含两次真实服务重启。真实 DeepSeek、安卓真机与公网链路待验。`n`n下载 blood-clocktower-android-ai.zip，解压打开 先读我.html。源码包含测试与维护工具，旁置清单含逐文件 SHA-256。首次未连接 AI 也能开局。"
  $release = Request-API 'Post' ($api + '/releases') @{ tag_name = $tag; target_commitish = $localHead; name = ($tag + ' · 平板一键连接 DeepSeek'); body = $body; draft = $true; prerelease = $false }
  $uploaded = @()
  foreach ($name in $files) {
    $file = Join-Path $taskRoot ('artifacts/' + $name)
    $sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    $uri = 'https://uploads.github.com/repos/' + $repository + '/releases/' + $release.id + '/assets?name=' + [Uri]::EscapeDataString($name)
    $type = if ($name.EndsWith('.zip')) { 'application/zip' } else { 'application/json' }
    try { $asset = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType $type -InFile $file }
    catch { throw ('附件上传失败：' + $name + '；版本仍为草稿，响应正文与凭据未输出') }
    if ($asset.state -ne 'uploaded' -or $asset.size -ne (Get-Item -LiteralPath $file).Length) { throw ('远端附件不完整：' + $name) }
    if ($asset.digest) {
      if ($asset.digest -ne ('sha256:' + $sha256.ToLowerInvariant())) { throw ('远端摘要不符：' + $name) }
    } else {
      $verifyPath = Join-Path $taskRoot ('artifacts/github-verify-' + $asset.id + '-' + $name)
      $downloadHeaders = $headers.Clone(); $downloadHeaders.Accept = 'application/octet-stream'
      try { Invoke-WebRequest -Uri $asset.url -Headers $downloadHeaders -OutFile $verifyPath }
      catch { throw ('附件回读校验失败：' + $name) }
      finally { $downloadHeaders.Clear() }
      if ((Get-FileHash -LiteralPath $verifyPath -Algorithm SHA256).Hash -ne $sha256) { throw ('附件回读摘要不符：' + $name) }
    }
    $uploaded += [pscustomobject]@{ name = $name; bytes = $asset.size; sha256 = $sha256; verified = $true }
  }
  $published = Request-API 'Patch' ($api + '/releases/' + $release.id) @{ draft = $false; make_latest = 'true' }
  if ($published.draft) { throw '附件已校验，但版本仍是草稿' }
  [pscustomobject]@{ repository = $repo.full_name; private = $repo.private; commit = $localHead; release = $published.html_url; assets = $uploaded } | ConvertTo-Json -Depth 5
} finally { $headers.Clear(); $credential.Clear(); $credentialLines = $null }
