@echo off
REM ---------------------------------------------------------------------
REM  IBI AI System - on-device engine
REM  Starts the local model runtime that powers the "IBI Local" engine.
REM
REM  The settings are applied here rather than left to the tray app:
REM    OLLAMA_MODELS   keeps the 2.5 GB model off the C: drive, which is
REM                    short on space.
REM    OLLAMA_ORIGINS  lets the AI System page call this runtime. Without
REM                    the live subdomain listed, the browser's CORS check
REM                    refuses the request with a 403. It is an allowlist
REM                    on purpose - do NOT widen it to *, or any site you
REM                    happen to visit could drive the model on this PC.
REM ---------------------------------------------------------------------

set "OLLAMA_MODELS=D:\OllamaModels"
set "OLLAMA_ORIGINS=https://ai.indiabusinessinternational.online,http://localhost,http://localhost:*,http://127.0.0.1,http://127.0.0.1:*"

REM Already listening? Then another copy is running - leave it alone.
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if errorlevel 1 exit /b 0

"%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
