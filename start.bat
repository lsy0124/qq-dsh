@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\harden-state-acl.mjs --quiet
node --env-file-if-exists=.env launch-bridge.mjs --foreground
set "bridgeExit=%errorlevel%"
if not "%bridgeExit%"=="0" pause
exit /b %bridgeExit%
