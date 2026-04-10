@echo off
setlocal

REM --- Backend ---
start "BACKEND" cmd /k "cd /d %~dp0backend && call startup.bat"

REM --- Frontend ---
start "FRONTEND" cmd /k "cd /d %~dp0frontend && npm install && npm run dev"

endlocal