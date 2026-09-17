# Installazione in studio

Procedura per mettere in servizio Regia sul **PC server** e sulle **poltrone Windows**.
Le istruzioni presumono Windows anche sul PC server; per un server Linux vedi *Deploy in studio*
nel README (systemd).

> **Da leggere prima.** Tutta la catena Windows — ponte OBSBOT compilato con `build.cmd`, agente
> telecamera, file di avvio — è **scritta ma non ancora provata su Windows**: è stata verificata
> su macOS con la telecamera vera. Per questo si parte da **una sola poltrona pilota**, e solo
> quando funziona si replicano le altre sei.

Nei comandi, `192.168.10.10` è l'indirizzo del PC server: sostituiscilo con il tuo.

---

## 0. Cosa serve

| Cosa | Dove |
| --- | --- |
| Il codice | repository privato `luzadev/regia` (clone con Git, oppure *Code → Download ZIP* da GitHub) |
| L'SDK OBSBOT `libdev_v2.1.0_8.zip` | non è nel repository: copialo a parte |
| Node.js **20 o superiore, x64** | server e poltrone |
| Google Chrome | server e poltrone |
| Git for Windows | server (serve anche per `openssl`) |
| Visual Studio Build Tools, carico *Sviluppo di applicazioni desktop con C++* | **solo** sulla poltrona pilota, per compilare il ponte OBSBOT una volta |
| Internet | **solo durante l'installazione** (Node, `npm install`); in diretta il sistema non ne ha bisogno |

**Licenza SDK:** lo zip OBSBOT non contiene un file di licenza. Prima di copiare `libdev.dll`
su sette computer verifica i termini d'uso con OBSBOT.

---

## 1. PC server (regia)

### 1.1 Rete
- Dai al server un **indirizzo IP fisso** (o una prenotazione DHCP sul router). Il certificato
  HTTPS contiene l'IP: se l'IP cambia, il certificato va rifatto e reinstallato ovunque.
- Apri la porta **8080** in ingresso (Prompt dei comandi *come amministratore*):

  ```bat
  netsh advfirewall firewall add rule name="Regia 8080" dir=in action=allow protocol=TCP localport=8080
  ```

### 1.2 Codice e dipendenze
```bat
cd C:\
git clone https://github.com/luzadev/regia.git regia
cd C:\regia
npm install
```

### 1.3 Certificato HTTPS
Senza HTTPS le poltrone non hanno webcam né microfono. Il certificato va generato **sul server**,
dopo aver fissato l'IP, da **Git Bash** (che contiene `openssl`):

```bash
cd /c/regia
npm run cert
```

Controlla che l'elenco stampato contenga l'IP fisso del server. `config.json` punta già a
`certs/server.crt` e `certs/server.key`.

Poi rendilo attendibile, così Chrome non mostra avvisi (Prompt *come amministratore*):

```bat
certutil -addstore -f Root C:\regia\certs\server.crt
```

`server.key` **non esce mai dal server**. Alle poltrone va copiato solo `server.crt`.

