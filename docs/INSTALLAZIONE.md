# Installazione in studio

Procedura per mettere in servizio Regia sul **PC server** e sulle **poltrone**, tutti Windows,
con le due app desktop:

| App | Dove | Cosa fa |
| --- | --- | --- |
| **Regia** (`Regia-Setup-1.0.0.exe`) | PC server | avvia il server, apre la dashboard, mette il feed a schermo intero sul monitor del mixer |
| **Regia Poltrona** (`Regia-Poltrona-Setup-1.0.0.exe`) | ogni poltrona | pagina poltrona a schermo intero + agente telecamera OBSBOT (ponte e SDK inclusi), in un solo programma |

Rispetto all'installazione a mano non servono più Node.js, Chrome, `openssl`, `certutil` né i
file `.cmd` di avvio: il certificato lo crea l'app Regia e le poltrone lo riconoscono con un
**abbinamento** fatto una volta.

> **Da leggere prima.** Le app sono state provate su macOS (abbinamento, certificato, webcam,
> messa in onda fino al feed, guasti e riavvii) e gli installer Windows sono generati, ma **su
> Windows non sono ancora state provate**, come il ponte OBSBOT. Si parte quindi da **una sola
> poltrona pilota**, e solo quando funziona si installano le altre sei.

Nei passi, `192.168.10.10` è l'indirizzo del PC server: sostituiscilo con il tuo.

---

## 0. Cosa serve

| Cosa | Dove |
| --- | --- |
| I due installer `.exe` | vedi *Generare gli installer* in fondo |
| L'SDK OBSBOT `libdev_v2.1.0_8.zip` | non è nel repository: si usa solo per compilare il ponte |
| Un PC Windows con Visual Studio Build Tools (carico *Sviluppo di applicazioni desktop con C++*), Node.js 20+ e il codice | **una volta sola**, per compilare il ponte OBSBOT prima di generare l'installer della poltrona |

**SDK OBSBOT:** proprietario, ma OBSBOT ha autorizzato la distribuzione dentro queste app.
L'installer della poltrona contiene già il ponte e le DLL dell'SDK: sulle poltrone non si copia
nulla a mano. Il repository invece continua a non contenerli.

**Avviso di Windows all'installazione.** Gli installer non sono firmati: Windows mostra
«Windows ha protetto il PC». Clicca **Ulteriori informazioni → Esegui comunque**.

---

## 1. PC server

### 1.1 Rete
- Dai al server un **indirizzo IP fisso** (o una prenotazione DHCP sul router): le poltrone lo
  memorizzano all'abbinamento.
- Porta **8080** in ingresso. Al primo avvio Windows chiede se consentire l'accesso a *Regia*:
  spunta **Reti private** e consenti. Se la domanda non compare (Prompt *come amministratore*):

  ```bat
  netsh advfirewall firewall add rule name="Regia 8080" dir=in action=allow protocol=TCP localport=8080
  ```

