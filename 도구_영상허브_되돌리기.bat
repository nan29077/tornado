@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 도네이도 - 영상 허브 되돌리기
echo.
echo ==========================================
echo   영상 허브(2026-11-16) 적용 전으로 되돌리기
echo ==========================================
echo.
echo   - 기존 파일 3개를 마지막 커밋(841ab57) 상태로 되돌립니다.
echo   - 새로 만든 파일 15개는 지우지 않고 백업 폴더로 옮깁니다.
echo   - DB 는 건드리지 않습니다 (이번 작업은 DB 변경이 없습니다).
echo   - 다시 적용하려면 docs\영상허브_되돌리기_안내.md 를 보세요.
echo.
echo   [참고] 되돌리지 않고 잠시 끄기만 하려면 .env 에
echo          VIDEO_HUB_ENABLED=false 를 넣고 서버를 다시 켜면 됩니다.
echo.
choice /c YN /m "지금 되돌릴까요"
if errorlevel 2 goto :cancel

where git >nul 2>nul || (echo [중단] git 을 찾을 수 없습니다. & goto :end)
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set TS=%%i
set "BK=tmp\영상허브_되돌림_백업_%TS%"
mkdir "%BK%" 2>nul

echo.
echo [1/3] 현재 상태를 백업합니다: %BK%
if exist "src\app\page.tsx" ( mkdir "%BK%\src\app" 2>nul & copy /y "src\app\page.tsx" "%BK%\src\app\page.tsx" >nul )
if exist "src\components\layout\public-shell-client.tsx" ( mkdir "%BK%\src\components\layout" 2>nul & copy /y "src\components\layout\public-shell-client.tsx" "%BK%\src\components\layout\public-shell-client.tsx" >nul )
if exist "src\components\layout\public-shell.tsx" ( mkdir "%BK%\src\components\layout" 2>nul & copy /y "src\components\layout\public-shell.tsx" "%BK%\src\components\layout\public-shell.tsx" >nul )
if exist "src\app\videos\page.tsx" ( mkdir "%BK%\src\app\videos" 2>nul & copy /y "src\app\videos\page.tsx" "%BK%\src\app\videos\page.tsx" >nul )
if exist "src\app\watch\[id]\page.tsx" ( mkdir "%BK%\src\app\watch\[id]" 2>nul & copy /y "src\app\watch\[id]\page.tsx" "%BK%\src\app\watch\[id]\page.tsx" >nul )
if exist "src\components\video-hub\home-video-loaders.tsx" ( mkdir "%BK%\src\components\video-hub" 2>nul & copy /y "src\components\video-hub\home-video-loaders.tsx" "%BK%\src\components\video-hub\home-video-loaders.tsx" >nul )
if exist "src\components\video-hub\home-video-pane.tsx" ( mkdir "%BK%\src\components\video-hub" 2>nul & copy /y "src\components\video-hub\home-video-pane.tsx" "%BK%\src\components\video-hub\home-video-pane.tsx" >nul )
if exist "src\components\video-hub\home-video-section.tsx" ( mkdir "%BK%\src\components\video-hub" 2>nul & copy /y "src\components\video-hub\home-video-section.tsx" "%BK%\src\components\video-hub\home-video-section.tsx" >nul )
if exist "src\components\video-hub\video-card.tsx" ( mkdir "%BK%\src\components\video-hub" 2>nul & copy /y "src\components\video-hub\video-card.tsx" "%BK%\src\components\video-hub\video-card.tsx" >nul )
if exist "src\components\video-hub\video-hub-header.tsx" ( mkdir "%BK%\src\components\video-hub" 2>nul & copy /y "src\components\video-hub\video-hub-header.tsx" "%BK%\src\components\video-hub\video-hub-header.tsx" >nul )
if exist "src\components\video-hub\video-hub-shell.tsx" ( mkdir "%BK%\src\components\video-hub" 2>nul & copy /y "src\components\video-hub\video-hub-shell.tsx" "%BK%\src\components\video-hub\video-hub-shell.tsx" >nul )
if exist "src\components\video-hub\video-player.tsx" ( mkdir "%BK%\src\components\video-hub" 2>nul & copy /y "src\components\video-hub\video-player.tsx" "%BK%\src\components\video-hub\video-player.tsx" >nul )
if exist "src\lib\video-hub.ts" ( mkdir "%BK%\src\lib" 2>nul & copy /y "src\lib\video-hub.ts" "%BK%\src\lib\video-hub.ts" >nul )
if exist "src\server\services\video-hub-channels.ts" ( mkdir "%BK%\src\server\services" 2>nul & copy /y "src\server\services\video-hub-channels.ts" "%BK%\src\server\services\video-hub-channels.ts" >nul )
if exist "src\server\services\video-hub-parse.ts" ( mkdir "%BK%\src\server\services" 2>nul & copy /y "src\server\services\video-hub-parse.ts" "%BK%\src\server\services\video-hub-parse.ts" >nul )
if exist "src\server\services\video-hub-sample.ts" ( mkdir "%BK%\src\server\services" 2>nul & copy /y "src\server\services\video-hub-sample.ts" "%BK%\src\server\services\video-hub-sample.ts" >nul )
if exist "src\server\services\video-hub.ts" ( mkdir "%BK%\src\server\services" 2>nul & copy /y "src\server\services\video-hub.ts" "%BK%\src\server\services\video-hub.ts" >nul )
if exist "tests\video-hub.test.ts" ( mkdir "%BK%\tests" 2>nul & copy /y "tests\video-hub.test.ts" "%BK%\tests\video-hub.test.ts" >nul )

