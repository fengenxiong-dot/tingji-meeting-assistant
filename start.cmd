@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS, then run this file again.
  pause
  exit /b 1
)
if not exist node_modules\ws (
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Tingjijun: http://127.0.0.1:4317
echo Open the address above in Microsoft Edge or Chrome.
echo Keep this window running while recording. Press Ctrl+C to stop.
node server.js
pause
