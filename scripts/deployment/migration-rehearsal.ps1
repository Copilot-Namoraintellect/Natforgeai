# WBS-R2.4 — Disposable migration rehearsal.
# Verifies canonical chain integrity, then - only when an operator supplies a
# DISPOSABLE target and explicitly acknowledges it - applies drizzle-kit
# migrate to that target and probes live schema parity. Stops before any
# execution when no disposable target exists.
[CmdletBinding()]
param(
  [string]$TargetUrl = "",
  [switch]$AcknowledgeDisposableTarget,
  [switch]$SkipIntegrity
)

$ErrorActionPreference = 'Stop'

Write-Host "=== NatForgeAI migration rehearsal ===" -ForegroundColor Cyan

# ── Phase A: chain integrity (always runs; no database needed) ─────────────
if (-not $SkipIntegrity) {
  Write-Host "[A] Verifying canonical migration chain integrity..." -ForegroundColor Cyan
  $journal = Get-Content "db/migrations/meta/_journal.json" -Raw | ConvertFrom-Json
  $entries = @($journal.entries)
  $fail = $false
  if ($entries.Count -ne 27) { Write-Host "FAIL  expected 27 journal entries, found $($entries.Count)" -ForegroundColor Red; $fail = $true }
  for ($i = 0; $i -lt $entries.Count; $i++) {
    if ($entries[$i].idx -ne $i) { Write-Host "FAIL  journal idx mismatch at position $i" -ForegroundColor Red; $fail = $true }
    $sql = "db/migrations/$($entries[$i].tag).sql"
    if (-not (Test-Path $sql)) { Write-Host "FAIL  journal entry $($entries[$i].tag) has no SQL file" -ForegroundColor Red; $fail = $true }
    $snap = "db/migrations/meta/{0:d4}_snapshot.json" -f $i
    if ($i -eq ($entries.Count - 1) -and -not (Test-Path $snap)) {
      Write-Host "FAIL  terminal snapshot missing for entry $($entries[$i].tag)" -ForegroundColor Red; $fail = $true
    }
  }
  $activeSql = @(Get-ChildItem "db/migrations" -Filter *.sql).Count
  if ($activeSql -ne $entries.Count) { Write-Host "FAIL  active SQL count ($activeSql) != journal count ($($entries.Count))" -ForegroundColor Red; $fail = $true }
  if ($fail) { Write-Host "CHAIN INTEGRITY FAILED — do not rehearse." -ForegroundColor Red; exit 1 }
  Write-Host "PASS  chain integrity: 27 entries, sequential idx, SQL + terminal snapshot present." -ForegroundColor Green
  Write-Host "      Expected schema baseline: terminal snapshot 0026 (= db/schema.ts, verified exact in R1.8)." -ForegroundColor Green
} else {
  Write-Host "[A] Skipped (-SkipIntegrity)." -ForegroundColor Yellow
}

# ── Phase B: disposable target gate ────────────────────────────────────────
if (-not $TargetUrl) {
  Write-Host "[B] No -TargetUrl supplied." -ForegroundColor Yellow
  Write-Host "    No disposable database is configured on this machine (see R2.3 missing-prerequisite report)." -ForegroundColor Yellow
  Write-Host "    Rehearsal stops before execution, per WBS-R2.4 (no database target invented)." -ForegroundColor Yellow
  Write-Host "    Procedure for when a disposable MySQL instance exists:" -ForegroundColor Yellow
  Write-Host "      1. Create/verify a THROWAWAY MySQL schema (local Docker, VM snapshot, or fresh schema on a non-prod host)." -ForegroundColor DarkGray
  Write-Host "      2. powershell -File scripts/deployment/migration-rehearsal.ps1 -TargetUrl mysql://... -AcknowledgeDisposableTarget" -ForegroundColor DarkGray
  Write-Host "      3. Review parity output; then run critical checks against the rehearsed schema:" -ForegroundColor DarkGray
  Write-Host "         `$env:DATABASE_URL='<same-disposable-url>'; npm run check; npx vitest run api/lib/workflow api/lib/learning api/lib/billing" -ForegroundColor DarkGray
  Write-Host "      4. Dispose of the target (drop schema / destroy VM)." -ForegroundColor DarkGray
  exit 2
}

if (-not $AcknowledgeDisposableTarget) {
  Write-Host "FAIL  -TargetUrl supplied without -AcknowledgeDisposableTarget. Refusing to touch any database." -ForegroundColor Red
  exit 1
}

# Fail-closed: refuse to run against the DATABASE_URL present in .env
# (that value is, by convention, the real deployment target).
$envFileDb = ""
if (Test-Path ".env") {
  $m = [regex]::Match((Get-Content ".env" -Raw), "(?m)^\s*DATABASE_URL\s*=\s*(\S+)")
  if ($m.Success) { $envFileDb = $m.Groups[1].Value }
}
if ($envFileDb -and $TargetUrl -eq $envFileDb) {
  Write-Host "FAIL  -TargetUrl equals the DATABASE_URL configured in .env. Rehearsal targets must be disposable; this guard prevents accidental production mutation." -ForegroundColor Red
  exit 1
}
if ($TargetUrl -notmatch "^mysql://") {
  Write-Host "FAIL  -TargetUrl must be a mysql:// DSN." -ForegroundColor Red
  exit 1
}

# ── Phase C: forward application against the disposable target ─────────────
Write-Host "[C] Applying canonical chain to the disposable target (drizzle-kit migrate)..." -ForegroundColor Cyan
$env:DATABASE_URL = $TargetUrl
npx drizzle-kit migrate
if ($LASTEXITCODE -ne 0) { Write-Host "FAIL  drizzle-kit migrate exited $LASTEXITCODE" -ForegroundColor Red; exit 1 }

Write-Host "[D] Probing live schema parity against terminal snapshot 0026..." -ForegroundColor Cyan
node scripts/deployment/verify-schema-parity.mjs $TargetUrl
if ($LASTEXITCODE -ne 0) { Write-Host "FAIL  schema parity probe failed" -ForegroundColor Red; exit 1 }

Write-Host "REHEARSAL COMPLETED: chain applied to a disposable target and parity-verified." -ForegroundColor Green
Write-Host "Rollback/recovery of the disposable target: drop the schema (or restore the VM/Docker snapshot); no production state was touched." -ForegroundColor Yellow
exit 0
