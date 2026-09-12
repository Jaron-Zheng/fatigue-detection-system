@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"
title Driver Fatigue Detection System - One-Click Launcher

echo.
echo  ============================================================
echo    Driver Fatigue Detection System  -  One-Click Launcher
echo  ============================================================
echo.

rem ------------------------------------------------------------------
rem  Step 1. Check that Node.js is installed and reachable
rem ------------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 goto NO_NODE

set "NODE_VER=unknown"
for /f "delims=" %%v in ('node -e "process.stdout.write(process.versions.node)"') do set "NODE_VER=%%v"
echo   [OK] Node.js v%NODE_VER% detected.
echo   Local address: http://127.0.0.1:5180/
echo   (The browser opens automatically; if not, open the address above.)
echo.

rem ------------------------------------------------------------------
rem  Step 2. Start the system.
rem  tools\launch.js verifies the Node version, downloads the offline
rem  model assets only if they are missing, then starts the local server
rem  and opens the browser.
rem ------------------------------------------------------------------
if not exist "tools\launch.js" goto DIRECT_START
node "tools\launch.js"
goto CHECK_EXIT

:DIRECT_START
echo   [..] tools\launch.js not found, starting the server directly...
node "server\server.js"

:CHECK_EXIT
set "EC=%errorlevel%"
if not "%EC%"=="0" goto STOPPED
goto DONE

:NO_NODE
echo   [ERROR] Node.js was NOT found on this computer.
echo.
echo           Please install Node.js 18 (LTS) or newer first:
echo               https://nodejs.org/
echo.
echo           After the installation finishes, close this window
echo           and double-click this file again.
echo.
pause
exit /b 1

:STOPPED
echo.
echo   The launcher has stopped (exit code %EC%).
echo.
echo   If you did not press Ctrl+C, please read the messages printed
echo   above, fix the issue, and run this file again.
echo.
pause
exit /b %EC%

:DONE
endlocal
