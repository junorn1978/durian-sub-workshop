@echo off
setlocal enabledelayedexpansion

set "PORT=8081"
set "translate_DIR=%USERPROFILE%\junorn_1978_translate"
set "PID="
for /f "tokens=5" %%P in ('
  netstat -ano ^| findstr /R /C:":%PORT%" ^| findstr LISTENING
') do set "PID=%%P"

if defined PID (
  echo "[INFO] The port %PORT% is already in use (PID=%PID%), skipping the launch of the Python HTTP server."
) else (
  echo "[INFO] The port %PORT% is available, launching the Python HTTP server..."
  start "" python -m http.server %PORT%
  timeout /t 1 /nobreak >nul
)

if not exist "%translate_DIR%" mkdir "%translate_DIR%"

start "" "C:\Users\reinf\AppData\Local\Google\Chrome SxS\Application\chrome.exe" ^
  "http://localhost:%PORT%/index.html" --window-size=1280,720 ^
  --disable-features=CalculateNativeWinOcclusion ^
  --user-data-dir="%translate_DIR%" ^
  --disable-extensions ^
  --disable-default-apps ^
  --flag-switches-begin ^
  --enable-features=AIPromptAPI ^
  --flag-switches-end ^
  --no-default-browser-check

exit /b