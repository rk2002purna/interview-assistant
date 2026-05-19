$ErrorActionPreference = 'SilentlyContinue'
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptPath
$proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm start" -WindowStyle Hidden -PassThru
Start-Sleep 3
if ($proc.HasExited) {
    Write-Host "Process exited with code: $($proc.ExitCode)"
} else {
    Write-Host "App started, PID: $($proc.Id)"
}