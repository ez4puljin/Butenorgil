@echo off
echo ========================================
echo   Stopping all ERP services...
echo ========================================
echo.

REM Signal the auto-restart wrapper (run_server_loop.bat) to stop so it does
REM NOT relaunch the backend after we kill it below.
echo [0/3] Signaling backend wrapper to stop (no auto-restart)...
if exist "%~dp0backend\run_server_loop.bat" (
    type nul > "%~dp0backend\stop.flag" 2>nul
)

echo [1/3] Stopping port 3000 (Frontend)...
for /f "tokens=5" %%p in ('netstat -aon 2^>nul ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo        Killing PID %%p
    taskkill /PID %%p /F >nul 2>&1
)

echo [2/3] Stopping port 3001 (Preview)...
for /f "tokens=5" %%p in ('netstat -aon 2^>nul ^| findstr ":3001" ^| findstr "LISTENING"') do (
    echo        Killing PID %%p
    taskkill /PID %%p /F >nul 2>&1
)

echo [3/3] Stopping port 8000 (Backend)...
for /f "tokens=5" %%p in ('netstat -aon 2^>nul ^| findstr ":8000" ^| findstr "LISTENING"') do (
    echo        Killing PID %%p
    taskkill /PID %%p /F >nul 2>&1
)

echo.
echo ========================================
echo   All services stopped.
echo ========================================
pause
