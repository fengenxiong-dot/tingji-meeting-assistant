@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "TINGJI_DATA_DIR=%~dp0data"
if exist "dist\scenario-pause\win-unpacked\听记君.exe" (
  start "" "dist\scenario-pause\win-unpacked\听记君.exe"
  exit /b
)
if exist "dist\local-fix\win-unpacked\听记君.exe" (
  start "" "dist\local-fix\win-unpacked\听记君.exe"
  exit /b
)
if exist "dist\providers\win-unpacked\听记君.exe" (
  start "" "dist\providers\win-unpacked\听记君.exe"
  exit /b
)
if exist "dist\win-unpacked\听记君.exe" (
  start "" "dist\win-unpacked\听记君.exe"
  exit /b
)
call npm.cmd run desktop
if errorlevel 1 pause
