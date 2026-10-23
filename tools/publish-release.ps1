#requires -Version 7.2
param([string]$Version = '0.5.0')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repository = 'wyswang3/blood-clocktower-storyteller'
$api = 'https://api.github.com/repos/' + $repository
$files = @('blood-clocktower-android-ai.zip', 'blood-clocktower-android-ai.zip.manifest.json', ('blood-clocktower-source-v' + $Version + '.zip'), ('blood-clocktower-source-v' + $Version + '.zip.manifest.json'))
$files += @(('blood-clocktower-v' + $Version + '.apk'), ('blood-clocktower-v' + $Version + '.apk.manifest.json'))
foreach ($name in $files) { if (-not (Test-Path -LiteralPath (Join-Path $taskRoot ('artifacts/' + $name)))) { throw ('缺少附件：' + $name) } }
$apk = Join-Path $taskRoot ('artifacts/blood-clocktower-v' + $Version + '.apk')
$apkManifest = Get-Content -LiteralPath ($apk + '.manifest.json') -Raw | ConvertFrom-Json
if (-not $apkManifest.signatureVerified -or $apkManifest.version -ne $Version -or $apkManifest.sha256 -ne (Get-FileHash -LiteralPath $apk).Hash) { throw 'APK 签名记录、版本或摘要不一致' }
$apkContent = Get-Content -LiteralPath (Join-Path $taskRoot 'artifacts/apk-content-verification.json') -Raw | ConvertFrom-Json
if (-not $apkContent.privateFilesAbsent -or -not $apkContent.gameSourcesMatch -or $apkContent.sha256 -ne $apkManifest.sha256) { throw 'APK 内容核验未完成或文件已变化' }
# 只通过系统凭据管理器取值，不显示、不落盘、不把响应正文写入错误日志。
$credentialLines = "protocol=https`nhost=github.com`nusername=wyswang3`n`n" | git credential fill
if ($LASTEXITCODE -ne 0) { throw '无法读取 GitHub 登录' }
$credential = @{}
foreach ($line in $credentialLines) { $parts = $line -split '=', 2; if ($parts.Count -eq 2) { $credential[$parts[0]] = $parts[1] } }
if (-not $credential['password']) { throw '缺少 GitHub 登录' }
$headers = @{ Authorization = 'Bearer ' + $credential['password']; Accept = 'application/vnd.github+json'; 'User-Agent' = 'blood-clocktower-maintenance'; 'X-GitHub-Api-Version' = '2022-11-28' }
function Request-API($method, $uri, $body = $null) {
  for ($apiAttempt = 1; $apiAttempt -le 3; $apiAttempt++) {
    try {
      if ($null -eq $body) { $response = Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -TimeoutSec 30 }
      else { $response = Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 6))) -TimeoutSec 30 }
      # 先接收再返回，展开 REST 数组；否则列表作为单个数组对象进入后续筛选。
      return $response
    } catch {
      if ($method -eq 'Get' -and $apiAttempt -lt 3) { Start-Sleep -Seconds 2; continue }
      throw ('GitHub 操作失败：' + $method + ' ' + ([Uri]$uri).AbsolutePath + '，HTTP ' + [int]$_.Exception.Response.StatusCode + '；响应正文与凭据未输出')
    }
  }
}
try {
  $repo = Request-API 'Get' $api
  if (-not $repo.private -or -not $repo.permissions.push) { throw '仓库必须是私密且当前账号有写入权限' }
  $localHead = git -C $taskRoot rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw '本地缺少已提交版本' }
  $remote = Request-API 'Get' ($api + '/git/ref/heads/main')
  if ($remote.object.sha -ne $localHead) { throw '远端 main 尚未与本地提交一致' }
  $builds = Request-API 'Get' ($api + '/actions/workflows/android.yml/runs?head_sha=' + $apkManifest.sourceCommit)
  $passed = @($builds.workflow_runs | Where-Object { $_.head_sha -eq $apkManifest.sourceCommit -and $_.conclusion -eq 'success' })
  if (-not $passed.Count) { throw 'APK 对应提交尚无完整通过的安卓构建与模拟器验收，不发布正式版本' }
  $tag = 'v' + $Version
  $existing = @(Request-API 'Get' ($api + '/releases')) | Where-Object { $_.tag_name -eq $tag }
  if ($existing -and -not $existing.draft) { throw '此版本已正式发布，脚本不会覆盖正式发布或旧附件' }
  $body = "下载 blood-clocktower-v$Version.apk，在安卓平板安装后点图标直接进入大厅。无需 Termux、命令或另装联网工具。点「连接 DeepSeek」填写 API Key，自动验证并保存，再分享房间链接邀请手机加入。`n`nAPK 约 91 MB；常见 ARM64 平板基础安装占用预计约 180–200 MB，安装时建议预留 500 MB。模型在云端，不下载。手机只打开网页。`n`n244 项自动测试、100 局模拟、本地七手机联机，以及 Android 15 平板模拟器安装、启动与进程重启恢复已通过。服务器仍在平板上；内置公网连接、自动重试和同一 Wi-Fi / 热点备用模式。真实平板、DeepSeek 账户及运营商网络仍需现场确认，模拟器未取得公网往返成功证据。`n`n同一网址下断线可恢复座位；房间网址改变后的手机座位迁移尚未实现，正式局避免重启或切换平板网络。完整说明见源码或备用运行包中的 先读我.html。游戏规则和本桌提名限制保持原约定。`n`n后续版本请覆盖安装，不要先卸载。ZIP 是源码与备用命令行运行包；密钥、存档和签名私钥均不在附件中。"
  $releaseData = @{ tag_name = $tag; target_commitish = $localHead; name = ($tag + ' · 安卓平板直接安装'); body = $body; draft = $true; prerelease = $false }
  $release = if ($existing) { Request-API 'Patch' ($api + '/releases/' + $existing.id) $releaseData } else { Request-API 'Post' ($api + '/releases') $releaseData }
  $uploaded = @()
  foreach ($name in $files) {
    $file = Join-Path $taskRoot ('artifacts/' + $name)
    $sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    $uri = 'https://uploads.github.com/repos/' + $repository + '/releases/' + $release.id + '/assets?name=' + [Uri]::EscapeDataString($name)
    $type = if ($name.EndsWith('.zip')) { 'application/zip' } elseif ($name.EndsWith('.apk')) { 'application/vnd.android.package-archive' } else { 'application/json' }
    $asset = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      # 仅恢复本版本的未发布草稿。网络断开时服务器可能已收齐，先按摘要检查，避免重复上传。
      $current = @(Request-API 'Get' ($api + '/releases/' + $release.id + '/assets')) | Where-Object name -eq $name
      if ($current -and $current.state -eq 'uploaded' -and $current.size -eq (Get-Item -LiteralPath $file).Length -and $current.digest -eq ('sha256:' + $sha256.ToLowerInvariant())) { $asset = $current; break }
      if ($current) { Request-API 'Delete' ($api + '/releases/assets/' + $current.id) | Out-Null }
      Write-Host ('上传 ' + $name + '，第 ' + $attempt + ' 次')
      # curl 从标准输入读取凭据，命令行不带 token；用相对 ASCII 文件名避免中文路径编码问题。
      $curlConfig = @(
        ('url = "' + $uri + '"')
        ('header = "Authorization: Bearer ' + $credential['password'] + '"')
        'header = "Accept: application/vnd.github+json"'
        ('header = "Content-Type: ' + $type + '"')
        'header = "User-Agent: blood-clocktower-maintenance"'
        ('data-binary = "@' + $name + '"')
      ) -join "`n"
      Push-Location (Join-Path $taskRoot 'artifacts')
      try {
        $reply = $curlConfig | & curl.exe --config - --silent --show-error --fail --connect-timeout 30 --max-time 360
        $uploadExit = $LASTEXITCODE
        if ($uploadExit -eq 0) { $asset = ($reply -join "`n") | ConvertFrom-Json }
      } catch { $uploadExit = -1 }
      finally { Pop-Location; $curlConfig = $null; $reply = $null }
      if ($asset) { break }
      if ($attempt -lt 3) { Start-Sleep -Seconds 3 }
    }
    if (-not $asset) { throw ('附件上传失败：' + $name + '；版本仍为可恢复草稿，响应正文与凭据未输出') }
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
