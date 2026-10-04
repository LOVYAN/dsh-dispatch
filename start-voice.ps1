param([switch]$InstallDependencies,[string]$DshHome=$env:DSH_HOME)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'portable-common.ps1')
$selectedHome=Resolve-DispatchHome $DshHome
$serviceDir=Join-Path $selectedHome 'services/dsh-voice-gateway'
if(!(Test-Path -LiteralPath (Join-Path $serviceDir 'src/server.js'))){throw 'Voice gateway is not installed. Run install.ps1 first.'}
if(Get-NetTCPConnection -LocalPort 3091 -State Listen -ErrorAction SilentlyContinue){throw 'Port 3091 is occupied. Verify ownership with your service manager; no process will be stopped.'}
if($InstallDependencies -or !(Test-Path -LiteralPath (Join-Path $serviceDir 'node_modules/ws'))){
 & npm ci --omit=dev --ignore-scripts --prefix $serviceDir
 if($LASTEXITCODE -ne 0){throw 'Voice dependency installation failed'}
}
$logDir=Join-Path $selectedHome 'logs'
New-Item -ItemType Directory -Force -Path $logDir|Out-Null
$outLog=Join-Path $logDir 'dsh-voice.out.log'
$errLog=Join-Path $logDir 'dsh-voice.err.log'
$node=(Get-Command node -ErrorAction Stop).Source
$previousHome=$env:DSH_HOME
try{
 $env:DSH_HOME=$selectedHome
 $proc=Start-Process -FilePath $node -ArgumentList 'src/server.js' -WorkingDirectory $serviceDir -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
}finally{$env:DSH_HOME=$previousHome}
$deadline=[datetime]::UtcNow.AddSeconds(15)
do{
 $proc.Refresh()
 if($proc.HasExited){throw 'New voice process exited. Inspect private logs in the selected home.'}
 $owners=@(Get-NetTCPConnection -LocalPort 3091 -State Listen -ErrorAction SilentlyContinue)
 if($owners.Count){
  if(@($owners|Where-Object OwningProcess -ne $proc.Id).Count){throw 'Unexpected listener owner; refusing to report startup success.'}
  try{$health=Invoke-RestMethod 'http://127.0.0.1:3091/health' -TimeoutSec 2;if($health.ok -eq $true){Write-Host ('Independent voice gateway healthy, PID '+$proc.Id);exit 0}}catch{}
 }
 Start-Sleep -Milliseconds 250
}while([datetime]::UtcNow -lt $deadline)
throw 'Voice health not confirmed. Inspect selected-home logs; no existing process was stopped.'
