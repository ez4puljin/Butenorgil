@echo off
REM =========================================================
REM  Open Windows Firewall ports 8000 and 8080 for the ERP server.
REM  Run ONCE as administrator: right-click -> "Run as administrator".
REM =========================================================

REM Detect admin
fltmc >nul 2>&1
if errorlevel 1 (
    echo.
    echo   This script needs administrator rights.
    echo   Right-click open_firewall.bat -^> "Run as administrator"
    echo.
    pause
    exit /b 1
)

echo.
echo   Adding firewall rules...

netsh advfirewall firewall delete rule name="ERP App 8000" >nul 2>&1
netsh advfirewall firewall add rule name="ERP App 8000" dir=in action=allow protocol=TCP localport=8000
echo.

netsh advfirewall firewall delete rule name="ERP CertHelper 8080" >nul 2>&1
netsh advfirewall firewall add rule name="ERP CertHelper 8080" dir=in action=allow protocol=TCP localport=8080
echo.

echo.
echo   [OK] Done. Phones / other PCs can now reach:
echo        https://192.168.1.198:8000   (main app)
echo        http://192.168.1.198:8080/   (cert setup helper)
echo.
pause
