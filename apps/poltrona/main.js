'use strict';

/**
 * Regia · app poltrona.
 *
 * One program on each station computer, in place of Chrome in kiosk plus a
 * separate camera agent:
 *   - shows /poltrona/?id=<station> full screen, served by the Regia server;
 *   - hands the page webcam and microphone without asking (only for that server);
 *   - trusts the server's self-signed certificate by fingerprint, paired once;
 *   - runs the OBSBOT camera agent as a supervised child process;
 *   - starts with Windows, keeps the screen awake, recovers by itself.
 *
 * Technician shortcuts: Ctrl+Shift+F12 pairing screen, Ctrl+Shift+Q quit.
 * Environment (tests and development): REGIA_APP_DATA data folder,
 * REGIA_WINDOWED=1 no kiosk, REGIA_BRIDGE_DIR where to look for the camera bridge.
 */

const { app, BrowserWindow, session, ipcMain, powerSaveBlocker } = require('electron');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

if (process.env.REGIA_APP_DATA) app.setPath('userData', path.resolve(process.env.REGIA_APP_DATA));

// The package mirrors the repository layout (apps/poltrona, apps/common, agent),
// so the same relative paths work from a checkout and from the installed app.
const ROOT = path.resolve(__dirname, '..', '..');
const pairing = require('./lib/pairing');
const { fingerprint, sameFingerprint } = require('../common/cert');
const { createSupervisor } = require('../common/supervisor');

const KIOSK = !process.env.REGIA_WINDOWED;
const DATA = app.getPath('userData');
const PAIRING_FILE = path.join(DATA, 'pairing.json');
const CA_FILE = path.join(DATA, 'server.crt');
const LOG_DIR = path.join(DATA, 'logs');
const RETRY_MS = 3000;
const BRIDGE_FILE = process.platform === 'win32' ? 'obsbot_bridge.dll'
  : process.platform === 'darwin' ? 'obsbot_bridge.dylib' : 'obsbot_bridge.so';

let current = pairing.load(PAIRING_FILE);
let win = null;
let mode = null; // 'setup' | 'connecting' | 'station' | 'offline'
let retryTimer = null;
let lastProbe = null;
let agent = null;
let quitting = false;

function log(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}\n`;
  process.stdout.write('[poltrona] ' + line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'app.log'), line);
  } catch {}
}

/* --- single instance ---------------------------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// The station page plays nothing audible, but a blocked autoplay must never
// stand between the guest and the "on air" view.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/* --- trust and permissions --------------------------------------------- */

function serverOrigin() {
  return pairing.isComplete(current) ? new URL(pairing.origin(current)).origin : null;
}

function fromServer(url) {
  try {
    return !!url && new URL(url).origin === serverOrigin();
  } catch {
    return false;
  }
}

function setupSession() {
  const ses = session.defaultSession;

  // Accept the paired certificate - and only it - on the paired host. Anything
  // else goes through Chromium's normal verification (and fails, for a
  // self-signed certificate nobody paired with).
  ses.setCertificateVerifyProc((req, callback) => {
    const p = current;
    if (pairing.isComplete(p) && p.scheme === 'https' && req.hostname === p.host &&
        sameFingerprint(fingerprint(req.certificate.data), p.fingerprint)) {
      return callback(0);
    }
    callback(-3);
  });

  const MEDIA = ['media', 'speaker-selection'];
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const ok = MEDIA.includes(permission) && fromServer(details.requestingUrl || wc.getURL());
    if (!ok) log('permesso negato:', permission, details.requestingUrl || '');
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    MEDIA.includes(permission) && fromServer(requestingOrigin));
}

/* --- window ------------------------------------------------------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    kiosk: KIOSK,
    fullscreen: KIOSK,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d10',
    title: 'Regia · Poltrona',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      // A kiosk that is never "in the foreground" must still stream at full rate.
      backgroundThrottling: false
    }
  });
  win.setMenu(null);
  win.once('ready-to-show', () => win.show());
  const wc = win.webContents;
  wc.setVisualZoomLevelLimits(1, 1).catch(() => {});

  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && !fromServer(url)) e.preventDefault();
  });

  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.control || !input.shift) return;
    if (input.key === 'F12') {
      e.preventDefault();
      showSetup();
    } else if (input.key.toLowerCase() === 'q') {
      e.preventDefault();
      app.quit();
    }
  });

  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || mode !== 'station') return; // -3: aborted by a newer load
    log('pagina non caricata:', code, description, url);
    const certificate = code <= -200 && code > -300;
    showOffline(certificate
      ? 'Il certificato del server è cambiato. Ripeti l\'abbinamento (Ctrl+Maiusc+F12).'
      : 'Server regia non raggiungibile.');
  });

  wc.on('render-process-gone', (_e, details) => {
    log('pagina terminata:', details.reason);
    if (!quitting) setTimeout(() => showStation(), 1000);
  });
  win.on('unresponsive', () => {
    log('pagina bloccata: ricarico');
    wc.forcefullyCrashRenderer();
  });
  win.on('closed', () => { win = null; });
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => showStation(), RETRY_MS);
}

let offlineMessage = null;
function showOffline(message) {
  // Retrying with the same message: leave the screen as it is, no flicker.
  if (mode === 'offline' && offlineMessage === message) return scheduleRetry();
  mode = 'offline';
  offlineMessage = message;
  win.loadFile(path.join(__dirname, 'pages', 'offline.html'), {
    query: { msg: message, station: (current && current.station) || '' }
  });
  scheduleRetry();
}

function showSetup() {
  clearTimeout(retryTimer);
  mode = 'setup';
  win.loadFile(path.join(__dirname, 'pages', 'setup.html'));
}

/**
 * Loads the station page, but only once the server answers with the paired
 * certificate and still knows this station: a blank Chromium error page is
 * what a guest must never see.
 */
async function showStation() {
  clearTimeout(retryTimer);
  if (!win || quitting) return;
  if (!pairing.isComplete(current)) return showSetup();

  const r = await pairing.probe(`${current.host}:${current.port}`, { timeout: 2500 });
  if (mode === 'setup') return; // the technician opened the pairing screen meanwhile
  if (!r.ok) return showOffline('Server regia non raggiungibile. Riprovo…');
  if (r.scheme !== current.scheme || (r.scheme === 'https' && !sameFingerprint(r.fingerprint, current.fingerprint))) {
    return showOffline('Il certificato del server è cambiato. Ripeti l\'abbinamento (Ctrl+Maiusc+F12).');
  }
  if (!r.stations.some((s) => s.id === current.station)) {
    return showOffline(`La poltrona ${current.station} non esiste più sul server. Ripeti l'abbinamento.`);
  }

  mode = 'station';
  win.loadURL(pairing.stationUrl(current));
}

