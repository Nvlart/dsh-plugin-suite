param(
    [ValidateSet('Configure','Start','Stop','Status','EnableAutoStart','DisableAutoStart','SelfTest','RunLinked')][string]$Action='Status',
    [switch]$ShowWindow
)
$ErrorActionPreference='Stop'
$taskRoot=$PSScriptRoot
$taskPrivate=Join-Path $taskRoot 'runtime\private'
$taskSecretFile=Join-Path $taskPrivate 'tunnel-key.dpapi'
$taskSettingsFile=Join-Path $taskPrivate 'background.json'
$taskClient=Join-Path $taskRoot 'tools\tunnel-client.exe'
$taskAlias='dsh-director'
$taskStartup=Join-Path ([Environment]::GetFolderPath('Startup')) 'DSH Director Tunnel.lnk'
$taskLinkedHealth=Join-Path $taskPrivate 'linked-health.url'

function Set-PrivateFolder([string]$Path) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    # Load and persist only the DACL. Do not request SACL/owner changes through
    # Set-Acl: those can require SeSecurityPrivilege on ordinary user tokens.
    $taskAcl=[IO.Directory]::GetAccessControl($Path,[Security.AccessControl.AccessControlSections]::Access)
    $taskAcl.SetAccessRuleProtection($true,$false)
    $taskSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach($taskExistingRule in @($taskAcl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){$taskAcl.RemoveAccessRuleSpecific($taskExistingRule)}
    foreach($taskIdentity in @($taskSid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        $taskRule=New-Object Security.AccessControl.FileSystemAccessRule($taskIdentity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $taskAcl.AddAccessRule($taskRule)
    }
    [IO.Directory]::SetAccessControl($Path,$taskAcl)
}
function ConvertTo-NativeArgument([string]$Value) {
    $taskBuilder=New-Object Text.StringBuilder
    $null=$taskBuilder.Append('"');$taskBackslashes=0
    foreach($taskChar in $Value.ToCharArray()) {
        if($taskChar -eq '\'){$taskBackslashes++;continue}
        if($taskChar -eq '"'){$null=$taskBuilder.Append(('\' * (2*$taskBackslashes+1)))}
        else{$null=$taskBuilder.Append(('\' * $taskBackslashes))}
        $null=$taskBuilder.Append($taskChar);$taskBackslashes=0
    }
    $null=$taskBuilder.Append(('\' * (2*$taskBackslashes)));$null=$taskBuilder.Append('"')
    return $taskBuilder.ToString()
}
function Invoke-TunnelJson([string[]]$Arguments) {
    # Windows PowerShell 5 loses embedded quotes when invoking native commands.
    # Use the Windows argv quoting rules directly through ProcessStartInfo.
    $taskInfo=New-Object Diagnostics.ProcessStartInfo
    $taskInfo.FileName=$taskClient
    $taskInfo.Arguments=($Arguments | ForEach-Object {ConvertTo-NativeArgument $_}) -join ' '
    $taskInfo.UseShellExecute=$false;$taskInfo.CreateNoWindow=$true
    $taskInfo.RedirectStandardOutput=$true;$taskInfo.RedirectStandardError=$true
    $taskProcess=[Diagnostics.Process]::Start($taskInfo)
    $taskStdout=$taskProcess.StandardOutput.ReadToEndAsync()
    $taskStderr=$taskProcess.StandardError.ReadToEndAsync()
    $taskProcess.WaitForExit();$taskCode=$taskProcess.ExitCode
    $taskOutput=$taskStdout.Result;$null=$taskStderr.Result;$taskProcess.Dispose()
    try{$taskObject=$taskOutput | ConvertFrom-Json}catch{throw 'Tunnel client returned an invalid response. Check the local tunnel UI.'}
    if($taskCode -ne 0 -and -not $taskObject){throw 'Tunnel command failed.'}
    return $taskObject
}
function Get-TunnelState {
    if(-not(Test-Path -LiteralPath $taskSettingsFile)){
        return [pscustomobject]@{configured=$false;process_running=$false;healthy=$false;ready=$false;poll_connected=$false;last_successful_poll=0;auto_start=(Test-Path -LiteralPath $taskStartup);ui_url=''}
    }
    $taskRuntime=$null
    try{$taskRuntime=Invoke-TunnelJson @('runtimes','status',$taskAlias,'--json')}catch{}
    if(-not $taskRuntime.process_running -and (Test-Path -LiteralPath $taskLinkedHealth)){
        try{
            $taskLinkedBase=(Get-Content -LiteralPath $taskLinkedHealth -Raw).Trim()
            if($taskLinkedBase -match '^http://127\.0\.0\.1:(\d+)$'){
                $taskLinkedPort=[int]$Matches[1]
                $taskLinkedOwner=Get-NetTCPConnection -State Listen -LocalPort $taskLinkedPort -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess
                $taskLinkedProcess=if($taskLinkedOwner){Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskLinkedOwner)}
                if($taskLinkedProcess.ExecutablePath -eq $taskClient){
                    $taskHealth=(Invoke-WebRequest -UseBasicParsing -Uri ($taskLinkedBase+'/health') -TimeoutSec 2).StatusCode -eq 200
                    $taskReady=$false
                    try{$taskReady=(Invoke-WebRequest -UseBasicParsing -Uri ($taskLinkedBase+'/readyz') -TimeoutSec 2).StatusCode -eq 200}catch{}
                    $taskRuntime=[pscustomobject]@{process_running=$true;healthy=$taskHealth;ready=$taskReady;local=@{health=@{base_url=$taskLinkedBase}}}
                }
            }
        }catch{}
    }
    $taskBase=$taskRuntime.local.health.base_url
    $taskPollTime=0.0
    if($taskBase -match '^http://127\.0\.0\.1:\d+$') {
        try {
            $taskMetrics=(Invoke-WebRequest -UseBasicParsing -Uri ($taskBase+'/metrics') -TimeoutSec 3).Content
            $taskMatch=[regex]::Match($taskMetrics,'(?m)^commands_poll_last_successful_timestamp_seconds(?:\{[^\r\n]*\})?\s+([0-9.eE+-]+)\s*$')
            if($taskMatch.Success){$taskPollTime=[double]::Parse($taskMatch.Groups[1].Value,[Globalization.CultureInfo]::InvariantCulture)}
        }catch{}
    }
    $taskNow=([DateTime]::UtcNow-[DateTime]'1970-01-01').TotalSeconds
    return [pscustomobject]@{
        configured=(Test-Path -LiteralPath $taskSecretFile)
        process_running=($taskRuntime.process_running -eq $true)
        healthy=($taskRuntime.healthy -eq $true)
        ready=($taskRuntime.ready -eq $true)
        poll_connected=($taskPollTime -gt 0 -and ($taskNow-$taskPollTime) -lt 120)
        last_successful_poll=$taskPollTime
        auto_start=(Test-Path -LiteralPath $taskStartup)
        ui_url= $(if($taskBase){$taskBase+'/ui'}else{''})
    }
}
function Set-AutoStart([bool]$Enabled) {
    if($Enabled) {
        $taskShell=New-Object -ComObject WScript.Shell
        $taskLink=$taskShell.CreateShortcut($taskStartup)
        $taskLink.TargetPath=Join-Path $PSHOME 'powershell.exe'
        $taskLink.Arguments='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $taskRoot 'manage-tunnel.ps1')+'" -Action Start'
        $taskLink.WorkingDirectory=$taskRoot
        $taskLink.WindowStyle=7
        $taskLink.Description='Start the local DSH Director tunnel after Windows sign-in.'
        $taskLink.Save()
    }elseif(Test-Path -LiteralPath $taskStartup){Remove-Item -LiteralPath $taskStartup}
}
function Invoke-WithTunnelEnvironment([scriptblock]$Run) {
    if(-not(Test-Path -LiteralPath $taskSecretFile)){throw 'Run First-time setup.cmd once to save the key encrypted for this Windows account.'}
    if($PSVersionTable.PSEdition -eq 'Desktop'){
        Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
    }
    $taskSettings=Get-Content -LiteralPath $taskSettingsFile -Raw | ConvertFrom-Json
    $taskBridgeConfig=if($env:DSH_DESKTOP_CONFIG){$env:DSH_DESKTOP_CONFIG}else{Join-Path $HOME '.dsh-desktop\config.json'}
    $taskBridge=Get-Content -LiteralPath $taskBridgeConfig -Raw | ConvertFrom-Json
    $taskSavedKey=(Get-Content -LiteralPath $taskSecretFile -Raw).Trim() | ConvertTo-SecureString
    $taskPointer=[IntPtr]::Zero
    $taskNames=@('CONTROL_PLANE_API_KEY','CONTROL_PLANE_TUNNEL_ID','CONTROL_PLANE_BASE_URL','CONTROL_PLANE_HTTP_PROXY','DSH_DESKTOP_CONFIG','LOG_FORMAT','LOG_LEVEL','LOG_HTTP_RAW_UNSAFE','HARPOON_CAPTURE_PAYLOADS','HEALTH_LISTEN_ADDR','MCP_COMMAND','HEALTH_URL_FILE')
    $taskOld=@{};foreach($taskName in $taskNames){$taskOld[$taskName]=[Environment]::GetEnvironmentVariable($taskName,'Process')}
    try {
        $taskPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSavedKey)
        $env:CONTROL_PLANE_API_KEY=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer).Trim()
        if($env:CONTROL_PLANE_API_KEY -notmatch '^[\x21-\x7e]+$'){throw 'Saved key contains spaces or non-ASCII characters. Run First-time setup.cmd with the runtime key only.'}
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer);$taskPointer=[IntPtr]::Zero
        $env:CONTROL_PLANE_TUNNEL_ID=$taskSettings.tunnel_id
        $env:CONTROL_PLANE_BASE_URL='https://api.openai.com'
        $env:CONTROL_PLANE_HTTP_PROXY=$taskBridge.tunnelProxy
        $env:DSH_DESKTOP_CONFIG=$taskBridgeConfig
        $env:LOG_FORMAT='struct-text';$env:LOG_LEVEL='warn'
        $env:LOG_HTTP_RAW_UNSAFE='false';$env:HARPOON_CAPTURE_PAYLOADS='false'
        $env:HEALTH_LISTEN_ADDR='127.0.0.1:0'
        $taskNode=(Get-Command node).Source.Replace('\','/')
        $taskEntry=(Join-Path $taskRoot 'server\stdio.mjs').Replace('\','/')
        $taskCommand='"'+$taskNode+'" "'+$taskEntry+'"'
        & $Run $taskSettings $taskCommand
    }finally {
        if($taskPointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer)}
        $taskSavedKey.Dispose()
        foreach($taskName in $taskNames){[Environment]::SetEnvironmentVariable($taskName,$taskOld[$taskName],'Process')}
    }
}

function Start-ManagedTunnel {
    Invoke-WithTunnelEnvironment {
        param($taskSettings,$taskCommand)
        $taskLaunch=Invoke-TunnelJson @('runtimes','connect','--alias',$taskAlias,'--tunnel-id',$taskSettings.tunnel_id,'--profile',$taskAlias,'--profile-dir',(Join-Path $taskRoot 'runtime\background-profiles'),'--mcp-command',$taskCommand,'--runtime-api-key','env:CONTROL_PLANE_API_KEY','--json')
        if(-not $taskLaunch.process_running -and -not $taskLaunch.launched){throw 'Managed tunnel did not start.'}
        $taskDeadline=[DateTime]::UtcNow.AddSeconds(50)
        do {
            $taskState=Get-TunnelState
            if($taskState.process_running -and $taskState.healthy -and $taskState.ready -and $taskState.poll_connected){return $taskState}
            if(-not $taskState.process_running){throw 'Managed tunnel exited. Open connection status for local diagnostics.'}
            Start-Sleep -Seconds 2
        }while([DateTime]::UtcNow -lt $taskDeadline)
        return $taskState
    }
}

$taskOldStateHome=$env:XDG_STATE_HOME
$env:XDG_STATE_HOME=Join-Path $taskRoot 'runtime\background-state'
try {
    switch($Action) {
        'RunLinked' {
            Invoke-WithTunnelEnvironment {
                param($taskSettings,$taskCommand)
                if(Test-Path -LiteralPath $taskLinkedHealth){Remove-Item -LiteralPath $taskLinkedHealth}
                $env:HEALTH_URL_FILE=$taskLinkedHealth
                $env:MCP_COMMAND=$taskCommand
                & $taskClient run
                if($LASTEXITCODE -ne 0){throw 'Linked tunnel exited. Check the linked tunnel log and saved credentials.'}
            }
            exit 0
        }
        'Configure' {
            $taskId=Read-Host 'Tunnel ID from OpenAI Platform'
            if($taskId -notmatch '^tunnel_[a-z0-9]{32}$'){throw 'Invalid tunnel ID.'}
            $taskSecret=Read-Host 'Runtime API key (hidden; encrypted for this Windows user)' -AsSecureString
            try {
                if($taskSecret.Length -eq 0){throw 'Key cannot be empty.'}
                $taskValidationPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecret)
                try{$taskKeyValid=([Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskValidationPointer).Trim() -match '^[\x21-\x7e]+$')}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskValidationPointer)}
                if(-not $taskKeyValid){throw 'Key contains spaces or non-ASCII characters. Paste only the raw runtime API key; nothing has been overwritten.'}
                Set-PrivateFolder $taskPrivate
                if(Test-Path -LiteralPath $taskSecretFile){Copy-Item -LiteralPath $taskSecretFile -Destination ($taskSecretFile+'.'+[DateTime]::UtcNow.Ticks+'.bak')}
                $taskSecret | ConvertFrom-SecureString | Set-Content -LiteralPath $taskSecretFile -Encoding ASCII
                @{tunnel_id=$taskId;credential_storage='Windows CurrentUser DPAPI'} | ConvertTo-Json | Set-Content -LiteralPath $taskSettingsFile -Encoding UTF8
            }finally{$taskSecret.Dispose()}
            $taskResult=Start-ManagedTunnel
            if($taskResult.poll_connected){Set-AutoStart $true;$taskResult.auto_start=$true}
        }
        'Start' {$taskResult=Start-ManagedTunnel}
        'Stop' {$null=Invoke-TunnelJson @('runtimes','stop',$taskAlias,'--json');$taskResult=Get-TunnelState}
        'Status' {$taskResult=Get-TunnelState}
        'EnableAutoStart' {if(-not(Test-Path -LiteralPath $taskSecretFile)){throw 'Configure the encrypted credential first.'};Set-AutoStart $true;$taskResult=Get-TunnelState}
        'DisableAutoStart' {Set-AutoStart $false;$taskResult=Get-TunnelState}
        'SelfTest' {
            $taskTestDir=Join-Path $taskRoot ('runtime\credential-test-'+[Guid]::NewGuid().ToString('N'))
            Set-PrivateFolder $taskTestDir
            $taskTestSecret=ConvertTo-SecureString 'local-dpapi-test-not-a-real-key' -AsPlainText -Force
            $taskEncrypted=$taskTestSecret | ConvertFrom-SecureString
            $taskTestPath=Join-Path $taskTestDir 'test.dpapi';Set-Content -LiteralPath $taskTestPath -Value $taskEncrypted -Encoding ASCII
            $taskRecovered=(Get-Content -LiteralPath $taskTestPath -Raw).Trim() | ConvertTo-SecureString
            $taskTestPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskRecovered)
            try{$taskEqual=([Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskTestPointer) -eq 'local-dpapi-test-not-a-real-key')}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskTestPointer);$taskRecovered.Dispose();$taskTestSecret.Dispose()}
            if(-not $taskEqual -or $taskEncrypted.Contains('local-dpapi-test-not-a-real-key')){throw 'DPAPI roundtrip failed'}
            $taskStartup=Join-Path $taskTestDir 'autostart-test.lnk'
            Set-AutoStart $true
            $taskTestShell=New-Object -ComObject WScript.Shell
            $taskTestLink=$taskTestShell.CreateShortcut($taskStartup)
            if($taskTestLink.Arguments -notmatch '-WindowStyle Hidden.*-Action Start'){throw 'Auto-start shortcut is incorrect'}
            Set-AutoStart $false
            $taskAlias='director-lifecycle-selftest'
            $env:XDG_STATE_HOME=Join-Path $taskTestDir 'state'
            $taskSettingsFile=Join-Path $taskTestDir 'settings.json'
            '{}' | Set-Content -LiteralPath $taskSettingsFile -Encoding ASCII
            $env:CONTROL_PLANE_API_KEY='local-dpapi-test-not-a-real-key'
            $env:CONTROL_PLANE_BASE_URL='http://127.0.0.1:9'
            $env:CONTROL_PLANE_HTTP_PROXY=''
            $env:HEALTH_LISTEN_ADDR='127.0.0.1:0'
            $env:LOG_FORMAT='struct-text';$env:LOG_LEVEL='warn'
            try {
                $taskCommand='"'+(Get-Command node).Source.Replace('\','/')+'" "'+(Join-Path $taskRoot 'server\stdio.mjs').Replace('\','/')+'"'
                $null=Invoke-TunnelJson @('runtimes','connect','--alias',$taskAlias,'--tunnel-id','tunnel_00000000000000000000000000000000','--profile','selftest','--profile-dir',(Join-Path $taskTestDir 'profiles'),'--mcp-command',$taskCommand,'--runtime-api-key','env:CONTROL_PLANE_API_KEY','--control-plane-base-url','http://127.0.0.1:9','--json')
                $taskGenerated=Get-Content -LiteralPath (Join-Path $taskTestDir 'profiles\selftest.yaml') -Raw | ConvertFrom-Json
                if($taskGenerated.mcp.commands[0].command -cne $taskCommand){throw 'Native command arguments were truncated'}
                $taskTestState=Get-TunnelState
                if(-not $taskTestState.process_running -or $taskTestState.poll_connected){throw 'Managed state must report running but NOT connected for unreachable fake control plane'}
            }finally{$null=Invoke-TunnelJson @('runtimes','stop',$taskAlias,'--json');$env:CONTROL_PLANE_API_KEY=$null}
            $taskStoppedState=Get-TunnelState
            if($taskStoppedState.process_running){throw 'Managed stop failed'}
            $taskResult=[pscustomobject]@{dpapi_roundtrip='PASS';plaintext_absent='PASS';private_acl=(Get-Acl -LiteralPath $taskTestDir).AreAccessRulesProtected;autostart_shortcut='PASS';native_command_preserved='PASS';managed_start_status_stop='PASS';false_connection_prevented='PASS';real_credential_used=$false}
        }
    }
    $taskResult | ConvertTo-Json -Depth 4
    if($Action -in @('Start','Configure') -and -not $taskResult.poll_connected){throw 'Background process started, but successful polling is not yet confirmed. Keep DSH Web and the local proxy running; check connection status.'}
    if($ShowWindow){Add-Type -AssemblyName System.Windows.Forms;[Windows.Forms.MessageBox]::Show(($taskResult | ConvertTo-Json),'DSH Director') | Out-Null}
}catch {
    $taskMessage=$_.Exception.Message
    if($ShowWindow){Add-Type -AssemblyName System.Windows.Forms;[Windows.Forms.MessageBox]::Show($taskMessage,'DSH Director') | Out-Null}
    else{if($Action -eq 'SelfTest'){Write-Output $_.ScriptStackTrace};Write-Error -Message $taskMessage -ErrorAction Continue}
    exit 1
}finally{$env:XDG_STATE_HOME=$taskOldStateHome}
