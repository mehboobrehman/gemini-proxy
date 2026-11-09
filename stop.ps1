# Stops the gemini-proxy server, wherever/however it was started (run.bat,
# run-background.vbs, run-restricted.bat, run-restricted.vbs, run.ps1, or
# `bun run src/server.ts` directly) — finds whatever process is actually
# listening on the proxy's port and stops just that one, so it never
# touches unrelated bun processes elsewhere on the machine.
#
# Needs PowerShell script execution to work, same as run.ps1 — if that's
# restricted in your environment, stop the process manually instead:
# `netstat -ano | findstr :8765` to find the PID, then `taskkill /PID <pid> /F`.

$ErrorActionPreference = "Stop"

$port = if ($env:PORT) { $env:PORT } else { 8765 }

$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
    Write-Host "gemini-proxy doesn't appear to be running (nothing listening on port $port)." -ForegroundColor Yellow
    exit 0
}

$stopped = @()
foreach ($procId in ($conns.OwningProcess | Sort-Object -Unique)) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Host "Stopping $($proc.ProcessName) (PID $procId) on port $port ..."
        Stop-Process -Id $procId -Force
        $stopped += $procId
    }
}

if ($stopped.Count -gt 0) {
    Write-Host "gemini-proxy stopped." -ForegroundColor Green
} else {
    Write-Host "Found a listener on port $port but couldn't resolve its process - it may have already exited." -ForegroundColor Yellow
}
