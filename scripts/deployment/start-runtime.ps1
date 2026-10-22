# WBS-R2.2 — Runtime start/restart with health verification (deployment phase).
# DRY-RUN unless -Execute. Requires an interactive operator for execution.
[CmdletBinding()]
param(
  [switch]$Execute,
  [string]$AppName = "natforgeai",
  [string]$WorkerName = "natforgeai-worker",
  [int]$ApiPort = 3001,
  [string]$SmokeUrl = ""
)

$ErrorActionPreference = 'Stop'

function Invoke-Step([string]$description, [string]$command) {
  if (-not $Execute) {
    Write-Host "DRY-RUN  $description" -ForegroundColor Yellow
    Write-Host "         > $command" -ForegroundColor DarkGray
    return
  }
  Write-Host "EXEC  $description" -ForegroundColor Cyan
  Invoke-Expression $command
  if ($LASTEXITCODE -ne 0) { throw "Step failed (exit $LASTEXITCODE): $description" }
}

Write-Host "=== NatForgeAI runtime start (PM2) ===" -ForegroundColor Cyan
if (-not $Execute) { Write-Host "(dry-run — re-run with -Execute to perform)" -ForegroundColor Yellow }

Invoke-Step "Start/restart API" "pm2 start dist/boot.js --name $AppName 2>`$null; if (`$LASTEXITCODE -ne 0) { pm2 restart $AppName }"

# Standalone worker only makes sense with Redis configured.
$envContent = if (Test-Path ".env") { Get-Content ".env" -Raw } else { "" }
$redisConfigured = ($envContent -match "(?m)^\s*REDIS_URL\s*=\s*\S+") -or -not [string]::IsNullOrWhiteSpace($env:REDIS_URL)
if ($redisConfigured) {
  Invoke-Step "Start/restart background worker (Redis configured)" "pm2 start dist/worker.js --name $WorkerName 2>`$null; if (`$LASTEXITCODE -ne 0) { pm2 restart $WorkerName }"
} else {
  Write-Host "NOTE  REDIS_URL not configured — skipping worker; boot.ts will use the in-process publishing runner." -ForegroundColor Yellow
}

Invoke-Step "Persist PM2 process list" "pm2 save"

if ($Execute) {
  Write-Host "Waiting for API to accept connections..." -ForegroundColor Cyan
  $healthy = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      # tRPC public health procedure (GET query, no input).
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$ApiPort/api/trpc/health.getSystemHealth" -Method Get -TimeoutSec 5 -UseBasicParsing
      if ($response.StatusCode -eq 200) { $healthy = $true; break }
    } catch { Start-Sleep -Seconds 2 }
  }
  if (-not $healthy) {
    Write-Host "FAIL  health.getSystemHealth did not return 200 on 127.0.0.1:$ApiPort — check 'pm2 logs $AppName'." -ForegroundColor Red
    exit 1
  }
  Write-Host "PASS  health.getSystemHealth returned 200." -ForegroundColor Green

  if ($SmokeUrl) {
    Invoke-Step "HTTP media smoke test" "`$env:NATFORGE_SMOKE_URL='$SmokeUrl'; node scripts/verify-deployment.mjs"
  }
  Invoke-Step "PM2 status snapshot" "pm2 status"
}

Write-Host "RUNTIME START COMPLETED." -ForegroundColor Green
exit 0
