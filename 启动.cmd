@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM --------------------------------------------------------------------
REM  Windows launcher -- double-click it.
REM
REM  TWO RULES, both measured the hard way. Keep them.
REM
REM  1) This file MUST be CRLF. (.gitattributes pins *.cmd eol=crlf.)
REM     With LF, cmd.exe eats the first one or two characters of every
REM     line: `chcp 65001` becomes "'5001' is not recognized", `REM`
REM     becomes "'M'", `Windows` becomes "'indows'". The server still
REM     comes up, but the window fills with errors and a non-technical
REM     user just reads that as "broken".
REM
REM  2) This file MUST stay ASCII-only -- comments included.
REM     cmd.exe reads a batch file in fixed-size blocks. A multi-byte
REM     UTF-8 character straddling a block boundary gets split, and the
REM     rest of that line is then executed as a command. Measured: a
REM     5-line Chinese probe ran fine (even under code page 936); the
REM     real 50-line file broke on 4 scattered lines, each starting at a
REM     mangled character. It depends on byte offsets -- so adding one
REM     comment line can move the breakage or bring it back.
REM     Unpredictable beats wrong, so: no non-ASCII in this file.
REM
REM  HOW THE CHINESE GETS OUT ANYWAY
REM
REM     Every user-facing line lives in scripts\msg\*.txt (UTF-8) and is
REM     printed with `type`. Rule 2 is about how cmd.exe PARSES a batch
REM     file; `type` never parses -- it streams the file's bytes to the
REM     console, and `chcp 65001` above already made the console read
REM     them as UTF-8. Measured both ways: `type` of a UTF-8 file prints
REM     clean Chinese, while re-encoding this file itself as GBK printed
REM     mojibake. So the text moved out; the rules stayed.
REM
REM     Edit the wording in scripts\msg\ -- no need to touch this file.
REM     The .command (macOS) and .sh (Linux) launchers keep their text
REM     inline: bash reads UTF-8 natively, so they were never affected.
REM --------------------------------------------------------------------

type scripts\msg\banner.txt

where node >nul 2>nul
if errorlevel 1 (
  type scripts\msg\no-node.txt
  pause
  exit /b 1
)

if not exist "server\dist\index.js" (
  type scripts\msg\first-run.txt
  call npm run go
) else (
  type scripts\msg\starting.txt
  call npm start
)

REM  "already stopped" is a lie when it never started -- a too-old Node makes
REM  `npm run go` die inside npm install. Say which one actually happened.
if errorlevel 1 (
  type scripts\msg\failed.txt
) else (
  type scripts\msg\stopped.txt
)
pause >nul
