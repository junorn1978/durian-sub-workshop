@echo off
set "translate_DIR=%USERPROFILE%\junorn_1978_translate"

:: 如果資料夾不存在，則建立
if not exist "%translate_DIR%" mkdir "%translate_DIR%"

start msedge.exe --app="https://junorn1978.github.io/durian-sub-workshop/" ^
--disable-features=CalculateNativeWinOcclusion ^
--user-data-dir="%translate_DIR%" ^
--disable-extensions ^
--disable-default-apps
exit /b