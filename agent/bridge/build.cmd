@echo off
rem Builds the bridge on Windows, from a "x64 Native Tools Command Prompt for VS".
rem   set OBSBOT_SDK_DIR=C:\obsbot\libdev_v2.1.0_8
rem   agent\bridge\build.cmd
if "%OBSBOT_SDK_DIR%"=="" (
  echo Imposta OBSBOT_SDK_DIR sulla cartella libdev_v2.x dell'SDK
  exit /b 1
)
set HERE=%~dp0
set OUT=%HERE%..\native
if not exist "%OUT%" mkdir "%OUT%"
set LIBDIR=%OBSBOT_SDK_DIR%\windows\win64-release
cl /nologo /LD /EHsc /std:c++17 /O2 /MD /I "%OBSBOT_SDK_DIR%\include" "%HERE%obsbot_bridge.cpp" ^
  /Fe"%OUT%\obsbot_bridge.dll" /Fo"%OUT%\\" /link "%LIBDIR%\libdev.lib" || exit /b 1
copy /Y "%LIBDIR%\libdev.dll" "%OUT%\" >nul
copy /Y "%LIBDIR%\w32-pthreads.dll" "%OUT%\" >nul
echo Ponte compilato in %OUT%
