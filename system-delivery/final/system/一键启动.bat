@echo off
REM ===========================================================================
REM  Driver Fatigue Detection System - launcher
REM
REM  IMPORTANT: keep this file ASCII-only.
REM  cmd.exe parses .bat bytes using the system code page (GBK on zh-CN)
REM  BEFORE `chcp 65001` takes effect. UTF-8 Chinese text here would be
REM  mis-parsed and would corrupt the command syntax. All localized messages
REM  are printed by tools\launch.js instead, where UTF-8 output works fine.
REM ===========================================================================

chcp 65001 >nul 2>&1
title Driver Fatigue Detection System
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto no_node

node "tools\launch.js"
if errorlevel 1 goto failed

echo.
echo   Server stopped.
pause
exit /b 0

:no_node
echo.
echo   [X] Node.js not found.
echo.
echo   This project needs Node.js to run its local server.
echo   No "npm install" is required - only Node built-in modules are used.
echo.
echo   Please install the LTS version from:  https://nodejs.org
echo   Then double-click this file again.
echo.
echo   ^(Chinese: Nodejs weianzhuang, qing xian anzhuang Node.js LTS ban^)
echo.
pause
exit /b 1

:failed
echo.
echo   Startup failed. See the messages above.
echo.
pause
exit /b 1
