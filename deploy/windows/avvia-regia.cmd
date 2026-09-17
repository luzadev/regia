@echo off
rem ==========================================================================
rem  Regia - avvio del PC server (regia)
rem  Metti un collegamento a questo file in shell:startup dell'utente di regia.
rem ==========================================================================

rem --- da adattare -----------------------------------------------------------
set REGIA_DIR=C:\regia
rem Coordinata X dell'angolo sinistro del monitor collegato al mixer
rem (Impostazioni > Schermo: se il primo monitor e' 1920 px, e' 1920).
set FEED_X=1920
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
rem ---------------------------------------------------------------------------

if not exist "%REGIA_DIR%\data" mkdir "%REGIA_DIR%\data"

rem Server (una sola istanza: se e' gia' attivo, il secondo avvio si ferma da solo)
start "Regia server" /min cmd /c "cd /d %REGIA_DIR% && node server\index.js >> %REGIA_DIR%\data\server.log 2>&1"

rem Attende che il server risponda prima di aprire le pagine
set /a TENTATIVI=0
:attesa
set /a TENTATIVI+=1
powershell -NoProfile -Command "try { [Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}; (Invoke-WebRequest -UseBasicParsing https://localhost:8080/api/ui-config -TimeoutSec 2) > $null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  if %TENTATIVI% lss 30 ( timeout /t 2 /nobreak >nul & goto attesa )
)

rem Feed pulito a schermo intero sul monitor del mixer
start "" %CHROME% --kiosk --autoplay-policy=no-user-gesture-required --window-position=%FEED_X%,0 ^
  --no-first-run --disable-session-crashed-bubble --user-data-dir=%REGIA_DIR%\chrome-feed ^
  "https://localhost:8080/feed/"

rem Dashboard di regia sul monitor dell'operatore
start "" %CHROME% --no-first-run --user-data-dir=%REGIA_DIR%\chrome-regia "https://localhost:8080/regia/"
