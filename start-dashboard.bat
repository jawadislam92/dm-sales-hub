@echo off
REM ==== Daily Mentor Sales Dashboard — one-click start ====
REM Double-click this file, then open the address it prints in your browser.
cd /d "%~dp0"
set PATH=C:\laragon\bin\nodejs\node-v22;%PATH%
echo.
echo   Starting the Daily Mentor dashboard...
echo   When it says "server listening", open this in your browser:
echo.
echo        http://localhost:8791
echo.
echo   (Leave this window open while you use the dashboard. Close it to stop.)
echo.
node node_modules\tsx\dist\cli.mjs src\server.ts 8791
pause
