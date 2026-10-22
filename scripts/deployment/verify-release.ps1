# WBS-R2.2 — Release verification gate (preparation phase).
# Proves: exact branch/commit, clean tree, toolchain baseline, config presence.
# Dry-run by default; this script never mutates anything.
[CmdletBinding()]
param(
  [string]$ExpectedBranch = "recovery/r2-production-activation",
  [string]$ExpectedCommit = "",
  [switch]$Execute  # accepted for interface symmetry; this script is read-only
)

$ErrorActionPreference = 'Stop'
$failures = New-Object System.Collections.Generic.List[string]

function Check($ok, [string]$message) {
  if ($ok) { Write-Host "PASS  $message" -ForegroundColor Green }
  else { Write-Host "FAIL  $message" -ForegroundColor Red; $failures.Add($message) | Out-Null }
}

Write-Host "=== NatForgeAI release verification (read-only) ===" -ForegroundColor Cyan

# 1. Repository identity
$branch = (git branch --show-current).Trim()
Check ($branch -eq $ExpectedBranch) "branch is '$ExpectedBranch' (actual: '$branch')"

if ($ExpectedCommit) {
  $head = (git rev-parse HEAD).Trim()
  Check ($head -eq $ExpectedCommit) "HEAD matches expected commit ($ExpectedCommit)"
} else {
  Write-Host "WARN  -ExpectedCommit not supplied; skipping exact-commit gate" -ForegroundColor Yellow
}

# 2. Clean tree (untracked + modified must be empty)
$dirty = (git status --porcelain)
Check ([string]::IsNullOrWhiteSpace($dirty)) "working tree is clean"

# 3. Toolchain baseline (R2.1)
$nodeMajor = (node -v).TrimStart('v').Split('.')[0]
Check ($nodeMajor -eq "20") "Node.js major version is 20 (actual: $(node -v))"
$npmMajor = (npm -v).Split('.')[0]
Check ($npmMajor -ge "10") "npm major version >= 10 (actual: $(npm -v))"
Check (Get-Command pm2 -ErrorAction SilentlyContinue) "PM2 is available on PATH"

# 4. Canonical migration chain present (27 journal entries / 27 SQL files)
$journal = Get-Content "db/migrations/meta/_journal.json" -Raw | ConvertFrom-Json
$journalCount = @($journal.entries).Count
$sqlCount = @(Get-ChildItem "db/migrations" -Filter *.sql).Count
Check ($journalCount -eq 27 -and $sqlCount -eq 27) "canonical migration chain intact ($journalCount journal / $sqlCount sql)"

# 5. Configuration presence (values NEVER printed)
$requiredKeys = @(
  "APP_SECRET", "DATABASE_URL", "FIREBASE_SERVICE_ACCOUNT",
  "VITE_FIREBASE_API_KEY", "VITE_FIREBASE_AUTH_DOMAIN", "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET", "VITE_FIREBASE_MESSAGING_SENDER_ID", "VITE_FIREBASE_APP_ID",
  "OPENAI_API_KEY", "PUBLIC_APP_URL"
)
$envFile = ".env"
Check (Test-Path $envFile) ".env present at repository root"
$envContent = if (Test-Path $envFile) { Get-Content $envFile -Raw } else { "" }
foreach ($key in $requiredKeys) {
  $present = $envContent -match "(?m)^\s*$key\s*=\s*\S+"
  Check $present "config key present: $key"
}

Write-Host ""
if ($failures.Count -gt 0) {
  Write-Host "RELEASE GATE FAILED ($($failures.Count) check(s)) — do not proceed." -ForegroundColor Red
  exit 1
}
Write-Host "RELEASE GATE PASSED — checkout is exactly the accepted release." -ForegroundColor Green
exit 0
