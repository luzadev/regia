# Agente telecamera

Programma che gira **su ogni computer poltrona**, accanto alla pagina in kiosk, e comanda
gimbal e zoom della **OBSBOT Tiny 2 Lite** attraverso l'SDK ufficiale di OBSBOT.

Prende ordini solo dal server di Regia, con lo stesso protocollo WebSocket di tutto il resto
(ruolo `camera`): la poltrona non muove mai la telecamera di sua iniziativa.

## Cosa fa

Appena trova la telecamera applica tre **regole di sicurezza**:

| Regola | Perché |
| --- | --- |
| Tracking AI spento | l'inquadratura non deve «respirare» mentre l'ospite è in onda |
| Gesti della mano spenti | un ospite che alza la mano per chiedere la parola non deve far zoomare la camera |
| Telecamera tenuta sveglia | senza stream la Tiny si addormenta e **parcheggia il gimbal** (verificato: pitch 85°), poi al risveglio torna in posizione muovendosi |

Poi esegue i comandi della regia: spostamento, zoom, richiamo dell'**inquadratura salvata**.
Quando l'agente o la telecamera ripartono (riavvio, corrente staccata) il server rimette da solo
l'inquadratura salvata di quella poltrona. **Una poltrona in onda non viene mai mossa**: né dai
comandi della regia né dal ripristino automatico.

## Stato delle verifiche

- **macOS, Tiny 2 Lite firmware 6.2.8.1 (17/9/2026)**: spostamento e zoom, precisione ~0,1°,
  salvataggio e richiamo dell'inquadratura, rifiuto in onda, ripristino al riavvio, sveglia
  dalla sospensione, e comandi eseguiti **mentre Chrome trasmette** dalla stessa telecamera.
- **Windows: non ancora verificato.** Stesso SDK e stesse funzioni, ma va provato sul mini PC
  (vedi *Prova su Windows*).

## L'SDK OBSBOT non è nel repository

È software proprietario e lo zip non contiene un file di licenza: **verifica i termini di OBSBOT**
prima di installare `libdev.dll` sulle poltrone. Il repository contiene solo il nostro ponte
(`bridge/obsbot_bridge.cpp`), che si compila contro l'SDK che hai scaricato. Cartelle ignorate da
git: `docs/libdev*` e `agent/native/`.

## Installazione su Windows (poltrona)

Serve una volta per computer, oppure una volta sola e poi si copia la cartella `agent\native`.

1. **Node.js 20+ x64** e **Visual Studio Build Tools** con il carico di lavoro *Sviluppo di
   applicazioni desktop con C++*.
2. Estrai l'SDK, ad esempio in `C:\obsbot\libdev_v2.1.0_8`.
3. Apri **x64 Native Tools Command Prompt for VS** nella cartella del progetto e compila il ponte:

   ```bat
   set OBSBOT_SDK_DIR=C:\obsbot\libdev_v2.1.0_8
   agent\bridge\build.cmd
   ```

   In `agent\native\` trovi `obsbot_bridge.dll`, `libdev.dll` e `w32-pthreads.dll`: su altre
   poltrone con lo stesso Windows basta copiare questa cartella, senza ricompilare.
4. Dipendenze dell'agente:

   ```bat
   cd agent
   npm install
   ```
5. Copia sulla poltrona il certificato del server (`certs\server.crt`) e avvia:

   ```bat
   node camera-agent.js --server wss://192.168.10.10:8080/ws --station post-01 --ca server.crt
   ```

   Con `control_token` impostato nel server aggiungi `--token <token>`. Senza `--ca` l'agente
   accetta il certificato senza verificarlo, e lo scrive all'avvio: va bene solo su LAN chiusa.

### Avvio automatico

Utilità di pianificazione → *Crea attività* → attivazione **All'accesso** dell'utente del kiosk,
azione `node.exe` con argomenti `camera-agent.js --server … --station post-01 --ca server.crt`
e cartella di avvio `…\agent`. Meglio dell'installazione come servizio di Windows: un servizio gira
in una sessione separata dove l'accesso ai dispositivi USB della fotocamera non è garantito.

### Prova su Windows

Con la pagina poltrona aperta in Chrome e l'agente avviato:

1. in regia la scheda della poltrona mostra il badge blu **ptz**;
2. «Guarda» sulla poltrona: sotto il riquadro compaiono frecce, zoom e «Salva inquadratura»;
3. muovi, salva, sposta ancora, premi ⟲: la telecamera torna all'inquadratura salvata;
4. autorizza la poltrona e prova a muoverla: la regia risponde che in onda non si muove;
5. chiudi l'agente, sposta la camera a mano, riavvia l'agente: torna sull'inquadratura salvata.

Il registro dell'agente dice cosa ha trovato e cosa ha applicato:

```
[agente] telecamera trovata: Tiny 2 Lite sn … firmware 6.2.8.1
[agente] regole di sicurezza: tracking AI spento:ok, gesti spenti:ok
```
