@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 도네이도 - EMMA 문자수신 폴러

echo.
echo ==========================================
echo   EMMA MO 수신 폴러 (10초 주기)
echo ==========================================
echo.
echo 이 창을 켜 두어야 후원 문자가 접수됩니다.
echo 창을 닫으면 문자 수신이 멈춥니다.
echo.
echo 종료하려면 Ctrl+C 를 누르세요.
echo ------------------------------------------
echo.

call npm run emma:poll

echo.
echo 폴러가 종료되었습니다.
pause
