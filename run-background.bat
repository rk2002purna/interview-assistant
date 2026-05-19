@echo off
cd /d "%~dp0"
start "" /MIN cmd /c "npm start & exit"
