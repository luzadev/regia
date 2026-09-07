# Regia — sistema di richiesta parola

Software per lo studio con 7 poltrone ospiti: le poltrone chiedono la parola da un touch,
la regia vede la coda e autorizza, il server commuta il feed video verso il mixer e accende
le luci della postazione.

Stato: **M1 e M2 completate** (core loop + percorso video WebRTC in casa). M3 (luci WLED/relè)
e M4 (endpoint Stream Deck, pagina `/log`, deploy) non sono ancora implementate.

Il video e l'audio delle poltrone viaggiano in **WebRTC**, senza software di terze parti:
la pagina poltrona pubblica webcam e microfono, la pagina `/feed/` li mostra a schermo intero
sull'uscita HDMI verso il mixer. Il driver NDI resta disponibile come alternativa.

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
- Feed pulito: `http://<ip-server>:8080/feed/` (schermo intero sull'HDMI verso il mixer)

## Configurazione (`config.json`)

| Campo | Significato |
| --- | --- |
| `bind_host`, `http_port` | interfaccia e porta di ascolto |
| `control_token` | se valorizzato, la dashboard deve presentarlo; `null` = LAN aperta |
| `stations[]` | id, etichetta, sorgente NDI, segmento WLED e URL del relè per ogni poltrona |
| `video_driver` | `webrtc` (predefinito), `ndi` o `mock` |
| `webrtc_ready_timeout_ms` | quanto attendere la conferma della pagina `/feed/` (5 s) |
| `webrtc_constraints` | risoluzione, frame rate e trattamento audio richiesti alla webcam |
| `webrtc_max_bitrate_kbps` | tetto di bitrate video (4000 = 4 Mbit/s), per partire subito alla risoluzione piena |
| `lights_driver` / `relay_driver` | `mock` per ora; `wled`, `shelly` da M3 |
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

## Percorso video WebRTC (M2)

```json
"video_driver": "webrtc",
"webrtc_ready_timeout_ms": 5000,
"webrtc_constraints": {
  "video": { "width": 1280, "height": 720, "frameRate": 30 },
  "audio": { "echoCancellation": false, "noiseSuppression": false, "autoGainControl": false }
}
```

Come funziona:

1. la pagina poltrona apre webcam e microfono **all'avvio** (non all'autorizzazione), così
   andare in onda è immediato e un dispositivo rotto si scopre prima della puntata: la
   dashboard mostra il badge `cam ko` e la poltrona una scritta rossa in basso;
2. all'autorizzazione il server dice alla poltrona di pubblicare e alla pagina `/feed/` chi
   guardare; le due si scambiano l'offerta WebRTC **attraverso il server**, sullo stesso
   WebSocket di tutto il resto;
3. il passo "video" della sequenza si considera concluso solo quando `/feed/` conferma che il
   flusso sta suonando davvero (`feed_ready`): la poltrona vede "SEI IN ONDA" **dopo** che il
   mixer sta ricevendo la sua immagine;
4. alla chiusura il feed torna nero e la poltrona smette di pubblicare.

Niente STUN, niente TURN: i peer sono nella stessa LAN e si scambiano solo candidati host,
quindi nessun traffico esce dalla rete (regola §2.5).

### Anteprima in dashboard

La dashboard mostra in alto al pannello "in onda" **cosa sta uscendo davvero**, con un pulsante
per ascoltare l'audio (di default muta, per non avere la voce dell'ospite da un secondo
altoparlante in regia).

L'anteprima è una connessione WebRTC **separata** dal feed pulito, a bassa qualità
(`webrtc_monitor_quality`, di default 600 kbit/s a mezza risoluzione): un secondo encode a
piena qualità costerebbe al mini PC quanto quello in onda, per un riquadro di pochi centimetri.
Non conferma mai l'andata in onda, non genera errori driver e **non scalza il feed pulito**:
il feed resta a ricevitore singolo.

