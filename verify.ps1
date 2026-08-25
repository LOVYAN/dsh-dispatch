# 重启后冒烟。token 从本机 cordis.patch.yml 读取，不写死。
# 用法：pwsh -File verify.ps1 [-DispatchTest]
param([switch]$DispatchTest)
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:3080'

function Find-Patch {
	$candidates = @(
		(Join-Path $PSScriptRoot '..\..\.dsh-home\profiles\web\cordis.patch.yml'),
		(Join-Path $env:USERPROFILE '.dsh-home\profiles\web\cordis.patch.yml')
	)
	if ($env:DSH_HOME) {
		$candidates = @((Join-Path $env:DSH_HOME 'profiles\web\cordis.patch.yml')) + $candidates
	}
	foreach ($c in $candidates) {
		$full = [IO.Path]::GetFullPath($c)
		if (Test-Path $full) { return $full }
	}
	return $null
}

$patch = Find-Patch
$token = $null
$publicBase = $null
if ($patch) {
	$raw = Get-Content $patch -Raw -Encoding UTF8
	if ($raw -match '(?m)^\s+token:\s+(\S+)') { $token = $Matches[1].Trim("'`"") }
	if ($raw -match '(?m)^\s+publicBaseUrl:\s+(\S+)') { $publicBase = $Matches[1].Trim("'`"") }
}
if (-not $token) {
	Write-Host 'WARN: 读不到 token，status 检查会跳过。把 DSH_HOME 指到配置目录，或先跑 install.ps1。'
}

Write-Host '== 1. health =='
try { (Invoke-WebRequest "$base/dispatch/health" -UseBasicParsing -TimeoutSec 5).Content } catch { Write-Host "FAIL: $($_.Exception.Message)"; exit 1 }

if ($token) {
	Write-Host "`n== 2. status (auth) =="
	try { (Invoke-WebRequest "$base/dispatch/status?token=$token" -UseBasicParsing -TimeoutSec 5).Content } catch { Write-Host "FAIL: $($_.Exception.Message)" }

	Write-Host "`n== 3. bad token rejected =="
	try { (Invoke-WebRequest "$base/dispatch/status?token=wrong" -UseBasicParsing -TimeoutSec 5).Content; Write-Host 'UNEXPECTED: bad token accepted!' } catch { Write-Host "OK rejected: $($_.Exception.Response.StatusCode.value__)" }
}

if ($DispatchTest -and $token) {
	Write-Host "`n== 4. task dispatch =="
	$body = @{ text = '[verify.ps1] 派单链路检查：只回复「收到」。' } | ConvertTo-Json
	try { (Invoke-WebRequest "$base/dispatch/task?token=$token" -Method POST -ContentType 'application/json; charset=utf-8' -Body $body -UseBasicParsing -TimeoutSec 60).Content } catch { Write-Host "FAIL: $($_.Exception.Message)" }
}

if ($publicBase) {
	Write-Host "`n== 5. publicBaseUrl health =="
	try { (Invoke-WebRequest "$publicBase/dispatch/health" -UseBasicParsing -TimeoutSec 8).Content } catch { Write-Host "serve 未就绪: $($_.Exception.Message)" }
}
