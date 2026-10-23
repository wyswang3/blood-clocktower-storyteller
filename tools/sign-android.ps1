#requires -Version 7.2
param([Parameter(Mandatory)][string]$ApkPath, [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceCommit, [string]$SignerJar = '', [string]$JavaHome = '')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).version
if (-not $JavaHome) {
  $java = Get-ChildItem -LiteralPath (Join-Path $taskRoot 'artifacts/android-deps/jre21') -Filter java.exe -File -Recurse | Select-Object -First 1
  if (-not $java) { throw '缺少便携 Java 环境' }
  $JavaHome = Split-Path (Split-Path $java.FullName)
}
if (-not $SignerJar) {
  $jar = Get-ChildItem -LiteralPath (Join-Path $taskRoot 'artifacts') -Filter apksigner.jar -File -Recurse | Select-Object -Last 1
  if (-not $jar) { throw '缺少官方 apksigner.jar' }
  $SignerJar = $jar.FullName
}
$inputApk = [IO.Path]::GetFullPath($ApkPath)
if (-not (Test-Path -LiteralPath $inputApk) -or -not $inputApk.EndsWith('.apk')) { throw '缺少待签名 APK' }
$privateDir = Join-Path $taskRoot 'artifacts/android-signing'
New-Item -ItemType Directory -Force -Path $privateDir | Out-Null
$key = Join-Path $privateDir 'clocktower-release.jks'
$secret = Join-Path $privateDir 'password.dpapi'
$metadataFile = Join-Path $privateDir 'signer-public.json'
if ((Test-Path -LiteralPath $key) -ne (Test-Path -LiteralPath $secret)) { throw '签名材料不完整，不自动生成新密钥；请恢复原备份' }
try {
  if (-not (Test-Path -LiteralPath $key)) {
    $password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
    # DPAPI 绑定当前 Windows 用户；明文仅存在于当前进程环境，退出后清空。
    ConvertTo-SecureString -String $password -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $secret
    $env:BTC_SIGN_PASSWORD = $password
    $keytool = Join-Path $JavaHome 'bin/keytool.exe'
    & $keytool -genkeypair -keystore $key -storetype JKS -alias clocktower -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Blood Clocktower, OU=Friends Game, O=wyswang3, C=CN' -storepass:env BTC_SIGN_PASSWORD -keypass:env BTC_SIGN_PASSWORD -noprompt 2>$null
    if ($LASTEXITCODE -ne 0) { throw '生成签名密钥失败；私密目录保留，需人工检查' }
  } else {
    $secure = (Get-Content -LiteralPath $secret -Raw).Trim() | ConvertTo-SecureString
    $password = [System.Net.NetworkCredential]::new('', $secure).Password
    $env:BTC_SIGN_PASSWORD = $password
  }
  $output = Join-Path $taskRoot ('artifacts/blood-clocktower-v' + $version + '.apk')
  & (Join-Path $JavaHome 'bin/java.exe') -jar $SignerJar sign --ks $key --ks-key-alias clocktower --ks-pass env:BTC_SIGN_PASSWORD --key-pass env:BTC_SIGN_PASSWORD --out $output $inputApk
  if ($LASTEXITCODE -ne 0) { throw 'APK 签名失败' }
  $verification = & (Join-Path $JavaHome 'bin/java.exe') -jar $SignerJar verify --verbose --print-certs $output
  if ($LASTEXITCODE -ne 0) { throw 'APK 签名校验失败' }
  $digest = $verification | Where-Object { $_ -match '^Signer #1 certificate SHA-256 digest:' } | Select-Object -First 1
  if (-not $digest) { throw '缺少签名证书摘要' }
  $certificate = ($digest -split ': ',2)[1]
  if (Test-Path -LiteralPath $metadataFile) {
    if ((Get-Content -LiteralPath $metadataFile -Raw | ConvertFrom-Json).certificateSha256 -ne $certificate) { throw '签名身份发生变化，不能用于覆盖更新' }
  } else { @{certificateSha256=$certificate;alias='clocktower'} | ConvertTo-Json | Set-Content -LiteralPath $metadataFile }
  $verification | Set-Content -LiteralPath (Join-Path $taskRoot 'artifacts/apk-signature-verification.txt')
  $manifest = [pscustomobject]@{ version=$version; file=[IO.Path]::GetFileName($output); bytes=(Get-Item -LiteralPath $output).Length; sha256=(Get-FileHash -LiteralPath $output).Hash; certificateSha256=$certificate; signatureVerified=$true; sourceCommit=$SourceCommit }
  $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath ($output + '.manifest.json')
  $manifest | ConvertTo-Json -Compress
} finally { Remove-Item Env:BTC_SIGN_PASSWORD -ErrorAction SilentlyContinue; $password=$null; $secure=$null }
