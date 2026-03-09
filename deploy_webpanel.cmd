@echo off
cd /d %~dp0webpanel
call npm install || exit /b 1
call npm run build || exit /b 1
echo Build gotowy. Wdróż webpanel jako nowy runtime Next.js.
