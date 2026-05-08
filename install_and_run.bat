@echo off
REM =========================================================
REM   ERP - Install and Run
REM   Works in 3 scenarios:
REM     1) Run from inside a cloned repo (most common)
REM     2) Run as standalone bat (will clone repo as subfolder)
REM     3) Run with existing cloned repo as sibling/subfolder
REM =========================================================

REM ---- Self-restart in cmd /k so double-click keeps window open on error ----
if /i not "%~1"=="--inner" (
    cmd /k "%~f0" --inner %*
    exit /b
)

setlocal enabledelayedexpansion

set "REPO_URL=https://github.com/ez4puljin/Butenorgil.git"
set "REPO_NAME=Butenorgil"

REM Resolve directory of this bat (always absolute, with no trailing backslash)
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

echo.
echo =========================================================
echo   ERP - Install and Run
echo =========================================================
echo   Script location: %SCRIPT_DIR%
echo.

REM ---- Tools check ----
echo [Check] Verifying required tools...

where git >nul 2>&1
if errorlevel 1 goto :err_no_git
echo   [OK] Git

where python >nul 2>&1
if errorlevel 1 goto :err_no_python
echo   [OK] Python

where node >nul 2>&1
if errorlevel 1 goto :err_no_node
echo   [OK] Node.js

where npm >nul 2>&1
if errorlevel 1 goto :err_no_npm
echo   [OK] npm

echo.

REM ---- Determine project ROOT ----
set "ROOT="
set "ACTION="

if exist "%SCRIPT_DIR%\.git" (
    set "ROOT=%SCRIPT_DIR%"
    set "ACTION=pull"
)

if not defined ROOT if exist "%SCRIPT_DIR%\%REPO_NAME%\.git" (
    set "ROOT=%SCRIPT_DIR%\%REPO_NAME%"
    set "ACTION=pull"
)

if not defined ROOT (
    set "ROOT=%SCRIPT_DIR%\%REPO_NAME%"
    set "ACTION=clone"
)

echo [1/4] Project root: !ROOT!
echo        Action: !ACTION!

if /i "!ACTION!"=="clone" goto :do_clone
goto :do_pull

:do_clone
if exist "!ROOT!" goto :err_root_exists
echo   Cloning %REPO_URL% ...
pushd "%SCRIPT_DIR%"
git clone "%REPO_URL%" "%REPO_NAME%"
if errorlevel 1 (
    popd
    goto :err_clone
)
popd
goto :after_action

:do_pull
echo   Pulling latest changes ...
pushd "!ROOT!"
git pull --ff-only
if errorlevel 1 (
    echo   [!] git pull failed; continuing with local code.
)
popd
goto :after_action

:after_action

REM ---- Verify expected folders ----
if not exist "!ROOT!\backend\requirements.txt" goto :err_no_backend
if not exist "!ROOT!\frontend\package.json"    goto :err_no_frontend

echo.

REM ---- Backend ----
echo [2/4] Setting up backend...
pushd "!ROOT!\backend"

if not exist ".venv\Scripts\python.exe" (
    echo   Creating Python virtualenv...
    python -m venv .venv
    if errorlevel 1 (
        popd
        goto :err_venv
    )
)

echo   Upgrading pip...
".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet --disable-pip-version-check

echo   Installing Python packages from requirements.txt
echo   (this may take a few minutes on first run)
".venv\Scripts\python.exe" -m pip install -r requirements.txt --disable-pip-version-check
if errorlevel 1 (
    popd
    goto :err_pip
)

popd
echo   [OK] Backend ready.
echo.

REM ---- Frontend (production build) ----
echo [3/4] Building frontend (production)...
pushd "!ROOT!\frontend"

if not exist "node_modules" (
    echo   First-time npm install...
    call npm install
    if errorlevel 1 (
        popd
        goto :err_npm
    )
) else (
    echo   node_modules exists, skipping npm install.
)

echo   Building optimized bundle (frontend\dist)...
call npm run build
if errorlevel 1 (
    popd
    goto :err_npm
)

popd
echo   [OK] Frontend built. Backend will serve it directly.
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
pushd "!ROOT!\backend"
.venv\Scripts\python.exe -m app.generate_cert
popd

REM ---- Start services ----
echo [4/4] Starting servers...
echo.
echo   App (HTTPS):         https://!LAN_IP!:8000
echo   Setup helper (HTTP): http://!LAN_IP!:8080/
echo.
echo   First time on a phone:
echo     1. Open  http://!LAN_IP!:8080/  in the phone browser
echo     2. Download rootCA.crt and install as Trusted Root
echo     3. Open the app, set Protocol=HTTPS, IP=!LAN_IP!, Port=8000
echo.

start "ERP-Server" /D "!ROOT!\backend" cmd /k ".venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --ssl-keyfile app/data/certs/server.key --ssl-certfile app/data/certs/server.crt"

REM Helper for cert download (port 8080, plain HTTP)
start "ERP-CertHelper" /D "!ROOT!\backend" /MIN cmd /k ".venv\Scripts\python.exe -m app.cert_helper_server"

echo.
echo =========================================================
echo   DONE - Server is starting in a new window.
echo   The frontend is served from the SAME port (8000) for fast
echo   access from phones and other PCs.
echo   Close the window to stop the server.
echo =========================================================
echo.
pause
endlocal
exit /b 0


REM ---- Error handlers ----
:err_no_git
echo   [X] Git not found.
echo       Install: https://git-scm.com/downloads
goto :fail

:err_no_python
echo   [X] Python not found.
echo       Install Python 3.11+ from https://www.python.org/downloads/
echo       Make sure "Add Python to PATH" is checked during install.
goto :fail

:err_no_node
echo   [X] Node.js not found.
echo       Install Node.js 20+ LTS from https://nodejs.org/
goto :fail

:err_no_npm
echo   [X] npm not found.
goto :fail

:err_root_exists
echo   [X] Folder !ROOT! already exists but is not a git repo.
echo       Please delete or rename it, then run again.
goto :fail

:err_clone
echo   [X] git clone failed. Check internet connection and URL.
goto :fail

:err_no_backend
echo   [X] backend\requirements.txt not found at !ROOT!\backend
echo       The repo structure may be incomplete.
goto :fail

:err_no_frontend
echo   [X] frontend\package.json not found at !ROOT!\frontend
goto :fail

:err_venv
echo   [X] Python virtualenv creation failed.
echo       Check that 'python' command works (Python 3.11+).
goto :fail

:err_pip
echo   [X] pip install failed.
echo       Check the error above. Possible causes: network, version mismatch.
goto :fail

:err_npm
echo   [X] npm install failed.
echo       Check the error above. Possible causes: network, Node version.
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
