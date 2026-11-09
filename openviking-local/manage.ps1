param([ValidateSet('Configure','Start','Stop','Status','Doctor','EnableAutoStart','DisableAutoStart')][string]$Action='Status')
$ErrorActionPreference='Stop'
$taskRoot=$PSScriptRoot
$taskRuntime=Join-Path $taskRoot 'runtime'
$taskPrivate=Join-Path $taskRuntime 'private'
$taskConfig=Join-Path $taskPrivate 'ov.conf'
$taskPython=Join-Path $taskRoot '.venv\Scripts\python.exe'
$taskServer=Join-Path $taskRoot '.venv\Scripts\openviking-server.exe'
$taskState=Join-Path $taskRuntime 'daemon.json'
$taskShortcut=Join-Path ([Environment]::GetFolderPath('Startup')) 'OpenViking Local Memory.lnk'
$env:LITELLM_LOCAL_MODEL_COST_MAP='True'

function Protect-Directory([string]$Path) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $taskDirectory=New-Object IO.DirectoryInfo($Path)
    if($PSVersionTable.PSEdition -eq 'Core'){$taskAcl=[IO.FileSystemAclExtensions]::GetAccessControl($taskDirectory,[Security.AccessControl.AccessControlSections]::Access)}
    else{$taskAcl=[IO.Directory]::GetAccessControl($Path,[Security.AccessControl.AccessControlSections]::Access)}
    $taskAcl.SetAccessRuleProtection($true,$false)
    foreach($taskRule in @($taskAcl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){$taskAcl.RemoveAccessRuleSpecific($taskRule)}
    foreach($taskSid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))){
        $taskRule=New-Object Security.AccessControl.FileSystemAccessRule($taskSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $taskAcl.AddAccessRule($taskRule)
    }
    if($PSVersionTable.PSEdition -eq 'Core'){[IO.FileSystemAclExtensions]::SetAccessControl($taskDirectory,$taskAcl)}
    else{[IO.Directory]::SetAccessControl($Path,$taskAcl)}
}
function Read-Endpoint([string]$Name) {
    try { return Invoke-RestMethod -Uri ('http://127.0.0.1:1933/'+$Name) -TimeoutSec 3 }
    catch { return $null }
}
function Read-State {
    if(Test-Path -LiteralPath $taskState){return Get-Content -LiteralPath $taskState -Raw | ConvertFrom-Json}
    return $null
}
function Get-OwnedProcesses {
    $taskSaved=Read-State
    if($null -eq $taskSaved){return}
    foreach($taskId in @($taskSaved.processIds)){
        if($taskId -isnot [int] -and $taskId -isnot [long]){continue}
        $taskProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskId) -ErrorAction SilentlyContinue
        if($taskProcess -and $taskProcess.Name -eq 'python.exe' -and $taskProcess.CommandLine -match '(?i)-m\s+openviking_cli\.server_bootstrap\b' -and $taskProcess.CommandLine.IndexOf($taskConfig,[StringComparison]::OrdinalIgnoreCase) -ge 0){$taskProcess}
    }
}
function Start-ServiceProcess {
    if(!(Test-Path -LiteralPath $taskConfig)){throw 'Configure the model API Key first: open Configure API.cmd.'}
    if(!(Test-Path -LiteralPath $taskServer)){throw 'OpenViking installation is incomplete.'}
    Protect-Directory $taskRuntime
    Protect-Directory (Join-Path $taskRoot 'data')
    $taskOwned=@(Get-OwnedProcesses)
    if($taskOwned.Count -gt 0){Write-Host 'Managed OpenViking process is already running.';return}
    $taskBusy=Get-NetTCPConnection -LocalPort 1933 -State Listen -ErrorAction SilentlyContinue
    if($taskBusy){throw 'Port 1933 is already in use by another process. No process was stopped.'}
    Protect-Directory $taskRuntime
    $taskOut=Join-Path $taskRuntime 'server.stdout.log';$taskErr=Join-Path $taskRuntime 'server.stderr.log'
    $taskProcess=Start-Process -FilePath $taskPython -ArgumentList @('-m','openviking_cli.server_bootstrap','--config',('"'+$taskConfig+'"'),'--host','127.0.0.1','--port','1933') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput $taskOut -RedirectStandardError $taskErr -PassThru
    @{processIds=@($taskProcess.Id);startedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $taskState -Encoding UTF8
    $taskDeadline=[DateTime]::UtcNow.AddSeconds(40)
    do {
        Start-Sleep -Milliseconds 800
        $taskProcess.Refresh()
        if($taskProcess.HasExited){throw 'OpenViking exited. Local diagnostics: runtime\server.stderr.log'}
        $taskReady=Read-Endpoint 'ready'
        $taskHealth=Read-Endpoint 'health'
        if($null -ne $taskReady -and $taskReady.status -eq 'ready' -and $null -ne $taskHealth -and $taskHealth.healthy -eq $true){
            $taskListeners=@(Get-NetTCPConnection -LocalPort 1933 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)
            $taskIds=@($taskProcess.Id)+$taskListeners | Select-Object -Unique
            @{processIds=@($taskIds);startedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $taskState -Encoding UTF8
            Write-Host 'OpenViking is responding on http://127.0.0.1:1933.'
            return
        }
    } while([DateTime]::UtcNow -lt $taskDeadline)
    throw 'Startup did not become ready in time. The managed process is still running; inspect Connection status.cmd and local logs.'
}

switch($Action){
    'Configure' {
        if(@(Get-OwnedProcesses).Count -gt 0){throw 'Stop the managed service before changing model configuration.'}
        Protect-Directory $taskRuntime
        Protect-Directory $taskPrivate
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [Windows.Forms.Application]::EnableVisualStyles()
        $taskForm=New-Object Windows.Forms.Form
        $taskForm.Text='OpenViking 本机记忆配置'
        $taskForm.Size=New-Object Drawing.Size(640,310)
        $taskForm.StartPosition='CenterScreen';$taskForm.FormBorderStyle='FixedDialog';$taskForm.MaximizeBox=$false;$taskForm.MinimizeBox=$false
        $taskLabel=New-Object Windows.Forms.Label
        $taskLabel.Location=New-Object Drawing.Point(20,18);$taskLabel.Size=New-Object Drawing.Size(585,74)
        $taskLabel.Text="向量化：阿里云百炼 text-embedding-v4（北京）`r`n记忆整理：复用 DSH 官方 DeepSeek API Key`r`n服务和数据库在本机；模型调用会发送内容到对应提供商。"
        $taskForm.Controls.Add($taskLabel)
        $taskLink=New-Object Windows.Forms.LinkLabel
        $taskLink.Location=New-Object Drawing.Point(20,98);$taskLink.Size=New-Object Drawing.Size(570,24)
        $taskLink.Text='打开百炼控制台，获取北京地域 API Key'
        $taskLink.add_LinkClicked({Start-Process 'https://bailian.console.aliyun.com/?tab=model#/api-key'})
        $taskForm.Controls.Add($taskLink)
        $taskInput=New-Object Windows.Forms.TextBox
        $taskInput.Location=New-Object Drawing.Point(20,134);$taskInput.Size=New-Object Drawing.Size(585,28);$taskInput.UseSystemPasswordChar=$true
        $taskForm.Controls.Add($taskInput)
        $taskSave=New-Object Windows.Forms.Button
        $taskSave.Text='验证并保存';$taskSave.Location=New-Object Drawing.Point(365,198);$taskSave.Size=New-Object Drawing.Size(115,34);$taskSave.DialogResult=[Windows.Forms.DialogResult]::OK
        $taskCancel=New-Object Windows.Forms.Button
        $taskCancel.Text='取消';$taskCancel.Location=New-Object Drawing.Point(490,198);$taskCancel.Size=New-Object Drawing.Size(115,34);$taskCancel.DialogResult=[Windows.Forms.DialogResult]::Cancel
        $taskForm.Controls.Add($taskSave);$taskForm.Controls.Add($taskCancel);$taskForm.AcceptButton=$taskSave;$taskForm.CancelButton=$taskCancel
        if($taskForm.ShowDialog() -ne [Windows.Forms.DialogResult]::OK){$taskForm.Dispose();Write-Host 'Cancelled. No model configuration was written.';return}
        $taskValue=$taskInput.Text.Trim();$taskInput.Clear();$taskForm.Dispose()
        if($taskValue.Length -lt 10){throw 'API Key is empty or too short.'}
        $taskInfo=New-Object Diagnostics.ProcessStartInfo
        $taskInfo.FileName=(Get-Command node -ErrorAction Stop).Source
        $taskInfo.Arguments='"'+(Join-Path $taskRoot 'service.mjs')+'" configure'
        $taskInfo.WorkingDirectory=$taskRoot;$taskInfo.UseShellExecute=$false;$taskInfo.CreateNoWindow=$true
        $taskInfo.RedirectStandardInput=$true;$taskInfo.RedirectStandardOutput=$true;$taskInfo.RedirectStandardError=$true
        $taskSetup=New-Object Diagnostics.Process;$taskSetup.StartInfo=$taskInfo
        $null=$taskSetup.Start()
        $taskSetup.StandardInput.WriteLine((@{embeddingKey=$taskValue} | ConvertTo-Json -Compress));$taskSetup.StandardInput.Close();$taskValue=$null
        $taskOutput=$taskSetup.StandardOutput.ReadToEnd();$taskError=$taskSetup.StandardError.ReadToEnd();$taskSetup.WaitForExit()
        if($taskSetup.ExitCode -ne 0){throw $taskError.Trim()}
        Write-Host $taskOutput.Trim()
        Start-ServiceProcess
        Write-Host 'Next: restart DSH Web and refresh the page.'
    }
    'Start' {Start-ServiceProcess}
    'Stop' {
        foreach($taskOwned in @(Get-OwnedProcesses)){Stop-Process -Id $taskOwned.ProcessId -ErrorAction SilentlyContinue}
        if(Test-Path -LiteralPath $taskState){Remove-Item -LiteralPath $taskState}
        Write-Host 'Stopped managed OpenViking processes.'
    }
    'Status' {
        [pscustomobject]@{configured=(Test-Path -LiteralPath $taskConfig);managedProcessIds=@(Get-OwnedProcesses | ForEach-Object ProcessId);health=(Read-Endpoint 'health');ready=(Read-Endpoint 'ready');autoStart=(Test-Path -LiteralPath $taskShortcut);dataDirectory=(Join-Path $taskRoot 'data')} | ConvertTo-Json -Depth 6
    }
    'Doctor' {
        if(!(Test-Path -LiteralPath $taskConfig)){throw 'Configure the model API Key first.'}
        & $taskPython -m openviking_cli.server_bootstrap doctor --config $taskConfig
        if($LASTEXITCODE -ne 0){throw 'OpenViking doctor reported a failure.'}
    }
    'EnableAutoStart' {
        if(!(Test-Path -LiteralPath $taskConfig)){throw 'Configure and verify the local service first.'}
        $taskShell=New-Object -ComObject WScript.Shell
        $taskLink=$taskShell.CreateShortcut($taskShortcut)
        $taskLink.TargetPath=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $taskLink.Arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$PSCommandPath+'" -Action Start'
        $taskLink.WorkingDirectory=$taskRoot;$taskLink.WindowStyle=7;$taskLink.Save()
        Write-Host 'Enabled login auto-start.'
    }
    'DisableAutoStart' {if(Test-Path -LiteralPath $taskShortcut){Remove-Item -LiteralPath $taskShortcut};Write-Host 'Disabled login auto-start.'}
}
