param(
	[string]$Message = 'feat: add independent Doubao STS voice gateway',
	[switch]$NoPush,
	[switch]$AuditOnly
)
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$forbiddenFiles = @(
	'dsh-dispatch.json', 'dsh-voice.json', 'dsh-voice-foreman.json',
	'*.log', '*.wav', '*.mp3', '*.m4a'
)
foreach ($pattern in $forbiddenFiles) {
	$hits = Get-ChildItem $root -Recurse -Force -File -Filter $pattern -ErrorAction SilentlyContinue |
		Where-Object { $_.FullName -notmatch '\\.git\\|\\node_modules\\' }
	if ($hits) { throw "发现禁止同步文件：$($hits.FullName -join ', ')" }
}

$textFiles = Get-ChildItem $root -Recurse -Force -File |
	Where-Object {
		$_.FullName -notmatch '\\.git\\|\\node_modules\\|\\dist\\|\\vendor\\downloads\\' -and
		$_.Extension -in @('.js', '.json', '.md', '.txt', '.ps1', '.yml', '.yaml', '.html', '.css')
	}
$patterns = @(
	'(?i)desktop-[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net',
	'(?i)[A-Z]:\\Users\\(?!<|YOUR|USER|用户)[^\\\r\n"'']+',
	'\u9648\u6893\u5065',
	'(?i)session-[0-9a-f]{8}-[0-9a-f-]{20,}',
	'(?i)"(?:apiKey|accessToken|token)"\s*:\s*"(?!"|<|your|你的)[^"\r\n]{8,}"',
	'(?i)X-Api-Key\s*[:=]\s*["''][A-Za-z0-9_\-]{16,}'
)
foreach ($file in $textFiles) {
	$content = Get-Content $file.FullName -Raw -Encoding UTF8
	foreach ($pattern in $patterns) {
		if ($content -match $pattern) { throw "敏感信息检查失败：$($file.FullName)，匹配 $pattern" }
	}
}

& git -C $root status --short
if ($AuditOnly) { Write-Host '敏感信息审计通过；AuditOnly 未暂存、提交或推送。'; exit 0 }
& git -C $root add --all
$staged = & git -C $root diff --cached --name-only
if (!$staged) { Write-Host '没有需要同步的改动。'; exit 0 }
& git -C $root commit -m $Message
if ($LASTEXITCODE -ne 0) { throw "git commit 失败：$LASTEXITCODE" }
if (!$NoPush) {
	$branch = (& git -C $root branch --show-current).Trim()
	if (!$branch) { throw '当前不是命名分支，未推送。' }
	& git -C $root push origin $branch
	if ($LASTEXITCODE -ne 0) { throw "git push 失败：$LASTEXITCODE" }
}
Write-Host 'GitHub 同步完成。'
