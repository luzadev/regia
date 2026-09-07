# CLAUDE.md — Sistema di richiesta parola per studio TV

Questo file è il brief di progetto. Leggilo per intero prima di scrivere codice. Lavora per milestone (vedi §9): completa e fai collaudare la M1 prima di passare oltre.

## 1. Contesto

Studio televisivo con 7 poltrone ospiti. Ogni poltrona ha un mini PC con monitor touch, webcam e microfono, collegato in LAN. Un PC server in regia raccoglie le richieste di parola, mostra la coda alla regia e, all'autorizzazione, manda video+audio della poltrona autorizzata sulla propria seconda uscita HDMI (feed pulito verso il mixer) e accende le luci della postazione.

Questo repository contiene il software: backend, pagina poltrona, dashboard regia e driver.

**Fuori scope, ma necessario al sistema**: la pubblicazione delle sorgenti NDI dalle poltrone (webcam+microfono → rete) è a carico di un software di terze parti sui mini PC (NDI Scan Converter, OBS con output NDI o equivalente), e la seconda uscita HDMI del server è pilotata da NDI Studio Monitor a schermo intero. Vedi README §Prerequisiti.

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
- **Stato**: in memoria, con log eventi append-only su file JSONL (per la cronologia dei tempi di parola). Niente database. Unica eccezione alla memoria volatile: i nomi ospite (vedi §6).
- **Configurazione**: un solo file `config.json` (vedi §6).
- Lingua: codice e commit in inglese; testi UI in italiano.

## 4. Struttura repository

