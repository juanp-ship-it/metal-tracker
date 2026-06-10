@echo off
title MetalTrack - Instalacion
color 0A
echo.
echo ==========================================
echo   MetalTrack - Instalador
echo ==========================================
echo.

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Node.js NO esta instalado.
    echo.
    echo Descargalo desde: https://nodejs.org
    echo Instala la version LTS (Long Term Support)
    echo.
    echo Una vez instalado Node.js, ejecuta este
    echo archivo nuevamente.
    echo.
    pause
    start https://nodejs.org
    exit /b 1
)

echo [OK] Node.js encontrado:
node --version
echo.

echo [..] Instalando dependencias...
cd /d "%~dp0"
npm install
if %errorlevel% neq 0 (
    echo [ERROR] Fallo la instalacion de dependencias
    pause
    exit /b 1
)

echo.
echo [OK] Instalacion completa!
echo.
echo Iniciando MetalTrack...
echo.
npm start
pause
