$ErrorActionPreference = 'Stop'

# cyrene-github-dns: register the on-demand scheduled task that applies hosts.
# Run this once with administrator rights (the plugin launches it via UAC).
# Writes data\install-result.json so the plugin can report the outcome.

$plugin = Split-Path -Parent $PSScriptRoot
$data = Join-Path $plugin 'data'
$resultPath = Join-Path $data 'install-result.json'
$scriptPath = Join-Path $PSScriptRoot 'apply-hosts.ps1'
$stableDir = Join-Path $env:ProgramData 'cyrene-github-dns'
$stableScript = Join-Path $stableDir 'apply-hosts.ps1'
$taskName = 'cyrene-github-dns-apply'
$utf8 = New-Object System.Text.UTF8Encoding($false)

try {
  if (-not (Test-Path $scriptPath)) { throw 'apply-hosts.ps1 not found' }

  # Keep the elevated task away from the user-writable plugin directory.
  New-Item -ItemType Directory -Force -Path $stableDir | Out-Null
  Copy-Item -Force -Path $scriptPath -Destination $stableScript
  & icacls.exe $stableDir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'failed to lock down ' + $stableDir }
  & icacls.exe $stableScript /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' '*S-1-5-32-545:RX' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'failed to lock down ' + $stableScript }

  $argument = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $stableScript + '" -PluginDir "' + $plugin + '"'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  $row = [ordered]@{ ok = $true; task = $taskName; script = $stableScript; source = $scriptPath; at = (Get-Date).ToString('o'); error = '' }
} catch {
  $row = [ordered]@{ ok = $false; task = $taskName; script = $stableScript; source = $scriptPath; at = (Get-Date).ToString('o'); error = $_.Exception.Message }
}

[System.IO.File]::WriteAllText($resultPath, ($row | ConvertTo-Json -Compress), $utf8)
if (-not $row.ok) { exit 1 }
