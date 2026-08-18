@echo off
chcp 65001 >nul 2>&1
title OpenFOAM Studio - WSL2 GUI
echo.
echo  ============================================
echo       OpenFOAM Studio - WSL2 Launcher
echo       Web GUI for OpenFOAM CFD
echo  ============================================
echo.

cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found!
    echo  Install Node.js from https://nodejs.org/
    goto :fail
)
for /f "tokens=*" %%v in ('node -v 2^>^&1') do echo [OK] Node.js %%v

where wsl >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] WSL not found!
    echo  To enable: wsl --install from Admin PowerShell
    goto :fail
)
echo [OK] WSL found

REM === Auto-detect Ubuntu distro (skip docker-desktop) ===
set WSL_DISTRO=
for /f "delims=" %%d in ('wsl --list -q 2^>nul ^| findstr /i "Ubuntu"') do (
    if not "%%d"=="" (
        set WSL_DISTRO=%%d
    )
)
if "%WSL_DISTRO%"=="" (
    wsl -d Ubuntu-22.04 -- echo ok >nul 2>&1 && set WSL_DISTRO=Ubuntu-22.04
)
if "%WSL_DISTRO%"=="" (
    wsl -d Ubuntu -- echo ok >nul 2>&1 && set WSL_DISTRO=Ubuntu
)
if "%WSL_DISTRO%"=="" (
    wsl -d Ubuntu-20.04 -- echo ok >nul 2>&1 && set WSL_DISTRO=Ubuntu-20.04
)
if "%WSL_DISTRO%"=="" (
    set WSL_DISTRO=Ubuntu
)
echo [OK] WSL distro: %WSL_DISTRO%

wsl -d %WSL_DISTRO% -- echo ok >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] WSL %WSL_DISTRO% not responding. Try: wsl --shutdown
    goto :fail
)
echo [OK] WSL2 active

REM === OpenFOAM Detection (on the correct distro) ===
wsl -d %WSL_DISTRO% -- test -f /opt/openfoam14/etc/bashrc >nul 2>&1
if %errorlevel% equ 0 goto :of_ok
wsl -d %WSL_DISTRO% -- test -f /opt/openfoam13/etc/bashrc >nul 2>&1
if %errorlevel% equ 0 goto :of_ok
wsl -d %WSL_DISTRO% -- test -f /opt/openfoam12/etc/bashrc >nul 2>&1
if %errorlevel% equ 0 goto :of_ok
wsl -d %WSL_DISTRO% -- test -f /opt/openfoam11/etc/bashrc >nul 2>&1
if %errorlevel% equ 0 goto :of_ok
wsl -d %WSL_DISTRO% -- test -f /opt/openfoam10/etc/bashrc >nul 2>&1
if %errorlevel% equ 0 goto :of_ok
wsl -d %WSL_DISTRO% -- test -f /opt/openfoam9/etc/bashrc >nul 2>&1
if %errorlevel% equ 0 goto :of_ok
wsl -d %WSL_DISTRO% -- test -f /opt/openfoam/OpenFOAM-14/etc/bashrc >nul 2>&1
if %errorlevel% equ 0 goto :of_ok
wsl -d %WSL_DISTRO% -- test -f /opt/openfoam/OpenFOAM-13/etc/bashrc >nul 2>&1
if %errorlevel% equ 0 goto :of_ok
wsl -d %WSL_DISTRO% -- test -f /opt/openfoam/OpenFOAM-12/etc/bashrc >nul 2>&1
if %errorlevel% equ 0 goto :of_ok
wsl -d %WSL_DISTRO% -- test -f /opt/openfoam/OpenFOAM-11/etc/bashrc >nul 2>&1
if %errorlevel% equ 0 goto :of_ok
wsl -d %WSL_DISTRO% -- test -f /opt/openfoam/OpenFOAM-2312/etc/bashrc >nul 2>&1
if %errorlevel% equ 0 goto :of_ok
wsl -d %WSL_DISTRO% -- test -f /usr/lib/openfoam/openfoam2312/etc/bashrc >nul 2>&1
if %errorlevel% equ 0 goto :of_ok
echo [WARNING] OpenFOAM not found in %WSL_DISTRO%.
echo  The server will start anyway - verify after login.
goto :of_done

:of_ok
echo [OK] OpenFOAM found in WSL2 (%WSL_DISTRO%)
:of_done
echo.

if not exist server.js (
    echo [ERROR] server.js not found! The zip appears corrupt.
    goto :fail
)
echo [OK] Pre-built found

echo.
echo  ============================================
echo   Starting on http://localhost:3000
echo   Ctrl+C to stop the server
echo  ============================================
echo.

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://localhost:3000

set HOSTNAME=127.0.0.1
set PORT=3000
if exist ".next\standalone\server.js" (
    node scripts\start.js
) else (
    node server.js
)

echo.
echo [INFO] Server stopped.

:fail
echo.
pause
exit /b
