@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM --------------------------------------------------------------------
REM  Stop the server. Same two rules as the start launcher next to this
REM  file: CRLF only, ASCII only -- including comments. The Chinese
REM  lives in scripts\msg\*.txt and is printed with `type`, which never
REM  goes through the batch parser.
REM
REM  Find the processes BY PORT, not by name: killing every node.exe
REM  would take the user's editor and other dev servers with it.
REM --------------------------------------------------------------------

type scripts\msg\stop-banner.txt

set FOUND=0
for %%P in (30031 30032) do (
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr ":%%P " ^| findstr LISTENING') do (
    echo   port %%P  ^-^-^>  killing PID %%I
    REM /T also kills the children (concurrently -> node / uv -> python)
    taskkill /F /T /PID %%I >nul 2>nul
    set FOUND=1
  )
)

echo.
if "%FOUND%"=="0" (
  type scripts\msg\stop-none.txt
) else (
  type scripts\msg\stop-done.txt
)

type scripts\msg\stop-bye.txt
pause >nul
