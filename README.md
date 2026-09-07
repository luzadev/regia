# Regia — sistema di richiesta parola

Software per lo studio con 7 poltrone ospiti: le poltrone chiedono la parola da un touch,
la regia vede la coda e autorizza, il server commuta il feed video verso il mixer e accende
le luci della postazione.

Stato: **M1 e M2 completate** (core loop + driver video NDI). M3 (luci WLED/relè) e
M4 (endpoint Stream Deck, pagina `/log`, deploy) non sono ancora implementate.

## Requisiti

- Node.js 20 o superiore (testato su 22)
- Tutto gira in LAN: nessuna connessione internet è richiesta a runtime

## Avvio

```bash
npm install
cp config.example.json config.json   # poi modifica config.json
npm start                            # oppure: npm run dev (riavvio automatico)
```

Il server stampa gli indirizzi utili all'avvio:

- Dashboard regia: `http://<ip-server>:8080/regia/`
- Pagina poltrona: `http://<ip-server>:8080/poltrona/?id=post-01`

## Configurazione (`config.json`)

| Campo | Significato |
| --- | --- |
| `bind_host`, `http_port` | interfaccia e porta di ascolto |
| `control_token` | se valorizzato, la dashboard deve presentarlo; `null` = LAN aperta |
| `stations[]` | id, etichetta, sorgente NDI, segmento WLED e URL del relè per ogni poltrona |
| `video_driver` / `lights_driver` / `relay_driver` | `mock` per ora; `ndi`, `wled`, `shelly` da M2/M3 |
| `driver_timeout_ms` | timeout di ogni chiamata ai driver (default 1500 ms) |
| `heartbeat_interval_ms` | cadenza dell'heartbeat verso i client (2 s) |
| `station_offline_timeout_ms` | oltre questo silenzio la poltrona è OFFLINE (6 s) |
| `denied_duration_s` | durata della schermata "richiesta non accolta" (5 s) |
| `countdown_presets_s` | preset mostrati in dashboard |
| `countdown_default_s` | countdown usato quando si autorizza senza sceglierne uno (`null` = nessuno) |
| `log_path`, `names_path` | file di log eventi e nomi ospite |
| `colors` | colore ed effetto delle luci per stato |

## Collaudo di M1 senza hardware

In due terminali:

```bash
npm start
npm run sim -- --auto      # 7 poltrone simulate che chiedono la parola da sole
```

Poi apri la dashboard e verifica il giro completo: richiesta → coda → autorizza →
countdown → chiudi. Il simulatore accetta anche `--stations post-02,post-05` e `--url`.

In alternativa apri 7 schede `/poltrona/?id=post-0N` e una `/regia/`.

Da controllare in collaudo:

1. la richiesta compare in coda con nome e attesa crescente;
2. autorizzando, la poltrona passa a "SEI IN ONDA" con countdown ad anello;
3. autorizzando una seconda poltrona, la prima si chiude da sola (una sola LIVE);
4. a countdown zero appare "TEMPO SCADUTO" lampeggiante e il conteggio va in negativo,
   **senza** che l'intervento venga chiuso;
5. fermando il server (Ctrl-C) tutte le poltrone passano a "SISTEMA NON DISPONIBILE";
   riavviandolo si riallineano da sole, in IDLE, con i nomi ospite recuperati.

## Test

```bash
npm test        # macchina a stati: transizioni, singola LIVE, debounce, deny -> idle
```

## Log

Ogni evento è una riga JSON in `data/events.jsonl`. Gli interventi sono tracciati da
`live_open` / `live_close` con lo stesso `intervention_id` e la `duration_s` sulla chiusura:
la pagina `/log` di M4 leggerà da qui.

```bash
tail -f data/events.jsonl
```

## Driver video NDI (M2)

Per commutare davvero il feed, in `config.json`:

```json
"video_driver": "ndi",
"ndi_monitor_url": "http://127.0.0.1:80",
"ndi_config_path": "/v1/configuration",
"ndi_sources_path": "/v1/sources",
"ndi_monitor_auth": null
```

