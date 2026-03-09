@echo off
cd /d %~dp0
if not exist .firebaserc copy .firebaserc.example .firebaserc >nul
echo Ustaw project ID w .firebaserc
cd functions
call npm install || exit /b 1
cd ..
call firebase deploy --only functions || exit /b 1
