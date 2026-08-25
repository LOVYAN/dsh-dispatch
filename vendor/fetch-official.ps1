# 从官方源拉取 / 打开 Tailscale、ntfy 安装入口。安装包不进 git。
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$dl = Join-Path $here 'downloads'
New-Item -ItemType Directory -Force -Path $dl | Out-Null

Write-Host '== Tailscale Windows (official MSI) =='
$msi = Join-Path $dl 'tailscale-setup-latest-amd64.msi'
$msiUrl = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi'
try {
	Write-Host "GET $msiUrl"
	Invoke-WebRequest -Uri $msiUrl -OutFile $msi -UseBasicParsing
	Write-Host "saved $msi"
	Write-Host '安装：右键该 MSI 或 msiexec /i 该文件。装完用同一账号登录 PC 与手机。'
} catch {
	Write-Host "下载失败：$($_.Exception.Message)"
	Write-Host '请浏览器打开 https://tailscale.com/download/windows'
	Start-Process 'https://tailscale.com/download/windows'
}

Write-Host ''
Write-Host '== Tailscale Android =='
Write-Host '不能代下 APK。请在手机打开：'
Write-Host '  Play: https://play.google.com/store/apps/details?id=com.tailscale.ipn'
Write-Host '  或 https://pkgs.tailscale.com/stable/#android'
Start-Process 'https://tailscale.com/download/android'

Write-Host ''
Write-Host '== ntfy Android（可选，锁屏推送才需要）=='
Write-Host '  https://ntfy.sh   Play / F-Droid / GitHub Releases'
Start-Process 'https://ntfy.sh'

Write-Host ''
Write-Host '== ntfy Windows 服务端（默认不需要，走 ntfy.sh）=='
Write-Host '若要自建：https://github.com/binwiederhier/ntfy/releases'
Write-Host '下载 windows_x86_64 zip 放到仓库 ntfy/ 后跑 setup-ntfy.ps1'

Write-Host ''
Write-Host "下载目录：$dl"
Write-Host '这些文件已 gitignore，不要 git add。'
