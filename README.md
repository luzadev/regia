# Regia — sistema di richiesta parola

Software per lo studio con 7 poltrone ospiti: le poltrone chiedono la parola da un touch,
la regia vede la coda e autorizza, il server commuta il feed video verso il mixer e accende
le luci della postazione.

Stato: **tutte le milestone completate** — core loop, percorso video WebRTC in casa, luci e
relè, comandi fisici, cronologia e deploy.

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
| `tls` | `{ "cert": …, "key": … }` per servire in HTTPS; `null` = HTTP (webcam solo su localhost) |
| `control_token` | se valorizzato, la dashboard deve presentarlo; `null` = LAN aperta |
| `stations[]` | id, etichetta, sorgente NDI, segmento WLED e URL del relè per ogni poltrona |
| `video_driver` | `webrtc` (predefinito), `ndi` o `mock` |
| `webrtc_ready_timeout_ms` | quanto attendere la conferma della pagina `/feed/` (5 s) |
| `webrtc_constraints` | risoluzione, frame rate e trattamento audio richiesti alla webcam |
| `webrtc_max_bitrate_kbps` | tetto di bitrate video (4000 = 4 Mbit/s), per partire subito alla risoluzione piena |
| `lights_driver` | `mock` oppure `wled` |
| `relay_driver` | `mock` oppure `shelly` |
| `wled_url`, `wled_effects` | indirizzo del controller e id degli effetti (`solid`, `blink`) |
| `relay_on_url`, `relay_off_url` | chiamate di accensione e spegnimento, con segnaposto `{url}` |
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

### Guardare un ospite prima di mandarlo in onda

Su ogni riga della **coda** e su ogni **scheda poltrona** c'è «Guarda». Il riquadro video della
regia passa a quella poltrona, con l'etichetta ambra **ANTEPRIMA · NON IN ONDA** e il bordo
ambra: il mixer non riceve niente, la poltrona resta in coda. Serve a controllare l'ospite
prima di dargli la parola — è inquadrato, è seduto, il microfono è quello giusto (usa
**AUDIO ON** per ascoltarlo).

- «**Torna all'onda**» riporta il riquadro su chi è in onda (etichetta rossa **IN ONDA**).
- Se autorizzi proprio la poltrona che stavi guardando, il riquadro diventa **IN ONDA** senza
  interrompere il video.
- Se nel frattempo l'onda cambia su un'altra poltrona, la tua anteprima **non viene toccata**:
  l'hai scelta tu.
- Ogni postazione di regia sceglie per conto suo cosa guardare.

La poltrona in anteprima non può mai raggiungere il feed pulito: il server collega al feed
solo la poltrona in onda, e a ogni dashboard solo la poltrona che quella dashboard sta
guardando.

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

### Telecamera delle poltrone: OBSBOT Tiny 2 Lite

Misurata il 17/9/2026 collegata via USB, dal browser (Chrome):

| Modo | Supportato |
| --- | --- |
| 3840×2160 @ 30 fps | sì |
| 1920×1080 @ 60 fps | sì |
| 1920×1080 @ 30 fps | sì |
| 1280×720 @ 60 fps | sì |
| 1280×720 @ 30 fps | sì — **default attuale** |

Microfono integrato: si presenta come «OBSBOT Tiny 2 Lite Microphone», e il browser lo
consegna mono a 48 kHz.

**Scegliere i dispositivi per nome, non lasciare fare al browser.** Con la scelta predefinita,
sulla macchina di prova il browser ha preso la telecamera OBSBOT ma **il microfono interno del
computer**: l'ospite sarebbe andato in onda con l'immagine giusta e l'audio sbagliato. Per
questo in `config.json`:

```json
"webrtc_video_device": "OBSBOT",
"webrtc_audio_device": "OBSBOT"
```

Sono frammenti del nome del dispositivo, senza distinzione di maiuscole. Se il dispositivo
indicato non si trova, la poltrona **funziona comunque** con quello predefinito, ma in regia
il badge diventa **ambra `cam !`** e passandoci sopra si leggono l'avviso e i dispositivi
effettivamente in uso: una differenza di nome non deve togliere una postazione dall'onda,
ma la regia deve saperlo. Con `null` il browser sceglie da solo.

