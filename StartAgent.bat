@echo off
setlocal EnableExtensions DisableDelayedExpansion

cd /d "%~dp0"

echo ========================================
echo YanCeTai - local service launcher
echo ========================================
echo.
echo Working folder:
echo %CD%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found in PATH.
  echo Install Node.js 18 or newer, then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "agent-server.js" (
  echo ERROR: agent-server.js was not found.
  echo Make sure this file sits next to agent-server.js.
  echo.
  pause
  exit /b 1
)

echo Node.js version:
node --version
echo.
echo Starting YanCeTai service...
echo URL: http://localhost:8787
echo Model configuration: stored in the browser only.
echo Keep this window open; closing it stops the service.
echo.

node agent-server.js

echo.
echo Service stopped.
echo.
pause
exit /b %ERRORLEVEL%
