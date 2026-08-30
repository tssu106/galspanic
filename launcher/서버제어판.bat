@echo off
chcp 65001 >nul
title galspanic 서버 제어판
cd /d "%~dp0"
echo galspanic 서버 제어판을 시작합니다...
echo 브라우저에서 http://localhost:5050 이 열립니다.
echo 이 창을 닫아도 게임 서버는 계속 실행됩니다. (제어판만 종료됨)
echo.
node launcher.js
pause
