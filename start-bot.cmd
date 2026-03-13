@echo off
setlocal
set "LOGDIR=E:\Dev\bot-screaping-shopee\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

rem Avoid multiple instances
tasklist /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq shopee-promo-bot" | find /I "node.exe" >nul
if %ERRORLEVEL%==0 exit /b 0

cd /d E:\Dev\bot-screaping-shopee
start "shopee-promo-bot" /min cmd /c "npm.cmd run dev >> \"%LOGDIR%\bot.log\" 2>&1"
