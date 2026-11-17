@echo off
rem Forever Mod Studio: one preview window for each of the nine "2" HUDs, tiled over the screen.
rem Change huds2 to huds for all 18, or to a list such as ForeverRogueHUD2,ForeverMageHUD2.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed in this folder. Run "npm install" here first.
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" . --each=huds2
