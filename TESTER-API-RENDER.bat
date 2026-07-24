@echo off
set /p API_URL=Colle l'adresse de l'API Render sans slash final : 
start "Test API DanaTrap" "%API_URL%/health"
