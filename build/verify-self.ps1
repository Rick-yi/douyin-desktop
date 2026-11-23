# 校验 Authenticode 签名（自签名场景，不依赖 signtool）
#   powershell -NoProfile -ExecutionPolicy Bypass -File build/verify-self.ps1 app.exe
# 证书链未受本机信任时只告警；完全没签名或哈希不匹配才返回失败。

param(
  [Parameter(Mandatory = $true)]
  [string]$File
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $File)) { throw "File not found: $File" }

$sig = Get-AuthenticodeSignature -FilePath $File
$status = [string]$sig.Status
Write-Host "Signature status: $status"
if ($sig.SignerCertificate) {
  Write-Host "Signer: $($sig.SignerCertificate.Subject)"
  Write-Host "Thumbprint: $($sig.SignerCertificate.Thumbprint)"
}
if ($status -eq 'NotSigned' -or $status -eq 'HashMismatch') {
  throw "Invalid signature: $status"
}
if ($status -ne 'Valid') {
  Write-Host "Warning: signature present but chain is not trusted ($status); expected for self-signed."
}

& chcp 65001 | Out-Null
