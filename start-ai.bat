@echo off
title PrepLOR AI Gateway
color 0A

echo.
echo  =========================================
echo   PrepLOR AI Gateway - Starting Up
echo  =========================================
echo.

REM ── Check if Node.js is available ──────────────────────────────────────────
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

REM ── Check if ngrok is available ─────────────────────────────────────────────
if not exist "%~dp0ngrok.exe" (
    echo  ERROR: ngrok.exe not found in OmniProxy folder.
    echo  Please place ngrok.exe in: %~dp0
    pause
    exit /b 1
)

echo  [1/3] Starting OmniProxy on port 10000...
start "OmniProxy - AI Engine" cmd /k "cd /d %~dp0 && echo OmniProxy starting... && node server.js"

echo  Waiting for OmniProxy to boot...
timeout /t 3 /nobreak >nul

echo  [2/3] Starting ngrok tunnel (static free URL)...
start "ngrok - Public Tunnel" cmd /k "%~dp0ngrok.exe http 10000 --url=payer-ether-unfiled.ngrok-free.dev"


echo  Waiting for tunnel to establish...
timeout /t 3 /nobreak >nul

echo.
echo  =========================================
echo   AI Gateway is LIVE!
echo  =========================================
echo.
echo   Public URL: https://payer-ether-unfiled.ngrok-free.dev
echo   Local URL:  http://localhost:10000
echo.
echo   The live site preplor.scrollar.com is now
echo   powered by AI on this PC!
echo.
echo   Keep this window open while using AI features.
echo   Press CTRL+C or close this window to stop.
echo  =========================================
echo.
pause
