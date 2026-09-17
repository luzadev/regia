# CLAUDE.md — Sistema di richiesta parola per studio TV

Questo file è il brief di progetto. Leggilo per intero prima di scrivere codice. Lavora per milestone (vedi §9): completa e fai collaudare la M1 prima di passare oltre.

## 1. Contesto

Studio televisivo con 7 poltrone ospiti. Ogni poltrona ha un mini PC con monitor touch, webcam e microfono, collegato in LAN. Un PC server in regia raccoglie le richieste di parola, mostra la coda alla regia e, all'autorizzazione, manda video+audio della poltrona autorizzata sulla propria seconda uscita HDMI (feed pulito verso il mixer) e accende le luci della postazione.

Questo repository contiene il software: backend, pagina poltrona, dashboard regia e driver.

**Percorso video: WebRTC in casa.** La pagina poltrona pubblica webcam+microfono via WebRTC; sulla seconda uscita HDMI del PC di regia gira Chromium in kiosk sulla pagina `/feed/`, che mostra la poltrona autorizzata ed è il feed pulito verso il mixer. Il signalling passa sul WebSocket già esistente, senza STUN né TURN (solo candidati host in LAN). Nessun software di terze parti sulle poltrone. Il driver NDI (`video.ndi.js`, Studio Monitor) resta nel repository come alternativa selezionabile da config.

## 2. Regole di prodotto NON negoziabili