Funziona anche quando `/feed/` non è ancora aperta, che è la condizione tipica in allestimento.

### La pagina /feed/ sul PC di regia

Va aperta in Chromium kiosk sul monitor collegato al mixer:

```
chromium --kiosk --autoplay-policy=no-user-gesture-required \
  --window-position=1920,0 http://localhost:8080/feed/
```

`--autoplay-policy=no-user-gesture-required` è **necessario**: senza, il browser blocca la
riproduzione con audio finché qualcuno non clicca (in quel caso la pagina mostra da sola un
avviso da toccare). `--window-position` va impostato sull'origine del secondo monitor.

Per il collaudo, `http://localhost:8080/feed/?debug=1` aggiunge una riga di stato in basso a
sinistra; senza `?debug=1` la pagina è nera e basta, come dev'essere un feed pulito.

L'audio esce dal dispositivo audio predefinito di Windows: per farlo viaggiare dentro l'HDMI
verso il mixer, imposta come predefinita l'uscita audio HDMI di quel monitor.

### Permessi webcam sulle poltrone

Chromium chiede il permesso per webcam e microfono. In kiosk conviene concederlo una volta
per sempre all'origine del server:

```
chromium --kiosk --use-fake-ui-for-media-stream \
  "http://<ip-server>:8080/poltrona/?id=post-01"
```

In alternativa, criterio aziendale `VideoCaptureAllowedUrls` / `AudioCaptureAllowedUrls` con
l'origine del server, oppure concedere il permesso a mano la prima volta (Chromium lo ricorda
per quell'origine).

### Qualità del video

WebRTC nasce per internet: parte a ~300 kbit/s e sale piano, e riduce la risoluzione appena
sospetta congestione. In una LAN dedicata è una cautela inutile, quindi il sender è tarato
esplicitamente:

| Parametro | Effetto |
| --- | --- |
| `webrtc_constraints.video` | risoluzione e fps chiesti alla webcam (1280x720@30 di default) |
| `webrtc_min_bitrate_kbps` | pavimento e bitrate iniziale (1500): niente prima inquadratura molle |
| `webrtc_max_bitrate_kbps` | tetto (4000) |
| `webrtc_codec` | `null` lascia scegliere il browser; `"H264"` di solito significa codifica hardware sui mini PC, `"VP9"` qualità migliore a parità di banda ma più CPU |
| `webrtc_monitor_quality` | qualità dell'anteprima in dashboard (`max_kbps`, `scale`) |

Oltre a questo il sender chiede `degradationPreference: maintain-resolution`, cioè in caso di
difficoltà preferisce perdere fotogrammi che nitidezza — su un talking head è la scelta giusta.

Misurato in laboratorio dopo la taratura: **1280x720 a 30 fps, ~4 Mbit/s, nessuna limitazione
di qualità**. Prima della taratura lo stesso collegamento stava a 780 kbit/s e scendeva a
480x270.

Per verificare in studio, dalla console della pagina poltrona in onda:

```js
(await regiaPeer.getStats()).forEach(r => r.type === 'outbound-rtp' && r.kind === 'video' && console.log(r.frameWidth, r.frameHeight, r.framesPerSecond, r.qualityLimitationReason))
```

`qualityLimitationReason` dice chi sta limitando: `bandwidth` (rete), `cpu` (mini PC troppo
carico: prova `"webrtc_codec": "H264"` o scendi a 720p25), `none` (tutto a posto).

### Se qualcosa non funziona

| Sintomo | Causa tipica |
| --- | --- |
| Banner rosso "nessun ricevitore feed collegato" | la pagina `/feed/` non è aperta sul PC di regia |
| Badge `cam ko` su una poltrona | permesso negato, webcam scollegata o occupata da un altro programma |
| Feed nero con poltrona in onda | il feed non ha confermato entro `webrtc_ready_timeout_ms`: guarda `/feed/?debug=1` |
| Video sì, audio no | l'uscita audio di Windows non è quella HDMI, oppure l'autoplay è bloccato |