**Risoluzione**: la telecamera arriva al 4K, ma a decidere è il mini PC che codifica. Il
default resta 1280×720@30; per passare a 1080p, prova sulla macchina della poltrona con
`webrtc_constraints.video` a 1920×1080 e controlla `qualityLimitationReason` (vedi *Qualità
del video*): se dice `cpu`, torna a 720p oppure prova `"webrtc_codec": "H264"`.

**Comandi PTZ (pan, tilt, zoom) dal browser: su macOS no, sul mini PC da verificare.**
Prova del 17/9/2026 con finestra Chrome vera (Chrome 153, macOS) e permesso della fotocamera
concesso: Chrome non espone né pan, né tilt, né zoom, e non chiede nemmeno il permesso di
«spostare la fotocamera» (resta su «da chiedere»). Chrome fa quella richiesta solo quando
riconosce una telecamera PTZ: quindi su questo Mac non la riconosce.

Le cause possibili sono due, e decidono se il PTZ dal browser ha futuro:

1. un limite di Chrome su macOS — allora su Windows o Linux può funzionare;
2. la telecamera muove il gimbal con comandi proprietari invece dei controlli UVC standard,
   e li usa solo l'app o l'SDK di OBSBOT — allora dal browser non funzionerà su nessun sistema.

**Indizio forte a favore del caso 1** (settembre 2026): nei progetti Linux per la Tiny 2
(`cgevans/tiny2`, `OpenFoxes/Tiny4Linux`) pan, tilt e zoom sono i **controlli V4L2 standard**
(`V4L2_CID_PAN_ABSOLUTE`, `TILT_ABSOLUTE`, `ZOOM_ABSOLUTE`), e il manutentore conferma che
sulla Tiny 2 «i movimenti funzionano normalmente con v4l2, senza software aggiuntivo». Se vale
anche per la Lite, sul Mac il limite è di Chrome su macOS, e su un mini PC Linux il PTZ dal
browser dovrebbe funzionare. **Per la Lite non c'è ancora conferma**: nessuno dei progetti la
cita nel codice, e l'unica segnalazione di un utente Lite sui movimenti è rimasta senza seguito.

Le funzioni **proprie di OBSBOT** (inquadratura automatica AI, HDR, campo visivo, LED,
sospensione) non sono controlli standard: passano da un'unità di estensione UVC del
produttore. Su Linux quei progetti le comandano con gli ioctl del driver `uvcvideo`, anche
mentre la telecamera trasmette. Dal browser non si raggiungono su nessun sistema.

**Le poltrone usano Windows.** Chrome su Windows comanda i movimenti standard delle webcam
USB, quindi il limite visto su macOS non dovrebbe valere lì. Si verifica con la pagina di
diagnostica (sotto). Le funzioni proprie di OBSBOT si impostano con OBSBOT Center, una volta
in allestimento, verificando che restino salvate nella telecamera.

### Telecamera comandabile dalla regia (agente OBSBOT)

Con l'**agente telecamera** installato sulla poltrona (vedi [`agent/README.md`](agent/README.md))
la regia comanda gimbal e zoom della OBSBOT attraverso l'SDK ufficiale, anche dove il browser
non arriva:

