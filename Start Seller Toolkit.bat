@echo off
rem Double-click to start Seller Toolkit. Close this window to stop it.
title Seller Toolkit - keep this window open
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 app.py
  goto done
)
where python >nul 2>nul
if %errorlevel%==0 (
  python app.py
  goto done
)
echo Python 3 is not installed.
echo Install it from https://www.python.org/downloads/ and tick "Add Python to PATH",
echo then double-click this file again.
pause
exit /b 1
:done
if errorlevel 1 pause
