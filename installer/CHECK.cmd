@echo off
setlocal
chcp 65001 >nul
title WinYandexMusicRPC - Check
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup.ps1" -Action Check
set "WYM_RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %WYM_RESULT%
