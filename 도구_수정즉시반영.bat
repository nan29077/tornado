@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 토네이도 - 개발 모드 미리보기 (수정 즉시 반영)

set TORNADO_URL=http://localhost:3025
set PREVIEW_MODE=dev

echo.
echo ==========================================
echo   토네이도 TORNADO - 개발 모드 미리보기
echo   %TORNADO_URL%
echo ==========================================
echo.
echo   코드를 저장하면 서버 재시작 없이 화면에 바로 반영됩니다.
echo   내장 데이터베이스(PGlite)를 사용하며 별도 설치가 필요 없습니다.
echo.
echo   [차이점]
echo     1_미리보기실행.bat  : 실제 서비스와 같은 빌드. 처음 실행에 1~3분
echo     도구_수정즉시반영.bat      : 수정 즉시 반영. 대신 화면을 처음 열 때 조금 느림
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js 를 찾을 수 없습니다.
  echo        https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo [확인] Node.js %%v

if not exist ".env" copy /y ".env.example" ".env" >nul

call "%~dp0tools\ensure-deps.bat"
if errorlevel 1 (
  pause
  exit /b 1
)

rem 스키마가 바뀌면(새 마이그레이션 등) 생성된 Prisma 클라이언트도 다시 만든다.
rem 예전에는 폴더가 없을 때만 생성해, 스키마 변경 뒤 빌드가 "모델 없음" 으로 실패했다.
set NEED_GEN=0
if not exist "src\generated\prisma" set NEED_GEN=1
if not exist "src\generated\.schema-stamp" set NEED_GEN=1
if exist "src\generated\.schema-stamp" (
  fc /b "prisma\schema.prisma" "src\generated\.schema-stamp" >nul 2>&1
  if errorlevel 1 set NEED_GEN=1
)
if "%NEED_GEN%"=="1" (
  echo [작업] Prisma 클라이언트 생성
  if not exist "logs" mkdir "logs"
  call npm run db:generate 2>&1
  if errorlevel 1 (
    echo.
    echo [오류] Prisma 클라이언트 생성에 실패했습니다. 도구_환경점검.bat 으로 점검해 주세요.
    echo.
    pause
    exit /b 1
  )
  copy /y "prisma\schema.prisma" "src\generated\.schema-stamp" >nul
)

netstat -ano | findstr /r /c:":3025 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [정리] 이전에 실행된 서버가 남아 있습니다. 정리한 뒤 새로 시작합니다.
)

echo.
echo [안내] 준비가 끝나면 브라우저가 자동으로 열립니다. (보통 10초 내외)
echo        이후에는 파일을 저장할 때마다 화면이 자동으로 갱신됩니다.
echo        종료하려면 이 창에서 Ctrl+C 를 누르거나 창을 닫으세요.
echo.
echo   메인        %TORNADO_URL%
echo   크리에이터  %TORNADO_URL%/studio   creator1@tornado.kr / tornado1234!
echo   관리자      %TORNADO_URL%/admin    admin@tornado.kr / tornado1234!
echo   후원자      %TORNADO_URL%/my       donor@tornado.kr / tornado1234!
echo.

call npm run preview
set PREVIEW_EXIT=%errorlevel%

echo.
if not "%PREVIEW_EXIT%"=="0" (
  echo ==========================================
  echo   [오류] 개발 모드 미리보기가 정상 종료되지 않았습니다.
  echo   화면 컴파일 오류가 반복되면 1_미리보기실행.bat 으로 실행해 보세요.
  echo ==========================================
) else (
  echo [종료] 개발 서버가 종료되었습니다.
)
echo.
pause

endlocal