/* --- camera agent ------------------------------------------------------- */

function bridgeDir() {
  if (process.env.REGIA_BRIDGE_DIR) {
    const dir = path.resolve(process.env.REGIA_BRIDGE_DIR);
    return { dirs: [dir], found: fs.existsSync(path.join(dir, BRIDGE_FILE)) ? dir : null };
  }
  const dirs = [path.join(DATA, 'native')];
  if (app.isPackaged) dirs.push(path.join(process.resourcesPath, 'native'));
  dirs.push(path.join(ROOT, 'agent', 'native'));
  return { dirs, found: dirs.find((d) => fs.existsSync(path.join(d, BRIDGE_FILE))) || null };
}

function logStream(name) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, name);
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1');
  } catch {}
  return fs.createWriteStream(file, { flags: 'a' });
}

async function startAgent() {
  if (agent) {
    await agent.stop();
    agent = null;
  }
  if (!pairing.isComplete(current)) return;
  const { found, dirs } = bridgeDir();
  if (!found) {
    log(`ponte telecamera non trovato (${BRIDGE_FILE} in ${dirs.join(' | ')}): controlli PTZ disattivati`);
    return;
  }

  const args = ['--server', pairing.wsUrl(current), '--station', current.station, '--native', found];
  if (current.scheme === 'https') args.push('--ca', CA_FILE, '--fingerprint', current.fingerprint);
  const out = logStream('agent.log');

  agent = createSupervisor({
    spawn: () => {
      log('avvio agente telecamera per', current.station);
      const child = fork(path.join(ROOT, 'agent', 'camera-agent.js'), args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true
      });
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
      return child;
    },
    // 3: another computer runs the agent for this station - do not fight it.
    isFinal: ({ code }) => code === 3,
    onExit: ({ code, signal }) => log('agente telecamera terminato', code, signal || ''),
    onFinal: () => log('agente telecamera fermo: questa poltrona è gestita da un altro computer')
  });
  agent.start();
}

/* --- pairing screen (IPC) ----------------------------------------------- */

const fromSetup = (e) => String(e.senderFrame && e.senderFrame.url).startsWith('file:');

ipcMain.handle('setup:info', (e) => {
  if (!fromSetup(e)) return null;
  const { found, dirs } = bridgeDir();
  const p = pairing.isComplete(current) ? { ...current, pem: undefined } : null;
  return { pairing: p, bridge: { found, dirs, file: BRIDGE_FILE }, version: app.getVersion(), dataDir: DATA };
});

ipcMain.handle('setup:probe', async (e, address) => {
  if (!fromSetup(e)) return null;
  lastProbe = await pairing.probe(address);
  if (!lastProbe.ok) return lastProbe;
  const { pem, ...rest } = lastProbe;
  return rest;
});

ipcMain.handle('setup:save', async (e, station) => {
  if (!fromSetup(e)) return null;
  if (!lastProbe || !lastProbe.ok) return { ok: false, message: 'Cerca prima il server' };
  if (!lastProbe.stations.some((s) => s.id === station)) return { ok: false, message: 'Poltrona sconosciuta' };
  current = pairing.save(PAIRING_FILE, { ...lastProbe, station });
  if (current.pem) fs.writeFileSync(CA_FILE, current.pem);
  log('abbinata a', pairing.origin(current), 'come', station, current.fingerprint || '(http)');
  // Connections opened under the previous pairing must not linger.
  await session.defaultSession.closeAllConnections();
  startAgent();
  mode = 'connecting';
  showStation();
  return { ok: true };
});

ipcMain.handle('setup:close', (e) => {
  if (!fromSetup(e)) return null;
  if (pairing.isComplete(current)) {
    mode = 'connecting';
    showStation();
  }
  return { ok: pairing.isComplete(current) };
});

ipcMain.handle('setup:quit', (e) => {
  if (fromSetup(e)) app.quit();
});

/* --- lifecycle ---------------------------------------------------------- */

app.whenReady().then(() => {
  log('avvio', app.getVersion(), 'dati in', DATA);
  // A guest screen that dims or sleeps in the middle of a show is a failure.
  powerSaveBlocker.start('prevent-display-sleep');
  if (app.isPackaged && !process.env.REGIA_APP_DATA) app.setLoginItemSettings({ openAtLogin: true });
  setupSession();
  createWindow();
  startAgent();
  showStation();
});

app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  clearTimeout(retryTimer);
  if (agent) {
    e.preventDefault();
    agent.stop().finally(() => app.quit());
  }
});

app.on('window-all-closed', () => app.quit());
