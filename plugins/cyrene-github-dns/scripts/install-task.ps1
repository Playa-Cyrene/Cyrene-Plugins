$ErrorActionPreference = 'Stop'

# cyrene-github-dns: register the on-demand scheduled task that applies hosts.
# Run this once with administrator rights (the plugin launches it via UAC).
# Writes data\install-result.json so the plugin can report the outcome.

$plugin = Split-Path -Parent $PSScriptRoot
$data = Join-Path $plugin 'data'
$resultPath = Join-Path $data 'install-result.json'
$scriptPath = Join-Path $PSScriptRoot 'apply-hosts.ps1'
$taskName = 'cyrene-github-dns-apply'
$utf8 = New-Object System.Text.UTF8Encoding($false)

try {
  if (-not (Test-Path $scriptPath)) { throw 'apply-hosts.ps1 not found' }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '"')
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  $row = [ordered]@{ ok = $true; task = $taskName; script = $scriptPath; at = (Get-Date).ToString('o'); error = '' }
} catch {
  $row = [ordered]@{ ok = $false; task = $taskName; script = $scriptPath; at = (Get-Date).ToString('o'); error = $_.Exception.Message }
}

[System.IO.File]::WriteAllText($resultPath, ($row | ConvertTo-Json -Compress), $utf8)
if (-not $row.ok) { exit 1 }
