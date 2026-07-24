@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe ou n'est pas dans le PATH.
  echo Installe Node.js 20 ou superieur puis relance ce fichier.
  pause
  exit /b 1
)
node tools\get-google-refresh-token.mjs
pause