- la scheda della poltrona mostra il badge blu **ptz**;
- con «**Guarda**» su una poltrona, sotto il riquadro compaiono **frecce, zoom, «Salva
  inquadratura» e ⟲** (torna all'inquadratura salvata);
- l'inquadratura salvata finisce in `config.json` (`stations[].framing`) e viene **rimessa da sola**
  quando la telecamera riparte;
- **una poltrona in onda non si muove mai**: i comandi compaiono solo in anteprima, e il server li
  rifiuta comunque se la poltrona è in onda.

L'agente spegne anche tracking AI e gesti, e tiene sveglia la telecamera.

### Diagnostica telecamera

Sul computer della poltrona, con la telecamera collegata, apri in Chrome:

```
https://<ip-server>:8080/diagnostica/
```

(link anche da «Impostazioni» in regia). Clicca **Consenti** alla richiesta di Chrome; la pagina
controlla da sola:

- connessione sicura (senza HTTPS webcam e microfono sono bloccati);
- telecamera e microfono trovati con i nomi di `webrtc_video_device` / `webrtc_audio_device`;
- risoluzioni che la telecamera consegna davvero;
- **pan, tilt e zoom dal browser**: se ci sono, la telecamera si muove per qualche secondo e
  torna in posizione, poi compaiono i pulsanti per provarla a mano.

Il risultato viene **inviato al server** e finisce nel registro eventi come `diagnostics`,
quindi si legge dalla regia senza copiare niente:

```bash
grep '"diagnostics"' data/events.jsonl | tail -1
```

Esito sul Mac di sviluppo (17/9/2026): telecamera e microfono OBSBOT trovati, fino a 4K30 e
1080p60, **PTZ assente** — atteso, è il limite di Chrome su macOS.

Per un mini PC **Linux** la stessa verifica si fa anche senza browser:

```bash
v4l2-ctl -d /dev/video0 --list-ctrls | grep -Ei 'pan|tilt|zoom'
```

Se compaiono `pan_absolute`, `tilt_absolute`, `zoom_absolute` siamo nel caso 1; se non
compaiono, nel caso 2. Su Windows si ripete la prova con la stessa pagina in Chrome.

Nel caso 2 l'unica strada sarebbe un programma sulle poltrone che usa l'SDK di OBSBOT, cioè il
software di terze parti che si voleva evitare: in quel caso conviene impostare l'inquadratura
una volta e lasciarla fissa, che per ospiti seduti è comunque la scelta giusta.

**Inquadratura automatica, gesti e le altre funzioni dell'app** si impostano con OBSBOT
Center. Da verificare se le impostazioni restano memorizzate nella telecamera dopo averla
scollegata: se sì, l'app serve solo in allestimento e non deve girare sulle poltrone.

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

### HTTPS: perché serve, non è un optional

I browser consegnano webcam e microfono **solo in contesto sicuro**: `https://`, oppure
`http://localhost`. Da un'altra macchina, su `http://192.168.x.x:8080`, `navigator.mediaDevices`
non esiste proprio e la poltrona scrive a schermo *«il browser blocca webcam e microfono …»*.
Vale anche per `RTCPeerConnection`, quindi riguarda poltrone, feed e anteprima di regia.

Due strade, entrambe supportate.

**1. HTTPS (consigliata, funziona con qualunque dispositivo)**

```bash
npm run cert          # certificato per localhost, nome macchina e tutti gli IP di rete
```

poi in `config.json`:

```json
"tls": { "cert": "certs/server.crt", "key": "certs/server.key" }
```

Riavvia: tutto passa a `https://`. Il certificato è auto-firmato, quindi la **prima** volta
ogni dispositivo mostra un avviso (*Avanzate → Procedi*); per non vederlo più, installa
`certs/server.crt` tra le autorità attendibili di quel dispositivo. `npm run cert` accetta
anche indirizzi o nomi aggiuntivi: `npm run cert -- 192.168.10.10 regia.local`.

Se il certificato manca o è illeggibile il server **non si ferma**: riparte in HTTP
avvisando sulla console, perché un certificato scaduto non deve impedire una puntata.

**2. Flag di Chromium sui kiosk (nessun certificato)**

```
chromium --kiosk --unsafely-treat-insecure-origin-as-secure="http://192.168.10.10:8080" \
         --user-data-dir=C:\regia-kiosk "http://192.168.10.10:8080/poltrona/?id=post-01"
```

Più rapida su sette macchine identiche che controlli tu, ma vale solo per i browser avviati
con quel flag: il tablet di un ospite resterebbe fuori. In azienda si può fare lo stesso con
il criterio `OverrideSecurityRestrictionsOnInsecureOrigin`.

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
| `webrtc_video_device`, `webrtc_audio_device` | nome (anche parziale) di telecamera e microfono da usare, es. `"OBSBOT"` |

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

## Comandi fisici (Stream Deck)

Stessa logica dei comandi della dashboard, un colpo HTTP ciascuno: un pulsante fisico non
deve avere bisogno di un browser aperto.

```bash
curl -X POST http://<server>:8080/api/grant-next -H 'Content-Type: application/json' -d '{"countdown_s":120}'
curl -X POST http://<server>:8080/api/grant/post-03
curl -X POST http://<server>:8080/api/close          # chiude chi è in onda
curl -X POST http://<server>:8080/api/countdown/120  # imposta a 2:00
curl -X POST http://<server>:8080/api/countdown/+30  # aggiunge 30 s
curl -X POST http://<server>:8080/api/countdown/-30  # toglie 30 s
curl      http://<server>:8080/api/state             # stato completo, in JSON
```

Risposta `{"ok":true,"live":"post-03"}`; se il comando non ha senso in quel momento (nessuno in
onda, coda vuota) torna **409** con il motivo, così il pulsante può accendersi di rosso.

Se `control_token` è valorizzato, aggiungi l'intestazione `X-Control-Token: <token>` (oppure
`?token=…`). Su Stream Deck si usa l'azione *Website / HTTP request* in POST.