1. **La chiusura dell'intervento è sempre e solo manuale dalla regia.** Nessun timeout chiude mai un intervento.
2. **Il countdown a zero non taglia nulla**: è solo segnalazione visiva (rosso lampeggiante + "TEMPO SCADUTO"). Superato lo zero il conteggio prosegue in negativo (overtime, `-MM:SS`).
3. **Una sola poltrona LIVE alla volta** (c'è un solo HDMI in uscita). Autorizzare B mentre A è live chiude A e apre B.
4. **Fail-safe**: se il server o la rete cadono, le poltrone mostrano la schermata OFFLINE; al riavvio tutto riparte in stato IDLE pulito. Il feed verso il mixer a riposo è nero (mai contenuto sbagliato).
5. **Zero dipendenze da internet a runtime.** Tutto gira in LAN. Nessun servizio cloud, nessuna telemetria.
6. Il touch della poltrona **non decide mai da solo**: ogni cambio di view è comandato dal server.
7. **Nessun errore di driver può interrompere la diretta**: ogni chiamata a video/luci ha timeout breve, l'errore viene loggato e segnalato in dashboard, ma la sequenza prosegue.

## 3. Stack tecnico (deciso, non cambiare senza chiedere)

- **Backend**: Node.js 20+, Express + `ws` (WebSocket). Un solo processo.
- **Frontend**: HTML/CSS/JS vanilla, servito dal backend. Nessun framework, nessun build step, nessun bundler. Deve girare su Chromium in kiosk su hardware modesto (N100).
- **Video/audio**: WebRTC nativo del browser (nessuna libreria), signalling sul WebSocket esistente, `iceServers: []`.
- **Stato**: in memoria, con log eventi append-only su file JSONL (per la cronologia dei tempi di parola). Niente database. Unica eccezione alla memoria volatile: i nomi ospite (vedi §6).
- **Configurazione**: un solo file `config.json` (vedi §6).
- Lingua: codice e commit in inglese; testi UI in italiano.

## 4. Struttura repository

```
/server
  index.js            # entrypoint: http + ws + orchestrazione driver
  state.js            # macchina a stati e coda (nessuna I/O, testabile)
  feed.js             # hub WebRTC: quale poltrona sta sul feed, relay del signalling
  settings.js         # validazione delle impostazioni modificabili a runtime
  drivers/
    video.mock.js     # driver video finto (logga soltanto)
    video.webrtc.js   # punta la pagina /feed/ sulla poltrona autorizzata (M2)
    video.ndi.js      # alternativa: commuta sorgente via HTTP di NDI Studio Monitor
    lights.mock.js
    lights.wled.js    # WLED JSON API (M3)
    relay.shelly.js   # accensione barre LED via Shelly/relè HTTP (M3)
  log.js              # event log JSONL
/public
  poltrona/           # pagina poltrona: /poltrona/?id=post-01
  log/                # cronologia interventi e tempi di parola: /log/
  regia/              # dashboard: /regia/
  impostazioni/       # configurazione luci e relè: /impostazioni/
  feed/               # feed pulito verso il mixer: /feed/ (Chromium kiosk su HDMI 2)
  diagnostica/        # prova telecamera sul computer della poltrona: dispositivi, risoluzioni, PTZ
  shared/             # css comune, client ws con riconnessione, WebRTC
/scripts
  sim.js              # simulatore poltrone (npm run sim)
/test
  state.test.js       # test della macchina a stati (node --test)
  integration.feed.test.js  # server vero + client di protocollo: ordine rigido, regole di accoppiamento, anteprima
config.json
config.example.json
package.json
README.md             # istruzioni avvio e deploy (in italiano)
```

## 5. Macchina a stati (per poltrona)

Stati: `IDLE`, `REQUESTED`, `LIVE`, `DENIED` (transitorio, `denied_duration_s`).

`OFFLINE` **non è uno stato della macchina**: è il flag ortogonale `connected` per poltrona, derivato dalla connessione WebSocket (chiusura socket oppure ping/pong senza risposta oltre `station_offline_timeout_ms`). Una poltrona che cade mentre è in `REQUESTED` o `LIVE` **mantiene il proprio stato**: non si perde il posto in coda e nulla va in onda o fuori onda da solo (§2.1). La dashboard mostra il badge offline sopra lo stato reale.

Transizioni:
- `IDLE → REQUESTED`: tocco "Chiedi la parola" (debounce lato server: una sola richiesta attiva per poltrona; richiesta ignorata durante `DENIED`).
- `REQUESTED → IDLE`: annulla ospite, oppure "Nega" regia (passando da `DENIED`).
- `REQUESTED → LIVE`: "Autorizza" regia.
- `IDLE → LIVE`: "Forza in onda" dalla regia, ammesso anche senza richiesta dell'ospite.
- `LIVE → IDLE`: "Chiudi" regia. Unica via d'uscita da LIVE.

Se un'altra poltrona è LIVE al momento di un'autorizzazione, il server esegue prima la sequenza completa di chiusura, poi quella di apertura. La poltrona chiusa torna in `IDLE` e **non** rientra in coda.

Sequenza apertura (ordine rigido): commuta sorgente video → view "LIVE" alla poltrona (`state_sync`) → luci ON. Sequenza chiusura: inversa (luci OFF → `state_sync` → sorgente nera).

Con il driver WebRTC il primo passo si considera concluso **solo quando la pagina `/feed/` conferma che il video sta effettivamente andando in onda** (`feed_ready`): la poltrona non vede mai "SEI IN ONDA" prima che il mixer stia ricevendo la sua immagine. Durante la sequenza gli aggiornamenti verso le poltrone sono sospesi, mentre la dashboard continua ad aggiornarsi (l'operatore deve vedere che sta succedendo qualcosa).

Coda: FIFO per timestamp di richiesta, visibile in dashboard con nome ospite e attesa. **Alla chiusura non c'è auto-autorizzazione**: il passaggio al successivo è sempre un'azione esplicita della regia (pulsante "Autorizza il primo" / `POST /api/grant-next`).

## 6. config.json (schema)

```json
{
  "bind_host": "0.0.0.0",
  "http_port": 8080,
  "control_token": null,
  "tls": { "cert": "certs/server.crt", "key": "certs/server.key" },
  "stations": [
    { "id": "post-01", "label": "Poltrona 1", "ndi_source": "POLTRONA-1",
      "wled_segment": 0, "relay_url": "http://192.168.10.41/relay/0" }
  ],
  "video_driver": "mock",
  "lights_driver": "mock",
  "relay_driver": "mock",
  "ndi_monitor_url": "http://127.0.0.1:80",
  "ndi_config_path": "/v1/configuration",
  "ndi_sources_path": "/v1/sources",
  "ndi_monitor_auth": null,
  "wled_url": "http://192.168.10.31",
  "wled_effects": { "solid": 0, "blink": 1 },
  "relay_on_url": "{url}?turn=on",
  "relay_off_url": "{url}?turn=off",
  "driver_timeout_ms": 1500,
  "heartbeat_interval_ms": 2000,
  "station_offline_timeout_ms": 6000,
  "denied_duration_s": 5,
  "countdown_presets_s": [30, 60, 120, 300],
  "countdown_default_s": null,
  "log_path": "data/events.jsonl",
  "names_path": "data/names.json",
  "colors": {
    "requested": { "rgb": [255, 170, 0], "effect": "blink" },
    "live":      { "rgb": [255, 0, 0],   "effect": "solid" },
    "idle":      { "rgb": [0, 0, 0],     "effect": "off" }
  }
}
```

- I driver si scelgono da config: `video_driver` (`mock` | `ndi`), `lights_driver` (`mock` | `wled`), `relay_driver` (`mock` | `shelly`). Luci e relè sono due driver distinti perché sono due impianti distinti.
- `countdown_default_s: null` = un `grant` senza `countdown_s` apre un LIVE **senza** countdown.
- **NDI Studio Monitor**: si comanda con un POST JSON su `/v1/configuration` — `{"version":1,"NDI_source":"MACCHINA (Stream)"}` per commutare, `"NDI_source":""` per il nero. `/v1/sources` elenca le sorgenti viste in rete (`npm run ndi:sources`). **La prima finestra di Studio Monitor ascolta sulla porta 80, la seconda sulla 81**, ecc.: `ndi_monitor_url` deve puntare alla finestra che sta sull'uscita HDMI pulita. Percorso, nome del campo e versione API restano configurabili (`ndi_config_path`, `ndi_source_field`, `ndi_api_version`) per eventuali build diverse; `ndi_monitor_auth` accetta `{ "user": "...", "password": "..." }` se l'interfaccia è protetta.
- **Luci e relè**: WLED riceve un POST su `/json/state` con il segmento della poltrona (`transition: 0`, perché una spia commuta e non sfuma); a riposo il segmento si spegne ma il controller resta acceso, così le altre poltrone non si toccano. Gli id degli effetti sono in `wled_effects` perché non tutte le build WLED li numerano uguale. Il relè usa i template `relay_on_url` / `relay_off_url` con segnaposto `{url}`: il default è Shelly gen 1, per la gen 2 basta cambiare le due stringhe. Una poltrona senza `wled_segment` o senza `relay_url` viene semplicemente saltata: è una scelta di configurazione, non un guasto.
- **Dispositivi della poltrona**: `webrtc_video_device` / `webrtc_audio_device` scelgono telecamera e microfono per nome (frammento, senza maiuscole). Le poltrone usano la **OBSBOT Tiny 2 Lite**. Senza questa scelta il browser prende i predefiniti, e su una macchina con più ingressi finisce con la telecamera giusta e il microfono sbagliato (verificato). Dispositivo non trovato = la poltrona funziona con il predefinito ma segnala un `warning`, che in regia accende il badge ambra.
- **`tls`**: i browser espongono webcam, microfono e `RTCPeerConnection` **solo in contesto sicuro** (`https://` o `http://localhost`), quindi con le poltrone su altre macchine l'HTTPS è necessario, non opzionale. `npm run cert` genera un certificato auto-firmato per `localhost`, il nome macchina e tutti gli IP di rete. `tls: null` = HTTP, e le poltrone hanno la webcam solo su localhost. Un certificato mancante o illeggibile non ferma il server: riparte in HTTP con un avviso.
- `control_token: null` disattiva l'autenticazione (LAN chiusa). Se valorizzato, il ruolo `control` deve presentarlo nell'`hello` e negli endpoint HTTP (header `X-Control-Token`).
- **Poltrone dalla dashboard**: `stations` si può modificare anche dalla regia (aggiungi/rimuovi a caldo, senza riavvio). Il server riscrive `config.json` in modo atomico tenendo una copia in `config.json.bak`, quindi il file resta l'unica fonte di verità. Una poltrona **in onda non è rimovibile**: prima si chiude l'intervento.
- **Nomi ospite**: si impostano dalla dashboard a inizio puntata e vivono in memoria, ma vengono salvati in `names_path` e ricaricati al boot, così un riavvio a metà puntata non li perde. Sono l'unico dato persistente oltre al log.

## 7. Protocollo WebSocket

Un solo endpoint WS (`/ws`). Il client si presenta con `{ "type": "hello", "role": "station"|"control"|"feed"|"monitor", "station": "post-01", "token": "..." }`.

Il ruolo `feed` è il **feed pulito verso il mixer**: uno solo alla volta (vince l'ultimo, il precedente viene chiuso con codice `4000`). Il ruolo `monitor` è un'**anteprima** (la dashboard): quante se ne vuole, ognuna con la propria connessione WebRTC a qualità ridotta. Un'anteprima non conferma mai l'andata in onda, non genera errori driver e non scalza il feed pulito. Di default **segue l'onda**; con `preview` l'operatore può invece guardare **una poltrona scelta** (tipicamente un ospite in coda) senza mandarla in onda. Ogni dashboard sceglie per conto suo. Se la poltrona in anteprima viene autorizzata, l'anteprima torna a seguire l'onda senza rinegoziare; se l'onda cambia su un'altra poltrona, un'anteprima scelta dall'operatore non viene toccata. Se due client si presentano con lo stesso `station`, **vince l'ultimo** (il precedente viene chiuso con codice `4000`): un kiosk ricaricato non resta bloccato. Il client scalzato **non deve riconnettersi** — altrimenti le due finestre si scalzano a vicenda all'infinito — ma mostrare la view "POLTRONA APERTA ALTROVE" finché non viene ricaricato.

```
station → server : { "type": "request_floor" }
station → server : { "type": "cancel_request" }
control → server : { "type": "grant",  "station": "post-03", "countdown_s": 120 }   // countdown_s opzionale
control → server : { "type": "grant_next" }
control → server : { "type": "deny",   "station": "post-03" }
control → server : { "type": "close",  "station": "post-03" }
control → server : { "type": "countdown_set",    "station": "post-03", "seconds": 60 }  // valore assoluto
control → server : { "type": "countdown_adjust", "station": "post-03", "delta_s": 30 }  // +/- 30 s, calcolato dal server
control → server : { "type": "set_name", "station": "post-03", "name": "Rossi" }
control → server : { "type": "manual_mode", "enabled": true }
control → server : { "type": "get_settings" }
control → server : { "type": "set_settings", "settings": { "lights_driver": "wled", "colors": { … } } }
control → server : { "type": "update_station", "station": "post-03", "wled_segment": 2, "relay_url": "..." }
control → server : { "type": "test_light", "station": "post-03", "color": "live" }   // prova, poi ripristina
control → server : { "type": "test_relay", "station": "post-03" }
server → mittente: { "type": "settings", "settings": { ... } }
control → server : { "type": "add_station", "station": { "id": "post-08", "label": "Poltrona 8", "wled_segment": 7, "relay_url": "..." } }
control → server : { "type": "remove_station", "station": "post-08" }
server → tutti   : { "type": "state_sync", ... }   // stato completo: idempotente, a ogni cambiamento e a ogni connessione
server → tutti   : { "type": "heartbeat", "t": <epoch_ms> }  // ogni heartbeat_interval_ms
server → mittente: { "type": "error", "code": "...", "message": "..." }  // comando rifiutato
```

Percorso video WebRTC:

```
station → server : { "type": "media_status", "ok": true|false, "message": "...", "warning": "...", "devices": { "video": "...", "audio": "..." } }
server → station : { "type": "feed_start", "peer": "feed"|"mon-1", "quality": { "max_kbps": 600, "scale": 2 } }
server → station : { "type": "feed_stop", "peer": "feed"|"mon-1" }
server → feed    : { "type": "feed_target", "station": "post-03"|null }
feed   → server  : { "type": "feed_ready", "station": "post-03" }
feed   → server  : { "type": "feed_error", "station": "post-03", "message": "..." }
monitor → server : { "type": "preview", "station": "post-03"|null }   // null = torna a seguire l'onda
server → monitor : { "type": "preview_mode", "station": "post-03"|null }
station ↔ server ↔ feed/monitor : { "type": "rtc_signal", "peer": "feed"|"mon-1", "station": "post-03", "data": { sdp | candidate } }
```

Il server fa da solo relay del signalling con regole di accoppiamento precise: il **feed pulito** parla solo con la poltrona in onda, e una poltrona non in onda non può mai raggiungerlo; ogni **monitor** parla solo con la poltrona che sta guardando (l'onda, oppure quella scelta in anteprima), e nessun'altra può aprire un canale verso di lui.

Il `+/- 30 s` è sempre `countdown_adjust` gestito dal server (mai un ricalcolo del client), così due click ravvicinati non si sovrascrivono.

Schema di `state_sync`:

```json
{
  "type": "state_sync",
  "server_t": 1710000000000,
  "manual_mode": false,
  "live": "post-03",
  "drivers": { "video": { "status": "ok" }, "lights": { "status": "error", "message": "..." } },
  "feed": { "receivers": 1, "monitors": 1, "previews": 0, "target": "post-03", "ready": true, "audio_blocked": false },
  "stations": [
    { "id": "post-01", "label": "Poltrona 1", "name": "Rossi", "state": "REQUESTED",
      "connected": true, "requested_at": 1709999990000, "live_since": null,
      "deadline": null, "countdown_total_s": null, "denied_until": null,
      "media": { "ok": true, "message": null, "warning": null, "devices": { "video": "OBSBOT Tiny 2 Lite StreamCamera", "audio": "OBSBOT Tiny 2 Lite Microphone" } } }
  ]
}
```

Il client (poltrona e regia) considera il server OFFLINE se non riceve heartbeat per > `station_offline_timeout_ms`: la poltrona mostra la view OFFLINE, la regia un banner. Riconnessione automatica con backoff. Al riconnettersi, lo `state_sync` riallinea tutto (nessuno stato locale autorevole).

Il countdown è calcolato dal server (`deadline` epoch nel `state_sync`); i client lo renderizzano localmente, così non serve un messaggio al secondo. **I client non usano mai `Date.now()` grezzo**: calcolano un offset dal campo `t` dello `heartbeat` (i mini PC sono senza internet e senza NTP, il loro orologio può derivare di minuti).

## 8. Interfacce

**Pagina poltrona** (`/poltrona/?id=post-01`): fullscreen, dark, testi enormi leggibili a 1 m. View: IDLE (pulsante gigante "Chiedi la parola"), REQUESTED ("Richiesta inviata — attendi la regia" + Annulla), LIVE ("SEI IN ONDA" + countdown ad anello: verde → ambra a 60 s e 30 s → rosso lampeggiante a 0 con "TEMPO SCADUTO" e overtime negativo), DENIED, OFFLINE. Nessun altro elemento interattivo. Niente cursore.

Soglie dell'anello: 60 s e 30 s si applicano solo se il totale le supera; per countdown più brevi si usano le soglie proporzionali 50% e 25%.

**Impostazioni** (`/impostazioni/`): pagina separata dalla regia — questa roba non deve stare accanto al pulsante CHIUDI durante una diretta. Gestisce scelta dei driver luci/relè, indirizzo e effetti WLED, template delle chiamate al relè, colori dei tre stati, e segmento/relè di ogni poltrona. Le modifiche vengono scritte in `config.json` e **applicate subito ricaricando i driver, senza riavviare**. Due comandi di prova per poltrona (spia e barra) accendono per due secondi e poi rimettono tutto com'era: servono a capire quale segmento corrisponde a quale poltrona il giorno dell'installazione. Non toccano mai una poltrona in onda.

**Feed pulito** (`/feed/`): pagina nera a riposo, mostra in fullscreen la poltrona autorizzata con il suo audio. Nessun testo, nessun overlay (con `?debug=1` una riga di stato per il collaudo). Va aperta in Chromium kiosk sulla seconda uscita HDMI del PC di regia, quella collegata al mixer.

**Dashboard regia** (`/regia/`): riquadro video sempre visibile — segue la poltrona in onda (etichetta rossa **IN ONDA**) oppure, con «Guarda» su una riga della coda o su una scheda, mostra quella poltrona **prima** di autorizzarla (etichetta ambra **ANTEPRIMA · NON IN ONDA** e pulsante «Torna all'onda»); connessione propria a qualità ridotta, muta, con pulsante per ascoltare l'audio, che serve proprio a controllare il microfono di chi aspetta; colonna coda richieste (ordine di arrivo, attesa in mm:ss), pannello poltrona live con countdown e tasti preset/±30 s, pulsante CHIUDI grande e rosso, griglia stato 7 poltrone (online/offline/stato) con "forza in onda", campo nome ospite per poltrona, toggle "modalità manuale", banner per server offline, errori driver e feed non collegato, indicatore webcam/microfono per poltrona. Utilizzabile anche da touch.

**Modalità manuale**: il server smette di comandare video e luci (coda, stati e display continuano a funzionare). Alla riattivazione il server **risincronizza subito** i driver con lo stato corrente.

**Diagnostica telecamera** (`/diagnostica/`): da aprire sul computer della poltrona (Windows). Verifica contesto sicuro, telecamera e microfono per nome, risoluzioni reali e pan/tilt/zoom dal browser, e invia il risultato a `POST /api/diagnostics`, che lo scrive nel log eventi (`type: "diagnostics"`).

**Endpoint HTTP di servizio** (per Stream Deck, M4): `POST /api/grant-next`, `POST /api/close`, `POST /api/countdown/:seconds`. Senza parametro `station` agiscono sulla poltrona attualmente LIVE. Stessa logica dei messaggi WS.

## 9. Milestone (in quest'ordine)

- **M1 — Core loop con driver mock. ✅ fatta.** Server, macchina a stati, pagina poltrona, dashboard, countdown, heartbeat/OFFLINE, log JSONL. Collaudo: aprire 7 tab `poltrona` + 1 tab `regia` e verificare l'intero giro richiesta→coda→autorizza→countdown→chiudi, il vincolo "una sola LIVE", e il comportamento staccando il server (OFFLINE e recupero).
- **M2 — Percorso video. ✅ fatta.** WebRTC in casa: la poltrona pubblica webcam+microfono, la pagina `/feed/` li mostra sull'HDMI verso il mixer, il server fa da signalling e decide chi è sul feed. A riposo nero. Degrada con grazia: se manca il ricevitore feed, se la poltrona non ha webcam o se il feed non conferma entro `webrtc_ready_timeout_ms`, si logga l'errore, si accende il banner in dashboard e il resto continua. Il driver NDI resta disponibile come alternativa (`video_driver: "ndi"`).
- **M3 — Driver luci. ✅ fatta.** WLED JSON API (`/json/state`, segmenti per poltrona, colori da config) + relè barre via HTTP. Stessa tolleranza ai guasti di M2.
- **M4 — Rifiniture. ✅ fatta.** Endpoint Stream Deck, pagina `/log` con cronologia interventi e durate, script/istruzioni di deploy (systemd + Chromium kiosk) nel README.

## 10. Qualità e collaudo

- Scrivi test automatici almeno per `state.js` (transizioni, vincolo singola LIVE, debounce, deny→idle).
- Prevedi uno script `npm run dev` e un simulatore (`npm run sim`) che apre/emula più poltrone per provare senza hardware.
- Gestisci sempre l'errore dei driver senza far cadere il processo: la diretta non deve mai dipendere da una luce che non risponde.
- **Log JSONL**: una riga per evento, con `ts`, `type`, `station`, `name` e, per gli interventi, un `intervention_id` che lega `live_open` e `live_close` (`duration_s` sulla chiusura), così la pagina `/log` di M4 può ricostruire i tempi di parola senza euristiche.
- Commit piccoli e descrittivi, uno per unità funzionale.
