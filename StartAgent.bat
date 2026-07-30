@echo off
setlocal EnableExtensions DisableDelayedExpansion

cd /d "%~dp0"

set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo ========================================
echo StrategyDesk - YanCeTai Launcher
echo ========================================
echo.
echo Working folder:
echo %CD%
echo.

echo Checking Node.js...
"%NODE_EXE%" --version
if errorlevel 1 (
  echo.
  echo ERROR: Node.js is not available.
  echo Please send this window content to Codex.
  echo.
  pause
  exit /b 1
)

if not exist "%CD%\agent-server.js" (
  echo.
  echo ERROR: agent-server.js was not found.
  echo Please make sure this file is in the project folder.
  echo.
  pause
  exit /b 1
)

echo.
echo Starting YanCeTai Agent service...
echo URL: http://localhost:8787
echo Model configuration: browser local storage
echo Open the page and click the model configuration button.
echo.
echo Keep this window open. Closing it will stop the service.
echo Then open http://localhost:8787 in your browser.
echo.

"%NODE_EXE%" agent-server.js

echo.
echo Service stopped.
echo.
pause
exit /b %ERRORLEVEL%
