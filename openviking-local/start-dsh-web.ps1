# Arguments following -File are passed to DSH Web, e.g. --port 3081.
$ErrorActionPreference = 'Stop'
$webArguments = @($args | ForEach-Object { [string]$_ })
$memoryRoot = $PSScriptRoot
$memoryConfig = Join-Path $memoryRoot 'runtime\private\ov.conf'
$memoryPython = Join-Path $memoryRoot '.venv\Scripts\python.exe'
$memoryLog = Join-Path $memoryRoot 'runtime\server.linked.log'
$npmRoot = Join-Path $env:APPDATA 'npm'
$dshEntry = Join-Path $npmRoot 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$node = Join-Path $npmRoot 'node.exe'
$tunnelRoot = Join-Path (Split-Path -Parent $memoryRoot) 'dsh-desktop'
$tunnelScript = Join-Path $tunnelRoot 'manage-tunnel.ps1'
$tunnelLog = Join-Path $tunnelRoot 'runtime\private\linked-tunnel.log'
$tunnelHealthFile = Join-Path $tunnelRoot 'runtime\private\linked-health.url'
$bridgeConfig = if($env:DSH_DESKTOP_CONFIG){$env:DSH_DESKTOP_CONFIG}else{Join-Path $HOME '.dsh-desktop\config.json'}
$winPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$launchDirectory = (Get-Location).ProviderPath
$mutex = New-Object Threading.Mutex($false, 'Local\DSH.Web.OpenViking.Linked')
$locked = $false
$job = $null
$memory = $null
$web = $null
$tunnel = $null
$exitCode = 1

function Read-LocalMemory([string]$Endpoint) {
    try {
        return Invoke-RestMethod -Uri ('http://127.0.0.1:1933/' + $Endpoint) -TimeoutSec 2
    } catch { return $null }
}

function Read-LinkedTunnelReady {
    if(!(Test-Path -LiteralPath $tunnelHealthFile)){return $false}
    try {
        $base=(Get-Content -LiteralPath $tunnelHealthFile -Raw).Trim()
        if($base -notmatch '^http://127\.0\.0\.1:(\d+)$'){return $false}
        $owner=Get-NetTCPConnection -State Listen -LocalPort ([int]$Matches[1]) -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess
        if(!$owner -or !$job.Owns($owner)){return $false}
        $metrics=(Invoke-WebRequest -UseBasicParsing -Uri ($base+'/metrics') -TimeoutSec 2).Content
        return $metrics -match '(?m)^commands_poll_last_successful_timestamp_seconds(?:\{[^\r\n]*\})?\s+[1-9][0-9.eE+\-]*\s*$'
    } catch { return $false }
}

