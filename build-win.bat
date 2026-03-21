@echo off
setlocal

echo ============================================================
echo  BASSM ^| Windows Build
echo ============================================================
echo.

echo [1/2] Installiere Abhaengigkeiten...
call npm install
if %ERRORLEVEL% neq 0 (
    echo FEHLER: npm install fehlgeschlagen.
    exit /b 1
)

echo.
echo [2/2] Erstelle Electron-App fuer Windows...
call npx electron-builder --win --x64 --publish never --config.directories.output=dist\windows
if %ERRORLEVEL% neq 0 (
    echo FEHLER: electron-builder fehlgeschlagen.
    exit /b 1
)

echo.
echo ============================================================
echo  Build fertig: dist\windows\BASSM-win-x64.exe
echo ============================================================
endlocal
