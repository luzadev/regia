'use strict';

/**
 * Regia · app regia, for the control room PC.
 *
 * One program in place of "node server/index.js" + Chrome windows:
 *   - runs the Regia server as a supervised child process (restarted if it dies);
 *   - on first start creates config.json and the HTTPS certificate in the data folder;
 *   - opens the dashboard, trusting the server's certificate by fingerprint;
 *   - puts the clean feed full screen on the mixer's screen, found by itself
 *     and followed when screens are plugged in or out;
 *   - shows what the station computers need to pair (address, fingerprint).
 *
 * Environment (tests and development): REGIA_APP_DATA data folder.
 */

const { app, BrowserWindow, Menu, dialog, screen, session, shell, clipboard, powerSaveBlocker } = require('electron');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const selfsigned = require('selfsigned');

if (process.env.REGIA_APP_DATA) app.setPath('userData', path.resolve(process.env.REGIA_APP_DATA));

// The package mirrors the repository layout (apps/regia, apps/common, server, public).
const ROOT = path.resolve(__dirname, '..', '..');
const { ensureConfig, ensureCertificate, lanAddresses, writeJsonAtomic } = require('./lib/setup');
const { pickFeedDisplay, describe } = require('./lib/displays');
const { fingerprint, sameFingerprint } = require('../common/cert');
const { createSupervisor } = require('../common/supervisor');

const DATA = app.getPath('userData');
const LOG_DIR = path.join(DATA, 'logs');
const PREFS_FILE = path.join(DATA, 'app.json');

let prefs = { feed_display: null, autostart: true };
let config = null;
let serverFingerprint = null;
let listening = null; // { port, scheme } once the server is up
let server = null;
let dashboard = null;
let feed = null;
let feedWindowed = false; // single-screen test mode, opened from the menu
let quitting = false;
const outputTail = [];

function log(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}\n`;
  process.stdout.write('[regia-app] ' + line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'app.log'), line);
  } catch {}
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (dashboard) {
      if (dashboard.isMinimized()) dashboard.restore();
      dashboard.focus();
    }
  });
}

// The clean feed must play its audio with nobody clicking on the mixer screen.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function loadPrefs() {
  try {
    prefs = { ...prefs, ...JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) };
  } catch {}
}
const savePrefs = () => writeJsonAtomic(PREFS_FILE, prefs);

const baseUrl = () => `${listening.scheme}://localhost:${listening.port}`;

/* --- server --------------------------------------------------------------- */

function startServer(configFile) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = fs.createWriteStream(path.join(LOG_DIR, 'server.log'), { flags: 'a' });
  const keep = (chunk) => {
    out.write(chunk);
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue;
      outputTail.push(line);
      if (outputTail.length > 40) outputTail.shift();
    }
  };

  let everListened = false;
  server = createSupervisor({
    spawn: () => {
      log('avvio server');
      const child = fork(path.join(ROOT, 'server', 'index.js'), [], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', REGIA_CONFIG: configFile },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true
      });
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      return child;
    },
    onMessage: (m) => {
      if (m && m.type === 'listening') {
        everListened = true;
        const first = !listening;
        listening = { port: m.port, scheme: m.scheme };
        log('server in ascolto', `${m.scheme}://localhost:${m.port}`);
        if (first) openWindows();
      }
    },
    // Not worth retrying: the port is taken, or the server never came up
    // (a broken config.json fails the same way every time).
    isFinal: ({ lastMessage, restarts }) =>
      (lastMessage && lastMessage.type === 'listen_error') || (!everListened && restarts >= 2),
    onExit: ({ code, signal }) => log('server terminato', code, signal || ''),
    onFinal: (info) => showServerFailure(info)
  });
  server.start();
}

async function showServerFailure({ lastMessage }) {
  const portTaken = lastMessage && lastMessage.type === 'listen_error' && lastMessage.code === 'EADDRINUSE';
  const detail = portTaken
    ? `La porta ${lastMessage.port} è già usata da un altro programma, probabilmente un altro server Regia avviato a mano. Chiudilo e premi Riprova.`
    : `Ultime righe del server:\n\n${outputTail.slice(-12).join('\n')}`;
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'Regia',
    message: 'Il server Regia non si avvia',
    detail,
    buttons: ['Riprova', 'Apri cartella dati', 'Esci'],
    defaultId: 0,
    cancelId: 2
  });
  if (response === 0) server.start();
  else if (response === 1) {
    shell.openPath(DATA);
    showServerFailure({ lastMessage });
  } else app.quit();
}

/* --- trust ------------------------------------------------------------------ */

function setupSession() {
  // Our own server on this computer, with our own certificate: accepted by
  // fingerprint. Nothing else is trusted beyond Chromium's normal checks.
  session.defaultSession.setCertificateVerifyProc((req, callback) => {
    const local = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    if (local && serverFingerprint && sameFingerprint(fingerprint(req.certificate.data), serverFingerprint)) {
      return callback(0);
    }
    callback(-3);
  });
  // The dashboard's camera diagnostics may ask for media; nothing else is granted.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(['media', 'speaker-selection'].includes(permission) && isLocal(details.requestingUrl));
  });
}

