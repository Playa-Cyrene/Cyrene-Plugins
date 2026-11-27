#Requires -Version 5.1
<#
send_mail.ps1 - send mail through Cyrene's configured SMTP account.

Why this exists: System.Net.Mail.SmtpClient only speaks STARTTLS (587 style),
so it cannot talk to port 465 (implicit TLS, e.g. smtp.163.com). This script
opens a raw TLS socket with SslStream and speaks SMTP by hand.

Params:
  -To       recipient address (required)
  -Subject  subject (UTF-8 safe)
  -Body     body text
  -BodyFile read body from a UTF-8 file (wins over -Body, avoids console encoding)
  -Attach   one or more absolute file paths

Example:
  powershell -NoProfile -ExecutionPolicy Bypass -File send_mail.ps1 `
    -To "someone@163.com" -Subject "hello" -Body "hi there"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$To,
  [string]$Subject = 'Cyrene Mail',
  [string]$Body = '',
  [string]$BodyFile = '',
  [string[]]$Attach = @(),
  [string]$SettingsPath = "$env:APPDATA\Cyrene\app-settings.json"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $SettingsPath)) {
  throw "settings not found: $SettingsPath"
}
$settings = Get-Content -LiteralPath $SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json

$smtpHost = [string]$settings.emailSmtpHost
$smtpPort = [int]$settings.emailSmtpPort
$smtpUser = [string]$settings.emailSmtpUser
$smtpPass = [string]$settings.emailSmtpPass
$fromName = [string]$settings.emailFromName

if (-not $smtpHost -or -not $smtpUser -or -not $smtpPass) {
  throw 'SMTP settings are incomplete in app-settings.json'
}

if ($BodyFile) {
  $Body = Get-Content -LiteralPath $BodyFile -Raw -Encoding UTF8
}

function ConvertTo-B64Lines {
  param([byte[]]$Bytes, [int]$Width = 76)
  $b64 = [Convert]::ToBase64String($Bytes)
  $sb = New-Object System.Text.StringBuilder
  for ($i = 0; $i -lt $b64.Length; $i += $Width) {
    $len = [Math]::Min($Width, $b64.Length - $i)
    [void]$sb.Append($b64.Substring($i, $len))
    [void]$sb.Append("`r`n")
  }
  return $sb.ToString()
}

function ConvertTo-HeaderText {
  param([string]$Text)
  return '=?UTF-8?B?' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text)) + '?='
}

# ---------- build MIME message ----------
$boundary = '----=_CyreneMail_' + [Guid]::NewGuid().ToString('N')
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('From: ' + (ConvertTo-HeaderText $fromName) + ' <' + $smtpUser + '>')
[void]$sb.AppendLine('To: <' + $To + '>')
[void]$sb.AppendLine('Subject: ' + (ConvertTo-HeaderText $Subject))
[void]$sb.AppendLine('Date: ' + (Get-Date).ToString('r'))
[void]$sb.AppendLine('MIME-Version: 1.0')

$hasAttach = ($Attach -and $Attach.Count -gt 0)
if ($hasAttach) {
  [void]$sb.AppendLine('Content-Type: multipart/mixed; boundary="' + $boundary + '"')
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('--' + $boundary)
}

[void]$sb.AppendLine('Content-Type: text/plain; charset=UTF-8')
[void]$sb.AppendLine('Content-Transfer-Encoding: base64')
[void]$sb.AppendLine('')
[void]$sb.Append((ConvertTo-B64Lines ([Text.Encoding]::UTF8.GetBytes($Body))))

if ($hasAttach) {
  foreach ($path in $Attach) {
    $fi = Get-Item -LiteralPath $path
    $bytes = [IO.File]::ReadAllBytes($fi.FullName)
    $nameHeader = ConvertTo-HeaderText $fi.Name
    [void]$sb.AppendLine('--' + $boundary)
    [void]$sb.AppendLine('Content-Type: application/octet-stream; name="' + $nameHeader + '"')
    [void]$sb.AppendLine('Content-Transfer-Encoding: base64')
    [void]$sb.AppendLine('Content-Disposition: attachment; filename="' + $nameHeader + '"')
    [void]$sb.AppendLine('')
    [void]$sb.Append((ConvertTo-B64Lines $bytes))
  }
  [void]$sb.AppendLine('--' + $boundary + '--')
}

$message = $sb.ToString()

# ---------- talk SMTP over implicit TLS ----------
$tcp = New-Object System.Net.Sockets.TcpClient
$tcp.Connect($smtpHost, $smtpPort)
$ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, ({ param($s, $cert, $chain, $errors) return $true }))
$ssl.AuthenticateAsClient($smtpHost)

$reader = New-Object System.IO.StreamReader($ssl, [Text.Encoding]::ASCII)
$writer = New-Object System.IO.StreamWriter($ssl, [Text.Encoding]::ASCII)
$writer.NewLine = "`r`n"
$writer.AutoFlush = $true

function Read-Reply {
  $lines = @()
  while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { throw 'SMTP connection closed unexpectedly' }
    $lines += $line
    if ($line.Length -ge 4 -and $line[3] -eq ' ') { break }
    if ($line.Length -eq 3) { break }
  }
  return $lines
}

function Send-Command {
  param([string]$Command, [int[]]$Expect)
  $writer.WriteLine($Command)
  $reply = @(Read-Reply)
  $code = 0
  [void][int]::TryParse($reply[-1].Substring(0, 3), [ref]$code)
  if ($Expect -notcontains $code) {
    throw ('SMTP command failed [' + $Command + '] -> ' + ($reply -join ' | '))
  }
  return $reply
}

try {
  [void](Read-Reply)
  [void](Send-Command ('EHLO ' + [System.Net.Dns]::GetHostName()) @(250))
  [void](Send-Command 'AUTH LOGIN' @(334))
  [void](Send-Command ([Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($smtpUser))) @(334))
  [void](Send-Command ([Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($smtpPass))) @(235))
  [void](Send-Command ('MAIL FROM:<' + $smtpUser + '>') @(250))
  [void](Send-Command ('RCPT TO:<' + $To + '>') @(250, 251))
  [void](Send-Command 'DATA' @(354))

  foreach ($line in ($message -split "`r`n")) {
    if ($line.StartsWith('.')) { $writer.WriteLine('.' + $line) }
    else { $writer.WriteLine($line) }
  }
  $writer.WriteLine('.')

  $done = @(Read-Reply)
  if (-not $done[-1].StartsWith('250')) {
    throw ('SMTP message rejected: ' + ($done -join ' | '))
  }

  try {
    $writer.WriteLine('QUIT')
    [void](Read-Reply)
  } catch { }

  Write-Output ('SENT_OK ' + $To)
}
finally {
  try { $ssl.Dispose() } catch { }
  try { $tcp.Close() } catch { }
}
