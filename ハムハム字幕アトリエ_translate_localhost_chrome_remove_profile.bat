@echo off
setlocal enabledelayedexpansion

set "PORT=8081"
set "translate_DIR=%USERPROFILE%\junorn_1978_translate"

:: �ˬd 8081 �O�_���{���b LISTENING
set "PID="
for /f "tokens=5" %%P in ('
  netstat -ano ^| findstr /R /C:":%PORT%" ^| findstr LISTENING
') do set "PID=%%P"

if defined PID (
  echo "[INFO] The port %PORT% is already in use (PID=%PID%), skipping the launch of the Python HTTP server."
) else (
  echo "[INFO] The port %PORT% is available, launching the Python HTTP server..."
  :: ���T�� start �Ϊk�G�Ĥ@�Ӥ޸��O�������D�A�d�ŧY�i
  start "" python -m http.server %PORT%
  :: �� 1 �������A���_�ӡ]�i�վ�/�i�ٲ��^
  timeout /t 1 /nobreak >nul
)

:: ���R���ǳƨϥΪ̸�Ƨ��b�إߨö}�� Chrome ���ε���
rmdir /S /Q "%USERPROFILE%\junorn_1978_translate"
if not exist "%translate_DIR%" mkdir "%translate_DIR%"

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  "http://localhost:%PORT%/index.html" --window-size=1280,720 ^
  --disable-features=CalculateNativeWinOcclusion ^
  --user-data-dir="%translate_DIR%" ^
  --disable-extensions ^
  --disable-default-apps

exit /b