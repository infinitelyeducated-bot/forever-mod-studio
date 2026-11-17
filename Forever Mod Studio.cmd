@echo off
rem Forever Mod Studio: starts the desktop app (Electron). If Electron is not
rem installed it falls back to the same page in an Edge app window.
cd /d "%~dp0"
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" .
  exit /b 0
)
echo Electron is not installed in this folder: opening the studio in an Edge window instead.
echo Run "npm install" in this folder to get the standalone window.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js, then run this file again.
  pause
  exit /b 1
)
start "Forever Mod Studio server" /min node server.cjs 8811
timeout /t 2 /nobreak >nul
start "" msedge --app=http://127.0.0.1:8811/
