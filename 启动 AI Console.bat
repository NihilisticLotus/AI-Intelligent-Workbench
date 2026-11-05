@echo off
chcp 65001 >nul
rem ASCII only: cmd misreads UTF-8 .bat files after running external commands. Chinese text lives in scripts\start.mjs and scripts\no-node.txt
setlocal
cd /d "%~dp0"
title AI Console

where node >nul 2>nul
if errorlevel 1 goto :no_node
set "NODE_MAJOR="
for /f "delims=" %%v in ('node -p "parseInt(process.versions.node)" 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR goto :no_node
if %NODE_MAJOR% LSS 24 goto :no_node

node scripts\start.mjs
echo.
pause
exit /b 0

:no_node
echo.
type scripts\no-node.txt
echo.
echo.
powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; $m = Get-Content -Raw -Encoding UTF8 'scripts\no-node.txt'; [void][System.Windows.MessageBox]::Show($m, 'AI Console', 'OK', 'Warning')" >nul 2>nul
start "" "https://nodejs.org/zh-cn/download"
pause
exit /b 1
