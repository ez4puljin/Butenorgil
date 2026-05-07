@echo off
REM =========================================================
REM   ERP - Quick Startup (production mode)
REM   Assumes dependencies are already installed.
REM   For first-time setup or fresh clone use: install_and_run.bat
REM
REM   Backend (FastAPI) serves the built frontend on port 8000.
REM   Other devices on the LAN access via http://<server-ip>:8000
REM =========================================================

REM Self-restart in cmd /k so double-click keeps the window open on error.
if /i not "%~1"=="--inner" (
    cmd /k "%~f0" --inner %*
    exit /b
)

setlocal enabledelayedexpansion

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo.
echo =========================================================
echo   ERP - Startup
echo =========================================================
echo   Project: %ROOT%
echo.

REM ---- Stop any previous instance on port 8000 (avoid conflicts) ----
echo [1/3] Cleaning previous instances on port 8000...

REM Run cleanup THREE times to catch parent + child uvicorn (--reload) processes.
call :kill_port_8000
timeout /t 1 /nobreak >nul
call :kill_port_8000
timeout /t 1 /nobreak >nul
call :kill_port_8000

REM Also kill any uvicorn-bearing python processes (catches reload children
REM that may have detached from netstat's PID listing).
for /f "tokens=2 delims=," %%p in (
    'tasklist /FI "IMAGENAME eq python.exe" /FO CSV /NH 2^>nul'
) do (
    set "pid=%%~p"
    wmic process where "ProcessId=!pid!" get CommandLine 2>nul | findstr /C:"uvicorn" >nul && (
        echo   Killing uvicorn python PID !pid!
        taskkill /PID !pid! /F >nul 2>&1
    )
)

REM Give Windows time to release the socket binding.
timeout /t 2 /nobreak >nul
echo   [OK] Cleanup done.

REM ---- Sanity checks ----
if not exist "%ROOT%\backend\.venv\Scripts\python.exe" (
    echo   [X] Backend virtualenv missing.
    echo       Run install_and_run.bat first to set up the project.
    goto :fail
)

if not exist "%ROOT%\frontend\package.json" (
    echo   [X] frontend\package.json missing.
    goto :fail
)

REM ---- Build frontend if dist is missing or older than source ----
echo [2/3] Checking frontend build...
set "REBUILD=0"
if not exist "%ROOT%\frontend\dist\index.html" (
    echo   No dist found - building...
    set "REBUILD=1"
)

if "%REBUILD%"=="1" (
    pushd "%ROOT%\frontend"
    if not exist "node_modules" (
        echo   Running npm install...
        call npm install
        if errorlevel 1 (
            popd
            goto :err_npm
        )
    )
    echo   Building optimized bundle...
    call npm run build
    if errorlevel 1 (
        popd
        goto :err_build
    )
    popd
    echo   [OK] Build complete.
) else (
    echo   [OK] Existing dist will be served. Run npm run build manually if you changed sources.
)

echo.

REM ---- Start backend (serves API + frontend) ----
echo [3/3] Starting server on port 8000...
echo.
echo   Local:  http://localhost:8000
echo   LAN:    http://^<server-ip^>:8000
echo.

start "ERP-Server" /D "%ROOT%\backend" cmd /k ".venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000"

echo.
echo =========================================================
echo   DONE - Server starting in a new window.
echo   To stop: close that window or run stop.bat
echo =========================================================
echo.
pause
endlocal
exit /b 0


:err_npm
echo   [X] npm install failed.
goto :fail

:err_build
echo   [X] npm run build failed.
goto :fail

:fail
echo.
echo =========================================================
echo   FAILED - See message above.
echo =========================================================
echo.
pause
endlocal
exit /b 1


REM ---- Subroutine: kill every PID listening on port 8000 ----
:kill_port_8000
for /f "tokens=5" %%p in ('netstat -aon 2^>nul ^| findstr ":8000" ^| findstr "LISTENING"') do (
    if not "%%p"=="0" (
        echo   Killing PID %%p
        taskkill /PID %%p /F >nul 2>&1
    )
)
exit /b 0
