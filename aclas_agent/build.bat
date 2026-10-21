@echo off
rem Aclas Agent — x86 заавал (AclasSDK.dll 32-бит)
set CSC=%WINDIR%\Microsoft.NET\Framework4.0.30319\csc.exe
"%CSC%" /nologo /platform:x86 /out:"%~dp0AclasAgent.exe" /r:System.Web.Extensions.dll "%~dp0AclasAgent.cs" || exit /b 1
echo OK: AclasAgent.exe
