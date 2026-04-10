@echo off
echo ========================================
echo   Starting ERP services...
echo ========================================
echo.

echo [1/2] Starting Backend (port 8000)...
cd /d "%~dp0backend"
start "ERP-Backend" cmd /k "call .venv\Scripts\activate && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"

echo [2/2] Starting Frontend (port 3000)...
cd /d "%~dp0frontend"
start "ERP-Frontend" cmd /k "npm run dev"

echo.
echo ========================================
echo   Backend:  http://localhost:8000
echo   Frontend: https://192.168.1.198:3000
echo ========================================
pause
