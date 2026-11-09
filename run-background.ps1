# Starts gemini-proxy detached and fully hidden (no console window).
# Invoked via run-background.vbs, which just does
# `WScript.Shell.Run "powershell ... -WindowStyle Hidden -File run-background.ps1", 0, False`
# and exits — a .vbs run through wscript.exe never attaches a console at
# all, unlike a .bat, which always gets one from Explorer for an instant.
#
# This script itself is short-lived: it does the checks, launches the actual
# server as a separate detached hidden process, and exits — it does not stay
# resident for the server's lifetime. Two log files, not one: launcher.log
# (this script's own quick status messages, e.g. "already running") uses
# Add-Content, which opens and closes the file per write, so it never
# conflicts with a concurrent invocation; background.log (the server's own
# stdout/stderr) is redirected by Start-Process and stays open for as long as
# the server runs — nothing else needs to touch that file, so that's fine.
#
# Use stop.bat to stop it — it works the same regardless of whether the
# proxy was started via run.bat or run-background.vbs.

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$port = if ($env:PORT) { $env:PORT } else { 8765 }
$baseUrl = "http://127.0.0.1:$port/"

$stateDir = Join-Path $env:LOCALAPPDATA "gemini-proxy"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$launcherLog = Join-Path $stateDir "launcher.log"
$serverLog = Join-Path $stateDir "background.log"

function Log($msg) {
    Add-Content -Path $launcherLog -Value "[$(Get-Date)] $msg"
}

# Only one proxy at a time — if something's already listening on the port
# (started via run.bat, run-background.vbs, run-restricted.bat/.vbs, or
# directly), stop it first rather than refusing to start or running a
# second instance alongside it.
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    foreach ($procId in ($existing.OwningProcess | Sort-Object -Unique)) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc) {
            Log "Stopping existing gemini-proxy ($($proc.ProcessName), PID $procId) on port $port ..."
            Stop-Process -Id $procId -Force
        }
    }
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
    }
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Log "Bun is not installed or not on PATH. Install it from https://bun.sh and try again."
    exit 1
}

if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
    Log "Installing dependencies..."
    bun install *>> $launcherLog
    if ($LASTEXITCODE -ne 0) {
        Log "bun install failed - see $launcherLog"
        exit 1
    }
}

Log "Starting gemini-proxy on $baseUrl (background, no window). Server output: $serverLog"

# bun is an npm shim (.ps1), not a real Win32 exe, so Start-Process can't
# launch it directly (needs a real Win32 executable) — launch it through a
# hidden PowerShell instead, same as run.ps1 does in the foreground, so the
# shim resolves normally.
Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    "Set-Location '$PSScriptRoot'; bun run src/server.ts"
) -RedirectStandardOutput $serverLog -RedirectStandardError "$serverLog.err"
