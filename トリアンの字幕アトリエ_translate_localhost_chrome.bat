@echo off

set "translate_DIR=%USERPROFILE%\junorn_1978_translate"
start python -m http.server 8081

:: 如果資料夾不存在，則建立
if not exist "%translate_DIR%" mkdir "%translate_DIR%"

start chrome.exe --app="http://localhost:8081/index.html" ^
--disable-features=CalculateNativeWinOcclusion ^
--user-data-dir="%translate_DIR%" ^
--disable-extensions ^
--disable-default-apps
exit /b