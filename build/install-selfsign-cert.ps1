# 在测试机/客户机导入自签名公钥证书
#
# 默认只装进「当前用户」的受信任发布者；加 -TrustRoot 才会装进受信任根。
# Windows 对写入根证书会弹一次安全警告，需要人工点『是』，不会静默完成。
# 这只是让 Windows 认识这个发布者，不代表 SmartScreen 一定放行。
#
#   npm run cert:trust
#   powershell ... -File build/install-selfsign-cert.ps1 -CerPath D:\shantuo-selfsign.cer
#   powershell ... -File build/install-selfsign-cert.ps1 -Remove

param(
  [string]$CerPath = (Join-Path $PSScriptRoot 'certs\shantuo-selfsign.cer'),
  [switch]$Remove,
  [switch]$TrustRoot
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $CerPath)) {
  throw "找不到证书文件：$CerPath"
}

$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CerPath)
Write-Host "证书：$($cert.Subject)"
Write-Host "指纹：$($cert.Thumbprint)"

if ($Remove) {
  foreach ($store in @('Root', 'TrustedPublisher')) {
    $path = "Cert:\CurrentUser\$store\$($cert.Thumbprint)"
    if (Test-Path $path) {
      Remove-Item $path -Force
      Write-Host "已从 CurrentUser\$store 移除"
    }
  }
  Write-Host "已取消信任。"
  exit 0
}

Import-Certificate -FilePath $CerPath -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
Write-Host "已导入当前用户受信任发布者。"

if ($TrustRoot) {
  Write-Host "即将写入受信任根；Windows 会弹出「安全警告」，请点『是』。"
  Import-Certificate -FilePath $CerPath -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
  Write-Host "已导入当前用户受信任根。"
} else {
  Write-Host "未导入受信任根；如需本机 signtool 校验通过，重新运行并加 -TrustRoot。"
}
Write-Host "注意：这只影响当前 Windows 用户；SmartScreen 仍可能根据下载信誉提示。"
