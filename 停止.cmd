@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM Keep this file ASCII and CRLF. Messages live in scripts\msg.
type scripts\msg\stop-banner.txt

where node >nul 2>nul
if errorlevel 1 (
  type scripts\msg\no-node.txt
  pause >nul
  exit /b 1
)

node scripts\stop.mjs
set "STOP_STATUS=%ERRORLEVEL%"
if "%STOP_STATUS%"=="0" type scripts\msg\stop-done.txt
if "%STOP_STATUS%"=="2" type scripts\msg\stop-none.txt
type scripts\msg\stop-bye.txt
pause >nul
if "%STOP_STATUS%"=="2" exit /b 0
exit /b %STOP_STATUS%
