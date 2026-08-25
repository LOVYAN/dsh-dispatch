# 把 plugin/ 同步到本机 DSH profile（不改 token / 主题）
# 用法：pwsh -File deploy.ps1   然后重启 DeepSeek Harness
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'plugin'

function Find-DshHome {
	$candidates = @(
		(Join-Path $PSScriptRoot '..\..\.dsh-home'),
		(Join-Path $env:USERPROFILE '.dsh-home')
	)
	foreach ($c in $candidates) {
		$full = [IO.Path]::GetFullPath($c)
		if (Test-Path (Join-Path $full 'profiles\web')) { return $full }
	}
	$probe = Get-ChildItem -Path $env:USERPROFILE -Filter '.dsh-home' -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue |
		Where-Object { Test-Path (Join-Path $_.FullName 'profiles\web') } |
		Select-Object -First 1
	if ($probe) { return $probe.FullName }
	throw '找不到 .dsh-home。请先启动过一次 DeepSeek Harness，或设置环境变量 DSH_HOME。'
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Find-DshHome }
$dst = Join-Path $dshHome 'profiles\web\node_modules\dsh-dispatch'
New-Item -ItemType Directory -Force -Path (Join-Path $dst 'lib') | Out-Null
Copy-Item (Join-Path $src 'package.json') $dst -Force
Copy-Item (Join-Path $src 'lib\index.js') (Join-Path $dst 'lib') -Force
Write-Host "deployed -> $dst"
