@echo off
setlocal enabledelayedexpansion

REM =========================================================
REM   ERP Setup and Run Script
REM   Clones repo, installs all dependencies, starts services
REM =========================================================

set REPO_URL=https://github.com/ez4puljin/Butenorgil.git
set REPO_DIR=Butenorgil

echo.
echo =========================================================
echo   ERP - Install and Run
echo =========================================================
echo.

REM ---- 1. Check prerequisites ----
echo [Check] Verifying required tools...

where git >nul 2>&1
if errorlevel 1 (
    echo   [X] Git not found.
    echo       Please install: https://git-scm.com/downloads
    pause
    exit /b 1
)
for /f "tokens=3" %%v in ('git --version') do set GITV=%%v
echo   [OK] Git !GITV!

where python >nul 2>&1
if errorlevel 1 (
    echo   [X] Python not found.
    echo       Please install Python 3.11+ from https://www.python.org/downloads/
    echo       Make sure to check "Add Python to PATH" during install.
    pause
    exit /b 1
)
for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYV=%%v
echo   [OK] Python !PYV!

where node >nul 2>&1
if errorlevel 1 (
    echo   [X] Node.js not found.
    echo       Please install Node.js 20+ LTS from https://nodejs.org/
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node --version') do set NODEV=%%v
echo   [OK] Node.js !NODEV!

where npm >nul 2>&1
if errorlevel 1 (
    echo   [X] npm not found.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('npm --version') do set NPMV=%%v
echo   [OK] npm !NPMV!

echo.

REM ---- 2. Determine project directory ----
REM If this script lives inside a git repo (has .git), use that.
REM Otherwise clone to a subfolder of the current location.

if exist "%~dp0.git" (
    set ROOT=%~dp0
    REM strip trailing backslash
    if "!ROOT:~-1!"=="\" set ROOT=!ROOT:~0,-1!
    echo [1/4] Using existing repo: !ROOT!
    pushd "!ROOT!"
    git pull --ff-only
    popd
) else (
    if exist "%REPO_DIR%\.git" (
        set ROOT=%CD%\%REPO_DIR%
        echo [1/4] Repo exists, pulling latest...
        pushd "!ROOT!"
        git pull --ff-only
        popd
    ) else (
        echo [1/4] Cloning %REPO_URL% ...
        git clone %REPO_URL% %REPO_DIR%
        if errorlevel 1 (
            echo   [X] git clone failed.
            pause
            exit /b 1
        )
        set ROOT=%CD%\%REPO_DIR%
    )
)
echo   Project root: !ROOT!
echo.

REM ---- 3. Backend setup ----
echo [2/4] Setting up backend...
pushd "!ROOT!\backend"

if not exist ".venv\Scripts\python.exe" (
    echo   Creating Python virtualenv...
    python -m venv .venv
    if errorlevel 1 (
        echo   [X] venv creation failed.
        popd
        pause
        exit /b 1
    )
)

echo   Upgrading pip...
.venv\Scripts\python.exe -m pip install --upgrade pip --quiet

echo   Installing Python packages from requirements.txt...
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 (
    echo   [X] pip install failed.
    popd
    pause
    exit /b 1
)

popd
echo   [OK] Backend ready.
echo.

REM ---- 4. Frontend setup ----
echo [3/4] Setting up frontend...
pushd "!ROOT!\frontend"

if not exist "node_modules" (
    echo   Running npm install (this may take several minutes)...
    call npm install
    if errorlevel 1 (
        echo   [X] npm install failed.
        popd
        pause
        exit /b 1
    )
) else (
    echo   node_modules exists, running npm install for any updates...
    call npm install
)

popd
echo   [OK] Frontend ready.
echo.

REM ---- 5. Start services ----
echo [4/4] Starting services...
echo.
echo   Backend  ^-^> http://localhost:8000
echo   Frontend ^-^> http://localhost:3000
echo.

start "ERP-Backend" cmd /k "cd /d !ROOT!\backend && call .venv\Scripts\activate && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"

REM Give the backend a moment to start binding the port
timeout /t 3 /nobreak >nul

start "ERP-Frontend" cmd /k "cd /d !ROOT!\frontend && npm run dev"

echo.
echo =========================================================
echo   DONE - Both services are starting in separate windows.
echo   Close those windows to stop the services.
echo =========================================================
echo.
pause
endlocal
