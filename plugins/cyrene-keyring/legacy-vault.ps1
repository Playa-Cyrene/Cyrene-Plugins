param(
  [Parameter(Mandatory = $true)][string]$Mode,
  [Parameter(Mandatory = $true)][string]$FilePath
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$text = [IO.File]::ReadAllText($FilePath, [Text.Encoding]::UTF8)

if ($Mode -eq 'protect') {
    # 明文 -> DPAPI 保护的十六进制串
    $secure = ConvertTo-SecureString -String $text -AsPlainText -Force
    $secure | ConvertFrom-SecureString
}
elseif ($Mode -eq 'unprotect') {
    # DPAPI 十六进制串 -> 明文
    $secure = ConvertTo-SecureString -String $text.Trim()
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}
else {
    throw "unknown mode: $Mode"
}
