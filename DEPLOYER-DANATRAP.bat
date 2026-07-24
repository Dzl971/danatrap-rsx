@echo off
chcp 65001 >nul
cd /d "%~dp0"
title DanaTrap RSX - Deploiement automatique

where py >nul 2>&1
if %errorlevel%==0 (
    py -3 "DEPLOYER-DANATRAP.py" %*
    goto :end
)

where python >nul 2>&1
if %errorlevel%==0 (
    python "DEPLOYER-DANATRAP.py" %*
    goto :end
)

echo.
echo ERREUR : Python 3 est introuvable.
echo Installe Python 3 puis coche "Add Python to PATH" pendant l'installation.

:end
echo.
pause
