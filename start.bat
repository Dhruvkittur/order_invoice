@echo off
title ANIRUDH AGENCY — Wholesale Order Entry Mobile App
echo =============================================================
echo   ANIRUDH AGENCY — Starting Mobile Order Entry Server
echo =============================================================
node local-server.js --open
if errorlevel 1 (
    echo Node.js error, trying python...
    start http://localhost:3000
    python -m http.server 3000
)
pause
