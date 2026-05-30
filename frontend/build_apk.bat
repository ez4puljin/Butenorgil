@echo off
REM =========================================================
REM   Бутэн-Оргил ERP — Android APK build
REM   Энэ скрипт нь:
REM     1. Frontend-ийг production-д build хийнэ (vite)
REM     2. Capacitor sync — web assets + plugin-ийг android руу хуулна
REM     3. Gradle assembleDebug — APK үүсгэнэ
REM   Гаралт: frontend\android\app\build\outputs\apk\debug\app-debug.apk
REM =========================================================

if /i not "%~1"=="--inner" (
    cmd /k "%~f0" --inner %*
    exit /b
)

setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

REM ---- Java (Android Studio-ийн JBR ашиглана) ----
if not defined JAVA_HOME (
    if exist "C:\Program Files\Android\Android Studio\jbr\bin\java.exe" (
        set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
        echo [i] JAVA_HOME = Android Studio JBR
    )
)
if not defined JAVA_HOME (
    echo [X] JAVA_HOME олдсонгүй. Android Studio суулгасан эсэхээ шалгана уу.
    goto :fail
)

echo.
echo [1/3] Frontend build (vite)...
pushd "%ROOT%"
call npm run build
if errorlevel 1 ( popd & goto :err_build )
popd

echo.
echo [2/3] Capacitor sync (android)...
pushd "%ROOT%"
call npx cap sync android
if errorlevel 1 ( popd & goto :err_sync )
popd

echo.
echo [3/3] Gradle assembleDebug (APK)...
pushd "%ROOT%\android"
call gradlew.bat assembleDebug
if errorlevel 1 ( popd & goto :err_gradle )
popd

set "APK=%ROOT%\android\app\build\outputs\apk\debug\app-debug.apk"
echo.
echo =========================================================
if exist "%APK%" (
    echo   [OK] APK амжилттай үүслээ:
    echo   %APK%
) else (
    echo   [!] APK файл олдсонгүй. Дээрх log-ийг шалгана уу.
)
echo =========================================================
echo.
pause
endlocal
exit /b 0

:err_build
echo [X] Frontend build амжилтгүй.
goto :fail
:err_sync
echo [X] Capacitor sync амжилтгүй.
goto :fail
:err_gradle
echo [X] Gradle build амжилтгүй.
goto :fail
:fail
echo.
echo FAILED — дээрх алдааг шалгана уу.
pause
endlocal
exit /b 1
