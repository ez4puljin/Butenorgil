@echo off
REM =========================================================
REM  ERP-г Windows-д нэвтрэхэд АВТОМАТ асдаг болгоно.
REM  ЭНЭ ФАЙЛЫГ НЭГ УДАА, Administrator-аар ажиллуулна
REM  (баруун товч > "Run as administrator").
REM
REM  BIOS "Restore on AC Power Loss = On" + Windows авто-нэвтрэлт-тэй
REM  хослуулбал тог тасраад ирэхэд систем БҮРЭН өөрөө сэргэнэ.
REM =========================================================
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

REM ---- Administrator эрх шаардана (/RL HIGHEST task-д) ----
fltmc >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [X] Administrator эрхээр ажиллуулна уу.
    echo       setup_autostart.bat дээр баруун товч ^> "Run as administrator"
    echo.
    pause
    exit /b 1
)

echo.
echo   "ERP Startup" scheduled task бүртгэж байна (нэвтрэхэд ажиллана)...
schtasks /Create /TN "ERP Startup" /TR "\"%ROOT%\startup.bat\"" /SC ONLOGON /RL HIGHEST /DELAY 0000:30 /F
if errorlevel 1 (
    echo.
    echo   [X] Task үүсгэж чадсангүй. Дээрх алдааг шалгана уу.
    echo.
    pause
    exit /b 1
)

echo.
echo   [OK] Болсон. Та нэвтэрсний ~30с дараа ERP автоматаар асна.
echo.
echo   ================= ҮЛДСЭН ГАРААР ХИЙХ АЛХАМ =================
echo   (дэлгэрэнгүй: SETUP_MONITORING.md)
echo     1. BIOS: "Restore on AC Power Loss" = Power On (тог ирэхэд PC асна)
echo     2. Windows авто-нэвтрэлт нээх (netplwiz)
echo     3. backend\.env-д HEARTBEAT_URL + Telegram token/chat id бөглөх
echo   ===========================================================
echo.
echo   Устгах бол:  schtasks /Delete /TN "ERP Startup" /F
echo.
pause
endlocal
