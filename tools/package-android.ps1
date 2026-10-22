#requires -Version 7.2
param(
  [string]$OutputName = 'blood-clocktower-android-ai.zip',
  [switch]$IncludeTests
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([System.IO.Path]::GetFileName($OutputName) -ne $OutputName -or -not $OutputName.EndsWith('.zip')) { throw '输出名必须是一个 .zip 文件名' }
$artifactDir = Join-Path $taskRoot 'artifacts'
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$archivePath = [System.IO.Path]::GetFullPath((Join-Path $artifactDir $OutputName))
if (-not $archivePath.StartsWith($artifactDir + [System.IO.Path]::DirectorySeparatorChar)) { throw '输出目录不合法' }
$tempArchive = $archivePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
$files = @('server.js','package.json','start-android.sh','README.md','AGENTS.md','先读我.html','DeepSeek配置.md','DeepSeek配置.html','安卓平板使用.md','说书人设计.md','说书人接口.md','技术路线.md','远程连接.md','dev.md','技能判定.md','配板指南.md','修复验证_20261022.md','AI接入验证_20261022.md','官方规则核对验证_20261022.md','官方规则核对验证_20261022.html','ai.config.example.json')
$folders = @('engine','lib','public','docs')
if ($IncludeTests) { $folders += @('tests','tools','deploy'); $files += @('.gitignore','.gitattributes') }
foreach ($folder in $folders) {
  foreach ($file in (Get-ChildItem -LiteralPath (Join-Path $taskRoot $folder) -File -Recurse)) { $files += [System.IO.Path]::GetRelativePath($taskRoot, $file.FullName) }
}
$files = @($files | Sort-Object -Unique)
$manifest = @()
$archive = [System.IO.Compression.ZipFile]::Open($tempArchive, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($relative in $files) {
    if ($relative -match '(^|[\\/])(ai\.local\.json|room[^\\/]*\.json|\.room[^\\/]*|[^\\/]+\.log)$') { throw ('拒绝打包私密或临时文件：' + $relative) }
    $source = Join-Path $taskRoot $relative
    $entry = 'blood-clocktower/' + $relative.Replace('\','/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $source, $entry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    $manifest += [pscustomobject]@{ entry = $entry; bytes = (Get-Item -LiteralPath $source).Length; sha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash }
  }
} finally { $archive.Dispose() }
$check = [System.IO.Compression.ZipFile]::OpenRead($tempArchive)
try {
  if ($check.Entries.Count -ne $manifest.Count) { throw '压缩包文件数不一致' }
  foreach ($record in $manifest) {
    $stream = $check.GetEntry($record.entry).Open()
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { if ([Convert]::ToHexString($hasher.ComputeHash($stream)) -ne $record.sha256) { throw ('文件校验失败：' + $record.entry) } }
    finally { $stream.Dispose(); $hasher.Dispose() }
  }
} finally { $check.Dispose() }
Move-Item -LiteralPath $tempArchive -Destination $archivePath -Force
$version = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).version
$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
$manifestPath = $archivePath + '.manifest.json'
[pscustomobject]@{ version = $version; date = '2026-10-22'; archive = $OutputName; sourcePackage = [bool]$IncludeTests; sha256 = $hash; files = $manifest } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
[pscustomobject]@{ archive = $archivePath; files = $manifest.Count; bytes = (Get-Item -LiteralPath $archivePath).Length; sha256 = $hash; verified = $true } | ConvertTo-Json -Compress
