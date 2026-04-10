@echo off
cd /d %~dp0

echo [1/2] Cleaning old processes...
powershell -Command "Get-Process | Where-Object { $_.Path -like '*Python314*' } | Stop-Process -Force -ErrorAction SilentlyContinue"
powershell -Command "Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Where-Object { $_ -gt 0 } | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
timeout /t 2 /nobreak >nul

echo [2/2] Starting backend...
.venv\Scripts\python.exe start_server.py
