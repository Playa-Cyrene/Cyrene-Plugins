param(
  [string]$PluginDir = '',
  [string]$RequestId = '',
  [string]$TaskUser = ''
)

$ErrorActionPreference = 'Stop'

# cyrene-github-dns: register the on-demand scheduled task that applies hosts.
# Run this once with administrator rights (the plugin launches it via UAC).
# Writes data\install-result.json so the plugin can report the outcome.

$plugin = if ($PluginDir) { $PluginDir } else { Split-Path -Parent $PSScriptRoot }
$data = Join-Path $plugin 'data'
$resultPath = Join-Path $data 'install-result.json'
$scriptPath = Join-Path $PSScriptRoot 'apply-hosts.ps1'
$stableDir = Join-Path $env:ProgramData 'cyrene-github-dns'
$stableScript = Join-Path $stableDir 'apply-hosts.ps1'
$taskName = 'cyrene-github-dns-apply'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Get-OwnerSid([string]$target) {
  $owner = (Get-Acl -LiteralPath $target).Owner
  try {
    return (New-Object System.Security.Principal.NTAccount($owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    return $owner
  }
}

function Assert-SafeDirectory([string]$target) {
  $item = Get-Item -LiteralPath $target -Force
  if (-not $item.PSIsContainer) { throw "refusing to reuse a non-directory: $target" }
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw "refusing to reuse a reparse point: $target"
  }
  $sid = Get-OwnerSid $target
  if ($sid -ne 'S-1-5-32-544' -and $sid -ne 'S-1-5-18') {
    throw "refusing to reuse $target because it is owned by $sid; delete it and run the installer again"
  }
}

function Assert-SafeFile([string]$target) {
  if (-not (Test-Path -LiteralPath $target)) { return }
  $item = Get-Item -LiteralPath $target -Force
  if ($item.PSIsContainer) { throw "refusing to reuse a directory as a file: $target" }
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw "refusing to reuse a reparse point: $target"
  }
}

function Set-LockedAcl([string]$target, [string[]]$grant) {
  & icacls.exe $target /reset | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'failed to reset ACL on ' + $target }
  & icacls.exe $target /setowner '*S-1-5-32-544' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'failed to take ownership of ' + $target }
  & icacls.exe $target /inheritance:r /grant:r @grant | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'failed to lock down ' + $target }
}

try {
  if (-not (Test-Path -LiteralPath $scriptPath)) { throw 'apply-hosts.ps1 not found' }

  # Keep the elevated task away from the user-writable plugin directory.
  # Reuse an existing directory only when it is a real directory owned by
  # Administrators/SYSTEM, and lock it before copying anything into it.
  if (Test-Path -LiteralPath $stableDir) {
    Assert-SafeDirectory $stableDir
  } else {
    New-Item -ItemType Directory -Path $stableDir | Out-Null
  }
  Set-LockedAcl $stableDir @('*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-545:(OI)(CI)RX')

  Assert-SafeFile $stableScript
  Copy-Item -Force -Path $scriptPath -Destination $stableScript
  Set-LockedAcl $stableScript @('*S-1-5-32-544:F', '*S-1-5-18:F', '*S-1-5-32-545:RX')

  # Single-quoted strings are verbatim: use a real double quote around paths,
  # not a backslash-escaped quote, or the task receives \"...\" literally.
  $argument = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $stableScript + '" -PluginDir "' + $plugin + '"'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
  if ($action.Arguments -ne $argument) { throw 'scheduled task action did not preserve the argument string' }
  $user = if ($TaskUser) { $TaskUser } else { "$env:USERDOMAIN\$env:USERNAME" }
  if (-not $user) { throw 'cannot determine the interactive user for the scheduled task' }
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  $registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  if (@($registered.Actions).Count -ne 1 -or $registered.Actions[0].Arguments -ne $argument) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    throw 'registered scheduled task action does not match the expected command'
  }
  $row = [ordered]@{ ok = $true; task = $taskName; script = $stableScript; source = $scriptPath; requestId = $RequestId; at = (Get-Date).ToString('o'); error = '' }
} catch {
  $row = [ordered]@{ ok = $false; task = $taskName; script = $stableScript; source = $scriptPath; requestId = $RequestId; at = (Get-Date).ToString('o'); error = $_.Exception.Message }
}

[System.IO.File]::WriteAllText($resultPath, ($row | ConvertTo-Json -Compress), $utf8)
if (-not $row.ok) { exit 1 }
