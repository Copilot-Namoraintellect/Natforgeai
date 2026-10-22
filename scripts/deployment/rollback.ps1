# WBS-R2.2 — Rollback (rollback phase).
# Repoints PM2 and the IIS site root to a previous release directory.
# DRY-RUN unless -Execute.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PreviousReleaseDir,
  [string]$IisSiteRoot = "",
  [string]$AppName = "natforgeai",
  [string]$WorkerName = "natforgeai-worker",
  [int]$ApiPort = 3001,
  [switch]$Execute
)

$ErrorActionPreference = 'Stop'

# Fail-closed input validation
if (-not (Test-Path (Join-Path $PreviousReleaseDir "dist/boot.js"))) {
  Write-Host "FAIL  $PreviousReleaseDir does not look like a release (dist/boot.js missing)." -ForegroundColor Red
  exit 1
}
if ($IisSiteRoot -and -not (Test-Path (Join-Path $IisSiteRoot "index.html")) -and -not (Test-Path (Join-Path $IisSiteRoot "web.config"))) {
  Write-Host "FAIL  IIS site root '$IisSiteRoot' is missing index.html/web.config." -ForegroundColor Red
  exit 1
}

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

Write-Host "=== NatForgeAI rollback ===" -ForegroundColor Cyan
if (-not $Execute) { Write-Host "(dry-run — re-run with -Execute to perform)" -ForegroundColor Yellow }

Push-Location $PreviousReleaseDir
try {
  Invoke-Step "Restart API from previous release" "pm2 start dist/boot.js --name $AppName 2>`$null; if (`$LASTEXITCODE -ne 0) { pm2 restart $AppName }"
  Invoke-Step "Restart worker from previous release (if present)" "if (Test-Path 'dist/worker.js') { pm2 start dist/worker.js --name $WorkerName 2>`$null; if (`$LASTEXITCODE -ne 0) { pm2 restart $WorkerName } }"
  Invoke-Step "Persist PM2 process list" "pm2 save"
}
finally { Pop-Location }

if ($IisSiteRoot) {
  Write-Host "MANUAL  Repoint the IIS site physical path to: $IisSiteRoot" -ForegroundColor Yellow
  Write-Host "        (appcmd: %systemroot%\system32\inetsrv\appcmd set site /site.name:<SITE> /[path='/'].physicalPath:$IisSiteRoot)" -ForegroundColor DarkGray
}

if ($Execute) {
  $healthy = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$ApiPort/api/trpc/health.getSystemHealth" -Method Get -TimeoutSec 5 -UseBasicParsing
      if ($response.StatusCode -eq 200) { $healthy = $true; break }
    } catch { Start-Sleep -Seconds 2 }
  }
  if (-not $healthy) {
    Write-Host "FAIL  post-rollback health check did not return 200 — investigate before serving traffic." -ForegroundColor Red
    exit 1
  }
  Write-Host "PASS  post-rollback health check returned 200." -ForegroundColor Green
}

Write-Host "ROLLBACK COMPLETED." -ForegroundColor Green
exit 0