try {
    try { $locked = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { throw 'DSH Web and OpenViking are already being managed by another launcher window.' }
    foreach ($required in @($memoryConfig, $memoryPython, $dshEntry)) {
        if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw ('Required file missing: ' + $required) }
    }
    if (!(Test-Path -LiteralPath $node -PathType Leaf)) { $node = (Get-Command node.exe -ErrorAction Stop).Source }
    if (Get-NetTCPConnection -State Listen -LocalPort 1933 -ErrorAction SilentlyContinue) {
        throw 'Port 1933 is already in use. Stop the standalone OpenViking instance before launching the linked pair.'
    }

    $env:LITELLM_LOCAL_MODEL_COST_MAP = 'True'
    Add-Type -Path (Join-Path $memoryRoot 'LinkedProcessJob.cs')
    $job = New-Object LinkedProcessJob
    Write-Host 'Starting OpenViking ...'
    $memory = $job.Start($memoryPython, [string[]]@('-m', 'openviking_cli.server_bootstrap', '--config', $memoryConfig, '--host', '127.0.0.1', '--port', '1933'), $memoryRoot, $memoryLog)
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    $ready = $false
    do {
        Start-Sleep -Milliseconds 500
        if ($memory.Exited) { throw ('OpenViking exited. Log: ' + $memoryLog) }
        $health = Read-LocalMemory 'health'
        if ($health.healthy -ne $true) { continue }
        if ((Read-LocalMemory 'ready').status -ne 'ready') { continue }
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 1933 -ErrorAction SilentlyContinue)
        $ready = $listeners.Count -gt 0 -and @($listeners | Where-Object { !$job.Owns($_.OwningProcess) }).Count -eq 0
    } while (!$ready -and [DateTime]::UtcNow -lt $deadline)
    if (!$ready) { throw ('OpenViking did not become ready in time. Log: ' + $memoryLog) }

    Write-Host 'OpenViking is ready. Starting DSH Web ...'
    Write-Host 'Close this window or press Ctrl+C to stop DSH Web, OpenViking and the ChatGPT tunnel.'
    $openBrowser = $webArguments -notcontains '--no-open'
    # The browser is launched by this parent rather than by the Node process inside the job.
    $effectiveArguments = if($openBrowser){@('--no-open')+$webArguments}else{$webArguments}
    $web = $job.StartWeb($node, [string[]](@($dshEntry, 'web') + $effectiveArguments), $launchDirectory, !$openBrowser)
    $webSeen=$false
    $browserOpened=!$openBrowser
    $tunnelConnected=$false
    $tunnelWarned=$false
    $nextCheck=[DateTime]::UtcNow
    $tunnelDeadline=$null
    while (!$web.Exited) {
        if ($memory.Exited) { throw ('OpenViking exited while DSH was running. Log: ' + $memoryLog) }
        if([DateTime]::UtcNow -ge $nextCheck){
            $nextCheck=[DateTime]::UtcNow.AddSeconds(2)
            if(!$browserOpened -and $web.WebUrl){
                $browserOpened=$true
                try{
                    $browserInfo=New-Object Diagnostics.ProcessStartInfo($web.WebUrl)
                    $browserInfo.UseShellExecute=$true
                    [Diagnostics.Process]::Start($browserInfo) | Out-Null
                } catch {
                    Write-Warning 'Unable to open the browser automatically. Use this DSH Web URL:'
                    Write-Host $web.WebUrl
                }
            }
            if(!$webSeen){
                $bridgeSettings=if(Test-Path -LiteralPath $bridgeConfig){Get-Content -LiteralPath $bridgeConfig -Raw|ConvertFrom-Json}
                $controlPort=if($bridgeSettings){([uri]$bridgeSettings.url).Port}else{0}
                $listen=Get-NetTCPConnection -State Listen -OwningProcess $web.Id -ErrorAction SilentlyContinue | Where-Object LocalPort -ne $controlPort | Select-Object -First 1
                if($listen){
                    $webSeen=$true
                    try {
                        if(!$bridgeSettings){throw 'Configure the DSH Director bridge to enable the ChatGPT tunnel.'}
                        $bridge=[uri]$bridgeSettings.webUrl
                        if($bridge.Port -ne $listen.LocalPort){throw 'The ChatGPT bridge points to a different DSH Web port. Start DSH on its normal port to use the tunnel.'}
                        Write-Host 'Starting the ChatGPT MCP tunnel ...'
                        $tunnel=$job.Start($winPowerShell,[string[]]@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$tunnelScript,'-Action','RunLinked'),$tunnelRoot,$tunnelLog)
                        $tunnelDeadline=[DateTime]::UtcNow.AddSeconds(60)
                    } catch { Write-Warning $_.Exception.Message }
                }
            }
            if($tunnel -and !$tunnelWarned -and $tunnel.Exited){
                Write-Warning ('ChatGPT tunnel exited. Log: '+$tunnelLog)
                $tunnelWarned=$true
            }
            if($tunnel -and !$tunnel.Exited -and !$tunnelConnected){
                if(Read-LinkedTunnelReady){Write-Host 'ChatGPT MCP tunnel connected.';$tunnelConnected=$true}
                elseif(!$tunnelWarned -and [DateTime]::UtcNow -ge $tunnelDeadline){
                    Write-Warning ('The ChatGPT tunnel is running, but a successful connection has not been confirmed. Log: '+$tunnelLog)
                    $tunnelWarned=$true
                }
            }
        }
        Start-Sleep -Milliseconds 250
    }
    $exitCode = $web.ExitCode
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
} finally {
    if ($job) { $job.Dispose() }
    if ($web) { $web.Dispose() }
    if ($tunnel) { $tunnel.Dispose() }
    if ($memory) { $memory.Dispose() }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit $exitCode
