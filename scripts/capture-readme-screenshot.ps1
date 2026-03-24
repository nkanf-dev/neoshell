param(
  [string]$ScreenshotPath = "docs/images/neoshell-product.png"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$bunPath = (Get-Command bun).Source
$serverRoot = Join-Path $repoRoot "apps/server"
$webRoot = Join-Path $repoRoot "apps/web"
$absoluteScreenshotPath = Join-Path $repoRoot $ScreenshotPath
$screenshotDirectory = Split-Path -Parent $absoluteScreenshotPath
$runStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$tempLogDirectory = Join-Path $env:TEMP "neoshell-readme-shot-$runStamp"
$tempServerDataDirectory = Join-Path $tempLogDirectory "server-data"
$tempDatabasePath = Join-Path $tempServerDataDirectory "neoshell.sqlite"
$tempSpillDirectory = Join-Path $tempServerDataDirectory "spills"
$serverOutLog = Join-Path $tempLogDirectory "server.out.log"
$serverErrLog = Join-Path $tempLogDirectory "server.err.log"
$webOutLog = Join-Path $tempLogDirectory "web.out.log"
$webErrLog = Join-Path $tempLogDirectory "web.err.log"
$playwrightSession = "neoshell-readme-shot"

function Wait-ForPort([int]$Port, [int]$TimeoutSeconds = 45) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $listener = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalPort -eq $Port } |
      Select-Object -First 1
    if ($listener) {
      return
    }
    Start-Sleep -Milliseconds 500
  }

  throw "Timed out waiting for port $Port."
}

function Stop-ProcessTree($Process) {
  if (-not $Process) {
    return
  }

  try {
    if (-not $Process.HasExited) {
      taskkill /PID $Process.Id /T /F | Out-Null
    }
  } catch {
    # Best effort cleanup only.
  }
}

function Invoke-PlaywrightCli([string[]]$Arguments) {
  & npx --yes --package @playwright/cli playwright-cli @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "playwright-cli failed with exit code $LASTEXITCODE."
  }
}

function Read-LogTail([string]$Path) {
  if (-not (Test-Path $Path)) {
    return "<missing>"
  }

  return (Get-Content -Path $Path -Tail 40) -join "`n"
}

New-Item -ItemType Directory -Force -Path $screenshotDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $tempLogDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $tempServerDataDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $tempSpillDirectory | Out-Null

$serverProcess = $null
$webProcess = $null

Push-Location $repoRoot
try {
  $serverBootstrap = @"
`$env:NEOSHELL_DATABASE_PATH = '$tempDatabasePath'
`$env:NEOSHELL_SPILL_DIRECTORY = '$tempSpillDirectory'
Set-Location '$serverRoot'
& '$bunPath' run dev
"@

  $serverProcess = Start-Process -FilePath "powershell.exe" `
    -WorkingDirectory $serverRoot `
    -ArgumentList "-NoLogo", "-NoProfile", "-Command", $serverBootstrap `
    -RedirectStandardOutput $serverOutLog `
    -RedirectStandardError $serverErrLog `
    -PassThru `
    -WindowStyle Hidden

  $webProcess = Start-Process -FilePath $bunPath `
    -WorkingDirectory $webRoot `
    -ArgumentList "run", "dev" `
    -RedirectStandardOutput $webOutLog `
    -RedirectStandardError $webErrLog `
    -PassThru `
    -WindowStyle Hidden

  Wait-ForPort -Port 4000
  Wait-ForPort -Port 3000

  Invoke-PlaywrightCli @("--session", $playwrightSession, "kill-all")
  Invoke-PlaywrightCli @("--session", $playwrightSession, "open", "http://127.0.0.1:3000")
  Invoke-PlaywrightCli @("--session", $playwrightSession, "resize", "1680", "1180")

  Invoke-PlaywrightCli @("--session", $playwrightSession, "run-code", "await page.waitForTimeout(2500)")
  Invoke-PlaywrightCli @("--session", $playwrightSession, "run-code", "await page.locator('#password').fill('change-me-before-deploy')")
  Invoke-PlaywrightCli @("--session", $playwrightSession, "run-code", "await page.locator('button[type=submit]').click()")
  Invoke-PlaywrightCli @("--session", $playwrightSession, "run-code", "await page.waitForTimeout(4000)")
  Invoke-PlaywrightCli @("--session", $playwrightSession, "screenshot", "--filename", $absoluteScreenshotPath)

  Write-Output $absoluteScreenshotPath
} catch {
  $message = @(
    $_.Exception.Message,
    "",
    "--- server stdout ---",
    (Read-LogTail -Path $serverOutLog),
    "",
    "--- server stderr ---",
    (Read-LogTail -Path $serverErrLog),
    "",
    "--- web stdout ---",
    (Read-LogTail -Path $webOutLog),
    "",
    "--- web stderr ---",
    (Read-LogTail -Path $webErrLog)
  ) -join "`n"

  throw $message
} finally {
  try {
    Invoke-PlaywrightCli @("--session", $playwrightSession, "kill-all")
  } catch {
    # Ignore browser cleanup errors.
  }

  Stop-ProcessTree -Process $serverProcess
  Stop-ProcessTree -Process $webProcess
  Pop-Location
}
