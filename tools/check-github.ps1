#requires -Version 7.2
$ErrorActionPreference = 'Stop'
# 凭据只留在进程内存；绝不输出或写入文件。
$credentialLines = "protocol=https`nhost=github.com`nusername=wyswang3`n`n" | git credential fill
if ($LASTEXITCODE -ne 0) { throw '无法读取 GitHub 登录凭据' }
$credential = @{}
foreach ($line in $credentialLines) {
  $parts = $line -split '=', 2
  if ($parts.Count -eq 2) { $credential[$parts[0]] = $parts[1] }
}
if (-not $credential['password']) { throw '缺少 GitHub 登录凭据' }
$headers = @{ Authorization = 'Bearer ' + $credential['password']; Accept = 'application/vnd.github+json'; 'User-Agent' = 'blood-clocktower-maintenance'; 'X-GitHub-Api-Version' = '2022-11-28' }
try {
  $repo = Invoke-RestMethod -Uri 'https://api.github.com/repos/wyswang3/blood-clocktower-storyteller' -Headers $headers
  [pscustomobject]@{ repository = $repo.full_name; private = $repo.private; canPush = $repo.permissions.push; defaultBranch = $repo.default_branch; size = $repo.size } | ConvertTo-Json -Compress
} catch { throw '无法核实仓库权限，请检查 GitHub 登录与仓库地址（服务响应和凭据未输出）' }
finally { $credential.Clear(); $credentialLines = $null; $headers.Clear() }
