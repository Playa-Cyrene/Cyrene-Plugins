param([string]$PluginDir = '')

$ErrorActionPreference = 'Stop'

# cyrene-github-dns: apply the requested hosts block.
# Runs from the scheduled task with highest privileges.
# Protocol: read data\apply.json (user-writable request), rewrite only our marked block,
# then write apply-result.json and backups under the protected ProgramData state directory.

$plugin = if ($PluginDir) { $PluginDir } else { Split-Path -Parent $PSScriptRoot }
$data = Join-Path $plugin 'data'
$stateDir = Join-Path $env:ProgramData 'cyrene-github-dns'
$backupDir = Join-Path $stateDir 'backups'
$systemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
$hostsPath = Join-Path $systemRoot 'System32\drivers\etc\hosts'
$requestPath = Join-Path $data 'apply.json'
$resultPath = Join-Path $stateDir 'apply-result.json'
$markStart = '# >>> cyrene-github-dns >>>'
$markEnd = '# <<< cyrene-github-dns <<<'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$rid = ''

function Test-IPv4([string]$value) {
  $parts = $value.Split('.')
  if ($parts.Length -ne 4) { return $false }
  foreach ($part in $parts) {
    if ($part -notmatch '^\d{1,3}$') { return $false }
    if ([int]$part -gt 255) { return $false }
  }
  return $true
}

function Read-HostsDocument([string]$path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    return @{ Text = [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3); Encoding = 'utf8-bom'; Bytes = $bytes }
  }
  if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
    return @{ Text = [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2); Encoding = 'utf16-le'; Bytes = $bytes }
  }
  if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
    return @{ Text = [System.Text.Encoding]::BigEndianUnicode.GetString($bytes, 2, $bytes.Length - 2); Encoding = 'utf16-be'; Bytes = $bytes }
  }
  $strict = New-Object System.Text.UTF8Encoding($false, $true)
  try {
    $text = $strict.GetString($bytes)
    return @{ Text = $text; Encoding = 'utf8'; Bytes = $bytes }
  } catch {
    return @{ Text = [System.Text.Encoding]::Default.GetString($bytes); Encoding = 'ansi'; Bytes = $bytes }
  }
}

function Write-HostsDocument([string]$path, [string]$text, [string]$encoding) {
  switch ($encoding) {
    'utf8-bom' { [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($true))); break }
    'utf16-le' { [System.IO.File]::WriteAllText($path, $text, [System.Text.Encoding]::Unicode); break }
    'utf16-be' { [System.IO.File]::WriteAllText($path, $text, [System.Text.Encoding]::BigEndianUnicode); break }
    'utf8' { [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false))); break }
    default { [System.IO.File]::WriteAllText($path, $text, [System.Text.Encoding]::Default); break }
  }
}

function Assert-SafeStateDir() {
  if (-not (Test-Path -LiteralPath $stateDir)) { throw 'protected state directory missing; reinstall the scheduled task' }
  $item = Get-Item -LiteralPath $stateDir -Force
  if (-not $item.PSIsContainer) { throw 'protected state path is not a directory' }
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'protected state path is a reparse point' }
  $owner = (Get-Acl -LiteralPath $stateDir).Owner
  try { $sid = (New-Object System.Security.Principal.NTAccount($owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid = $owner }
  if ($sid -ne 'S-1-5-32-544' -and $sid -ne 'S-1-5-18') { throw 'protected state directory is not owned by Administrators/SYSTEM' }
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
}

function New-BackupPath([string]$requestId) {
  $suffix = if ($requestId) { $requestId -replace '[^A-Za-z0-9_-]', '' } else { '' }
  if (-not $suffix) { $suffix = [guid]::NewGuid().ToString('N').Substring(0, 8) }
  $base = Join-Path $backupDir ('hosts.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + $suffix)
  $candidate = $base + '.txt'
  $index = 1
  while (Test-Path -LiteralPath $candidate) {
    $candidate = $base + '-' + $index + '.txt'
    $index++
  }
  return $candidate
}

function Write-Result($ok, $action, $ip, $errorText, $backup, $requestId) {
  $row = [ordered]@{
    ok = $ok
    action = $action
    ip = $ip
    backup = $backup
    requestId = $requestId
    at = (Get-Date).ToString('o')
    error = $errorText
  }
  $json = $row | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($resultPath, $json, $utf8)
}

try {
  if (-not (Test-Path $requestPath)) { throw 'apply.json not found' }
  $request = Get-Content -Raw -Encoding UTF8 -Path $requestPath | ConvertFrom-Json
  $rid = [string]$request.requestId
  $action = [string]$request.action
  $ip = [string]$request.ip
  $domains = @($request.domains)
  if (-not $domains -or $domains.Count -eq 0) { $domains = @('github.com', 'www.github.com') }

  Assert-SafeStateDir
  $hostsDocument = Read-HostsDocument $hostsPath
  $raw = $hostsDocument.Text
  $backup = New-BackupPath $rid
  [System.IO.File]::WriteAllBytes($backup, $hostsDocument.Bytes)

  $lines = $raw -split '\r?\n'
  $out = New-Object System.Collections.Generic.List[string]
  $inside = $false
  $pairs = 0
  foreach ($line in $lines) {
    $t = $line.Trim()
    if ($t -eq $markStart) {
      if ($inside) { throw 'hosts has nested start markers; refusing to modify' }
      $inside = $true
      continue
    }
    if ($t -eq $markEnd) {
      if (-not $inside) { throw 'hosts has an end marker without a start marker; refusing to modify' }
      $inside = $false
      $pairs++
      continue
    }
    if (-not $inside) { $out.Add($line) }
  }
  if ($inside) { throw 'hosts has an unclosed start marker; refusing to modify' }
  if ($pairs -gt 1) { throw 'hosts has multiple marked blocks; refusing to modify' }
  while ($out.Count -gt 0 -and $out[$out.Count - 1] -eq '') { $out.RemoveAt($out.Count - 1) }

  if ($action -ne 'apply' -and $action -ne 'clear') { throw 'invalid action: ' + $action }

  if ($action -eq 'apply') {
    if (-not (Test-IPv4 $ip)) { throw 'invalid ip: ' + $ip }
    foreach ($d in $domains) {
      if ($d -ne 'github.com' -and $d -ne 'www.github.com') { throw 'invalid domain: ' + $d }
    }
    $out.Add('')
    $out.Add($markStart)
    foreach ($d in $domains) { $out.Add($ip + ' ' + $d) }
    $out.Add($markEnd)
  }

  $text = ($out -join "`r`n") + "`r`n"
  Write-HostsDocument $hostsPath $text $hostsDocument.Encoding
  ipconfig /flushdns | Out-Null
  Write-Result $true $action $ip '' $backup $rid
} catch {
  Write-Result $false 'unknown' '' $_.Exception.Message '' $rid
  exit 1
}
