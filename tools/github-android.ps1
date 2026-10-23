#requires -Version 7.2
param([ValidateSet('Status','Logs','Download')][string]$Operation = 'Status', [long]$RunId = 0, [ValidateSet('','android-build','android-smoke')][string]$ArtifactName = '')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$credential = @{}
foreach ($line in ("protocol=https`nhost=github.com`nusername=wyswang3`n`n" | git credential fill)) {
  $parts = $line -split '=', 2; if ($parts.Count -eq 2) { $credential[$parts[0]] = $parts[1] }
}
if (-not $credential.password) { throw '缺少 GitHub 登录凭据' }
$headers = @{ Authorization = 'Bearer ' + $credential.password; Accept = 'application/vnd.github+json'; 'User-Agent' = 'blood-clocktower-maintenance' }
$api = 'https://api.github.com/repos/wyswang3/blood-clocktower-storyteller'
try {
  $repo = Invoke-RestMethod $api -Headers $headers
  if ($repo.full_name -ne 'wyswang3/blood-clocktower-storyteller') { throw '仓库身份不符，停止操作' }
  if (-not $RunId) {
    $runs = Invoke-RestMethod ($api + '/actions/workflows/android.yml/runs?per_page=5') -Headers $headers
    if (-not $runs.workflow_runs.Count) { throw '尚无安卓构建记录' }
    $RunId = $runs.workflow_runs[0].id
  }
  $run = Invoke-RestMethod ($api + '/actions/runs/' + $RunId) -Headers $headers
  if ($Operation -eq 'Status') {
    $jobs = Invoke-RestMethod ($api + '/actions/runs/' + $RunId + '/jobs') -Headers $headers
    [pscustomobject]@{ id=$RunId; commit=$run.head_sha; status=$run.status; conclusion=$run.conclusion; url=$run.html_url; jobs=@($jobs.jobs | Select-Object id,name,status,conclusion,@{n='completedSteps';e={@($_.steps | Where-Object conclusion -eq 'success').Count}},@{n='steps';e={@($_.steps | Where-Object { $_.status -eq 'in_progress' -or $_.conclusion -eq 'failure' } | Select-Object name,status,conclusion)}}) } | ConvertTo-Json -Depth 8
  } elseif ($Operation -eq 'Logs') {
    $output = Join-Path $taskRoot ('artifacts/android-run-' + $RunId + '-logs.zip')
    $jobs = Invoke-RestMethod ($api + '/actions/runs/' + $RunId + '/jobs') -Headers $headers
    $job = $jobs.jobs | Where-Object name -eq 'build' | Select-Object -Last 1
    Invoke-WebRequest ($api + '/actions/jobs/' + $job.id + '/logs') -Headers $headers -OutFile ($output + '.txt')
    Get-Content -LiteralPath ($output + '.txt') -Tail 65
    return
  } else {
    $assets = Invoke-RestMethod ($api + '/actions/runs/' + $RunId + '/artifacts') -Headers $headers
    foreach ($asset in $assets.artifacts) {
      if ($asset.expired -or $asset.name -notin @('android-build','android-smoke')) { continue }
      if ($ArtifactName -and $asset.name -ne $ArtifactName) { continue }
      $output = Join-Path $taskRoot ('artifacts/' + $asset.name + '-' + $RunId + '.zip')
      Invoke-WebRequest $asset.archive_download_url -Headers $headers -OutFile $output
      Expand-Archive -LiteralPath $output -DestinationPath ($output + '.unpacked') -Force
      [pscustomobject]@{ artifact=$asset.name; file=$output; bytes=(Get-Item -LiteralPath $output).Length; sha256=(Get-FileHash -LiteralPath $output).Hash }
    }
  }
} catch { throw ('安卓构建操作失败：' + $_.Exception.GetType().Name + ' HTTP ' + $_.Exception.Response.StatusCode + '；凭据与服务响应未输出') }
finally { $credential.Clear(); $headers.Clear() }