```
/server
  index.js            # entrypoint: http + ws + orchestrazione driver
  state.js            # macchina a stati e coda (nessuna I/O, testabile)
  drivers/
    video.mock.js     # driver video finto (logga soltanto)
    video.ndi.js      # commuta sorgente via HTTP di NDI Studio Monitor (M2)
    lights.mock.js
    lights.wled.js    # WLED JSON API (M3)
    relay.shelly.js   # accensione barre LED via Shelly/relè HTTP (M3)
  log.js              # event log JSONL
/public
  poltrona/           # pagina poltrona: /poltrona/?id=post-01
  regia/              # dashboard: /regia/
  shared/             # css comune, client ws con riconnessione
/scripts
  sim.js              # simulatore poltrone (npm run sim)
/test
  state.test.js       # test della macchina a stati (node --test)
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

Coda: FIFO per timestamp di richiesta, visibile in dashboard con nome ospite e attesa. **Alla chiusura non c'è auto-autorizzazione**: il passaggio al successivo è sempre un'azione esplicita della regia (pulsante "Autorizza il primo" / `POST /api/grant-next`).

## 6. config.json (schema)

```json
{
  "bind_host": "0.0.0.0",
  "http_port": 8080,
  "control_token": null,
  "stations": [
    { "id": "post-01", "label": "Poltrona 1", "ndi_source": "POLTRONA-1",
      "wled_segment": 0, "relay_url": "http://192.168.10.41/relay/0" }
  ],
  "video_driver": "mock",
  "lights_driver": "mock",
  "relay_driver": "mock",
  "ndi_monitor_url": "http://127.0.0.1:81",
  "wled_url": "http://192.168.10.31",
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
- `control_token: null` disattiva l'autenticazione (LAN chiusa). Se valorizzato, il ruolo `control` deve presentarlo nell'`hello` e negli endpoint HTTP (header `X-Control-Token`).
- **Nomi ospite**: si impostano dalla dashboard a inizio puntata e vivono in memoria, ma vengono salvati in `names_path` e ricaricati al boot, così un riavvio a metà puntata non li perde. Sono l'unico dato persistente oltre al log.

## 7. Protocollo WebSocket

Un solo endpoint WS (`/ws`). Il client si presenta con `{ "type": "hello", "role": "station"|"control", "station": "post-01", "token": "..." }`. Se due client si presentano con lo stesso `station`, **vince l'ultimo** (il precedente viene chiuso): un kiosk ricaricato non resta bloccato.

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
server → tutti   : { "type": "state_sync", ... }   // stato completo: idempotente, a ogni cambiamento e a ogni connessione
server → tutti   : { "type": "heartbeat", "t": <epoch_ms> }  // ogni heartbeat_interval_ms
server → mittente: { "type": "error", "code": "...", "message": "..." }  // comando rifiutato
```

Il `+/- 30 s` è sempre `countdown_adjust` gestito dal server (mai un ricalcolo del client), così due click ravvicinati non si sovrascrivono.

Schema di `state_sync`:

```json
{
  "type": "state_sync",
  "server_t": 1710000000000,
  "manual_mode": false,
  "live": "post-03",
  "drivers": { "video": { "status": "ok" }, "lights": { "status": "error", "message": "..." } },
  "stations": [
    { "id": "post-01", "label": "Poltrona 1", "name": "Rossi", "state": "REQUESTED",
      "connected": true, "requested_at": 1709999990000, "live_since": null,
      "deadline": null, "countdown_total_s": null, "denied_until": null }
  ]
}
```

Il client (poltrona e regia) considera il server OFFLINE se non riceve heartbeat per > `station_offline_timeout_ms`: la poltrona mostra la view OFFLINE, la regia un banner. Riconnessione automatica con backoff. Al riconnettersi, lo `state_sync` riallinea tutto (nessuno stato locale autorevole).

Il countdown è calcolato dal server (`deadline` epoch nel `state_sync`); i client lo renderizzano localmente, così non serve un messaggio al secondo. **I client non usano mai `Date.now()` grezzo**: calcolano un offset dal campo `t` dello `heartbeat` (i mini PC sono senza internet e senza NTP, il loro orologio può derivare di minuti).

## 8. Interfacce

**Pagina poltrona** (`/poltrona/?id=post-01`): fullscreen, dark, testi enormi leggibili a 1 m. View: IDLE (pulsante gigante "Chiedi la parola"), REQUESTED ("Richiesta inviata — attendi la regia" + Annulla), LIVE ("SEI IN ONDA" + countdown ad anello: verde → ambra a 60 s e 30 s → rosso lampeggiante a 0 con "TEMPO SCADUTO" e overtime negativo), DENIED, OFFLINE. Nessun altro elemento interattivo. Niente cursore.

Soglie dell'anello: 60 s e 30 s si applicano solo se il totale le supera; per countdown più brevi si usano le soglie proporzionali 50% e 25%.

**Dashboard regia** (`/regia/`): colonna coda richieste (ordine di arrivo, attesa in mm:ss), pannello poltrona live con countdown e tasti preset/±30 s, pulsante CHIUDI grande e rosso, griglia stato 7 poltrone (online/offline/stato) con "forza in onda", campo nome ospite per poltrona, toggle "modalità manuale", banner per server offline ed errori driver. Utilizzabile anche da touch.

**Modalità manuale**: il server smette di comandare video e luci (coda, stati e display continuano a funzionare). Alla riattivazione il server **risincronizza subito** i driver con lo stato corrente.

**Endpoint HTTP di servizio** (per Stream Deck, M4): `POST /api/grant-next`, `POST /api/close`, `POST /api/countdown/:seconds`. Senza parametro `station` agiscono sulla poltrona attualmente LIVE. Stessa logica dei messaggi WS.

## 9. Milestone (in quest'ordine)

- **M1 — Core loop con driver mock.** Server, macchina a stati, pagina poltrona, dashboard, countdown, heartbeat/OFFLINE, log JSONL. Collaudo: aprire 7 tab `poltrona` + 1 tab `regia` e verificare l'intero giro richiesta→coda→autorizza→countdown→chiudi, il vincolo "una sola LIVE", e il comportamento staccando il server (OFFLINE e recupero).
- **M2 — Driver video NDI.** Commutazione sorgente tramite l'interfaccia HTTP di NDI Studio Monitor (`ndi_monitor_url`); a riposo sorgente "nera"/nessuna. Il driver deve degradare con grazia: se Studio Monitor non risponde, log di errore, banner in dashboard, il resto continua.
- **M3 — Driver luci.** WLED JSON API (`/json/state`, segmenti per poltrona, colori da config) + relè barre via HTTP. Stessa tolleranza ai guasti di M2.
- **M4 — Rifiniture.** Endpoint Stream Deck, pagina `/log` con cronologia interventi e durate, script/istruzioni di deploy (systemd + Chromium kiosk) nel README.

## 10. Qualità e collaudo

- Scrivi test automatici almeno per `state.js` (transizioni, vincolo singola LIVE, debounce, deny→idle).
- Prevedi uno script `npm run dev` e un simulatore (`npm run sim`) che apre/emula più poltrone per provare senza hardware.
- Gestisci sempre l'errore dei driver senza far cadere il processo: la diretta non deve mai dipendere da una luce che non risponde.
- **Log JSONL**: una riga per evento, con `ts`, `type`, `station`, `name` e, per gli interventi, un `intervention_id` che lega `live_open` e `live_close` (`duration_s` sulla chiusura), così la pagina `/log` di M4 può ricostruire i tempi di parola senza euristiche.
- Commit piccoli e descrittivi, uno per unità funzionale.
