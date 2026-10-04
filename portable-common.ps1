# Shared portable packaging/install helpers. No host discovery, process control, or network calls.
Set-StrictMode -Version Latest

function Write-PortableJson {
    param([string]$Path, $Value)
    # Windows PowerShell 5.1's Set-Content -Encoding utf8 adds a BOM that JSON.parse rejects.
    $text = $Value | ConvertTo-Json -Depth 100
    [IO.File]::WriteAllText($Path, $text + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Resolve-DispatchHome {
    param([string]$DshHome)
    if (-not $DshHome) { $DshHome = $env:DSH_HOME }
    if (-not $DshHome) { throw 'Specify -DshHome or set DSH_HOME to the intended initialized rc2 home. No home is guessed.' }
    $resolved = [IO.Path]::GetFullPath($DshHome)
    if (-not (Test-Path -LiteralPath (Join-Path $resolved 'profiles/web/package.json') -PathType Leaf)) {
        throw "Selected DSH_HOME has no initialized web profile: $resolved. Refusing to select another home."
    }
    return $resolved
}

function Get-DispatchSource {
    param([string]$Root)
    foreach ($candidate in @((Join-Path $Root 'plugin'), $Root)) {
        if ((Test-Path -LiteralPath (Join-Path $candidate 'lib/index.js')) -and
            (Test-Path -LiteralPath (Join-Path $candidate 'package.json'))) { return $candidate }
    }
    throw "No runtime package found in $Root"
}

function Copy-AllowedTree {
    param([string]$Source, [string]$Destination)
    $blocked = @('node_modules', '.git', '.dsh-home', 'test', 'tests', 'testhomes', 'test-homes', 'config', 'configs', 'dist', 'vendor')
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing symbolic link in distributable source: $($item.FullName)" }
        if ($item.Name.StartsWith('.') -or $blocked -contains $item.Name -or $item.Name -match '(?i)(\.test\.|\.spec\.|testhome|^dsh-dispatch\.json$|^dsh-voice\.json$)') { continue }
        $target = Join-Path $Destination $item.Name
        if ($item.PSIsContainer) { Copy-AllowedTree $item.FullName $target }
        else { Copy-Item -LiteralPath $item.FullName -Destination $target -Force }
    }
}

function Assert-PlainDestination {
    param([string]$Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing linked destination: $current. Use the CLI install mode instead of copying into a package-manager link." }
        }
        $parent = Split-Path -Parent $current
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Copy-DispatchRuntime {
    param([string]$Source, [string]$Destination)
    Assert-PlainDestination $Destination
    foreach ($required in @('package.json', 'cordis.patch.yml', 'lib/index.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Source $required) -PathType Leaf)) { throw "Missing runtime file: $required" }
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Copy-AllowedTree (Join-Path $Source 'lib') (Join-Path $Destination 'lib')
    # Runtime metadata only: development lifecycle hooks must not execute during portable install.
    $manifest = Get-Content -LiteralPath (Join-Path $Source 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($field in @('devDependencies', 'scripts')) { $manifest.PSObject.Properties.Remove($field) }
    Write-PortableJson (Join-Path $Destination 'package.json') $manifest
    Copy-Item -LiteralPath (Join-Path $Source 'cordis.patch.yml') -Destination $Destination -Force
    foreach ($name in @('README.md', 'LICENSE')) {
        if (Test-Path -LiteralPath (Join-Path $Source $name) -PathType Leaf) { Copy-Item -LiteralPath (Join-Path $Source $name) -Destination $Destination -Force }
    }
}

function Register-CopiedDispatch {
    param([string]$Profile)
    $path = Join-Path $Profile 'package.json'
    $pkg = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $pkg.PSObject.Properties['dependencies']) { $pkg | Add-Member dependencies ([pscustomobject]@{}) }
    $pkg.dependencies | Add-Member 'dsh-dispatch' 'file:node_modules/dsh-dispatch' -Force
    if (-not $pkg.PSObject.Properties['dsh']) { $pkg | Add-Member dsh ([pscustomobject]@{}) }
    if (-not $pkg.dsh.PSObject.Properties['profile']) { $pkg.dsh | Add-Member profile ([pscustomobject]@{}) }
    if (-not $pkg.dsh.profile.PSObject.Properties['bundles']) { $pkg.dsh.profile | Add-Member bundles @() }
    $pkg.dsh.profile.bundles = @(@($pkg.dsh.profile.bundles) + 'dsh-dispatch' | Select-Object -Unique)
    Write-PortableJson $path $pkg
}

function Copy-VoiceRuntime {
    param([string]$Source, [string]$Destination)
    Assert-PlainDestination $Destination
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    foreach ($dir in @('src', 'public')) { Copy-AllowedTree (Join-Path $Source $dir) (Join-Path $Destination $dir) }
    foreach ($name in @('package.json', 'package-lock.json', 'README.md', 'dsh-voice.example.json')) {
        if (Test-Path -LiteralPath (Join-Path $Source $name) -PathType Leaf) { Copy-Item -LiteralPath (Join-Path $Source $name) -Destination $Destination -Force }
    }
}
