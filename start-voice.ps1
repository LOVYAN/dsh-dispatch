param(
	[switch]$InstallDependencies
)
$ErrorActionPreference = 'Stop'

function Find-DshHome {
	if ($env:DSH_HOME) { return [IO.Path]::GetFullPath($env:DSH_HOME) }
	$candidates = @(
		(Join-Path $PSScriptRoot '..\..\.dsh-home'),
		(Join-Path $env:USERPROFILE '.dsh-home')
	)
	foreach ($candidate in $candidates) {
		$full = [IO.Path]::GetFullPath($candidate)
		if (Test-Path $full) { return $full }
	}
	throw '找不到 DSH_HOME。请先启动 DeepSeek Harness，或设置环境变量 DSH_HOME。'
}

$dshHome = Find-DshHome
$serviceDir = Join-Path $dshHome 'services\dsh-voice-gateway'
if (!(Test-Path (Join-Path $serviceDir 'src\server.js'))) {
	throw "语音网关尚未安装：$serviceDir。请先运行 install.ps1。"
}
if ($InstallDependencies -or !(Test-Path (Join-Path $serviceDir 'node_modules\ws'))) {
	& npm install --omit=dev --prefix $serviceDir
	if ($LASTEXITCODE -ne 0) { throw "npm install 失败：$LASTEXITCODE" }
}
$env:DSH_HOME = $dshHome
$logDir = Join-Path $dshHome 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$outLog = Join-Path $logDir 'dsh-voice.out.log'
$errLog = Join-Path $logDir 'dsh-voice.err.log'
$existing = Get-NetTCPConnection -LocalPort 3091 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
	Write-Host "3091 已在监听，PID $($existing.OwningProcess)。如需重启，请先停止该进程。"
	exit 0
}
$node = (Get-Command node -ErrorAction Stop).Source
$proc = Start-Process -FilePath $node -ArgumentList 'src/server.js' -WorkingDirectory $serviceDir -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 800
try {
	$health = Invoke-RestMethod 'http://127.0.0.1:3091/health' -TimeoutSec 5
	Write-Host "语音网关已启动，PID $($proc.Id)，health ok=$($health.ok)，volcConfigured=$($health.volcConfigured)"
} catch {
	throw "语音网关启动后 health 失败。查看 $errLog"
}
