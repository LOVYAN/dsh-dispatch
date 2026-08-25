# 打一份可发给别人的 zip（不含你的 token / 主题 / ntfy 源码包）
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd'
$outDir = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$zip = Join-Path $outDir "dsh-dispatch-$stamp.zip"

$stage = Join-Path $env:TEMP ("dsh-dispatch-pack-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
try {
	Copy-Item (Join-Path $root 'plugin') (Join-Path $stage 'plugin') -Recurse
	foreach ($name in @('install.ps1','deploy.ps1','verify.ps1','setup-ntfy.ps1','pack.ps1','README.md','LICENSE','CONTRIBUTING.md','分发说明.md','.gitignore')) {
		$p = Join-Path $root $name
		if (Test-Path $p) { Copy-Item $p $stage }
	}
	Copy-Item (Join-Path $root 'docs') (Join-Path $stage 'docs') -Recurse
	if (Test-Path $zip) { Remove-Item $zip -Force }
	Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
	Write-Host "packed -> $zip"
} finally {
	Remove-Item $stage -Recurse -Force
}