echo [2/3] 기존 파일 3개를 커밋 상태로 되돌립니다
git checkout -- "src/app/page.tsx" "src/components/layout/public-shell-client.tsx" "src/components/layout/public-shell.tsx"
if errorlevel 1 (echo [중단] git 되돌리기에 실패했습니다. 백업은 %BK% 에 있습니다. & goto :end)

echo [3/3] 새 파일 15개를 치웁니다 (백업 폴더에 사본이 있습니다)
if exist "src\app\videos\page.tsx" del /q "src\app\videos\page.tsx"
if exist "src\app\watch\[id]\page.tsx" del /q "src\app\watch\[id]\page.tsx"
if exist "src\components\video-hub\home-video-loaders.tsx" del /q "src\components\video-hub\home-video-loaders.tsx"
if exist "src\components\video-hub\home-video-pane.tsx" del /q "src\components\video-hub\home-video-pane.tsx"
if exist "src\components\video-hub\home-video-section.tsx" del /q "src\components\video-hub\home-video-section.tsx"
if exist "src\components\video-hub\video-card.tsx" del /q "src\components\video-hub\video-card.tsx"
if exist "src\components\video-hub\video-hub-header.tsx" del /q "src\components\video-hub\video-hub-header.tsx"
if exist "src\components\video-hub\video-hub-shell.tsx" del /q "src\components\video-hub\video-hub-shell.tsx"
if exist "src\components\video-hub\video-player.tsx" del /q "src\components\video-hub\video-player.tsx"
if exist "src\lib\video-hub.ts" del /q "src\lib\video-hub.ts"
if exist "src\server\services\video-hub-channels.ts" del /q "src\server\services\video-hub-channels.ts"
if exist "src\server\services\video-hub-parse.ts" del /q "src\server\services\video-hub-parse.ts"
if exist "src\server\services\video-hub-sample.ts" del /q "src\server\services\video-hub-sample.ts"
if exist "src\server\services\video-hub.ts" del /q "src\server\services\video-hub.ts"
if exist "tests\video-hub.test.ts" del /q "tests\video-hub.test.ts"
rmdir "src\app\watch\[id]" 2>nul
rmdir "src\app\watch" 2>nul
rmdir "src\app\videos" 2>nul
rmdir "src\components\video-hub" 2>nul

echo.
echo 완료했습니다. git status 결과:
git status --short
echo.
echo   미리보기를 켜 둔 상태라면 1_미리보기실행.bat 을 다시 실행해 주세요 (재빌드).
goto :end
:cancel
echo 취소했습니다. 아무것도 바꾸지 않았습니다.
:end
echo.
pause
