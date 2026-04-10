@echo off
cd /d %~dp0
setlocal

set LOGFILE=%~dp0backend_error.log

:loop
echo [%DATE% %TIME%] Cleaning old processes... >> "%LOGFILE%"
powershell -Command "Get-Process | Where-Object { $_.Path -like '*Python314*' } | Stop-Process -Force -ErrorAction SilentlyContinue"
powershell -Command "Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Where-Object { $_ -gt 0 } | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
timeout /t 2 /nobreak >nul

echo [%DATE% %TIME%] Starting backend... >> "%LOGFILE%"
echo [%DATE% %TIME%] Starting backend...

.venv\Scripts\python.exe start_server.py >> "%LOGFILE%" 2>&1

set ERR=%ERRORLEVEL%
echo [%DATE% %TIME%] Backend stopped (exit code: %ERR%) >> "%LOGFILE%"
echo.
echo ============================================================
echo  Backend stopped! Exit code: %ERR%
echo  Log file: %LOGFILE%
echo ============================================================
echo.

if %ERR% NEQ 0 (
    echo Error detected. Last 30 lines:
    echo ----------------------------------------
    powershell -Command "Get-Content '%LOGFILE%' | Select-Object -Last 30"
    echo.
    echo Restarting in 5 seconds...
    timeout /t 5 /nobreak >nul
    goto loop
) else (
    echo Stopped by user.
    pause
)
