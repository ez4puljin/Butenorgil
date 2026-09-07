@echo off
REM =========================================================
REM  Үнэ харах KIOSK — auto-restart on crash.
REM
REM  ТУСДАА порт (8100) дээр ЗӨВХӨН үнийн хуудсыг үйлчилнэ.
REM  Заалны таблет үүн рүү хандана — үндсэн ERP (:8000) руу ОРОХГҮЙ,
REM  тиймээс дотоод цэс, өгөгдөл гаднын хүнд харагдахгүй.
REM
REM  Зогсоохдоо: kiosk_stop.flag файл үүсгэнэ (эсвэл цонхыг хаана).
REM =========================================================
title ERP-Kiosk (Үнэ харах)
cd /d "%~dp0"

if exist "kiosk_stop.flag" del /q "kiosk_stop.flag" >nul 2>&1

:loop
if exist "kiosk_stop.flag" (
    del /q "kiosk_stop.flag" >nul 2>&1
    echo [OK] Stop requested - kiosk will not restart.
    timeout /t 2 /nobreak >nul
    exit /b 0
)

REM HTTPS ЗААВАЛ — хөтөч камерыг зөвхөн secure context дээр нээнэ.
set "MODE=HTTP"
if exist "app\data\certs\server.key" if exist "app\data\certs\server.crt" set "MODE=HTTPS"

if "%MODE%"=="HTTPS" (
    echo.
    echo [%date% %time%] Kiosk starting ^(HTTPS^) on :8100 ...
    .venv\Scripts\python.exe -m uvicorn kiosk_app:app --host 0.0.0.0 --port 8100 --ssl-keyfile app/data/certs/server.key --ssl-certfile app/data/certs/server.crt
) else (
    echo.
    echo [!] WARNING: cert missing - camera will NOT work over plain HTTP.
    echo [%date% %time%] Kiosk starting ^(HTTP^) on :8100 ...
    .venv\Scripts\python.exe -m uvicorn kiosk_app:app --host 0.0.0.0 --port 8100
)

if exist "kiosk_stop.flag" (
    del /q "kiosk_stop.flag" >nul 2>&1
    echo.
    echo [OK] Stopped - kiosk will not restart.
    timeout /t 2 /nobreak >nul
    exit /b 0
)

echo.
echo [!] Kiosk exited/crashed. Auto-restarting in 3s...
timeout /t 3 /nobreak >nul
goto loop
