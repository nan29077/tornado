@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 도네이도 - MO 번호 정리

echo.
echo ==========================================
echo   구 체계 MO 번호를 1688 체계로 정리
echo ==========================================
echo.
echo   화면(미리보기)이 쓰는 데이터베이스를 정리합니다.
echo   미리보기 서버가 켜져 있으면 먼저 3_서버종료.bat 으로 꺼 주세요.
echo.
echo [1] 바뀔 대상 확인 (변경 없음)
echo.
call npm run mo:reissue -- --dry-run
if errorlevel 1 goto :fail

echo.
echo ------------------------------------------
set /p GO=위 번호들을 실제로 재발급할까요? (Y 입력): 
if /i not "%GO%"=="Y" (
  echo 취소했습니다. 아무것도 바꾸지 않았습니다.
  goto :end
)

echo.
echo [2] 재발급 실행
echo.
call npm run mo:reissue
if errorlevel 1 goto :fail
goto :end

:fail
echo.
echo 처리 중 문제가 발생했습니다. 위 메시지를 확인해 주세요.

:end
echo.
pause
