@echo off
chcp 65001 >nul
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set http_proxy=
set https_proxy=
set all_proxy=
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" --env-file-if-exists=.env "%~dp0src\bridge.js"