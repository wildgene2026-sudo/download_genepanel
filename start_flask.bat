@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv-flask\Scripts\python.exe" (
  py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
  if errorlevel 1 goto :python_version_error
  py -3 -m venv .venv-flask
  if errorlevel 1 goto :python_error
)

.venv-flask\Scripts\python.exe -m pip install --disable-pip-version-check --quiet -r flask_app\requirements.txt
if errorlevel 1 goto :install_error

if /I "%~1"=="--lan" set REFERENCE_BRIDGE_HOST=0.0.0.0
.venv-flask\Scripts\python.exe -m flask_app
goto :eof

:python_error
echo Python 3 was not found. Install Python 3.10 or newer, then run this file again.
pause
exit /b 1

:python_version_error
echo Reference Bridge requires Python 3.10 or newer.
pause
exit /b 1

:install_error
echo The Flask packages could not be installed. Check the internet connection and try again.
pause
exit /b 1
