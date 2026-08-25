# dsh-dispatch 一键安装（Windows / 已装 DeepSeek Harness）
# 用法：在任意目录：pwsh -File install.ps1
# 会：复制插件 → 写入 cordis.patch.yml（缺项才插，不覆盖其它 patch）
#     → 尝试开启 Tailscale Serve → 打印手机端三件事
$ErrorActionPreference = 'Stop'

function Find-DshHome {
	$here = $PSScriptRoot
	$candidates = @(
		(Join-Path $here '..\..\.dsh-home'),
		(Join-Path $env:USERPROFILE '.dsh-home'),
		(Join-Path $env:USERPROFILE 'DeepSeek Harness\.dsh-home')
	)
	foreach ($c in $candidates) {
		$full = [IO.Path]::GetFullPath($c)
		if (Test-Path (Join-Path $full 'profiles\web')) { return $full }
	}
	$probe = Get-ChildItem -Path $env:USERPROFILE -Filter '.dsh-home' -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue |
		Where-Object { Test-Path (Join-Path $_.FullName 'profiles\web') } |
		Select-Object -First 1
	if ($probe) { return $probe.FullName }
	throw '找不到 .dsh-home（DeepSeek Harness 配置目录）。请先在本机启动过一次 DSH。'
}

function New-SecretHex([int]$bytes = 16) {
	$buf = New-Object byte[] $bytes
	[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
	return ([BitConverter]::ToString($buf) -replace '-', '').ToLowerInvariant()
}

function Get-TailscaleExe {
	$p = 'C:\Program Files\Tailscale\tailscale.exe'
	if (Test-Path $p) { return $p }
	$cmd = Get-Command tailscale -ErrorAction SilentlyContinue
	if ($cmd) { return $cmd.Source }
	return $null
}

$srcPlugin = Join-Path $PSScriptRoot 'plugin'
if (-not (Test-Path (Join-Path $srcPlugin 'lib\index.js'))) {
	throw "插件源码不完整：$srcPlugin"
}

$dshHome = Find-DshHome
$profileDir = Join-Path $dshHome 'profiles\web'
$dst = Join-Path $profileDir 'node_modules\dsh-dispatch'
$patch = Join-Path $profileDir 'cordis.patch.yml'

Write-Host "DSH_HOME = $dshHome"
New-Item -ItemType Directory -Force -Path (Join-Path $dst 'lib') | Out-Null
Copy-Item (Join-Path $srcPlugin 'package.json') $dst -Force
Copy-Item (Join-Path $srcPlugin 'lib\index.js') (Join-Path $dst 'lib') -Force
Write-Host "plugin  -> $dst"

$token = $null
$topic = $null
$publicBase = ''
if (Test-Path $patch) {
	$existing = Get-Content $patch -Raw -Encoding UTF8
	if ($existing -match '(?m)^\s+token:\s+(\S+)') { $token = $Matches[1].Trim("'`"") }
	if ($existing -match '(?m)^\s+ntfyTopic:\s+(\S+)') { $topic = $Matches[1].Trim("'`"") }
	if ($existing -match '(?m)^\s+publicBaseUrl:\s+(\S+)') { $publicBase = $Matches[1].Trim("'`"") }
}
if (-not $token) { $token = New-SecretHex 16 }
if (-not $topic) { $topic = 'dsh-dispatch-' + (New-SecretHex 8) }

$ts = Get-TailscaleExe
$serveHint = ''
if ($ts) {
	try {
		& $ts serve --bg --https=443 http://127.0.0.1:3080 2>$null | Out-Null
		$st = & $ts status --json | ConvertFrom-Json
		$dns = $st.Self.DNSName
		if ($dns) { $publicBase = ('https://' + $dns.TrimEnd('.')) }
		$serveHint = "Tailscale Serve 已尝试开启 → $publicBase"
	} catch {
		$serveHint = "Tailscale Serve 未成功（可稍后手动：tailscale serve --bg --https=443 http://127.0.0.1:3080）"
	}
} else {
	$serveHint = '未检测到 Tailscale。PC 与手机都要装：https://tailscale.com/download'
}

$block = @"
# dsh-dispatch：手机派单 + 锁屏审批 + 手机会话页
- insert:
    - id: dsh-dispatch
      name: dsh-dispatch
      config:
        token: $token
        publicBaseUrl: $publicBase
        ntfyServerUrl: http://ntfy.sh
        ntfyTopic: $topic
        pushEnabled: true
"@

if (Test-Path $patch) {
	$raw = Get-Content $patch -Raw -Encoding UTF8
	if ($raw -notmatch '(?m)id:\s*dsh-dispatch') {
		if ($raw -notmatch '\n$') { $raw += "`n" }
		Set-Content -Path $patch -Value ($raw + "`n" + $block) -Encoding utf8
		Write-Host "cordis.patch.yml 已追加 dsh-dispatch"
	} else {
		Write-Host "cordis.patch.yml 已有 dsh-dispatch 段，保留现有 token/topic（只同步了插件代码）"
	}
} else {
	Set-Content -Path $patch -Value $block -Encoding utf8
	Write-Host "已新建 cordis.patch.yml"
}

$chatUrl = if ($publicBase) { "$publicBase/dispatch/chat?token=$token" } else { "http://127.0.0.1:3080/dispatch/chat?token=$token" }

Write-Host ""
Write-Host "======== 安装完成 ========"
Write-Host $serveHint
Write-Host ""
Write-Host "1) 重启 DeepSeek Harness（停止 → 启动）"
Write-Host "2) 手机只需要装 Tailscale（同一账号）+ 系统浏览器："
Write-Host "     https://tailscale.com/download/android"
Write-Host "3) 电池无限制 + 自启动后，打开会话页即可看回复 / 续聊 / 点批准："
Write-Host "     $chatUrl"
Write-Host "4) （可选）锁屏推送再装 ntfy，订阅主题："
Write-Host "     $topic"
Write-Host "   服务器 https://ntfy.sh ，打开「即时传递」。不装也能从会话页批权限。"
Write-Host "冒烟：重启后访问 http://127.0.0.1:3080/dispatch/health 应返回 {ok:true}"
