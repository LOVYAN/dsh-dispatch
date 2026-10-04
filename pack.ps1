# Build an allowlisted portable source/runtime zip, never a machine/home backup.
param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'portable-common.ps1')
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot 'dist' }
$out = [IO.Path]::GetFullPath($OutputDirectory)
Assert-PlainDestination $out
New-Item -ItemType Directory -Force -Path $out | Out-Null
$zip = Join-Path $out ("dsh-dispatch-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
$stage = Join-Path ([IO.Path]::GetTempPath()) ('dsh-dispatch-pack-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $source = Get-DispatchSource $PSScriptRoot
    Copy-DispatchRuntime $source (Join-Path $stage 'plugin')
    Copy-DispatchRuntime $source $stage
    foreach ($name in @('install.ps1', 'deploy.ps1', 'verify.ps1', 'pack.ps1', 'portable-common.ps1', 'setup-ntfy.ps1', 'start-voice.ps1', 'README.md', 'LICENSE', 'CONTRIBUTING.md', '.gitignore')) {
        $path = Join-Path $PSScriptRoot $name
        if (Test-Path -LiteralPath $path -PathType Leaf) { Copy-Item -LiteralPath $path -Destination $stage -Force }
    }
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'docs')) { Copy-AllowedTree (Join-Path $PSScriptRoot 'docs') (Join-Path $stage 'docs') }
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'voice-gateway/src/server.js')) {
        Copy-VoiceRuntime (Join-Path $PSScriptRoot 'voice-gateway') (Join-Path $stage 'voice-gateway')
    }
    # No vendor tree: existing platform binaries are never redistributed.
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
    Write-Host "packed -> $zip"
} finally {
    # Deletion is limited to the exact unique staging directory allocated above.
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    if ((Split-Path -Parent $resolvedStage).TrimEnd([IO.Path]::DirectorySeparatorChar) -ne ([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) -or (Split-Path -Leaf $resolvedStage) -notmatch '^dsh-dispatch-pack-[0-9a-f]{32}$') { throw "Unexpected staging cleanup target: $resolvedStage" }
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
}
