@echo off
title MetalTrack
color 0A
cd /d "%~dp0"

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js no encontrado. Ejecuta INSTALAR.bat primero.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Instalando dependencias por primera vez...
    npm install
)

echo.
echo Abriendo MetalTrack en el navegador...
timeout /t 2 /nobreak >nul
start http://localhost:3000
node server.js
pause