function isLocal(url) {
  try {
    const u = new URL(url);
    return !!listening && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && Number(u.port) === listening.port;
  } catch {
    return false;
  }
}

/* --- windows ------------------------------------------------------------------ */

function guardNavigation(win) {
  const wc = win.webContents;
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && !isLocal(url)) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (!isLocal(url)) return { action: 'deny' };
    // "Apri feed" in the dashboard: the feed already has its own window.
    if (new URL(url).pathname.startsWith('/feed')) {
      showFeedWindowed();
      return { action: 'deny' };
    }
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#0b0d10' } };
  });
  wc.on('render-process-gone', (_e, details) => {
    log('pagina terminata:', details.reason, wc.getURL());
    if (!quitting && listening) setTimeout(() => !win.isDestroyed() && win.reload(), 1000);
  });
}

function createDashboard() {
  dashboard = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#0b0d10',
    title: 'Regia',
    webPreferences: { backgroundThrottling: false }
  });
  dashboard.maximize();
  dashboard.once('ready-to-show', () => dashboard.show());
  guardNavigation(dashboard);
  dashboard.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    const response = dialog.showMessageBoxSync(dashboard, {
      type: 'warning',
      title: 'Regia',
      message: 'Chiudere la regia?',
      detail: 'Si ferma anche il server: le poltrone vanno in OFFLINE e il feed verso il mixer diventa nero.',
      buttons: ['Chiudi la regia', 'Annulla'],
      defaultId: 1,
      cancelId: 1
    });
    if (response === 0) app.quit();
  });
  dashboard.on('closed', () => { dashboard = null; });
  dashboard.loadFile(path.join(__dirname, 'pages', 'starting.html'));
}

function openWindows() {
  if (dashboard) dashboard.loadURL(`${baseUrl()}/regia/`);
  placeFeed();
  buildMenu();
}

function feedWindowOptions(bounds) {
  return {
    ...bounds,
    show: false,
    frame: false,
    skipTaskbar: true,
    backgroundColor: '#000000',
    title: 'Regia · Feed',
    webPreferences: { backgroundThrottling: false }
  };
}

function createFeed(bounds, fullscreen) {
  const win = new BrowserWindow(feedWindowOptions(bounds));
  win.setMenu(null);
  guardNavigation(win);
  win.once('ready-to-show', () => {
    if (fullscreen) win.setFullScreen(true);
    win.showInactive(); // never steal focus from the dashboard
  });
  win.on('closed', () => {
    if (feed === win) {
      feed = null;
      feedWindowed = false;
    }
  });
  win.loadURL(`${baseUrl()}/feed/`);
  return win;
}

/** Puts the feed on the mixer's screen, or takes it away if there is none. */
function placeFeed() {
  if (!listening || quitting) return;
  const target = pickFeedDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay().id, prefs.feed_display);
  if (!target) {
    if (feed && !feedWindowed) {
      log('nessun secondo schermo: feed chiuso');
      feed.destroy();
    }
    if (!feed) log('nessun secondo schermo: il feed non è su nessuna uscita (dashboard: banner feed)');
    return;
  }
  if (feed && feedWindowed) {
    feed.destroy();
    feed = null;
  }
  if (!feed) {
    log('feed sullo schermo', describe(target, 0, screen.getPrimaryDisplay().id));
    feed = createFeed(target.bounds, true);
    return;
  }
  const current = screen.getDisplayMatching(feed.getBounds());
  if (current.id !== target.id) {
    log('feed spostato sullo schermo', target.id);
    feed.setFullScreen(false);
    feed.setBounds(target.bounds);
    feed.setFullScreen(true);
  }
}

/** Single-screen test: the feed in an ordinary window on this screen. */
function showFeedWindowed() {
  if (feed) {
    feed.show();
    return;
  }
  const { workArea } = screen.getPrimaryDisplay();
  feedWindowed = true;
  feed = createFeed({ x: workArea.x + 60, y: workArea.y + 60, width: 960, height: 540 }, false);
  feed.setSkipTaskbar(false);
}

let displayTimer = null;
function onDisplaysChanged() {
  clearTimeout(displayTimer);
  displayTimer = setTimeout(() => {
    placeFeed();
    buildMenu();
  }, 800);
}

/* --- menu ------------------------------------------------------------------------ */

function openPage(pathname) {
  if (dashboard && listening) dashboard.loadURL(`${baseUrl()}${pathname}`);
}

