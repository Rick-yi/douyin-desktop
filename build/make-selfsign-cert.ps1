# 生成自签名代码签名证书（仅用于内部测试/自用分发）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File build/make-selfsign-cert.ps1
#   powershell ... -File build/make-selfsign-cert.ps1 -Force
#   powershell ... -File build/make-selfsign-cert.ps1 -TrustRoot
#   powershell ... -File build/make-selfsign-cert.ps1 -NoTrust
#
# 默认只把公钥证书装进「当前用户」的受信任发布者，不自动改受信任根。
# 自签名证书要消除“未知发布者”，还需要把 .cer 装进「受信任的根证书颁发机构」；
# Windows 会弹一次安全警告，确认后才会写入，不能静默完成。
# 不要把这套证书当成公开可信证书发给客户；客户机器要单独导入 .cer 才会信任。

param(
  [switch]$Force,
  [switch]$NoTrust,
  [switch]$TrustRoot
)

$ErrorActionPreference = 'Stop'
$certDir = Join-Path $PSScriptRoot 'certs'
$jsonPath = Join-Path $certDir 'selfsign.json'
$pfxPath = Join-Path $certDir 'shantuo-selfsign.pfx'
$cerPath = Join-Path $certDir 'shantuo-selfsign.cer'
$pwdPath = Join-Path $certDir 'selfsign-password.txt'

if ((Test-Path $jsonPath) -and -not $Force) {
  $meta = Get-Content $jsonPath -Raw | ConvertFrom-Json
  Write-Host "自签名证书已存在：$($meta.subject)"
  Write-Host "Thumbprint: $($meta.thumbprint)"
  Write-Host "PFX: $pfxPath"
  Write-Host "如需重新生成，加 -Force"
  exit 0
}

if ($Force) {
  $stores = @('My', 'Root', 'TrustedPublisher')
  $oldThumbs = @()
  if (Test-Path $jsonPath) {
    try { $oldThumbs += (Get-Content $jsonPath -Raw | ConvertFrom-Json).thumbprint } catch {}
  }
  foreach ($store in $stores) {
    try {
      $oldThumbs += Get-ChildItem "Cert:\CurrentUser\$store" -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -eq 'CN=Shantuo Self-Signed, O=Shantuo, C=CN' } |
        ForEach-Object { $_.Thumbprint }
    } catch {}
  }
  foreach ($thumb in ($oldThumbs | Select-Object -Unique)) {
    foreach ($store in $stores) {
      $path = "Cert:\CurrentUser\$store\$thumb"
      if (Test-Path $path) { Remove-Item $path -Force -ErrorAction SilentlyContinue }
    }
  }
  Remove-Item $pfxPath, $cerPath, $pwdPath, $jsonPath -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Path $certDir -Force | Out-Null
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $certDir /inheritance:r /grant:r "${currentUser}:(OI)(CI)F" | Out-Null

$bytes = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$passwordPlain = [Convert]::ToBase64String($bytes)
$password = ConvertTo-SecureString $passwordPlain -AsPlainText -Force

$subject = 'CN=Shantuo Self-Signed, O=Shantuo, C=CN'
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $subject `
  -FriendlyName 'Shantuo Self-Signed Code Signing' `
  -KeyUsage DigitalSignature `
  -KeySpec Signature `
  -KeyExportPolicy Exportable `
  -KeyLength 3072 `
  -HashAlgorithm SHA256 `
  -CertStoreLocation Cert:\CurrentUser\My `
  -NotAfter (Get-Date).AddYears(10)

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $password | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT | Out-Null
Set-Content -Path $pwdPath -Value $passwordPlain -Encoding ASCII -NoNewline
& icacls $pwdPath /inheritance:r /grant:r "${currentUser}:F" | Out-Null

$trustedRoot = $false
if (-not $NoTrust) {
  Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
  if ($TrustRoot) {
    Write-Host "即将写入当前用户的受信任根证书颁发机构。"
    Write-Host "Windows 会弹出「安全警告」，请点『是』；否则这一步会一直等待。"
    Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
    $trustedRoot = $true
  }
}

$meta = [ordered]@{
  subject = $cert.Subject
  thumbprint = $cert.Thumbprint
  notAfter = $cert.NotAfter.ToString('o')
  createdAt = (Get-Date).ToString('o')
  pfx = $pfxPath
  cer = $cerPath
  passwordFile = $pwdPath
  trustedRootOnThisMachine = $trustedRoot
  trustedPublisherOnThisMachine = (-not $NoTrust)
}
$meta | ConvertTo-Json | Set-Content -Path $jsonPath -Encoding UTF8

Write-Host ""
Write-Host "自签名证书已生成："
Write-Host "  Subject   : $($cert.Subject)"
Write-Host "  Thumbprint: $($cert.Thumbprint)"
Write-Host "  NotAfter  : $($cert.NotAfter)"
Write-Host "  PFX       : $pfxPath"
Write-Host "  CER       : $cerPath"
Write-Host "  Password  : $pwdPath"
if ($trustedRoot) {
  Write-Host "  已加入当前用户受信任根（仅本机）"
} elseif (-not $NoTrust) {
  Write-Host "  已加入当前用户受信任发布者"
  Write-Host "  如需本机 signtool 校验通过，双击 CER → 安装证书 → 当前用户 → 受信任的根证书颁发机构"
  Write-Host "  或运行：npm run cert:trust   （会弹安全警告，需点『是』）"
} else {
  Write-Host "  未加入任何受信任存储"
}
Write-Host ""
Write-Host "打包时签名："
Write-Host "  SELFSIGN=1 npm run dist"
Write-Host "（Git Bash 写法；PowerShell 用 `$env:SELFSIGN='1'; npm run dist）"
