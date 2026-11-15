@echo off
rem Double-click to update Seller Toolkit to the latest version. Your data is kept.
title Update Seller Toolkit
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 update.py
  goto done
)
where python >nul 2>nul
if %errorlevel%==0 (
  python update.py
  goto done
)
echo Python 3 is not installed.
echo Install it from https://www.python.org/downloads/ and tick "Add Python to PATH",
echo then double-click this file again.
:done
echo.
pause
