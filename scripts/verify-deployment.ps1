# Deployment verification for NatForgeAI IIS media routing.
# Run after build or deployment on Windows/IIS.

param(
  [string]$DistPath = "D:\react\natdev\Natforgeai\dist\public\web.config",
  [string]$SmokeUrl = ""
)

$requiredPatterns = @(
  "^api/\(.*\)",
  "^generated/\(.*\)",
  "^uploads/\(.*\)",
  "React SPA Fallback"
)

$allOk = $true

if (-not (Test-Path $DistPath)) {
  Write-Host "❌ Missing $DistPath" -ForegroundColor Red
  exit 1
}

$content = Get-Content $DistPath -Raw
foreach ($pattern in $requiredPatterns) {
  if ($content -match $pattern) {
    Write-Host "✅ Found rule: $pattern" -ForegroundColor Green
  } else {
    Write-Host "❌ Missing rule: $pattern" -ForegroundColor Red
    $allOk = $false
  }
}

if ($SmokeUrl) {
  try {
    $response = Invoke-WebRequest -Uri $SmokeUrl -UseBasicParsing -Method HEAD
    $contentType = $response.Headers["Content-Type"]
    if ($response.StatusCode -eq 200 -and $contentType -like "image/*") {
      Write-Host "✅ Smoke test passed: $SmokeUrl → $($response.StatusCode) $contentType" -ForegroundColor Green
    } else {
      Write-Host "❌ Smoke test failed: $SmokeUrl → $($response.StatusCode) $contentType (expected image/*)" -ForegroundColor Red
      $allOk = $false
    }
  } catch {
    Write-Host "❌ Smoke test error: $SmokeUrl → $_" -ForegroundColor Red
    $allOk = $false
  }
} else {
  Write-Host "ℹ️  Pass -SmokeUrl to run an HTTP smoke test." -ForegroundColor Cyan
}

if ($allOk) {
  Write-Host "`n✅ Deployment verification passed." -ForegroundColor Green
  exit 0
} else {
  Write-Host "`n❌ Deployment verification failed." -ForegroundColor Red
  exit 1
}