## Cronologia interventi

`/log/` (link «Cronologia» in regia) ricostruisce gli interventi dagli eventi già scritti:
inizio, poltrona, ospite, durata reale e countdown assegnato, più il **tempo di parola** totale
per poltrona. Le durate che hanno sforato il countdown sono evidenziate in ambra.

Un intervento senza chiusura è marcato **IN ONDA** se è davvero in corso, e **INTERROTTO** se il
server si è fermato prima della chiusura: senza questa distinzione ogni riavvio lascerebbe una
riga «in onda» falsa per sempre.

I dati arrivano da `data/events.jsonl`, che è append-only: la cronologia non ha una sua
contabilità separata da tenere allineata.

## Deploy in studio

### Server di regia (Linux, systemd)

`/etc/systemd/system/regia.service`:

```ini
[Unit]
Description=Regia - sistema di richiesta parola
After=network-online.target

[Service]
Type=simple
User=regia
WorkingDirectory=/opt/regia
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now regia
sudo journalctl -u regia -f      # log dal vivo
```

`Restart=always` è voluto: se il processo muore a puntata in corso riparte in pochi secondi e
le poltrone si riallineano da sole in stato IDLE.

Su **Windows** l'equivalente più semplice è l'Utilità di pianificazione con trigger
«all'avvio del computer» e azione `node server\index.js` nella cartella del progetto.

### Poltrone (Chromium in kiosk)

```bash
chromium --kiosk --noerrdialogs --disable-session-crashed-bubble \
  --use-fake-ui-for-media-stream \
  --disable-features=TranslateUI \
  --user-data-dir=/home/kiosk/.regia \
  "https://<server>:8080/poltrona/?id=post-01"
```

`--use-fake-ui-for-media-stream` concede webcam e microfono senza chiedere. Su Linux,
`unclutter -idle 0 &` toglie il cursore anche fuori dalla pagina.

### Feed pulito (secondo monitor del PC di regia)

```bash
chromium --kiosk --autoplay-policy=no-user-gesture-required \
  --window-position=1920,0 \
  --user-data-dir=/home/regia/.regia-feed \
  "https://localhost:8080/feed/"
```

`--autoplay-policy=no-user-gesture-required` è necessario: senza, il browser blocca l'audio
finché qualcuno non clicca. `--window-position` va all'origine del secondo schermo.

### Checklist di accensione

1. Server acceso e raggiungibile (`curl -k https://localhost:8080/api/state`).
2. Pagina **Feed** aperta sul monitor del mixer: in regia il banner rosso deve sparire.
3. Sette poltrone **online** con badge verde **cam**.
4. Nomi ospiti scritti nelle schede.
5. Una prova completa: richiesta → autorizza → countdown → chiudi.

## Roadmap

- `docs/roadmap.html` — apribile direttamente nel browser (doppio clic sul file)
- `docs/roadmap.pdf` — la stessa pagina pronta da mandare, 9 pagine

Descrive le release successive: studio completo, multi-device, ospiti remoti, ambienti
phygital, e le regole che nessuna di esse può violare.

