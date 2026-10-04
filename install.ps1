# Portable rc2 installer. Never discovers another home or restarts a host.
# CLI mode may download dependencies. -CopyOnly -SkipVoice is an offline runtime copy.
param(
    [string]$DshHome = '',
    [switch]$CopyOnly,
    [switch]$SkipVoice,
    [switch]$SkipDependencyInstall,
    [string]$VolcApiKey = '',
    [string]$VolcAppId = '',
    [string]$VolcResourceId = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'portable-common.ps1')
$selectedHome = Resolve-DispatchHome $DshHome
$profile = Join-Path $selectedHome 'profiles/web'
$source = Get-DispatchSource $PSScriptRoot
Write-Host "Selected DSH_HOME: $selectedHome"
if ($CopyOnly) {
    $destination = Join-Path $profile 'node_modules/dsh-dispatch'
    Copy-DispatchRuntime $source $destination
    Register-CopiedDispatch $profile
    Write-Host 'Offline copy registered. Host-provided runtime peers and rc2 compatibility must be verified before starting.'
} else {
    $dsh = Get-Command dsh -ErrorAction Stop
    # A stable sanitized source avoids installing checkout configs, tests or dev dependencies.
    $destination = Join-Path $selectedHome 'packages/dsh-dispatch'
    Copy-DispatchRuntime $source $destination
    $previousHome = $env:DSH_HOME
    try {
        $env:DSH_HOME = $selectedHome
        & $dsh.Source plugin --profile web add $destination
        if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed (exit $LASTEXITCODE). No copy fallback: inspect compatibility/package-manager diagnostics." }
    } finally { $env:DSH_HOME = $previousHome }
}
if (-not $SkipVoice) {
    $voiceSource = Join-Path $PSScriptRoot 'voice-gateway'
    if (-not (Test-Path -LiteralPath (Join-Path $voiceSource 'src/server.js'))) { throw 'Independent voice-gateway source missing; use -SkipVoice for plugin-only installation.' }
    $voiceDestination = Join-Path $selectedHome 'services/dsh-voice-gateway'
    Copy-VoiceRuntime $voiceSource $voiceDestination
    $voiceConfig = Join-Path $selectedHome 'dsh-voice.json'
    if (-not (Test-Path -LiteralPath $voiceConfig)) {
        $config = Get-Content -LiteralPath (Join-Path $voiceSource 'dsh-voice.example.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($pair in @(@('apiKey', $VolcApiKey), @('appId', $VolcAppId), @('resourceId', $VolcResourceId))) {
            if ($pair[1]) { $config | Add-Member -NotePropertyName $pair[0] -NotePropertyValue $pair[1] -Force }
        }
        Write-PortableJson $voiceConfig $config
    }
    if (-not $SkipDependencyInstall) {
        & npm ci --omit=dev --ignore-scripts --prefix $voiceDestination
        if ($LASTEXITCODE -ne 0) { throw "Independent voice dependency install failed (exit $LASTEXITCODE)." }
    }
    Write-Host "Independent voice files: $voiceDestination; existing voice configuration preserved."
}
Write-Host 'Installed files only. The host owner must restart the existing DSH Web and independent voice service using their own service manager.'
Write-Host 'No processes, Tailscale routes, vendor binaries, or production endpoints were managed by this script.'
Write-Host "After owner restart: pwsh -File `"$PSScriptRoot/verify.ps1`" -DshHome `"$selectedHome`""