### 1.2 Installazione e primo avvio
1. Esegui `Regia-Setup-1.0.0.exe`.
2. Avvia **Regia**. Al primo avvio crea in `%APPDATA%\Regia\`:
   - `config.json` (video WebRTC, HTTPS attivo, sette poltrone),
   - `certs\server.crt` e `certs\server.key` (certificato valido 10 anni),
   - `data\` (cronologia e nomi) e `logs\` (registri dell'app e del server).
3. Si apre la **dashboard**. Se compare «Il server Regia non si avvia — porta 8080 già usata»,
   c'è ancora un server avviato a mano: chiudilo e premi **Riprova**.

`server.key` **non esce mai dal server** e non va copiato da nessuna parte.

**Arrivi da un'installazione a mano?** Chiudi l'app, copia il tuo `config.json` e la cartella
`certs\` in `%APPDATA%\Regia\` e riavvia: i percorsi vengono sistemati da soli.

### 1.3 Configurazione
- **Poltrone**: si aggiungono e tolgono dalla dashboard.
- **Luci e relè**: menu **Regia › Impostazioni luci e relè**.
- Per il resto, menu **Aiuto › Apri cartella dati** e modifica `config.json` ad app chiusa.
- **`control_token`: lascialo `null`.** Le pagine non inviano ancora il token.

### 1.4 Feed verso il mixer
- Con il monitor del mixer collegato, il feed va **da solo a schermo intero sul secondo
  schermo** (nero a riposo). Se stacchi e riattacchi il cavo, torna al suo posto.
- Con più di due schermi: **Feed › Schermo del feed** e scegli quello giusto (la scelta resta).
- Con un solo schermo il feed non va da nessuna parte e la dashboard mostra il banner «nessun
  ricevitore feed». Per una prova: **Feed › Apri il feed in una finestra**.
- **Audio:** in *Impostazioni di Windows → Audio* imposta come uscita predefinita il dispositivo
  HDMI verso il mixer, se il mixer prende l'audio dall'HDMI.

### 1.5 Avvio automatico e spegnimento
- L'app parte con Windows (disattivabile da **Aiuto › Avvia con Windows**) e tiene lo schermo
  acceso.
- Chiudendo la finestra della dashboard l'app chiede conferma: si ferma anche il server, le
  poltrone vanno OFFLINE e il feed diventa nero.
- Se il server si blocca, l'app lo riavvia da sola; le pagine si ricollegano.

### 1.6 Dati per l'abbinamento
**Aiuto › Collegamento poltrone…** mostra l'**indirizzo** da scrivere sulle poltrone e
l'**impronta del certificato** (`AB:CD:…`), che ogni poltrona mostra durante l'abbinamento:
devono coincidere. Tieni aperta la finestra mentre abbini.

---

## 2. Poltrona pilota (post-01)

### 2.1 Windows
- Utente dedicato con **accesso automatico** (`netplwiz` → togli «Per usare questo computer è
  necessario che l'utente immetta nome e password»).
- Nessuna sospensione e nessun risparmio energetico sull'USB, altrimenti la telecamera può
  staccarsi (Prompt *come amministratore*):

  ```bat
  powercfg /change standby-timeout-ac 0
  powercfg /change monitor-timeout-ac 0
  powercfg /change hibernate-timeout-ac 0
  powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0
  powercfg /setactive SCHEME_CURRENT
  ```
- Collega la **OBSBOT Tiny 2 Lite** a una porta USB diretta del PC, non a un hub.
- *Impostazioni → Privacy → Fotocamera / Microfono*: lascia attivo l'accesso per le **app
  desktop**.

### 2.2 Installazione e abbinamento
1. Esegui `Regia-Poltrona-Setup-1.0.0.exe` e avvia **Regia Poltrona**.
2. Si apre **Abbinamento poltrona** (serve una tastiera, solo questa volta):
   1. scrivi l'indirizzo del server (`192.168.10.10`) e premi **Cerca**;
   2. confronta l'**impronta** con quella di *Aiuto › Collegamento poltrone* sul server — se è
      diversa **non proseguire**;
   3. tocca **Poltrona 1**.
3. Compare il pulsante **CHIEDI LA PAROLA** a schermo intero. Webcam e microfono vengono concessi
   dall'app senza domande (solo alla pagina del server abbinato).

Da qui in poi l'app parte con Windows, a schermo intero. Scorciatoie per il tecnico:

| Tasti | Effetto |
| --- | --- |
| `Ctrl+Maiusc+F12` | torna all'abbinamento (cambiare server o poltrona) |
| `Ctrl+Maiusc+Q` | chiude l'app |

Dati e registri in `%APPDATA%\Regia Poltrona\` (`pairing.json`, `logs\app.log`,
`logs\agent.log`).

### 2.3 Telecamera
Il ponte OBSBOT è dentro l'app, insieme al runtime C++ Microsoft che l'SDK richiede (dalla 1.0.2:
sulle poltrone non serve installare il *Visual C++ Redistributable*). In `%APPDATA%\Regia Poltrona\logs\agent.log` deve comparire:
```
[agente] telecamera trovata: Tiny 2 Lite sn … firmware …
[agente] regole di sicurezza: tracking AI spento:ok, gesti spenti:ok
```
Se il ponte mancasse (installer generato con `REGIA_ALLOW_NO_BRIDGE=1`) la poltrona funziona lo
stesso, video e audio, ma senza controlli della telecamera dalla regia: la schermata di
abbinamento lo segnala in basso.

Per provare un ponte diverso senza reinstallare, i tre file messi in
`%APPDATA%\Regia Poltrona\native\` hanno la precedenza su quelli dell'installer.

### 2.4 Collaudo della pilota, dalla regia
1. La scheda **Poltrona 1** è **online**, con badge verde **cam** e blu **ptz**.
2. Passando sul badge **cam**: telecamera e microfono sono entrambi **OBSBOT**.
3. **Guarda** sulla Poltrona 1: video in anteprima, frecce e zoom muovono la camera.
4. **Salva inquadratura**, sposta la camera, premi **⟲**: torna dov'era.
5. Dalla poltrona **Chiedi la parola**, poi **Autorizza**: la poltrona mostra «SEI IN ONDA», il
   feed sul mixer mostra l'ospite con l'audio.
6. In onda: il riquadro rosso **Inquadratura in onda** cambia modo solo col doppio tocco; frecce e
   zoom non ci sono.
7. **CHIUDI**: la poltrona torna al pulsante, il feed torna nero.
8. Spegni e riaccendi la poltrona: l'app riparte da sola, a schermo intero, e la camera torna
   sull'inquadratura salvata.
9. Chiudi l'app Regia sul server: la poltrona mostra SISTEMA NON DISPONIBILE; riaprila: la
   poltrona torna al pulsante senza toccarla.

Se un punto fallisce, manda `logs\app.log` e `logs\agent.log` della poltrona e `logs\server.log`
del server.

---

## 3. Le altre sei poltrone

Per ciascuna (`post-02` … `post-07`), come la pilota:

1. Windows: utente con accesso automatico, `powercfg` (2.1), OBSBOT su USB diretta.
2. Installa **Regia Poltrona**, abbina scegliendo la poltrona giusta (2.2).
3. Collaudo 2.4, punti 1–3.

Una poltrona già collegata da un altro computer compare come «già collegata altrove»: per
prenderla serve un secondo tocco, ed è giusto così solo se stai sostituendo quel computer.

---

## 4. Accensione dello studio, ogni volta

1. Accendi il **PC server**: parte Regia, con dashboard e feed.
2. Accendi le **poltrone**: in regia diventano **online** una dopo l'altra (se partono prima del
   server mostrano SISTEMA NON DISPONIBILE e si collegano da sole).
3. In regia: nessun banner rosso, sette poltrone con **cam** verde e **ptz** blu.
4. Scrivi i **nomi degli ospiti** nelle schede.
5. Prova completa su una poltrona: richiesta → autorizza → chiudi.

---

## Se qualcosa non va

| Sintomo | Causa probabile |
| --- | --- |
| Poltrona: «Server regia non raggiungibile» | server spento, IP cambiato, porta 8080 chiusa dal firewall del server |
| Poltrona: «Il certificato del server è cambiato» | è stato rigenerato il certificato (o cancellata la cartella `certs`) sul server: rifai l'abbinamento su ogni poltrona |
| Poltrona: «La poltrona post-0N non esiste più» | tolta dalla dashboard: riaggiungila o abbina un'altra poltrona |
| Il server ha cambiato IP | `Ctrl+Maiusc+F12` su ogni poltrona e nuovo indirizzo; l'impronta resta la stessa |
| Badge **cam !** ambra | telecamera o microfono OBSBOT non trovati, o accesso negato in *Privacy → Fotocamera* |
| Nessun badge **ptz** | agente fermo o telecamera non trovata: guarda `logs\agent.log` della poltrona |
| `Failed to load shared library: Impossibile trovare il modulo specificato` | app precedente alla 1.0.2: manca il runtime C++ accanto al ponte. Aggiorna la poltrona |
| «POLTRONA APERTA ALTROVE» | la stessa poltrona è aperta anche su un altro computer o in un browser |
| Banner rosso «nessun ricevitore feed» | nessun secondo schermo collegato al server, o feed chiuso: menu **Feed** |
| Audio del feed muto | uscita audio di Windows non impostata sull'HDMI del mixer |
| Regia: «Il server Regia non si avvia» | leggi il dettaglio; **Aiuto › Apri cartella dati → logs\server.log** |

---

## Generare gli installer

**Il modo normale è automatico.** Un tag `vX.Y.Z` inviato a GitHub avvia la build Windows
(`.github/workflows/windows.yml`): scarica la parte Windows dell'SDK OBSBOT da una release in
bozza privata, compila il ponte con Visual Studio, verifica che la DLL si carichi, genera i due
installer e crea una release in bozza da controllare e pubblicare. Dalla pagina *Actions* si può
anche lanciare a mano: gli installer restano scaricabili come artefatto.

```bash
# aggiorna "version" in apps/regia/package.json e apps/poltrona/package.json, poi:
git tag v1.0.2 && git push origin master v1.0.2
```

I passi qui sotto servono solo per generare gli installer a mano.

Serve Node.js 20+ e internet. L'installer della regia si genera ovunque (Windows o macOS);
quello della poltrona ha bisogno prima del **ponte OBSBOT compilato su Windows**.

### 1. Ponte OBSBOT (una volta, su un PC Windows)
1. Codice del repository in `C:\regia` (clone o ZIP) e SDK estratto, ad esempio in
   `C:\obsbot\libdev_v2.1.0_8`.
2. Apri **x64 Native Tools Command Prompt for VS**:

   ```bat
   cd C:\regia
   set OBSBOT_SDK_DIR=C:\obsbot\libdev_v2.1.0_8
   agent\bridge\build.cmd
   ```
3. In `C:\regia\agent\native\` devono esserci `obsbot_bridge.dll`, `libdev.dll`,
   `w32-pthreads.dll`. Se generi l'installer su un altro computer, copia lì i tre file nella
   stessa cartella `agent/native/`. Vanno ricompilati solo cambiando versione dell'SDK o il
   file `obsbot_bridge.cpp`.

### 2. Installer
```bash
cd apps/regia
npm install
npm run dist:win        # → apps/regia/dist/Regia-Setup-1.0.0.exe

cd ../poltrona
npm install
npm run dist:win        # → apps/poltrona/dist/Regia-Poltrona-Setup-1.0.0.exe
```

Se in `agent/native/` mancano i tre file, `npm run dist:win` della poltrona si ferma e dice
quali: un installer che non comanda le telecamere non deve uscire per sbaglio. Per farlo
apposta: `REGIA_ALLOW_NO_BRIDGE=1 npm run dist:win`.

Per provare le app senza installarle: `npm start` nelle due cartelle (`REGIA_WINDOWED=1` per la
poltrona in finestra, `REGIA_APP_DATA=<cartella>` per non toccare i dati veri).

## Installazione a mano (senza app)

Resta possibile: server con `npm start`, certificato con `npm run cert` e `certutil` su ogni
computer, Chrome in kiosk e agente telecamera avviati da `deploy\windows\avvia-regia.cmd` e
`avvia-poltrona.cmd`. I dettagli sono nel README (*Deploy in studio*) e nella versione precedente
di questa guida nella cronologia del repository.
