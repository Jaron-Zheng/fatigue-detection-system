@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "REPO=https://github.com/Jaron-Zheng/fatigue-detection-system.git"
set "SITE=https://Jaron-Zheng.github.io/fatigue-detection-system/"

echo ============================================================
echo   Push fatigue-detection-system to GitHub - main + gh-pages
echo   Repo: %REPO%
echo ============================================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git was not found in PATH.
  echo         Install it first: https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

rem --- Ensure a clean repo exists; re-init if missing or broken/unborn ---
git rev-parse --verify HEAD >nul 2>nul
if errorlevel 1 (
  if exist ".git" rmdir /s /q ".git"
  git init -b main
)
git config user.name "Jaron"
git config user.email "Jaron-Zheng@users.noreply.github.com"

echo [1/3] Committing full source to branch main ...
git add -A
git commit -m "chore: optimized fatigue detection system"
git remote remove origin >nul 2>nul
git remote add origin "%REPO%"

echo [2/3] Pushing main ... enter GitHub username and token when asked
git push --force origin main
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to push main.
  echo         Use a Personal Access Token as the password, not your login password.
  echo         Create one: GitHub - Settings - Developer settings - Personal access tokens.
  echo.
  pause
  exit /b 1
)

echo [3/3] Building gh-pages from the web folder and pushing ...
set "GHP=%TEMP%\ghp_%RANDOM%%RANDOM%"
if exist "%GHP%" rmdir /s /q "%GHP%"
mkdir "%GHP%"
robocopy "web" "%GHP%" /E /NFL /NDL /NJH /NJS /NP >nul
pushd "%GHP%"
git init -b gh-pages
git config user.name "Jaron"
git config user.email "Jaron-Zheng@users.noreply.github.com"
git add -A
git commit -m "deploy: GitHub Pages site"
git remote add origin "%REPO%"
git push --force origin gh-pages
set "GHPERR=%errorlevel%"
popd
rmdir /s /q "%GHP%"
if not "%GHPERR%"=="0" (
  echo.
  echo [ERROR] Failed to push gh-pages.
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   DONE. main and gh-pages have been pushed.
echo   Site goes live in 1-2 min: %SITE%
echo ============================================================
echo.
pause
