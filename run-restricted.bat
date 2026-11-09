@echo off
rem Starts gemini-proxy using only cmd.exe built-ins (start, netstat,
rem findstr) - no PowerShell script execution. Common in corporate
rem environments with restricted user rights; if `bun run src\server.ts`
rem works for you directly but run.bat/run.ps1 doesn't, this is the one to
rem use instead. For a fully hidden window (not just minimized), see
rem run-restricted.vbs, which needs Windows Script Host instead of
rem PowerShell - a separate Group Policy switch, so it may work even where
rem PowerShell scripts don't (or vice versa).
rem
rem The proxy runs in a separate, minimized console window (the closest
rem thing to "no window" achievable with cmd.exe alone - `start` can
rem minimize a window but not hide it, that needs a Win32-level flag cmd.exe
rem doesn't expose). Use stop.bat to stop it.

setlocal enabledelayedexpansion
if "%PORT%"=="" set PORT=8765

rem --- Only one proxy at a time: stop whatever's already running -----------
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
    echo Stopping existing gemini-proxy ^(PID %%p^) on port %PORT% ...
    taskkill /PID %%p /F >nul 2>&1
)
for /l %%i in (1,1,20) do (
    netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
    if errorlevel 1 goto :portfree
    ping -n 2 127.0.0.1 >nul
)
:portfree

cd /d "%~dp0"

where bun >nul 2>&1
if errorlevel 1 (
    echo Bun is not installed or not on PATH. Install it from https://bun.sh and try again.
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies...
    call bun install
    if errorlevel 1 (
        echo bun install failed.
        pause
        exit /b 1
    )
)

echo Starting gemini-proxy on http://127.0.0.1:%PORT%/ in a minimized window ...
start "gemini-proxy" /min cmd /c "bun run src\server.ts"