## Alternativa: driver video NDI

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

## Aggiungere e togliere poltrone

Dalla dashboard, pannello **Poltrone → + Aggiungi poltrona**. Id ed etichetta sono già
proposti (`post-08`, «Poltrona 8»); segmento luci e URL del relè sono facoltativi e servono
solo ai driver di M3.

La poltrona è attiva **subito, senza riavviare il server**, e viene scritta in `config.json`
(in modo atomico, con copia di sicurezza in `config.json.bak`): resta anche dopo un riavvio.
Sotto l'etichetta di ogni scheda c'è il suo id: cliccandolo si apre la pagina di quella
poltrona, pronta da caricare sul mini PC nuovo.

Per toglierne una, la **×** in alto a destra della scheda, con conferma in due passi. Una
poltrona **in onda non si può rimuovere**: prima si chiude l'intervento. Chi era collegato a
una poltrona rimossa vede subito «POLTRONA NON CONFIGURATA».

Nulla nel codice fissa il numero di postazioni: provato con dodici, la griglia di regia si
riadatta da sola. Il numero è limitato solo dall'hardware, non dal software.

## Roadmap

`docs/roadmap.html` — apribile direttamente nel browser (doppio clic sul file). Descrive le
release successive: studio completo, multi-device, ospiti remoti, ambienti phygital.

## Modalità manuale

Il toggle in dashboard congela i driver: il server smette di comandare video e luci, ma coda,
stati e display delle poltrone continuano a funzionare. Disattivandolo, il server risincronizza
subito hardware e stato corrente. Serve quando si passa in regia manuale o quando un driver
sta dando problemi.

## Prerequisiti hardware e software

Con il percorso WebRTC predefinito il sistema è autosufficiente: servono solo Node sul PC di
regia e Chromium sulle macchine.

1. **Poltrone**: mini PC con webcam e microfono, Chromium in kiosk su
   `/poltrona/?id=post-0N` con il permesso media concesso all'origine del server.
2. **Regia**: questo server, più Chromium in kiosk su `/feed/` a schermo intero sull'uscita
   HDMI collegata al mixer.
3. **Rete**: tutte le macchine sulla stessa LAN. Nessun accesso a internet.

Con `video_driver: "ndi"` servono invece NDI Studio Monitor sul PC di regia e un emittente
NDI su ogni poltrona (vedi §Alternativa).

### Banda di rete

Pubblica solo la poltrona in onda: il server dice alle altre di non trasmettere, quindi sulla
rete viaggia **un flusso alla volta** (qualche Mbit/s a 720p30), non sette. Una LAN a 100 Mbit
basterebbe; con una gigabit si sta larghi. Le poltrone non in onda non consumano banda.

### Audio verso il mixer

L'audio arriva alla pagina `/feed/` ed esce dal **dispositivo audio predefinito di Windows**
sul PC di regia: non finisce automaticamente dentro l'HDMI. Se il mixer si aspetta l'audio
embedded, imposta come predefinita l'uscita audio HDMI di quel monitor; altrimenti preleva
l'audio dalla scheda del PC e portalo al banco separatamente.

Se il microfono della poltrona è già cablato al banco audio, **non mandare la stessa voce
anche via WebRTC**: sommeresti due volte lo stesso audio con ritardi diversi. In quel caso
metti `"audio": false` in `webrtc_constraints`.

### Latenza e taglio pulito

In LAN la latenza WebRTC è nell'ordine dei 100-200 ms, ma la commutazione **non è a livello di
frame**: l'handshake richiede qualche centinaio di millisecondi. Il taglio pulito lo fa il
mixer, che tratta questa uscita HDMI come una sorgente. Il software garantisce comunque che la
poltrona veda "SEI IN ONDA" solo **dopo** che il feed sta effettivamente trasmettendo la sua
immagine, quindi non esiste il caso "l'ospite parla ma il mixer riceve ancora nero".
