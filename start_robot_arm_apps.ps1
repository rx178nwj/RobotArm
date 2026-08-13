$ErrorActionPreference = "Stop"

$workspaceDir = $PSScriptRoot
$controlAppDir = Join-Path $workspaceDir "control_app"
$monitorAppDir = Join-Path $workspaceDir "robot_arm_monitor"
$controlPipe = "\\.\pipe\robotarm-control-app"

function Test-AppRunning([string]$appDirectory) {
    $escapedDirectory = [WildcardPattern]::Escape($appDirectory)
    return $null -ne (Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
        Where-Object { $_.CommandLine -like "*$escapedDirectory*" } |
        Select-Object -First 1)
}

function Start-RobotArmApp([string]$name, [string]$appDirectory) {
    if (-not (Test-Path (Join-Path $appDirectory "package.json"))) {
        throw "$name directory is not valid: $appDirectory"
    }
    if (Test-AppRunning $appDirectory) {
        Write-Host "$name is already running."
        return
    }

    Write-Host "Starting $name..."
    $previousElectronMode = $env:ELECTRON_RUN_AS_NODE
    try {
        $env:ELECTRON_RUN_AS_NODE = $null
        Start-Process -FilePath "npm.cmd" -ArgumentList "start" `
            -WorkingDirectory $appDirectory -WindowStyle Hidden
    } finally {
        $env:ELECTRON_RUN_AS_NODE = $previousElectronMode
    }
}

function Test-ControlPipe {
    try {
        return [System.IO.Directory]::GetFiles("\\.\pipe\") -contains $controlPipe
    } catch {
        return $false
    }
}

Start-RobotArmApp "Robot Arm Control" $controlAppDir

$deadline = (Get-Date).AddSeconds(20)
while (-not (Test-ControlPipe) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
}
if (Test-ControlPipe) {
    Write-Host "Control IPC is ready."
} else {
    Write-Warning "Control IPC did not become ready within 20 seconds. The monitor will still be started."
}

Start-RobotArmApp "Robot Arm Monitor" $monitorAppDir
Write-Host "Robot Arm applications were started."
