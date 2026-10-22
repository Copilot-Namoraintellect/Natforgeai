# WBS-R2.2 — Install + build validation (validation phase).
# Performs a clean dependency install and full build. DRY-RUN unless -Execute.
[CmdletBinding()]
param(
  [switch]$Execute,
  [string]$SmokeUrl = ""   # optional; forwarded to verify-deployment.mjs
)

$ErrorActionPreference = 'Stop'

function Invoke-Step([string]$description, [string]$command) {
  if (-not $Execute) {
    Write-Host "DRY-RUN  $description" -ForegroundColor Yellow
    Write-Host "         > $command" -ForegroundColor DarkGray
    return
  }
  Write-Host "EXEC  $description" -ForegroundColor Cyan
  Write-Host "      > $command" -ForegroundColor DarkGray
  Invoke-Expression $command
  if ($LASTEXITCODE -ne 0) { throw "Step failed (exit $LASTEXITCODE): $description" }
}

Write-Host "=== NatForgeAI install + build validation ===" -ForegroundColor Cyan
if (-not $Execute) { Write-Host "(dry-run — re-run with -Execute to perform)" -ForegroundColor Yellow }

Invoke-Step "Clean dependency install (npm ci)" "npm ci --no-audit --no-fund"

# Build bakes VITE_* client config — require the VITE_FIREBASE_* keys to exist first.
$envContent = if (Test-Path ".env") { Get-Content ".env" -Raw } else { "" }
$missingVite = @()
foreach ($key in @("VITE_FIREBASE_API_KEY","VITE_FIREBASE_AUTH_DOMAIN","VITE_FIREBASE_PROJECT_ID","VITE_FIREBASE_STORAGE_BUCKET","VITE_FIREBASE_MESSAGING_SENDER_ID","VITE_FIREBASE_APP_ID")) {
  if (-not ($envContent -match "(?m)^\s*$key\s*=\s*\S+")) { $missingVite += $key }
}
if ($missingVite.Count -gt 0) {
  Write-Host "FAIL  missing build-time keys: $($missingVite -join ', ')" -ForegroundColor Red
  exit 1
}

Invoke-Step "Full production build (vite + esbuild + deployment verification)" "npm run build"

Invoke-Step "Artifact check" "if (-not (Test-Path 'dist/boot.js')) { throw 'dist/boot.js missing' }; if (-not (Test-Path 'dist/worker.js')) { throw 'dist/worker.js missing' }; if (-not (Test-Path 'dist/public/index.html')) { throw 'dist/public/index.html missing' }; Write-Host 'artifacts present'"

if ($SmokeUrl) {
  Invoke-Step "HTTP media smoke test" "`$env:NATFORGE_SMOKE_URL='$SmokeUrl'; node scripts/verify-deployment.mjs"
} else {
  Write-Host "NOTE  -SmokeUrl not supplied; skipping HTTP smoke test (web.config checks already run inside the build)." -ForegroundColor Yellow
}

Write-Host "BUILD VALIDATION PASSED." -ForegroundColor Green
exit 0
