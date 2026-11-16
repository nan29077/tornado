@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 도네이도 - 테스트 더미 데이터 정리

echo.
echo ==========================================
echo   테스트 더미 데이터 정리 (배포 전 필수)
echo ==========================================
echo.
echo   demo- 로 시작하는 더미 크리에이터 · 상품을 모두 지웁니다.
echo   실제 데이터는 건드리지 않습니다.
echo.
echo   * 미리보기(1_미리보기실행.bat)를 쓰는 경우:
echo     .env 의 DEMO_DATA 를 clean 으로 바꾸고 미리보기를 다시 켠 뒤
echo     메인 화면을 한 번 열면 자동으로 정리됩니다. (그 다음 DEMO_DATA 줄을 지우세요)
echo.
echo   * 이 도구는 개발 서버 DB(.env 의 DATABASE_URL)를 정리합니다.
echo.
set /p CONFIRM="계속하려면 Y 를 입력하세요: "
if /i not "%CONFIRM%"=="Y" (
  echo 취소했습니다.
  pause
  exit /b 0
)

call "%~dp0tools\ensure-deps.bat"
if errorlevel 1 (
  pause
  exit /b 1
)

call npx tsx scripts/demo-data.ts clean
if errorlevel 1 (
  echo.
  echo [실패] 데이터베이스 연결을 확인해 주세요. 도구_DB시작.bat 을 먼저 실행해 보세요.
  pause
  exit /b 1
)
echo.
echo 정리했습니다. .env 의 DEMO_DATA 줄도 지우거나 false 로 바꿔 주세요.
pause
