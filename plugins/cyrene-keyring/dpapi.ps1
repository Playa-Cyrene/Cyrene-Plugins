param(
  [string]$Mode = "protect"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security

$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) {
  Write-Output "EMPTY_INPUT"
  exit 2
}

try {
  $bytes = [Convert]::FromBase64String($raw.Trim())
  if ($Mode -eq "protect") {
    $out = [System.Security.Cryptography.ProtectedData]::Protect(
      $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    Write-Output ([Convert]::ToBase64String($out))
    exit 0
  }
  if ($Mode -eq "unprotect") {
    $out = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    Write-Output ([Convert]::ToBase64String($out))
    exit 0
  }
  Write-Output "UNKNOWN_MODE"
  exit 2
} catch {
  Write-Output ("ERROR " + $_.Exception.Message)
  exit 1
}
