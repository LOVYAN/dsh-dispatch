# Portable redeployment uses the same complete, sanitized runtime package as install.
# Restart is deliberately host-owned; there is no portable way to know the service manager.
param(
    [string]$DshHome = '',
    [switch]$CopyOnly,
    [switch]$SkipVoice,
    [switch]$SkipDependencyInstall
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install.ps1') -DshHome $DshHome -CopyOnly:$CopyOnly -SkipVoice:$SkipVoice -SkipDependencyInstall:$SkipDependencyInstall
Write-Host 'Deployment copied/registered files; it did NOT restart services or claim live activation.'
Write-Host 'Ask the host owner to restart their existing Web service and separate voice service, then run verify.ps1 with the same explicit DSH_HOME.'
