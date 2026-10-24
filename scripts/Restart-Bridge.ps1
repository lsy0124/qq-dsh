$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
$taskLock=Join-Path $taskRoot 'state\bridge.lock'
$taskEntry=Join-Path $taskRoot 'src\bridge.js'
if(Test-Path -LiteralPath $taskLock){
    $taskOldPid=0
    if(![int]::TryParse((Get-Content -LiteralPath $taskLock -Raw).Trim(),[ref]$taskOldPid) -or $taskOldPid -le 0){throw 'Invalid lock. Inspect it before removing it.'}
    $taskProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$taskOldPid"
    if($taskProcess){
        $taskCommand=[string]$taskProcess.CommandLine
        if($taskProcess.Name -ne 'node.exe' -or $taskCommand.Replace('/','\').IndexOf($taskEntry,[StringComparison]::OrdinalIgnoreCase) -lt 0){
            throw 'The lock PID could not be verified as this repository bridge. Stop its terminal manually; no process was terminated.'
        }
        Stop-Process -Id $taskOldPid -Force
        Wait-Process -Id $taskOldPid -Timeout 10 -ErrorAction SilentlyContinue
    }
    if((Get-Content -LiteralPath $taskLock -Raw).Trim() -eq [string]$taskOldPid){Remove-Item -LiteralPath $taskLock}
}
Set-Location -LiteralPath $taskRoot
& node --env-file-if-exists=.env launch-bridge.mjs --foreground
exit $LASTEXITCODE
