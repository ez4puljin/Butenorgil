@echo off
REM =========================================================
REM  ERP backend runner — auto-restart on crash.
REM  Launched by startup.bat in the backend directory:
REM      start "ERP-Server" /D "...\backend" cmd /k run_server_loop.bat
REM
REM  If uvicorn exits (crash / OOM / unhandled error) it is
REM  relaunched after 3s. To STOP without restart, stop.bat
REM  (or startup.bat) creates "stop.flag" in this folder.
REM =========================================================
title ERP-Server
cd /d "%~dp0"

REM Clear any stale stop flag left over from a previous run.
if exist "stop.flag" del /q "stop.flag" >nul 2>&1

:loop
REM Stop requested before (re)launch? -> quit without restarting.
if exist "stop.flag" (
    del /q "stop.flag" >nul 2>&1
    echo [OK] Stop requested - backend will not restart.
    timeout /t 2 /nobreak >nul
    exit /b 0
)

REM Pick HTTPS if both cert files exist, else HTTP (same rule as startup.bat).
set "MODE=HTTP"
if exist "app\data\certs\server.key" if exist "app\data\certs\server.crt" set "MODE=HTTPS"

if "%MODE%"=="HTTPS" (
    echo.
    echo [%date% %time%] Backend starting ^(HTTPS^) on :8000 ...
    .venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --ssl-keyfile app/data/certs/server.key --ssl-certfile app/data/certs/server.crt
) else (
    echo.
    echo [%date% %time%] Backend starting ^(HTTP^) on :8000 ...
    .venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000
)

REM uvicorn returned. If a stop was requested, quit; else auto-restart.
if exist "stop.flag" (
    del /q "stop.flag" >nul 2>&1
    echo.
    echo [OK] Stopped - backend will not restart.
    timeout /t 2 /nobreak >nul
    exit /b 0
)

echo.
echo [!] Backend exited/crashed. Auto-restarting in 3s...  (run stop.bat to stop)
timeout /t 3 /nobreak >nul
goto loop
