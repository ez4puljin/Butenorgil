@echo off
REM =========================================================
REM   ERP - Developer mode (Vite HMR + uvicorn --reload)
REM   For production / LAN access use: startup.bat
REM =========================================================
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo.
echo ========================================
echo   ERP services - DEVELOPER MODE
echo ========================================
echo.

echo [1/2] Starting Backend (port 8000, --reload)...
start "ERP-Backend" /D "%ROOT%\backend" cmd /k ".venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"

echo [2/2] Starting Frontend (port 3000, vite dev)...
start "ERP-Frontend" /D "%ROOT%\frontend" cmd /k "npm run dev"

echo.
echo ========================================
echo   Backend:  http://localhost:8000
echo   Frontend: http://localhost:3000
echo.
echo   Note: dev mode is for the developer's local browser only.
echo   For phones / other PCs, run startup.bat instead so the
echo   backend serves the built frontend on a single port (8000).
echo ========================================
endlocal
