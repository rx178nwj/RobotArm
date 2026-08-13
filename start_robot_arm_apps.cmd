@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_robot_arm_apps.ps1"
if errorlevel 1 (
  echo.
  echo Failed to start Robot Arm applications.
  pause
)
endlocal
