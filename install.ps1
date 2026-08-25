# 把本仓库安装成 DSH web profile 插件（Windows）
# 优先：dsh plugin --profile web add <本目录>
# 回退：复制 plugin/ 到 profile node_modules，并确保 bundle 出现在 package.json
$ErrorActionPreference = 'Stop'

function Find-DshHome {
	if ($env:DSH_HOME) {
		$full = [IO.Path]::GetFullPath($env:DSH_HOME)
		if (Test-Path (Join-Path $full 'profiles\web')) { return $full }
	}
	$candidates = @(
		(Join-Path $PSScriptRoot '..\..\.dsh-home'),
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
	throw '找不到 .dsh-home。请先启动过一次 DeepSeek Harness。'
}

function Get-TailscaleExe {
	$p = 'C:\Program Files\Tailscale\tailscale.exe'
	if (Test-Path $p) { return $p }
	$cmd = Get-Command tailscale -ErrorAction SilentlyContinue
	if ($cmd) { return $cmd.Source }
	return $null
}

$srcPlugin = if (Test-Path (Join-Path $PSScriptRoot 'plugin\lib\index.js')) {
	Join-Path $PSScriptRoot 'plugin'
} elseif (Test-Path (Join-Path $PSScriptRoot 'lib\index.js')) {
	$PSScriptRoot
} else {
	throw "插件源码不完整：$PSScriptRoot"
}

$dshHome = Find-DshHome
$profileDir = Join-Path $dshHome 'profiles\web'
Write-Host "DSH_HOME = $dshHome"

$added = $false
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($dsh) {
	try {
		& $dsh.Source plugin --profile web add $srcPlugin
		$added = $true
		Write-Host "dsh plugin add 完成"
	} catch {
		Write-Host "dsh plugin add 失败，改复制： $($_.Exception.Message)"
	}
}

if (-not $added) {
	$dst = Join-Path $profileDir 'node_modules\dsh-dispatch'
	New-Item -ItemType Directory -Force -Path (Join-Path $dst 'lib') | Out-Null
	Copy-Item (Join-Path $srcPlugin 'package.json') $dst -Force
	Copy-Item (Join-Path $srcPlugin 'lib\index.js') (Join-Path $dst 'lib') -Force
	Copy-Item (Join-Path $srcPlugin 'cordis.patch.yml') $dst -Force
	Write-Host "copied plugin -> $dst"

	$pkgPath = Join-Path $profileDir 'package.json'
	if (Test-Path $pkgPath) {
		$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
		if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
		$pkg.dependencies | Add-Member -NotePropertyName 'dsh-dispatch' -NotePropertyValue 'file:node_modules/dsh-dispatch' -Force
		if ($pkg.dsh.profile.bundles -is [System.Array]) {
			if ($pkg.dsh.profile.bundles -notcontains 'dsh-dispatch') {
				$pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) + 'dsh-dispatch'
			}
		}
		($pkg | ConvertTo-Json -Depth 8) | Set-Content $pkgPath -Encoding utf8
		Write-Host "profile package.json 已加入 dsh-dispatch bundle"
	}
}

$ts = Get-TailscaleExe
$publicBase = ''
$serveHint = ''
if ($ts) {
	try {
		& $ts serve --bg --https=443 http://127.0.0.1:3080 2>$null | Out-Null
		$st = & $ts status --json | ConvertFrom-Json
		$dns = $st.Self.DNSName
		if ($dns) { $publicBase = ('https://' + $dns.TrimEnd('.')) }
		$serveHint = "Tailscale Serve 已尝试开启 → $publicBase"
	} catch {
		$serveHint = 'Tailscale Serve 未成功。手动：tailscale serve --bg --https=443 http://127.0.0.1:3080'
	}
} else {
	$serveHint = '未检测到 Tailscale。PC 与手机都要装：https://tailscale.com/download'
}

$secrets = Join-Path $dshHome 'dsh-dispatch.json'
Write-Host ""
Write-Host "======== 安装完成 ========"
Write-Host $serveHint
Write-Host ""
Write-Host "1) 重启 DeepSeek Harness"
Write-Host "2) 密钥写在 $secrets （首次启动自动生成 token / 主题）"
Write-Host "3) 冒烟：http://127.0.0.1:3080/dispatch/health"
if ($publicBase) {
	Write-Host "4) 手机会话页：重启后打开 $secrets 看 token，再访问"
	Write-Host "     $publicBase/dispatch/chat?token=<token>"
}
Write-Host "不要把 $secrets 或 cordis.patch.yml 提交到 git。"