### 1.4 Configurazione (`config.json`)
- `stations`: le sette poltrone, con `id` (`post-01`…`post-07`) ed etichetta.
- `webrtc_video_device` / `webrtc_audio_device`: `"OBSBOT"` (già impostati).
- `lights_driver` / `relay_driver`: lascia `mock` finché WLED e relè non sono in rete, poi si
  impostano da **/impostazioni/**.
- **`control_token`: lascialo `null`.** Regia, impostazioni e feed non inviano ancora il token:
  impostandolo, la regia verrebbe rifiutata.

### 1.5 Primo avvio a mano
```bat
cd C:\regia
npm start
```
Deve comparire `in ascolto su https://0.0.0.0:8080` e l'indirizzo della poltrona con l'IP del
server. Se compare «porta 8080 già occupata», c'è già un server acceso.

Apri `https://localhost:8080/regia/`: la regia deve caricarsi senza avvisi di certificato.

### 1.6 Feed verso il mixer e avvio automatico
1. Copia `deploy\windows\avvia-regia.cmd` e adatta le righe in cima: `REGIA_DIR` e `FEED_X`
   (la coordinata X del monitor collegato al mixer, da *Impostazioni → Schermo*).
2. **Audio:** in *Impostazioni → Audio* imposta come uscita predefinita il dispositivo HDMI del
   monitor verso il mixer, se il mixer prende l'audio dall'HDMI.
3. Premi `Win+R`, scrivi `shell:startup` e metti lì un collegamento a `avvia-regia.cmd`.
4. Riavvia il PC: devono partire server, **feed** a schermo intero sul monitor del mixer (nero) e
   **regia** sul monitor dell'operatore. In regia il banner rosso «nessun ricevitore feed» deve
   sparire.

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

### 2.2 Codice e certificato
- Copia il progetto in `C:\regia` (clone o ZIP).
- Crea `C:\regia\certs` e copiaci **solo** `server.crt` dal server, poi rendilo attendibile
  (*come amministratore*):

  ```bat
  certutil -addstore -f Root C:\regia\certs\server.crt
  ```

### 2.3 Prima prova: diagnostica
Apri Chrome normale su `https://192.168.10.10:8080/diagnostica/`, clicca **Consenti** e aspetta
l'esito. Tutte le voci devono essere verdi tranne, eventualmente, **PTZ dal browser** (non serve:
i movimenti passano dall'agente). Il risultato arriva anche al server:

```bat
findstr "diagnostics" C:\regia\data\events.jsonl
```

### 2.4 Ponte OBSBOT (una volta sola, su questa poltrona)
1. Estrai l'SDK, ad esempio in `C:\obsbot\libdev_v2.1.0_8`.
2. Apri **x64 Native Tools Command Prompt for VS**:

   ```bat
   cd C:\regia
   set OBSBOT_SDK_DIR=C:\obsbot\libdev_v2.1.0_8
   agent\bridge\build.cmd
   ```
3. In `C:\regia\agent\native\` devono esserci `obsbot_bridge.dll`, `libdev.dll`,
   `w32-pthreads.dll`. **Conserva questa cartella**: sulle altre poltrone si copia e basta.

### 2.5 Agente telecamera
```bat
cd C:\regia\agent
npm install
node camera-agent.js --server wss://192.168.10.10:8080/ws --station post-01 --ca C:\regia\certs\server.crt
```
Deve scrivere:
```
[agente] telecamera trovata: Tiny 2 Lite sn … firmware …
[agente] regole di sicurezza: tracking AI spento:ok, gesti spenti:ok
```
Chiudilo con `Ctrl+C` quando la prova è finita: poi parte da solo (punto successivo).

### 2.6 Avvio automatico
1. Copia `deploy\windows\avvia-poltrona.cmd` in `C:\regia\avvia-poltrona.cmd` e imposta
   `STATION=post-01` e `SERVER_IP`.
2. `Win+R` → `shell:startup` → collegamento a `avvia-poltrona.cmd`.
3. Riavvia: devono partire la pagina poltrona a schermo intero e, ridotto a icona, l'agente
   (registro in `C:\regia\agent-post-01.log`).

### 2.7 Collaudo della pilota, dalla regia
1. La scheda **Poltrona 1** è **online**, con badge verde **cam** e blu **ptz**.
2. Passando sul badge **cam**: telecamera e microfono sono entrambi **OBSBOT**.
3. **Guarda** sulla Poltrona 1: video in anteprima, frecce e zoom muovono la camera.
4. **Salva inquadratura**, sposta la camera, premi **⟲**: torna dov'era.
5. Dalla poltrona **Chiedi la parola**, poi **Autorizza**: la poltrona mostra «SEI IN ONDA», il
   feed sul mixer mostra l'ospite.
6. In onda: il riquadro rosso **Inquadratura in onda** cambia modo solo col doppio tocco; frecce e
   zoom non ci sono.
7. **CHIUDI**: la poltrona torna al pulsante, il feed torna nero.
8. Riavvia il PC della poltrona: al rientro la camera torna sull'inquadratura salvata.

Se un punto fallisce, manda il registro dell'agente (`agent-post-01.log`) e l'ultima riga
`diagnostics` del server.

---

## 3. Le altre sei poltrone

Per ciascuna (`post-02` … `post-07`), come la pilota **tranne la compilazione**:

1. Windows: utente con accesso automatico, `powercfg` (2.1), OBSBOT su USB diretta.
2. Copia `C:\regia` **dalla pilota**, compresi `agent\native\` e `agent\node_modules\`: così
   non servono né Build Tools né internet.
3. `certutil -addstore -f Root C:\regia\certs\server.crt` (come amministratore).
4. In `C:\regia\avvia-poltrona.cmd` cambia **solo** `STATION`.
5. Collegamento in `shell:startup`, riavvio, collaudo 2.7 punti 1–3.

---

## 4. Accensione dello studio, ogni volta

1. Accendi il **PC server**: partono server, feed e regia.
2. Accendi le **poltrone**: in regia diventano **online** una dopo l'altra (se partono prima del
   server mostrano OFFLINE e si ricollegano da sole).
3. In regia: nessun banner rosso, sette poltrone con **cam** verde e **ptz** blu.
4. Scrivi i **nomi degli ospiti** nelle schede.
5. Prova completa su una poltrona: richiesta → autorizza → chiudi.

---

## Se qualcosa non va

| Sintomo | Causa probabile |
| --- | --- |
| La poltrona scrive «il browser blocca webcam e microfono» | aperta in `http://` invece di `https://`, o certificato non installato |
| Avviso di certificato in Chrome | `certutil` non eseguito come amministratore, oppure certificato generato prima di fissare l'IP |
| Badge **cam !** ambra | telecamera o microfono OBSBOT non trovati: la poltrona usa i dispositivi predefiniti |
| Nessun badge **ptz** | agente non partito: guarda `agent-post-0N.log` |
| «POLTRONA APERTA ALTROVE» | la stessa poltrona è aperta in due finestre: chiudine una e ricarica |
| Banner rosso «nessun ricevitore feed» | la pagina feed non è aperta sul PC server |
| Audio del feed muto | uscita audio di Windows non impostata sull'HDMI del mixer |
| Regia rifiutata dopo aver impostato `control_token` | non ancora supportato dalle pagine: riportalo a `null` |