async function showPairingInfo() {
  const ips = lanAddresses();
  const port = listening ? listening.port : config.http_port || 8080;
  const address = ips.length ? ips.map((ip) => (port === 8080 ? ip : `${ip}:${port}`)).join('   oppure   ') : '(nessuna rete)';
  const scheme = listening ? listening.scheme : '?';
  const detail = [
    `Indirizzo da scrivere sulla poltrona:\n${address}`,
    serverFingerprint
      ? `Impronta del certificato (deve coincidere con quella mostrata dalla poltrona):\n${serverFingerprint}`
      : scheme === 'http'
        ? 'ATTENZIONE: il server è senza HTTPS, le poltrone non avranno webcam e microfono.'
        : '',
    'Sulla poltrona: al primo avvio si apre l\'abbinamento, oppure Ctrl+Maiusc+F12.'
  ].filter(Boolean).join('\n\n');
  const { response } = await dialog.showMessageBox(dashboard, {
    type: 'info',
    title: 'Collegamento poltrone',
    message: 'Collegamento poltrone',
    detail,
    buttons: serverFingerprint ? ['OK', 'Copia impronta'] : ['OK'],
    defaultId: 0
  });
  if (response === 1) clipboard.writeText(serverFingerprint);
}

function buildMenu() {
  const primaryId = screen.getPrimaryDisplay().id;
  const displays = screen.getAllDisplays();
  const chosen = prefs.feed_display;
  const choose = (display) => {
    prefs.feed_display = display ? { id: display.id, label: display.label || null } : null;
    savePrefs();
    placeFeed();
    buildMenu();
  };

  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Regia',
      submenu: [
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => openPage('/regia/') },
        { label: 'Cronologia interventi', accelerator: 'CmdOrCtrl+2', click: () => openPage('/log/') },
        { label: 'Impostazioni luci e relè', accelerator: 'CmdOrCtrl+3', click: () => openPage('/impostazioni/') },
        { label: 'Diagnostica telecamera', click: () => openPage('/diagnostica/') },
        { type: 'separator' },
        { label: 'Ricarica pagina', accelerator: 'CmdOrCtrl+R', click: () => dashboard && dashboard.reload() },
        { type: 'separator' },
        { label: 'Esci', accelerator: 'CmdOrCtrl+Q', click: () => dashboard ? dashboard.close() : app.quit() }
      ]
    },
    {
      label: 'Feed',
      submenu: [
        {
          label: 'Schermo del feed',
          submenu: [
            { label: 'Automatico (il primo schermo non principale)', type: 'radio', checked: !chosen, click: () => choose(null) },
            { type: 'separator' },
            ...displays.map((d, i) => ({
              label: describe(d, i, primaryId),
              type: 'radio',
              checked: !!chosen && chosen.id === d.id,
              click: () => choose(d)
            }))
          ]
        },
        { label: 'Ricarica il feed', click: () => feed && feed.reload() },
        { label: 'Apri il feed in una finestra (prova con un solo schermo)', click: showFeedWindowed }
      ]
    },
    {
      label: 'Aiuto',
      submenu: [
        { label: 'Collegamento poltrone…', click: showPairingInfo },
        { type: 'separator' },
        { label: 'Apri cartella dati (config.json, certificato, log)', click: () => shell.openPath(DATA) },
        {
          label: 'Riavvia il server',
          click: async () => {
            await server.stop();
            server.start();
          }
        },
        {
          label: 'Avvia con Windows',
          type: 'checkbox',
          checked: prefs.autostart,
          visible: app.isPackaged,
          click: (item) => {
            prefs.autostart = item.checked;
            savePrefs();
            app.setLoginItemSettings({ openAtLogin: prefs.autostart });
          }
        },
        { label: 'Strumenti di sviluppo', accelerator: 'F12', click: () => dashboard && dashboard.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: `Regia ${app.getVersion()}`, enabled: false }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* --- lifecycle ------------------------------------------------------------------------ */

app.whenReady().then(async () => {
  log('avvio', app.getVersion(), 'dati in', DATA);
  loadPrefs();
  powerSaveBlocker.start('prevent-display-sleep');
  if (app.isPackaged && !process.env.REGIA_APP_DATA) app.setLoginItemSettings({ openAtLogin: prefs.autostart });
  setupSession();
  buildMenu();
  createDashboard();

  let configFile;
  try {
    const ensured = ensureConfig(DATA, path.join(ROOT, 'config.example.json'));
    configFile = ensured.file;
    config = ensured.config;
    if (ensured.created) log('primo avvio: creato', configFile);
    const cert = await ensureCertificate(config, selfsigned);
    if (cert.generated) log('certificato generato per', [...cert.names, ...cert.addresses].join(', '));
    if (cert.tls) serverFingerprint = fingerprint(fs.readFileSync(config.tls.cert, 'utf8'));
  } catch (e) {
    log('configurazione non valida:', e.message);
    dialog.showErrorBox('Regia', `config.json non leggibile in ${DATA}:\n\n${e.message}`);
    shell.openPath(DATA);
    app.quit();
    return;
  }

  startServer(configFile);
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);
});

app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  if (server) {
    e.preventDefault();
    // The server blacks out the feed on its way out.
    server.stop().finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  if (quitting || process.platform !== 'darwin') app.quit();
});
