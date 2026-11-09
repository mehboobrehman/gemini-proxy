@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1"
if errorlevel 1 (
    echo.
    echo gemini-proxy exited with an error - see above.
    pause
)