La pagina ha un foglio di stile per la stampa (fondo bianco, blocchi che non si spezzano tra
due fogli), quindi da browser basta Stampa → Salva come PDF. Per rigenerare il file dopo una
modifica all'HTML:

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --no-pdf-header-footer --virtual-time-budget=10000 \
  --print-to-pdf="$PWD/docs/roadmap.pdf" "file://$PWD/docs/roadmap.html"

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new ^
  --no-pdf-header-footer --print-to-pdf="docs\roadmap.pdf" "file:///.../docs/roadmap.html"
```

## Luci e relè (M3)

```json
"lights_driver": "wled",
"relay_driver": "shelly",
"wled_url": "http://192.168.10.31",
"wled_effects": { "solid": 0, "blink": 1 },
"relay_on_url": "{url}?turn=on",
"relay_off_url": "{url}?turn=off"
```

Un solo controller WLED serve tutte le poltrone: ognuna ha il suo **segmento**
(`stations[].wled_segment`) e i colori arrivano da `colors`. Le barre LED sono relè HTTP
indipendenti, uno per poltrona (`stations[].relay_url`).

Cosa succede, e perché:

| Stato | Luce | Barra |
| --- | --- | --- |
| Richiesta in attesa | segmento ambra lampeggiante (`fx` = `blink`) | spenta |
| In onda | segmento rosso fisso (`fx` = `solid`) | accesa |
| A riposo | **solo quel segmento** si spegne, il controller resta acceso | spenta |

Le richieste partono con `transition: 0`: una spia di studio deve commutare, non sfumare.

**Adattare l'hardware senza toccare il codice**: gli id degli effetti stanno in
`wled_effects` (le build WLED non li numerano tutte allo stesso modo), e le chiamate al relè
sono template. Il default è Shelly **gen 1** (`http://ip/relay/0` + `?turn=on`); per la
**gen 2** basta cambiare le due stringhe:

```json
"relay_url": "http://192.168.10.41",
"relay_on_url": "{url}/rpc/Switch.Set?id=0&on=true",
"relay_off_url": "{url}/rpc/Switch.Set?id=0&on=false"
```

Se il controller è protetto da password: `"relay_auth": { "user": "...", "password": "..." }`.
Il percorso della API WLED, se diverso, si cambia con `wled_state_path`.

Una poltrona **senza** `wled_segment` o **senza** `relay_url` viene saltata in silenzio: è il
caso delle postazioni aggiunte al volo dalla dashboard, che hanno il video ma non le luci.

### Configurare tutto dalla dashboard

`/impostazioni/` (link «Impostazioni» in alto nella regia) gestisce l'intera M3 senza aprire
`config.json`:

- scelta dei driver (`mock` ↔ `wled` / `shelly`) e timeout delle periferiche;
- indirizzo del controller, percorso della API e **id degli effetti**;
- template delle chiamate al relè e credenziali;
- **colori dei tre stati** con selettore colore, effetto e luminosità;
- **segmento e URL relè di ogni poltrona**, in tabella.

Salvando, le impostazioni finiscono in `config.json` e i driver vengono **ricaricati a caldo**:
niente riavvio del server tra un segmento e l'altro.

In cima alla pagina c'è una **guida** con la procedura passo passo (trovare l'indirizzo di
WLED, scoprire quale segmento è quale poltrona, correggere l'id dell'effetto lampeggiante) e
cosa succede quando una periferica non risponde. È aperta di default e si richiude con un clic.

**Le due prove sono la parte che conta il giorno dell'installazione**: per ogni poltrona,
«Spia» e «Barra» accendono per due secondi e poi rimettono tutto com'era. È il modo pratico
per scoprire quale segmento WLED corrisponde a quale poltrona senza mandare nessuno in onda.
Le prove usano le impostazioni **salvate** e non toccano mai una poltrona in onda.

### Se le luci non rispondono

Non succede niente alla diretta: l'errore finisce nel log, la dashboard accende il banner
ambra **DRIVER IN ERRORE — LIGHTS / RELAY**, e la poltrona va in onda lo stesso con il suo
countdown. Alla prima chiamata riuscita il banner si spegne da solo. Verificato staccando il
controller a puntata in corso.

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

## Crediti

- **Luciano Zappacosta** — contributor
- **Luza Dev** — contributor
