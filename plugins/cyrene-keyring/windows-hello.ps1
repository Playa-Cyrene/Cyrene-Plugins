param(
  [string]$Mode = "availability",
  [string]$Message = "Unlock Cyrene Keyring"
)

$ErrorActionPreference = "Stop"

# WinRT IAsyncOperation -> Task 的桥
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and
  $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

[Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime] | Out-Null

if ($Mode -eq "availability") {
  $result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
  Write-Output $result.ToString()
  exit 0
}

if ($Mode -eq "verify") {
  $result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($Message)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
  Write-Output $result.ToString()
  exit 0
}

Write-Output "UNKNOWN_MODE"
exit 2
