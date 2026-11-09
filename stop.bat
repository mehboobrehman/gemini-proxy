@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
if errorlevel 1 (
    echo.
    echo Failed to stop gemini-proxy - see above.
    pause
)
