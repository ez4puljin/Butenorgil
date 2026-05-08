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
echo [1/3] Cleaning previous instances...

REM First pass: kill processes listening on port 8000.
call :kill_port_8000

REM Second pass: kill ALL python.exe (this is a server box - only ERP runs here).
REM This is brute force but reliable: catches uvicorn parent + reload workers
REM + multiprocessing children that often slip out of netstat's PID listing.
echo   Killing all python.exe processes...
taskkill /IM python.exe /F >nul 2>&1

REM Wait long enough for Windows to release sockets fully (TIME_WAIT cleanup).
timeout /t 3 /nobreak >nul

REM Final port verification.
netstat -ano 2>nul | findstr ":8000" | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo   [!] Port 8000 still appears bound; trying once more...
    call :kill_port_8000
    timeout /t 2 /nobreak >nul
)
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

REM ---- Detect LAN IP for the user-friendly banner ----
REM Prefer 192.168.x.x (typical home/office LAN), fallback to first IPv4.
set "LAN_IP="
for /f "tokens=2 delims=:" %%a in (
    'ipconfig ^| findstr /R /C:"IPv4 Address"'
) do (
    set "ip=%%a"
    set "ip=!ip:~1!"
    echo !ip! | findstr /R /C:"^192\.168\." >nul && (
        if not defined LAN_IP set "LAN_IP=!ip!"
    )
)
if not defined LAN_IP (
    for /f "tokens=2 delims=:" %%a in (
        'ipconfig ^| findstr /R /C:"IPv4 Address"'
    ) do (
        if not defined LAN_IP (
            set "LAN_IP=%%a"
            set "LAN_IP=!LAN_IP:~1!"
        )
    )
)
if not defined LAN_IP set "LAN_IP=<server-ip>"

REM ---- Generate HTTPS self-signed cert + auto-install in Windows trust ----
echo   Ensuring HTTPS cert exists...
pushd "%ROOT%\backend"
.venv\Scripts\python.exe -m app.generate_cert
popd

REM ---- Free port 8080 for the cert helper ----
for /f "tokens=5" %%p in ('netstat -aon 2^>nul ^| findstr ":8080" ^| findstr "LISTENING"') do (
    taskkill /PID %%p /F >nul 2>&1
)

REM ---- Start backend (HTTPS) + cert helper (HTTP, cert download only) ----
echo [3/3] Starting servers...
echo.
echo   App (HTTPS):       https://!LAN_IP!:8000
echo   Setup helper (HTTP): http://!LAN_IP!:8080/
echo.
echo   First time on a phone:
echo     1. Open  http://!LAN_IP!:8080/  in the phone's browser
echo     2. Tap "rootCA.crt download" and install it as Trusted Root
echo     3. Open the app, set Protocol=HTTPS, IP=!LAN_IP!, Port=8000
echo.

start "ERP-Server" /D "%ROOT%\backend" cmd /k ".venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --ssl-keyfile app/data/certs/server.key --ssl-certfile app/data/certs/server.crt"

REM Helper for cert download (port 8080, plain HTTP)
start "ERP-CertHelper" /D "%ROOT%\backend" /MIN cmd /k ".venv\Scripts\python.exe -m app.cert_helper_server"

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
