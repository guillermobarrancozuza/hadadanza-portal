@echo on
title HADADANZA Portal de Giras
color 0B

echo ========================================
echo INICIO DEL SCRIPT DE ARRANQUE SEGURO
echo ========================================

echo 0. Limpiando procesos anteriores en el puerto 3000...
powershell -Command "Stop-Process -Name node -Force -ErrorAction SilentlyContinue"
timeout /t 2 /nobreak > NUL

echo 1. Comprobando directorio actual...
cd /d "%~dp0"
dir server.js
if %errorlevel% neq 0 (
    echo ERROR: server.js no encontrado en esta carpeta.
    pause
    exit /b
)

echo 2. Comprobando si Node.js esta instalado...
node -v
if %errorlevel% neq 0 (
    echo ERROR: Node.js no esta disponible en el PATH.
    pause
    exit /b
)

echo 3. Instalando dependencias...
call npm install express cors body-parser better-sqlite3 express-session bcrypt passport passport-google-oauth20 node-cron --no-fund --no-audit
if %errorlevel% neq 0 (
    echo ERROR: NPM fallo al instalar.
    pause
    exit /b
)

echo 4. Abriendo navegador...
start http://localhost:3000

echo 5. Arrancando servidor (Seguro)...
node server.js

echo.
echo EL SERVIDOR SE HA DETENIDO O HA DADO UN ERROR.
pause
cmd /k
