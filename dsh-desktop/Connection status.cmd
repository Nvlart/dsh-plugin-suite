@echo off
start "" powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0manage-tunnel.ps1" -Action Status -ShowWindow
