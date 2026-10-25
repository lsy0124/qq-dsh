@echo off
chcp 65001 >nul
title qq-dsh 一键安装
cd /d "%~dp0"

echo.
echo ============================================================
echo   qq-dsh 一键安装
echo ============================================================
echo.
echo 这个脚本会做三件事：
echo   1. 装 npm 依赖
echo   2. 创建 config.json（如果还没有）
echo   3. 挂载到 DSH，然后体检
echo.
echo 装不了的东西（需要你另外装）：
echo   QQ 客户端、SnowLuma、DSH Desktop
echo.
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 找不到 Node.js
    echo.
    echo 请先装 Node.js 22.13 或更高版本：
    echo   https://nodejs.org/
    echo.
    pause
    exit /b 1
)

node scripts\install.mjs

echo.
echo ============================================================
echo 装完了。按任意键关闭。
echo ============================================================
pause >nul
