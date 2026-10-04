param([string]$Message='feat: support DSH rc2',[switch]$NoPush,[switch]$AuditOnly)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
# Audit Git candidates only; ignored runtime files must never be staged.
$paths=@(& git -C $root -c core.quotepath=false ls-files --cached --others --exclude-standard)
if($LASTEXITCODE -ne 0){throw 'Cannot list repository files'}
$patterns=@(
 '(?i)desktop-[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net',
 '(?i)[A-Z]:\\Users\\(?!<|YOUR|USER)[^\\\r\n"'']+',
 '\u9648\u6893\u5065',
 '(?i)session-[0-9a-f]{8}-[0-9a-f-]{20,}',
 '(?i)"(?:apiKey|accessToken|token)"\s*:\s*"(?!"|<|your)[^"\r\n]{8,}"',
 '(?i)X-Api-Key\s*[:=]\s*["''][A-Za-z0-9_\-]{16,}'
)
foreach($relative in $paths){
 if($relative -match '(^|/)(node_modules|\.dsh-home[^/]*|test-home|sessions|private-backups|restart-recovery)(/|$)' -or $relative -match '(?i)(^|/)(dsh-dispatch|dsh-voice|dsh-voice-foreman)\.json$|\.(log|wav|mp3|m4a|jsonl|zstd|sqlite|db)$'){throw ('Private/runtime file rejected: '+$relative)}
 $file=Join-Path $root $relative
 if(!(Test-Path -LiteralPath $file -PathType Leaf)){continue}
 if([IO.Path]::GetExtension($file) -notin @('.js','.mjs','.cjs','.json','.md','.txt','.ps1','.cmd','.yml','.yaml','.html','.css')){continue}
 $content=Get-Content -LiteralPath $file -Raw -Encoding UTF8
 foreach($pattern in $patterns){if($content -match $pattern){throw ('Sensitive-data audit failed: '+$relative)}}
}
& git -C $root status --short
if($AuditOnly){Write-Host 'Audit passed. No staging, commit or push performed.';exit 0}
& git -C $root add --all
if($LASTEXITCODE -ne 0){throw 'Staging failed'}
$staged=@(& git -C $root diff --cached --name-only)
if(!$staged.Count){Write-Host 'No changes to commit.';exit 0}
& git -C $root commit -m $Message
if($LASTEXITCODE -ne 0){throw 'Commit failed'}
if(!$NoPush){$branch=(& git -C $root branch --show-current).Trim();if(!$branch){throw 'Detached HEAD: refusing push'};& git -C $root push origin $branch;if($LASTEXITCODE -ne 0){throw 'Push failed'}}
Write-Host 'Repository sync complete.'
