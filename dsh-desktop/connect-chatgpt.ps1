# Interactive local credential entry. Never paste the runtime key into chat.
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskClient = Join-Path $taskRoot 'tools\tunnel-client.exe'
if (-not (Test-Path -LiteralPath $taskClient)) { throw 'Bundled official tunnel-client.exe is missing.' }
$taskConfig = if($env:DSH_DESKTOP_CONFIG){$env:DSH_DESKTOP_CONFIG}else{Join-Path $HOME '.dsh-desktop\config.json'}
if (-not (Test-Path -LiteralPath $taskConfig)) { throw 'DSH Director is not configured on this computer.' }
$taskLocalConfig = Get-Content -LiteralPath $taskConfig -Raw | ConvertFrom-Json
$taskTunnelId = Read-Host 'Tunnel ID from OpenAI Platform (tunnel_...)'
if ($taskTunnelId -notmatch '^tunnel_[a-z0-9]{32}$') { throw 'Invalid Tunnel ID.' }
$taskSecret = Read-Host 'Tunnel RUNTIME API key (hidden; never an admin key)' -AsSecureString
$taskPointer = [IntPtr]::Zero
$taskEnvNames = @('CONTROL_PLANE_API_KEY','CONTROL_PLANE_TUNNEL_ID','CONTROL_PLANE_HTTP_PROXY','MCP_COMMAND','DSH_DESKTOP_CONFIG','LOG_FORMAT','LOG_LEVEL','LOG_HTTP_RAW_UNSAFE','HARPOON_CAPTURE_PAYLOADS')
$taskOriginalEnv = @{}
foreach ($taskName in $taskEnvNames) { $taskOriginalEnv[$taskName] = [Environment]::GetEnvironmentVariable($taskName,'Process') }
try {
    $taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecret)
    $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer)
    $taskPointer = [IntPtr]::Zero
    $env:CONTROL_PLANE_TUNNEL_ID = $taskTunnelId
    if ($taskLocalConfig.tunnelProxy) { $env:CONTROL_PLANE_HTTP_PROXY = $taskLocalConfig.tunnelProxy }
    $env:DSH_DESKTOP_CONFIG = $taskConfig
    # tunnel-client parses this as a shell-style command; backslashes escape
    # characters even inside quotes. Forward slashes work with Windows Node.
    $taskNodePath = (Get-Command node).Source.Replace('\','/')
    $taskServerPath = (Join-Path $taskRoot 'server\stdio.mjs').Replace('\','/')
    $env:MCP_COMMAND = '"' + $taskNodePath + '" "' + $taskServerPath + '"'
    $env:LOG_FORMAT = 'struct-text'
    $env:LOG_LEVEL = 'warn'
    $env:LOG_HTTP_RAW_UNSAFE = 'false'
    $env:HARPOON_CAPTURE_PAYLOADS = 'false'
    & $taskClient doctor --explain
    if ($LASTEXITCODE -ne 0) { throw 'Tunnel doctor failed. No DSH task was submitted.' }
    Write-Host 'Keep this window open. Connect this tunnel in ChatGPT custom MCP settings.'
    & $taskClient run
} finally {
    if ($taskPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer) }
    $taskSecret.Dispose()
    foreach ($taskName in $taskEnvNames) { [Environment]::SetEnvironmentVariable($taskName,$taskOriginalEnv[$taskName],'Process') }
}