Il driver usa l'interfaccia HTTP documentata di Studio Monitor: un POST JSON su
`/v1/configuration` con `{"version":1,"NDI_source":"MACCHINA (Stream)"}` per commutare e
`"NDI_source":""` per il nero (a riposo, all'avvio del server e alla chiusura del processo).

**La porta conta**: la *prima* finestra di Studio Monitor ascolta sulla **80**, la seconda
sulla **81**, la terza sulla 82. `ndi_monitor_url` deve puntare alla finestra che sta a
schermo intero sull'uscita HDMI verso il mixer. Se apri Studio Monitor una volta sola, è la 80.

Se una build diversa usasse un altro schema, si adattano `ndi_config_path`,
`ndi_source_field` e `ndi_api_version` senza toccare il codice. `ndi_monitor_auth` accetta
`{ "user": "...", "password": "..." }` se l'interfaccia è protetta.

### Verificare i nomi delle sorgenti

```bash
npm run ndi:sources                                  # usa ndi_monitor_url da config.json
npm run ndi:sources -- --url http://192.168.10.10:80
```

Elenca le sorgenti NDI viste da Studio Monitor e dice, per ogni poltrona, se la
`ndi_source` configurata corrisponde a una sorgente realmente in rete. I nomi NDI hanno la
forma `NOME-MACCHINA (Nome stream)` e vanno copiati esattamente.

### Tolleranza ai guasti

Se Studio Monitor non risponde entro `driver_timeout_ms`:

- l'errore finisce nel log (`driver_video_error`) e sulla console;
- la dashboard mostra il banner ambra **DRIVER IN ERRORE — VIDEO: …**;
- **il resto continua**: la poltrona va comunque in onda, il countdown parte, le luci si
  accendono e la coda funziona. Alla prima chiamata riuscita il banner sparisce da solo.

## Modalità manuale

Il toggle in dashboard congela i driver: il server smette di comandare video e luci, ma coda,
stati e display delle poltrone continuano a funzionare. Disattivandolo, il server risincronizza
subito hardware e stato corrente. Serve quando si passa in regia manuale o quando un driver
sta dando problemi.

## Prerequisiti hardware e software (fuori da questo repository)

Questo software **non** cattura né pubblica il video delle poltrone: si limita a dire a NDI
Studio Monitor quale sorgente mostrare. Perché il sistema funzioni servono:

1. su ogni mini PC poltrona, un emittente NDI di webcam+microfono (vedi sotto);
2. sul PC di regia, NDI Studio Monitor a schermo intero sull'uscita HDMI collegata al mixer,
   con l'interfaccia web raggiungibile su `ndi_monitor_url`;
3. le poltrone in Chromium kiosk su `/poltrona/?id=post-0N`.

Con `video_driver: "mock"` nulla di tutto questo è necessario: il driver logga soltanto.

### Pubblicare webcam + microfono da ogni poltrona (OBS + DistroAV)

NDI Tools **riceve** ma non pubblica una webcam: Screen Capture cattura lo schermo e Webcam
Input fa il percorso inverso (da NDI a webcam virtuale). Per mandare in rete webcam e
microfono della poltrona la strada collaudata è OBS Studio con il plugin NDI **DistroAV**
(l'ex obs-ndi), gratuito e open source.

Su ogni mini PC, una volta sola:

1. rinomina il PC in `POLTRONA-1` … `POLTRONA-7` (il nome finisce dentro il nome NDI);
2. installa **OBS Studio**, poi **DistroAV** e il **runtime NDI** che il plugin richiede;
3. in OBS crea una scena con due sorgenti: *Dispositivo di acquisizione video* (la webcam) e
   *Cattura audio in ingresso* (il microfono della poltrona);
4. `Strumenti → NDI Output Settings` → abilita **Main Output** e dai un nome stabile
   (es. `POLTRONA-1`). L'uscita principale porta con sé anche l'audio del programma, quindi
   il microfono viaggia insieme al video; le uscite NDI *per singola sorgente* invece hanno
   limiti sull'audio, quindi usa la Main Output;
5. imposta l'avvio automatico di OBS al login (cartella Esecuzione automatica) con
   `--startvirtualcam` non necessario, ma con la scena giusta già attiva;
6. firewall di Windows: consenti OBS e NDI sulla rete **privata** (discovery mDNS su UDP
   5353, flussi TCP dalla 5960 in su). Con il firewall attivo le sorgenti semplicemente
   "non si vedono", senza alcun messaggio di errore.

Il nome NDI risultante ha la forma `NOME-MACCHINA (Nome uscita)`, ad esempio
`POLTRONA-1 (POLTRONA-1)`. Copialo **esatto** in `stations[].ndi_source`: usa
`npm run ndi:sources` per leggere i nomi veri visti da Studio Monitor.

Alternativa senza PC di mezzo: telecamere con NDI nativo (NDI|HX), che pubblicano da sole e
tolgono OBS dall'equazione. Costano di più ma sono una cosa in meno che può rompersi in diretta.

### Banda di rete

NDI trasmette **solo quando qualcuno è in ascolto**. Poiché Studio Monitor riceve una
sorgente alla volta, sulla rete viaggia un flusso solo (qualche decina di Mbit/s), non sette:
una LAN gigabit è ampiamente sufficiente. Le poltrone non in onda non consumano banda.

### Audio verso il mixer

L'audio NDI arriva a Studio Monitor, che lo riproduce su un **dispositivo audio di Windows**:
non finisce automaticamente dentro l'HDMI. Se il mixer si aspetta l'audio embedded nell'HDMI,
imposta l'uscita audio di Studio Monitor sul dispositivo HDMI corrispondente; in alternativa
prendi l'audio dalla scheda audio del PC di regia e portalo al mixer separatamente.

Se il microfono della poltrona è già cablato al banco audio, **non mandare lo stesso
microfono anche via NDI**: sommeresti due volte la stessa voce con ritardi diversi.

### Latenza della commutazione

Il cambio sorgente in Studio Monitor non è a livello di frame: la connessione al nuovo flusso
NDI richiede una frazione di secondo, durante la quale il feed pulito può restare nero o
fermo. Il taglio pulito lo fa il mixer: tratta questa uscita HDMI come una sorgente e stacca
tu quando l'immagine è arrivata. Il software rispetta comunque l'ordine rigido
video → view → luci, quindi la poltrona vede "SEI IN ONDA" dopo che la sorgente è stata
commutata.
