@echo off
REM =========================================================
REM   ERP - Install and Run
REM   Clones repo, installs dependencies, starts services
REM =========================================================

REM Self-restart in a new cmd window if double-clicked, so errors do not auto-close it.
if "%~1"=="" (
    cmd /k "%~f0" --inner
    exit /b
)

setlocal enabledelayedexpansion

set "REPO_URL=https://github.com/ez4puljin/Butenorgil.git"
set "REPO_NAME=Butenorgil"
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

echo.
echo =========================================================
echo   ERP - Install and Run
echo =========================================================
echo.

REM ---- Check tools ----
echo [Check] Verifying required tools...

where git >nul 2>&1
if errorlevel 1 (
    echo   [X] Git not found.
    echo       Install: https://git-scm.com/downloads
    goto :fail
)
echo   [OK] Git

where python >nul 2>&1
if errorlevel 1 (
    echo   [X] Python not found.
    echo       Install Python 3.11+ from https://www.python.org/downloads/
    echo       Make sure "Add Python to PATH" is checked.
    goto :fail
)
echo   [OK] Python

where node >nul 2>&1
if errorlevel 1 (
    echo   [X] Node.js not found.
    echo       Install Node.js 20+ LTS from https://nodejs.org/
    goto :fail
)
echo   [OK] Node.js

where npm >nul 2>&1
if errorlevel 1 (
    echo   [X] npm not found.
    goto :fail
)
echo   [OK] npm

echo.

REM ---- Determine project ROOT ----
set "ROOT="
if exist "%SCRIPT_DIR%\.git" (
    set "ROOT=%SCRIPT_DIR%"
    echo [1/4] Using existing repo: !ROOT!
    pushd "!ROOT!"
    git pull --ff-only
    popd
) else (
    if exist "%SCRIPT_DIR%\%REPO_NAME%\.git" (
        set "ROOT=%SCRIPT_DIR%\%REPO_NAME%"
        echo [1/4] Repo exists, pulling latest...
        pushd "!ROOT!"
        git pull --ff-only
        popd
    ) else (
        echo [1/4] Cloning %REPO_URL%
        pushd "%SCRIPT_DIR%"
        git clone %REPO_URL% %REPO_NAME%
        if errorlevel 1 (
            popd
            echo   [X] git clone failed.
            goto :fail
        )
        popd
        set "ROOT=%SCRIPT_DIR%\%REPO_NAME%"
    )
)
echo   Project root: !ROOT!
echo.

REM ---- Backend ----
echo [2/4] Setting up backend...
pushd "!ROOT!\backend"
if errorlevel 1 (
    echo   [X] backend folder not found at !ROOT!\backend
    goto :fail
)

if not exist ".venv\Scripts\python.exe" (
    echo   Creating Python virtualenv...
    python -m venv .venv
    if errorlevel 1 (
        echo   [X] venv creation failed.
        popd
        goto :fail
    )
)

echo   Upgrading pip...
".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet --disable-pip-version-check

echo   Installing Python packages from requirements.txt
echo   (this may take a few minutes on first run)
".venv\Scripts\python.exe" -m pip install -r requirements.txt --disable-pip-version-check
if errorlevel 1 (
    echo   [X] pip install failed.
    popd
    goto :fail
)

popd
echo   [OK] Backend ready.
echo.

REM ---- Frontend ----
echo [3/4] Setting up frontend...
pushd "!ROOT!\frontend"
if errorlevel 1 (
    echo   [X] frontend folder not found at !ROOT!\frontend
    goto :fail
)

echo   Running npm install (this may take several minutes)...
call npm install
if errorlevel 1 (
    echo   [X] npm install failed.
    popd
    goto :fail
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

start "ERP-Backend" cmd /k "cd /d \"!ROOT!\backend\" && call .venv\Scripts\activate && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"

REM Give backend a moment to bind the port
timeout /t 3 /nobreak >nul

start "ERP-Frontend" cmd /k "cd /d \"!ROOT!\frontend\" && npm run dev"

echo.
echo =========================================================
echo   DONE - Backend and Frontend are starting in new windows.
echo   Close those windows to stop the services.
echo =========================================================
echo.
pause
endlocal
exit /b 0


:fail
echo.
echo =========================================================
echo   FAILED - See message above.
echo =========================================================
echo.
pause
endlocal
exit /b 1
