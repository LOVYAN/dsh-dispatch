# ntfy 一键部署：解压 zip → 写配置 → 注册计划任务 → 启动 → 测试发布
# 前置：ntfy_*_windows_x86_64.zip 已放入 $Root
$ErrorActionPreference = 'Stop'
$Root = Join-Path $PSScriptRoot 'ntfy'
$Bin  = Join-Path $Root 'bin'
$Zip  = Get-ChildItem $Root -Filter 'ntfy_*_windows_*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $Zip) { Write-Host "未找到 zip，请先下载到 $Root"; exit 1 }

if (-not (Test-Path (Join-Path $Bin 'ntfy.exe'))) {
  New-Item -ItemType Directory -Force -Path $Bin | Out-Null
  Expand-Archive -Path $Zip.FullName -DestinationPath $Root\extract -Force
  $exe = Get-ChildItem $Root\extract -Recurse -Filter 'ntfy.exe' | Select-Object -First 1
  Copy-Item $exe.FullName "$Bin\ntfy.exe" -Force
}
$ntfy = Join-Path $Bin 'ntfy.exe'
Write-Host "ntfy: $(& $ntfy version 2>&1 | Select-Object -First 1)"

$yml = @"
base-url: "http://127.0.0.1:2586"
listen-http: "127.0.0.1:2586"
cache-file: "$($Root.Replace('\','\\'))\\cache.db"
cache-duration: "24h"
attachment-cache-dir: "$($Root.Replace('\','\\'))\\attachments"
"@
Set-Content (Join-Path $Root 'ntfy.yml') $yml -Encoding UTF8

# 计划任务：开机自启 + 立即启动（已存在则覆盖）
$action  = New-ScheduledTaskAction -Execute $ntfy -Argument "serve --config `"$Root\ntfy.yml`"" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'dsh-dispatch-ntfy' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'dsh-dispatch-ntfy'
Start-Sleep -Seconds 3

Write-Host "== health =="
try { (Invoke-WebRequest 'http://127.0.0.1:2586/v1/health' -UseBasicParsing -TimeoutSec 5).Content } catch { Write-Host "启动失败：$($_.Exception.Message)"; Get-ScheduledTaskInfo dsh-dispatch-ntfy | Out-String; exit 1 }

Write-Host "== 测试发布（手机订阅后应收到）=="
Invoke-WebRequest -Uri 'http://127.0.0.1:2586/dsh-dispatch' -Method POST -Body 'ntfy 部署成功 ✅ — 来自 setup-ntfy.ps1' -UseBasicParsing | Out-Null
Write-Host '完成。下一步：把 cordis.patch.yml 的 pushEnabled 改为 true 并重启 DSH。'
