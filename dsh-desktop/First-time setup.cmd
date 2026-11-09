@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage-tunnel.ps1" -Action Configure
if errorlevel 1 pause
