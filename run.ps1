# Starts the gemini-proxy server and opens it in the default browser once
# it's actually ready to accept requests. Run via run.bat (double-clickable)
# or directly: powershell -ExecutionPolicy Bypass -File run.ps1

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$port = if ($env:PORT) { $env:PORT } else { 8765 }
$baseUrl = "http://127.0.0.1:$port/"
$healthUrl = "${baseUrl}health"

# Only one proxy at a time — if something's already listening on the port
# (started via run.bat, run-background.vbs, run-restricted.bat/.vbs, or
# directly), stop it first rather than refusing to start or running a
# second instance alongside it.
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    foreach ($procId in ($existing.OwningProcess | Sort-Object -Unique)) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "Stopping existing gemini-proxy ($($proc.ProcessName), PID $procId) on port $port ..." -ForegroundColor Yellow
            Stop-Process -Id $procId -Force
        }
    }
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
    }
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "Bun is not installed or not on PATH. Install it from https://bun.sh and try again." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
    Write-Host "Installing dependencies..."
    bun install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "bun install failed." -ForegroundColor Red
        exit 1
    }
}

# bun on Windows is usually an npm-installed .ps1/.cmd shim rather than a
# native .exe, and Start-Process can't launch those directly (it needs a
# real Win32 executable). So run bun in the foreground the normal way —
# PowerShell's own command resolution handles any shim type — and use a
# background job purely to poll for readiness and pop the browser open.
$job = Start-Job -ScriptBlock {
    param($healthUrl, $baseUrl)
    for ($i = 0; $i -lt 40; $i++) {
        try {
            $resp = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 1
            if ($resp.StatusCode -eq 200) {
                Start-Process $baseUrl
                return
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
} -ArgumentList $healthUrl, $baseUrl

Write-Host "Starting gemini-proxy on $baseUrl ..."
Write-Host "(Opening your browser once it's ready. Close this window or press Ctrl+C to stop the server.)"

try {
    & bun run src/server.ts
}
finally {
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
}
