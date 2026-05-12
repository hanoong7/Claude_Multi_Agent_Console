@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required ^(v20+^). Install from https://nodejs.org and retry.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo Node %NODE_MAJOR% detected; v20+ required.
  pause
  exit /b 1
)

where claude >nul 2>nul
if errorlevel 1 (
  echo Claude Code CLI not found in PATH.
  echo Install: https://claude.com/code
  echo ^(After install, run "claude" once to log in.^)
)

set PROD=1
if "%PORT%"=="" set PORT=8787
node app.js
