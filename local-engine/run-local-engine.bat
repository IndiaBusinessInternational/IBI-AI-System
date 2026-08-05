@echo off
setlocal
REM ---------------------------------------------------------------------
REM  IBI AI System - on-device engine
REM  Starts, and then KEEPS UP, the two processes behind the "IBI Local"
REM  engine:
REM
REM      gateway  127.0.0.1:11435   what the Cloudflare tunnel points at
REM      runtime  127.0.0.1:11434   the model itself
REM
REM  WHY THIS SUPERVISES INSTEAD OF JUST STARTING.
REM  The earlier version started both once and exited. That is fine on
REM  this PC - if the runtime stops you are sitting in front of it and can
REM  see so. It is not fine from a phone: the tunnel stays up and healthy
REM  the whole time, so a dead runtime looks exactly like a working system
REM  that refuses to answer, and there is no way to restart it from the
REM  phone. Either half dying silently kills mobile IBI Local until
REM  somebody comes back to the laptop. So this loops.
REM
REM  Each half is checked and restarted independently: the gateway
REM  survives the runtime dying (verified), so restarting one must never
REM  disturb the other.
REM
REM  TWO THINGS THIS FILE IS FUSSY ABOUT - both cost an afternoon once:
REM
REM    1. LINE ENDINGS MUST BE CRLF. With Unix line endings cmd cannot
REM       resolve "call :label" and every check fails with "The system
REM       cannot find the batch label specified", which leaves the loop
REM       spinning and restarting nothing. It looks identical to the
REM       engine simply being down.
REM
REM    2. EACH PROCESS LOGS TO ITS OWN FILE. The gateway holds gateway.log
REM       open for as long as it runs, so anything else appending to that
REM       same file just fails with "being used by another process" - and
REM       the supervisor's own diagnostics are exactly what you need when
REM       this misbehaves.
REM
REM  The settings are applied here rather than left to the tray app:
REM    OLLAMA_MODELS   keeps the 2.5 GB model off the C: drive, which is
REM                    short on space.
REM    OLLAMA_ORIGINS  lets the AI System page call this runtime directly
REM                    when you are ON this PC. Without the live subdomain
REM                    listed, the browser's CORS check refuses the
REM                    request with a 403. It is an allowlist on purpose -
REM                    do NOT widen it to *, or any site you happen to
REM                    visit could drive the model on this PC.
REM                    (The phone path does not rely on this: the gateway
REM                    answers CORS itself and strips Origin.)
REM
REM  Started hidden from the Startup folder by IBI-LocalEngine.vbs.
REM  Running it a second time is harmless - it adopts whatever is already
REM  listening rather than starting a duplicate.
REM ---------------------------------------------------------------------

set "OLLAMA_MODELS=D:\OllamaModels"
set "OLLAMA_ORIGINS=https://ai.indiabusinessinternational.online,http://localhost,http://localhost:*,http://127.0.0.1,http://127.0.0.1:*"

set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
set "GATEWAY_JS=%~dp0local-gateway.js"
set "GATEWAY_LOG=%~dp0gateway.log"
set "RUNTIME_LOG=%~dp0runtime.log"
set "SUP_LOG=%~dp0supervisor.log"

REM  How often to look. Long enough to be invisible, short enough that a
REM  phone retry a few seconds later finds the engine back up.
set "CHECK_SECONDS=15"

echo [%date% %time%] supervisor: started, checking every %CHECK_SECONDS%s >> "%SUP_LOG%"

:loop

REM ---- gateway on 11435 ------------------------------------------------
REM  What the Cloudflare tunnel points at. It checks an access code and
REM  forwards only chat, so the runtime - which has no authentication of
REM  its own - is never the thing exposed. Listens on loopback only, and
REM  is harmless when nothing is using the tunnel.
call :listening 11435
if errorlevel 1 (
  echo [%date% %time%] supervisor: gateway not listening, starting >> "%SUP_LOG%"
  start "" /b node "%GATEWAY_JS%" >> "%GATEWAY_LOG%" 2>&1
)

REM ---- model runtime on 11434 ------------------------------------------
REM  Started detached rather than in the foreground: this script has to
REM  stay alive to keep watching, so it must not block on the runtime.
call :listening 11434
if errorlevel 1 (
  echo [%date% %time%] supervisor: runtime not listening, starting >> "%SUP_LOG%"
  start "" /b "%OLLAMA_EXE%" serve >> "%RUNTIME_LOG%" 2>&1
)

REM  timeout needs a console; started hidden there isn't one, hence ping.
ping -n %CHECK_SECONDS% 127.0.0.1 >nul 2>&1
goto loop

REM ---------------------------------------------------------------------
REM  Sets errorlevel 1 when nothing holds the port, 0 when something does.
REM ---------------------------------------------------------------------
:listening
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %1 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
goto :eof
