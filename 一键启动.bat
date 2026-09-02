@echo off
chcp 65001 >nul 2>&1
title 驾驶员疲劳检测系统 · 一键启动
cd /d "%~dp0"

echo.
echo   ┌──────────────────────────────────────────────────────┐
echo   │           驾驶员疲劳检测系统 · 一键启动               │
echo   └──────────────────────────────────────────────────────┘
echo.

REM ============================================================
REM 1. 检查 Node.js 是否已安装
REM ============================================================
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   [错误] 未检测到 Node.js，请先安装 Node.js 18 或更高版本。
    echo.
    echo          下载地址: https://nodejs.org/
    echo.
    echo   安装完成后重新双击本文件即可启动。
    echo.
    pause
    exit /b 1
)

REM ============================================================
REM 2. 检查 Node.js 版本 ^>= 18
REM ============================================================
for /f "tokens=*" %%v in ('node -e "process.stdout.write(process.versions.node)"') do set NODE_VERSION=%%v
for /f "tokens=1 delims=." %%a in ("%NODE_VERSION%") do set NODE_MAJOR=%%a

if %NODE_MAJOR% lss 18 (
    echo   [错误] Node.js 版本过低：当前 v%NODE_VERSION%，需要 v18 或更高。
    echo.
    echo          请前往 https://nodejs.org/ 升级 Node.js。
    echo.
    pause
    exit /b 1
)

echo   [√] Node.js v%NODE_VERSION% 检测通过

REM ============================================================
REM 3. 检查推理资源是否已就位
REM ============================================================
set VENDOR_OK=1
if not exist "web\vendor\tasks-vision\vision_bundle.mjs" set VENDOR_OK=0
if not exist "web\vendor\tasks-vision\wasm\vision_wasm_internal.wasm" set VENDOR_OK=0
if not exist "web\vendor\models\face_landmarker.task" set VENDOR_OK=0

if %VENDOR_OK% equ 0 (
    echo   [!] 推理资源缺失，正在自动下载...
    echo.
    node tools\fetch-vendor.js
    if %errorlevel% neq 0 (
        echo.
        echo   [错误] 推理资源下载失败，请检查网络后重试。
        echo          或手动运行: node tools\fetch-vendor.js
        echo.
        pause
        exit /b 1
    )
    echo.
    echo   [√] 推理资源下载完成
) else (
    echo   [√] 推理资源已就位，可离线运行
)

REM ============================================================
REM 4. 启动服务器
REM ============================================================
echo.
echo   正在启动本地服务器...
echo.
echo   访问地址: http://127.0.0.1:5180/
echo   按 Ctrl+C 可停止服务
echo   ══════════════════════════════════════════════════════
echo.

node server/server.js

if %errorlevel% neq 0 (
    echo.
    echo   [错误] 服务器异常退出，错误码: %errorlevel%
    echo.
    pause
)

exit /b %errorlevel%
