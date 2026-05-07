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

REM ---- Frontend ----
echo [3/4] Setting up frontend...
pushd "!ROOT!\frontend"

echo   Running npm install (this may take several minutes)...
call npm install
if errorlevel 1 (
    popd
    goto :err_npm
)

popd
echo   [OK] Frontend ready.
echo.

REM ---- Start services ----
echo [4/4] Starting services...
echo.
echo   Backend  -^> http://localhost:8000
echo   Frontend -^> http://localhost:3000
echo.

REM Use start /D to set working directory - avoids path quoting issues with spaces.
REM Use the venv's python directly (no `call activate`) so the `--reload`
REM watchfiles subprocess inherits the same interpreter.
start "ERP-Backend" /D "!ROOT!\backend" cmd /k ".venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"

REM Give backend a moment to bind the port
timeout /t 3 /nobreak >nul

start "ERP-Frontend" /D "!ROOT!\frontend" cmd /k "npm run dev"

echo.
echo =========================================================
echo   DONE - Backend and Frontend are starting in new windows.
echo   Close those windows to stop the services.
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
