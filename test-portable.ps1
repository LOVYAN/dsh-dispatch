# Offline regression fixtures only: no live DSH CLI, home, HTTP, model, or service access.
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('dsh-dispatch-fixture-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$oldHome = $env:DSH_HOME
try {
    $repo = Join-Path $fixture 'repo'
    $homePath = Join-Path $fixture 'home'
    New-Item -ItemType Directory -Force -Path "$repo/plugin/lib/dispatch-adapter", "$repo/plugin/lib/history-adapter", "$repo/plugin/lib/tests", "$repo/plugin/lib/node_modules/private", "$repo/plugin/config", "$repo/plugin/testhomes", "$homePath/profiles/web", "$repo/voice-gateway/src", "$repo/voice-gateway/public", "$repo/voice-gateway/node_modules/ws", "$repo/vendor" | Out-Null
    foreach ($name in @('install.ps1', 'deploy.ps1', 'pack.ps1', 'verify.ps1', 'portable-common.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $repo }
    '{"name":"dsh-dispatch","type":"module","devDependencies":{"do-not-install":"*"},"scripts":{"prepare":"exit 99"}}' | Set-Content "$repo/plugin/package.json"
    '[]' | Set-Content "$repo/plugin/cordis.patch.yml"
    foreach ($name in @('index.js', 'task-identity.js', 'turn-result.js', 'dispatch-adapter/index.js', 'history-adapter/index.js', 'tests/private.js', 'node_modules/private/index.js')) { 'export {};' | Set-Content (Join-Path "$repo/plugin/lib" $name) }
    'secret' | Set-Content "$repo/plugin/config/private.json"
    'secret' | Set-Content "$repo/plugin/testhomes/private.json"
    'binary' | Set-Content "$repo/vendor/not-for-redistribution.exe"
    '{"private":true}' | Set-Content "$repo/voice-gateway/package.json"
    '{}' | Set-Content "$repo/voice-gateway/dsh-voice.example.json"
    'export {};' | Set-Content "$repo/voice-gateway/src/server.js"
    '<html></html>' | Set-Content "$repo/voice-gateway/public/index.html"
    '{"name":"fixture","custom":{"preserve":true}}' | Set-Content "$homePath/profiles/web/package.json"
    '{"token":"dummy"}' | Set-Content "$homePath/dsh-dispatch.json"
    '{"apiKey":"dummy"}' | Set-Content "$homePath/dsh-voice.json"
    $env:DSH_HOME = $homePath
    & "$repo/install.ps1" -CopyOnly -SkipVoice
    $installed = "$homePath/profiles/web/node_modules/dsh-dispatch"
    foreach ($name in @('lib/index.js', 'lib/task-identity.js', 'lib/turn-result.js', 'lib/dispatch-adapter/index.js', 'lib/history-adapter/index.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $installed $name))) { throw "Missing complete runtime: $name" }
    }
    foreach ($name in @('lib/tests', 'lib/node_modules', 'config', 'testhomes')) {
        if (Test-Path -LiteralPath (Join-Path $installed $name)) { throw "Forbidden content copied: $name" }
    }
    $manifest = Get-Content "$installed/package.json" -Raw | ConvertFrom-Json
    if ($manifest.PSObject.Properties['scripts'] -or $manifest.PSObject.Properties['devDependencies']) { throw 'Unsafe installation metadata retained' }
    $profile = Get-Content "$homePath/profiles/web/package.json" -Raw | ConvertFrom-Json
    if (-not $profile.custom.preserve -or $profile.dsh.profile.bundles -notcontains 'dsh-dispatch') { throw 'Profile merge failed' }
    & "$repo/deploy.ps1" -DshHome $homePath -CopyOnly -SkipDependencyInstall
    if ((Get-Content "$homePath/dsh-voice.json" -Raw | ConvertFrom-Json).apiKey -ne 'dummy') { throw 'Existing voice configuration changed' }
    if ((Get-Content "$homePath/dsh-dispatch.json" -Raw | ConvertFrom-Json).token -ne 'dummy') { throw 'Existing dispatch token changed' }
    $env:DSH_HOME = Join-Path $fixture 'missing-explicit-home'
    $rejected = $false
    try { & "$repo/install.ps1" -CopyOnly -SkipVoice } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid explicit DSH_HOME was not rejected' }
    & "$repo/pack.ps1" -OutputDirectory (Join-Path $fixture 'out')
    $archive = Get-ChildItem "$fixture/out/*.zip" | Select-Object -First 1
    $expanded = Join-Path $fixture 'expanded'
    Expand-Archive -LiteralPath $archive.FullName -DestinationPath $expanded
    foreach ($name in @('plugin/lib/dispatch-adapter/index.js', 'lib/history-adapter/index.js', 'portable-common.ps1', 'voice-gateway/src/server.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $expanded $name))) { throw "Missing archive runtime: $name" }
    }
    foreach ($name in @('vendor', 'plugin/lib/tests', 'plugin/lib/node_modules', 'voice-gateway/node_modules')) {
        if (Test-Path -LiteralPath (Join-Path $expanded $name)) { throw "Forbidden archive content: $name" }
    }
    Write-Host 'PASS offline fixture install, repeat deploy, preservation, explicit-home rejection, and archive allowlist'
} finally {
    $env:DSH_HOME = $oldHome
    $resolved = [IO.Path]::GetFullPath($fixture)
    if ((Split-Path -Parent $resolved).TrimEnd([IO.Path]::DirectorySeparatorChar) -ne ([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) -or (Split-Path -Leaf $resolved) -notmatch '^dsh-dispatch-fixture-[0-9a-f]{32}$') { throw "Unexpected fixture cleanup target: $resolved" }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
