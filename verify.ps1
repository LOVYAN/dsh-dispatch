# Read-only HTTP smoke checks. No task submission, model calls or restart.
param(
    [string]$DshHome = '',
    [string]$BaseUrl = 'http://127.0.0.1:3080',
    [string]$VoiceBaseUrl = 'http://127.0.0.1:3091',
    [switch]$CheckVoice,
    [switch]$HealthOnly,
    [switch]$DispatchTest
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'portable-common.ps1')
try {
    if ($DispatchTest) { throw '-DispatchTest is intentionally disabled: verification must not submit tasks or spend model credits.' }
    $selectedHome = Resolve-DispatchHome $DshHome
    $base = $BaseUrl.TrimEnd('/')
    $uri = [uri]$base
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http', 'https')) { throw 'BaseUrl must be an absolute HTTP(S) URL.' }
    $response = Invoke-WebRequest "$base/dispatch/health" -UseBasicParsing -TimeoutSec 10
    if ([int]$response.StatusCode -ne 200) { throw 'Dispatch health did not return HTTP 200.' }
    Write-Host 'PASS dispatch health'
    if (-not $HealthOnly) {
        # rc2 dispatch persists generated credentials at the selected home, not arbitrary YAML.
        $configPath = Join-Path $selectedHome 'dsh-dispatch.json'
        if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'Selected home has no dsh-dispatch.json; use -HealthOnly explicitly to skip authentication checks.' }
        $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $config.PSObject.Properties['token'] -or -not $config.token) { throw 'Selected home dispatch config has no token.' }
        $response = Invoke-WebRequest "$base/dispatch/status" -Headers @{ Authorization = "Bearer $($config.token)" } -UseBasicParsing -TimeoutSec 10
        if ([int]$response.StatusCode -ne 200) { throw 'Authenticated status did not return HTTP 200.' }
        Write-Host 'PASS authenticated status'
        $badStatus = 0
        try {
            $response = Invoke-WebRequest "$base/dispatch/status" -Headers @{ Authorization = "Bearer invalid-$([guid]::NewGuid().ToString('n'))" } -UseBasicParsing -TimeoutSec 10
            $badStatus = [int]$response.StatusCode
        } catch {
            if ($_.Exception.Response) { $badStatus = [int]$_.Exception.Response.StatusCode }
            else { throw 'Bad-token check had a transport failure, not an authorization rejection.' }
        }
        if ($badStatus -notin @(401, 403)) { throw "Bad-token request returned HTTP $badStatus; expected 401 or 403." }
        Write-Host 'PASS invalid token rejected'
    } else { Write-Host 'Authentication checks explicitly skipped (-HealthOnly).' }
    if ($CheckVoice) {
        $response = Invoke-WebRequest "$($VoiceBaseUrl.TrimEnd('/'))/health" -UseBasicParsing -TimeoutSec 10
        if ([int]$response.StatusCode -ne 200) { throw 'Independent voice health did not return HTTP 200.' }
        Write-Host 'PASS independent voice health'
    }
    exit 0
} catch {
    # Do not print HTTP response bodies or credentials.
    Write-Error "Verification failed: $($_.Exception.Message)"
    exit 1
}
