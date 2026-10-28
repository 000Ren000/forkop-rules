@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
if errorlevel 1 exit /b 1
where node >nul 2>&1
if errorlevel 1 (
    echo Не найден Node.js. Установите Node.js LTS и запустите файл снова.
    popd
    pause
    exit /b 1
)
node "%~dp0update.mjs" %*
set "FORKOP_EXIT_CODE=%errorlevel%"
popd
echo.
if not "%FORKOP_EXIT_CODE%"=="0" echo Обновление не завершено. Причина указана выше.
pause
exit /b %FORKOP_EXIT_CODE%
