@echo off
REM ---------------------------------------------------------------------
REM  IBI AI System - on-device engine
REM  Starts the local model runtime that powers the "IBI Local" engine,
REM  plus the gateway that lets a phone reach it.
REM
REM  The settings are applied here rather than left to the tray app:
REM    OLLAMA_MODELS   keeps the 2.5 GB model off the C: drive, which is
REM                    short on space.
REM    OLLAMA_ORIGINS  lets the AI System page call this runtime. Without
REM                    the live subdomain listed, the browser's CORS check
REM                    refuses the request with a 403. It is an allowlist
REM                    on purpose - do NOT widen it to *, or any site you
REM                    happen to visit could drive the model on this PC.
REM
REM  Both parts are started independently and each is skipped if it is
REM  already listening, so running this twice is harmless.
REM ---------------------------------------------------------------------

set "OLLAMA_MODELS=D:\OllamaModels"
set "OLLAMA_ORIGINS=https://ai.indiabusinessinternational.online,http://localhost,http://localhost:*,http://127.0.0.1,http://127.0.0.1:*"

REM ---- gateway on 11435 ------------------------------------------------
REM  What the Cloudflare tunnel points at. It checks an access code and
REM  forwards only chat, so the runtime - which has no authentication of
REM  its own - is never the thing exposed. Listens on loopback only, and
REM  is harmless when nothing is using the tunnel.
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 11435 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if errorlevel 1 goto runtime
start "" /b node "%~dp0local-gateway.js" >> "%~dp0gateway.log" 2>&1

REM ---- model runtime on 11434 ------------------------------------------
:runtime
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if errorlevel 1 exit /b 0

"%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
