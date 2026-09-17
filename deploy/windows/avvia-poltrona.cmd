@echo off
rem ==========================================================================
rem  Regia - avvio di una poltrona
rem  Una copia per poltrona: cambia STATION. Metti un collegamento a questo
rem  file in shell:startup dell'utente con accesso automatico.
rem ==========================================================================

rem --- da adattare -----------------------------------------------------------
set STATION=post-01
set SERVER_IP=192.168.10.10
set REGIA_DIR=C:\regia
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
rem ---------------------------------------------------------------------------

rem Pagina poltrona in kiosk. Webcam e microfono concessi senza chiedere.
rem Se il server non e' ancora acceso la pagina mostra OFFLINE e si ricollega da sola.
start "" %CHROME% --kiosk --use-fake-ui-for-media-stream --noerrdialogs ^
  --no-first-run --disable-session-crashed-bubble --user-data-dir=%REGIA_DIR%\chrome-poltrona ^
  "https://%SERVER_IP%:8080/poltrona/?id=%STATION%"

rem Agente telecamera (OBSBOT). Si ricollega da solo se il server non c'e' ancora.
if exist "%REGIA_DIR%\agent\native\obsbot_bridge.dll" (
  start "Regia agente telecamera" /min cmd /c "node %REGIA_DIR%\agent\camera-agent.js --server wss://%SERVER_IP%:8080/ws --station %STATION% --ca %REGIA_DIR%\certs\server.crt >> %REGIA_DIR%\agent-%STATION%.log 2>&1"
) else (
  echo Ponte OBSBOT non compilato: agente telecamera non avviato. Vedi docs\INSTALLAZIONE.md
)
