@echo off
setlocal enabledelayedexpansion

set "PORT=8081"
set "translate_DIR=%USERPROFILE%\junorn_1978_translate"

:: 檢查 8081 是否有程式在 LISTENING
set "PID="
for /f "tokens=5" %%P in ('
  netstat -ano ^| findstr /R /C:":%PORT%" ^| findstr LISTENING
') do set "PID=%%P"

if defined PID (
  echo "[INFO] The port %PORT% is already in use (PID=%PID%) skipping the launch of the Python HTTP server."
) else (
  echo "[INFO] The port %PORT% is available, launching the Python HTTP server..."
  :: 正確的 start 用法：第一個引號是視窗標題，留空即可
  start "" python -m http.server %PORT%
  :: 等 1 秒讓伺服器起來（可調整/可省略）
  timeout /t 1 /nobreak >nul
)

:: 準備使用者資料夾並開啟 Chrome 應用視窗
if not exist "%translate_DIR%" mkdir "%translate_DIR%"

start "" msedge.exe ^
  "http://localhost:%PORT%/index.html" --window-size=1280,720 ^
  --disable-features=CalculateNativeWinOcclusion ^
  --user-data-dir="%translate_DIR%" ^
  --disable-extensions ^
  --disable-default-apps

exit /b