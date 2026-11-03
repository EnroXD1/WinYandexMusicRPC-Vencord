@echo off
setlocal
chcp 65001 >nul
title WinYandexMusicRPC - Installer
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup.ps1" -Action Install
set "WYM_RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %WYM_RESULT%
