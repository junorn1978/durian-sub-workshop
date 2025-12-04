@echo off
set "translate_DIR=%USERPROFILE%\junorn_1978_translate"

:: 如果資料夾不存在，則建立
if not exist "%translate_DIR%" mkdir "%translate_DIR%"

start chrome.exe --app="https://junorn1978.github.io/durian-sub-workshop/" --window-size=1280,720 ^
--disable-features=CalculateNativeWinOcclusion ^
--user-data-dir="%translate_DIR%" ^
--disable-extensions ^
--enable-features=AIPromptAPI ^
--disable-default-apps
exit /b