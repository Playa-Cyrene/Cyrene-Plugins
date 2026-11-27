$ErrorActionPreference = 'Stop'

# cyrene-github-dns: apply the requested hosts block.
# Runs from the scheduled task with highest privileges.
# Protocol: read data\apply.json, rewrite only our marked block, write data\apply-result.json.

$plugin = Split-Path -Parent $PSScriptRoot
$data = Join-Path $plugin 'data'
$hostsPath = 'C:\Windows\System32\drivers\etc\hosts'
$requestPath = Join-Path $data 'apply.json'
$resultPath = Join-Path $data 'apply-result.json'
$markStart = '# >>> cyrene-github-dns >>>'
$markEnd = '# <<< cyrene-github-dns <<<'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$rid = ''

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

  $raw = [System.IO.File]::ReadAllText($hostsPath)
  $backup = Join-Path $data ('hosts.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
  [System.IO.File]::WriteAllText($backup, $raw, $utf8)

  $lines = $raw -split '\r?\n'
  $out = New-Object System.Collections.Generic.List[string]
  $inside = $false
  foreach ($line in $lines) {
    $t = $line.Trim()
    if ($t -eq $markStart) { $inside = $true; continue }
    if ($t -eq $markEnd) { $inside = $false; continue }
    if (-not $inside) { $out.Add($line) }
  }
  while ($out.Count -gt 0 -and $out[$out.Count - 1] -eq '') { $out.RemoveAt($out.Count - 1) }

  if ($action -eq 'apply') {
    if ($ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw 'invalid ip: ' + $ip }
    $out.Add('')
    $out.Add($markStart)
    foreach ($d in $domains) { $out.Add($ip + ' ' + $d) }
    $out.Add($markEnd)
  }

  $text = ($out -join "`r`n") + "`r`n"
  [System.IO.File]::WriteAllText($hostsPath, $text, $utf8)
  ipconfig /flushdns | Out-Null
  Write-Result $true $action $ip '' $backup $rid
} catch {
  Write-Result $false 'unknown' '' $_.Exception.Message '' $rid
  exit 1
}
