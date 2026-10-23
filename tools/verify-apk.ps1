#requires -Version 7.2
param([Parameter(Mandatory)][string]$ApkPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version=(Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).version
$zip=[IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($ApkPath))
try {
  $names=@($zip.Entries.FullName)
  foreach($name in $names) {
    if($name -match '(^|/)(ai\.local\.json[^/]*|room[^/]*\.json|\.room[^/]*|[^/]+\.(jks|keystore)|password\.dpapi|local\.properties)$' -or $name -match '(^|/)\.\./') { throw ('APK 含不允许的文件：'+$name) }
  }
  foreach($abi in @('arm64-v8a','armeabi-v7a','x86_64')) {
    foreach($library in @('libnode.so','libclocktower.so','libcloudflared.so','libc++_shared.so')) {
      $name='lib/'+$abi+'/'+$library
      if($name -notin $names -or $zip.GetEntry($name).Length -lt 1000) { throw ('缺少完整的原生组件：'+$name) }
    }
  }
  foreach($name in @('AndroidManifest.xml','classes.dex','resources.arsc','assets/game/server.js','assets/licenses/nodejs-mobile-LICENSE','assets/licenses/cloudflared-LICENSE')) {
    if($name -notin $names) { throw ('缺少 APK 运行文件：'+$name) }
  }
  $runtimeEntries=@($zip.Entries | Where-Object {$_.FullName.StartsWith('assets/game/') -and $_.Length -gt 0})
  foreach($entry in $runtimeEntries) {
    $relative=$entry.FullName.Substring('assets/game/'.Length)
    if($relative -notin @('server.js','package.json') -and $relative -notmatch '^(engine|lib|public)/') { throw ('游戏资源超出白名单：'+$relative) }
    $file=Join-Path $taskRoot $relative
    if(-not (Test-Path -LiteralPath $file)) { throw ('源文件缺失：'+$relative) }
    $stream=$entry.Open();$hasher=[Security.Cryptography.SHA256]::Create()
    try { $hash=[Convert]::ToHexString($hasher.ComputeHash($stream)) } finally {$stream.Dispose();$hasher.Dispose()}
    if($hash -ne (Get-FileHash -LiteralPath $file).Hash) { throw ('APK 中的游戏代码与当前源文件不一致：'+$relative) }
  }
  $record=[pscustomobject]@{version=$version;entries=$zip.Entries.Count;gameFiles=$runtimeEntries.Count;abis=@('arm64-v8a','armeabi-v7a','x86_64');nativeComponentsComplete=$true;privateFilesAbsent=$true;gameSourcesMatch=$true;sha256=(Get-FileHash -LiteralPath $ApkPath).Hash}
  $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskRoot 'artifacts/apk-content-verification.json')
  $record | ConvertTo-Json -Compress
} finally {$zip.Dispose()}
