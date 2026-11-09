$ErrorActionPreference = 'Stop'
$taskPluginRoot = $PSScriptRoot
Start-Process -FilePath (Get-Command node).Source -ArgumentList @(('"' + (Join-Path $taskPluginRoot 'server\host.mjs') + '"')) -WorkingDirectory $taskPluginRoot -WindowStyle Hidden
Write-Host 'DSH Director starting. Check: node server/doctor.mjs'
