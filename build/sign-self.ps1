# 用自签名证书给 PE 文件签名（不需要 Windows SDK/signtool）
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File build/sign-self.ps1 a.exe b.exe
#
# 证书来自 build/certs/selfsign.json；私钥优先从当前用户证书库读取，
# 证书库丢失时回退到同目录的 PFX + 密码文件。

param(
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
  [string[]]$Files
)

$ErrorActionPreference = 'Stop'
$certDir = Join-Path $PSScriptRoot 'certs'
$metaPath = Join-Path $certDir 'selfsign.json'
if (-not (Test-Path $metaPath)) {
  throw "Missing $metaPath. Run: npm run cert:self"
}
$meta = Get-Content $metaPath -Raw | ConvertFrom-Json

$cert = Get-Item "Cert:\CurrentUser\My\$($meta.thumbprint)" -ErrorAction SilentlyContinue
if (-not $cert) {
  $plain = (Get-Content $meta.passwordFile -Raw).Trim()
  $secure = ConvertTo-SecureString $plain -AsPlainText -Force
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
    $meta.pfx, $secure,
    [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable
  )
}

foreach ($file in $Files) {
  if (-not (Test-Path $file)) { throw "File not found: $file" }
  $sig = Set-AuthenticodeSignature -FilePath $file -Certificate $cert -HashAlgorithm SHA256
  if (-not $sig.SignerCertificate) {
    throw "Signing failed: $file ($($sig.StatusMessage))"
  }
  $status = [string]$sig.Status
  if ($status -eq 'NotSigned' -or $status -eq 'HashMismatch') {
    throw "Signature verification failed: $file ($status)"
  }
  Write-Host "Signed: $file ($status)"
}

# 恢复控制台代码页，避免父进程后续 UTF-8 日志乱码
& chcp 65001 | Out-Null
