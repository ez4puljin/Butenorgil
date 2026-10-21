@echo off
rem Aclas Agent-ийг тасралтгүй ажиллуулна (унавал 10 секундын дараа дахин асаана)
title Aclas Agent
cd /d "%~dp0"
:loop
AclasAgent.exe
timeout /t 10 /nobreak >nul
goto loop
