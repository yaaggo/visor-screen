@echo off
rem Compila visor-audio.exe com MSVC (Visual Studio 2022 + Windows SDK 10.0.20348+)
setlocal
set VCVARS="C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if not exist %VCVARS% (echo vcvars64.bat nao encontrado & exit /b 1)
call %VCVARS% >nul
cd /d "%~dp0"
if not exist bin mkdir bin
cl /nologo /O2 /EHsc /std:c++17 /utf-8 /DUNICODE /D_UNICODE /MT visor-audio.cpp /Fe:bin\visor-audio.exe /Fo:bin\ /link /SUBSYSTEM:CONSOLE
exit /b %errorlevel%
