'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');

const { Studio } = require('./state');
const { createLog, readInterventions: readLog } = require('./log');
const { FeedHub } = require('./feed');
const { CameraHub } = require('./camera');
const { sanitizeSettings, SETTINGS_KEYS } = require('./settings');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.REGIA_CONFIG || path.join(ROOT, 'config.json');

// --- config ------------------------------------------------------------

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`config non trovato: ${CONFIG_PATH} — copia config.example.json in config.json`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!Array.isArray(cfg.stations) || cfg.stations.length === 0) {
    console.error('config non valido: "stations" mancante o vuoto');
    process.exit(1);
  }
  return cfg;
}

const config = loadConfig();
const HEARTBEAT_MS = config.heartbeat_interval_ms ?? 2000;
const OFFLINE_MS = config.station_offline_timeout_ms ?? 6000;
const DRIVER_TIMEOUT_MS = config.driver_timeout_ms ?? 1500;
// Held in a box so a settings change is picked up without re-binding.
const COLORS_REF = { value: config.colors || {} };

const log = createLog(path.resolve(ROOT, config.log_path || 'data/events.jsonl'));
const studio = new Studio(config);
const feedHub = new FeedHub({
  log,
  readyTimeoutMs: config.webrtc_ready_timeout_ms ?? 5000,
  monitorQuality: config.webrtc_monitor_quality || null
});

// --- guest names (only persisted state besides the log) ----------------

const NAMES_PATH = path.resolve(ROOT, config.names_path || 'data/names.json');

function loadNames() {
  try {
    const names = JSON.parse(fs.readFileSync(NAMES_PATH, 'utf8'));
    for (const [id, name] of Object.entries(names)) studio.setName(id, name);
  } catch {
    /* no names yet: normal on a fresh install */
  }
}

let namesTimer = null;
function saveNamesSoon() {
  clearTimeout(namesTimer);
  namesTimer = setTimeout(() => {
    const names = {};
    for (const st of studio.list()) if (st.name) names[st.id] = st.name;
    try {
      fs.mkdirSync(path.dirname(NAMES_PATH), { recursive: true });
      fs.writeFileSync(NAMES_PATH, JSON.stringify(names, null, 2));
    } catch (e) {
      console.error(`[names] write error: ${e.message}`);
    }
  }, 500);
  namesTimer.unref?.();
}

loadNames();

/**
 * Stations added or removed from the dashboard are written back to
 * config.json, which stays the single source of truth (brief §6). The write is
 * atomic and keeps one backup: a half-written config would cost a show.
 */
function saveConfig(mutate) {
  const backup = CONFIG_PATH + '.bak';
  const tmp = CONFIG_PATH + '.tmp';
  try {
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    onDisk.stations = studio.list().map((st) => st.config);
    if (mutate) mutate(onDisk);
    fs.copyFileSync(CONFIG_PATH, backup);
    fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2) + '\n');
    fs.renameSync(tmp, CONFIG_PATH);
    return { ok: true };
  } catch (e) {
    console.error(`[config] salvataggio fallito: ${e.message}`);
    log.event('config_save_error', { message: e.message });
    return { ok: false, message: e.message };
  }
}

const saveStations = () => saveConfig();

const cameraHub = new CameraHub({ studio, log, saveConfig: () => saveConfig() });

/** The slice of config the settings page may read and write. */
function currentSettings() {
  const out = {};
  for (const key of SETTINGS_KEYS) out[key] = config[key] ?? null;
  out.stations = studio.list().map((st) => ({
    id: st.id,
    label: st.label,
    wled_segment: Number.isInteger(st.config.wled_segment) ? st.config.wled_segment : null,
    relay_url: st.config.relay_url || ''
  }));
  return out;
}

// --- drivers -----------------------------------------------------------

const driverStatus = {
  video: { status: 'ok' },
  lights: { status: 'ok' },
  relay: { status: 'ok' }
};

function loadDriver(kind, name, bus) {
  const file = path.join(__dirname, 'drivers', `${kind}.${name}.js`);
  try {
    return require(file).create(config, log, bus);
  } catch (e) {
    console.error(`[driver] ${kind}.${name} non caricabile (${e.message}), uso il mock`);
    driverStatus[kind] = { status: 'error', message: `driver ${name} non disponibile` };
    return require(path.join(__dirname, 'drivers', `${kind}.mock.js`)).create(config, log, bus);
  }
}

const video = loadDriver('video', config.video_driver || 'mock', feedHub);
let lights = loadDriver('lights', config.lights_driver || 'mock');
let relay = loadDriver('relay', config.relay_driver || 'mock');

/**
 * Rebuilds the light and relay drivers after a settings change, so the
 * control room does not have to restart the server between two segments.
 * The video driver is deliberately left alone: the WebRTC hub is wired into
 * it, and swapping it mid-show is not something to do from a settings page.
 */
function reloadLightDrivers() {
  lights = loadDriver('lights', config.lights_driver || 'mock');
  relay = loadDriver('relay', config.relay_driver || 'mock');
  driverStatus.lights = { status: 'ok' };
  driverStatus.relay = { status: 'ok' };
  appliedColor.clear(); // the new driver knows nothing: push the whole state again
  console.log(`[driver] ricaricati: lights=${lights.name} relay=${relay.name}`);
}

/** Runs a driver call with a short timeout. Never throws: the show goes on. */
async function callDriver(kind, label, fn, timeoutMs) {
  if (studio.manualMode) return;
  const limit = timeoutMs || DRIVER_TIMEOUT_MS;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), limit))
    ]);
    if (driverStatus[kind].status !== 'ok') driverStatus[kind] = { status: 'ok' };
  } catch (e) {
    driverStatus[kind] = { status: 'error', message: `${label}: ${e.message}` };
    log.event('driver_error', { driver: kind, action: label, message: e.message });
    console.error(`[driver:${kind}] ${label} fallito: ${e.message}`);
  }
}

// Colour actually pushed to each station, so manual mode can be resynced.
const appliedColor = new Map();

function colorKeyFor(station) {
  if (station.state === 'LIVE') return 'live';
  if (station.state === 'REQUESTED') return 'requested';
  return 'idle';
}

async function applyColor(station, key) {
  const spec = COLORS_REF.value[key] || { rgb: [0, 0, 0], effect: 'off' };
  await callDriver('lights', `apply ${station.id} ${key}`, () => lights.apply(station, key, spec));
  if (!studio.manualMode) appliedColor.set(station.id, key);
}

/** Non-live colours (requested blink, idle off) are applied by diff. */
async function syncLights() {
  for (const st of studio.list()) {
    const key = colorKeyFor(st);
    if (appliedColor.get(st.id) !== key) await applyColor(st, key);
  }
}

/**
 * Executes a state-machine plan with the rigid ordering from the brief:
 * open  = video source -> LIVE view (state_sync) -> lights on
 * close = lights off -> state_sync -> black source
 */
async function runPlan(plan) {
  for (const step of plan) {
    const st = studio.get(step.id);
    if (!st) continue;
    if (step.op === 'close') {
      await applyColor(st, 'idle');
      await callDriver('relay', `off ${st.id}`, () => relay.set(st, false));
      sendSnapshot();
      await callDriver('video', 'black', () => video.setSource(null), video.timeoutMs);
      log.event('live_close', {
        station: st.id,
        name: st.name,
        intervention_id: step.intervention_id,
        duration_s: step.duration_s
      });
    } else if (step.op === 'open') {
      await callDriver('video', `source ${st.id}`, () => video.setSource(st), video.timeoutMs);
      sendSnapshot();
      await applyColor(st, 'live');
      await callDriver('relay', `on ${st.id}`, () => relay.set(st, true));
      log.event('live_open', {
        station: st.id,
        name: st.name,
        intervention_id: step.intervention_id,
        countdown_s: st.countdown_total_s
      });
    }
  }
}

/** After manual mode is switched off, push the current state to the hardware. */
async function resyncDrivers() {
  const live = studio.liveStation();
  await callDriver('video', 'resync', () => video.setSource(live), video.timeoutMs);
  for (const st of studio.list()) {
    await applyColor(st, colorKeyFor(st));
    await callDriver('relay', `resync ${st.id}`, () => relay.set(st, st.state === 'LIVE'));
  }
}

// --- websocket hub ------------------------------------------------------

const app = express();

/**
 * HTTPS is optional but usually necessary: browsers only expose webcam and
 * microphone in a secure context, and http://<ip> is not one. Without TLS the
 * stations work over http://localhost only. A broken certificate must never
 * stop the show, so a failure here falls back to plain HTTP with a loud notice.
 */
function loadTls() {
  const tls = config.tls;
  if (!tls || !tls.cert || !tls.key) return null;
  try {
    return {
      cert: fs.readFileSync(path.resolve(ROOT, tls.cert)),
      key: fs.readFileSync(path.resolve(ROOT, tls.key))
    };
  } catch (e) {
    console.error(`[tls] certificato non caricabile (${e.message}): parto in HTTP`);
    log.event('tls_error', { message: e.message });
    return null;
  }
}

const tlsOptions = loadTls();
const server = tlsOptions ? https.createServer(tlsOptions, app) : http.createServer(app);
const scheme = tlsOptions ? 'https' : 'http';

/** LAN addresses, so the startup log shows the URL to open on the stations. */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}
const wss = new WebSocketServer({ server, path: '/ws' });

/**
 * A server that cannot take its port must fail loudly and stop: otherwise the
 * uncaughtException handler swallows the bind error, the process stays alive
 * doing nothing, and an older instance keeps answering - which looks exactly
 * like a bug in the code you just changed.
 *
 * The handler is attached to BOTH emitters on purpose. `ws` re-emits the HTTP
 * server's errors on the WebSocketServer, and its listener is registered
 * first, so a handler on the HTTP server alone never runs.
 */
function onServerError(e) {
  if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) {
    const port = config.http_port || 8080;
    console.error(
      e.code === 'EADDRINUSE'
        ? `[regia] porta ${port} già occupata: un altro server è in ascolto, chiudilo prima di riavviare.`
        : `[regia] porta ${port} non consentita: servono privilegi o un'altra porta.`
    );
    log.event('listen_error', { code: e.code, message: e.message });
    process.exit(1);
  }
  // Anything else is a runtime hiccup: report it, never take the show down.
  console.error(`[regia] errore del server: ${e.message}`);
  log.event('server_error', { code: e.code, message: e.message });
}

server.on('error', onServerError);
wss.on('error', onServerError);

/** All authenticated sockets. Station sockets also live in `stationSockets`. */
const clients = new Set();
const stationSockets = new Map();

feedHub.stationSocket = (id) => stationSockets.get(id) || null;
feedHub.onChange = () => broadcast();
cameraHub.onChange = () => broadcast();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function sendError(ws, code, message) {
  send(ws, { type: 'error', code, message });
}

/**
 * While an open/close sequence runs, the state machine has already changed but
 * the drivers have not caught up: a stray broadcast would tell the station it
 * is on air before its video actually reaches the feed. So broadcasts are held
 * during a plan and released at the exact points the rigid order allows.
 */
let broadcastHeld = false;
let broadcastMissed = false;

function sendSnapshot(options) {
  const skipStations = options && options.skipStations;
  if (!skipStations) broadcastMissed = false;
  const payload = JSON.stringify(studio.snapshot(driverStatus, feedHub.status()));
  for (const ws of clients) {
    if (skipStations && ws.role === 'station') continue;
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function broadcast() {
  if (broadcastHeld) {
    // The hold protects what the STATION shows: the dashboard must keep
    // updating while a switch is in progress, or it looks frozen to the operator.
    broadcastMissed = true;
    sendSnapshot({ skipStations: true });
    return;
  }
  sendSnapshot();
}

// Commands are serialized: a grant that closes A and opens B must never
// interleave with another operator click.
let chain = Promise.resolve();
function enqueue(fn) {
  chain = chain.then(fn).catch((e) => console.error(`[chain] ${e.stack || e.message}`));
  return chain;
}

function handleResult(ws, result) {
  if (!result.ok) {
    sendError(ws, result.code, result.message);
    return;
  }
  enqueue(async () => {
    if (result.plan && result.plan.length) {
      broadcastHeld = true;
      try {
        await runPlan(result.plan);
      } finally {
        broadcastHeld = false;
      }
    }
    await syncLights();
    if (broadcastMissed || (result.plan && result.plan.length)) sendSnapshot();
    else broadcast();
  });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.lastPong = Date.now();
  ws.on('pong', () => {
    ws.lastPong = Date.now();
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return sendError(ws, 'bad_json', 'Messaggio non valido');
    }
    if (!msg || typeof msg.type !== 'string') return sendError(ws, 'bad_message', 'Messaggio non valido');

    if (msg.type === 'hello') return handleHello(ws, msg);
    if (!ws.role) return sendError(ws, 'not_identified', 'Presentarsi con hello');
    if (ws.role === 'station') return handleStationMessage(ws, msg);
    if (ws.role === 'feed') return handleFeedMessage(ws, msg);
    if (ws.role === 'monitor') return handleMonitorMessage(ws, msg);
    if (ws.role === 'camera') return handleCameraMessage(ws, msg);
    return handleControlMessage(ws, msg);
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (ws.role === 'feed') feedHub.removeClient(ws);
    if (ws.role === 'monitor') feedHub.removeMonitor(ws);
    if (ws.role === 'camera') cameraHub.removeAgent(ws, ws.stationId);
    if (ws.role === 'station' && stationSockets.get(ws.stationId) === ws) {
      stationSockets.delete(ws.stationId);
      if (studio.setConnected(ws.stationId, false)) {
        log.event('station_offline', { station: ws.stationId });
        broadcast();
      }
    }
  });

  ws.on('error', () => ws.terminate());
});

function handleHello(ws, msg) {
  if (msg.role === 'station') {
    const st = studio.get(msg.station);
    if (!st) {
      sendError(ws, 'unknown_station', `Poltrona sconosciuta: ${msg.station}`);
      return ws.close(4004, 'unknown station');
    }
    // Last one wins: a reloaded kiosk must never be locked out by its own stale socket.
    const previous = stationSockets.get(st.id);
    if (previous && previous !== ws) {
      previous.stationId = null;
      previous.close(4000, 'replaced');
    }
    ws.role = 'station';
    ws.stationId = st.id;
    stationSockets.set(st.id, ws);
    clients.add(ws);
    studio.setConnected(st.id, true);
    log.event('station_online', { station: st.id });
    // A kiosk reloaded during its own intervention must resume publishing.
    if (feedHub.target === st.id) feedHub.restartPublishing('poltrona riconnessa');
    feedHub.restartMonitorsFor(st.id);
    broadcast();
    return;
  }

  if (msg.role === 'feed') {
    if (config.control_token && msg.token !== config.control_token) {
      sendError(ws, 'unauthorized', 'Token non valido');
      return ws.close(4003, 'unauthorized');
    }
    ws.role = 'feed';
    clients.add(ws);
    feedHub.addClient(ws);
    log.event('feed_online', {});
    send(ws, studio.snapshot(driverStatus, feedHub.status()));
    return;
  }

  // Camera agent on a station computer: moves the OBSBOT gimbal and zoom when
  // the server says so. It can point a camera anywhere, so it needs the control
  // token whenever one is configured.
  if (msg.role === 'camera') {
    if (config.control_token && msg.token !== config.control_token) {
      sendError(ws, 'unauthorized', 'Token non valido');
      return ws.close(4003, 'unauthorized');
    }
    const st = studio.get(msg.station);
    if (!st) {
      sendError(ws, 'unknown_station', `Poltrona sconosciuta: ${msg.station}`);
      return ws.close(4004, 'unknown station');
    }
    ws.role = 'camera';
    ws.stationId = st.id;
    clients.add(ws); // heartbeat and dead-socket detection like everyone else
    cameraHub.addAgent(ws, st.id);
    return;
  }

  // Preview receiver (dashboard): watches the on-air station without ever
  // touching the clean feed.
  if (msg.role === 'monitor') {
    if (config.control_token && msg.token !== config.control_token) {
      sendError(ws, 'unauthorized', 'Token non valido');
      return ws.close(4003, 'unauthorized');
    }
    ws.role = 'monitor';
    clients.add(ws);
    ws.monitorId = feedHub.addMonitor(ws);
    send(ws, studio.snapshot(driverStatus, feedHub.status()));
    return;
  }

  if (msg.role === 'control') {
    if (config.control_token && msg.token !== config.control_token) {
      sendError(ws, 'unauthorized', 'Token non valido');
      return ws.close(4003, 'unauthorized');
    }
    ws.role = 'control';
    clients.add(ws);
    send(ws, studio.snapshot(driverStatus, feedHub.status()));
    return;
  }

  sendError(ws, 'bad_role', 'Ruolo sconosciuto');
  ws.close(4004, 'bad role');
}

function handleStationMessage(ws, msg) {
  const id = ws.stationId;
  switch (msg.type) {
    case 'request_floor': {
      const res = studio.requestFloor(id);
      if (res.ok) log.event('request_floor', { station: id, name: studio.get(id).name });
      return handleResult(ws, res);
    }
    case 'cancel_request': {
      const res = studio.cancelRequest(id);
      if (res.ok) log.event('cancel_request', { station: id });
      return handleResult(ws, res);
    }
    case 'rtc_signal': {
      // Only the station the feed is pointed at may reach the receivers.
      if (!feedHub.relayFromStation(id, msg.data, msg.peer)) {
        return sendError(ws, 'not_on_feed', 'Poltrona non collegata al feed');
      }
      return;
    }
    case 'media_status': {
      const res = studio.setMedia(id, msg.ok, msg.message, { warning: msg.warning, devices: msg.devices });
      if (res.ok) {
        log.event('media_status', {
          station: id,
          ok: !!msg.ok,
          message: msg.message || null,
          warning: msg.warning || null,
          devices: msg.devices || null
        });
        // A camera that only becomes available after the grant must still reach
        // the feed instead of leaving it black.
        if (msg.ok && feedHub.target === id && !feedHub.ready) {
          feedHub.restartPublishing('webcam disponibile');
        }
        if (msg.ok) feedHub.restartMonitorsFor(id);
        broadcast();
      }
      return;
    }
    default:
      return sendError(ws, 'bad_command', `Comando non ammesso: ${msg.type}`);
  }
}

function handleFeedMessage(ws, msg) {
  switch (msg.type) {
    case 'feed_ready': {
      feedHub.markReady(msg.station);
      // The feed recovering on its own (a reloaded receiver, a late camera)
      // must clear the driver banner too, or the dashboard keeps crying wolf.
      if (feedHub.ready && video.name === 'video.webrtc' && driverStatus.video.status === 'error') {
        driverStatus.video = { status: 'ok' };
        broadcast();
      }
      return;
    }
    case 'feed_error':
      return feedHub.markError(msg.station, msg.message);
    case 'feed_audio':
      return feedHub.setAudioBlocked(msg.blocked) && undefined;
    case 'rtc_signal': {
      if (!feedHub.relayToStation(msg.station, msg.data, 'feed')) {
        return sendError(ws, 'not_on_feed', 'Poltrona non collegata al feed');
      }
      return;
    }
    default:
      return sendError(ws, 'bad_command', `Comando non ammesso: ${msg.type}`);
  }
}

function handleCameraMessage(ws, msg) {
  if (msg.type === 'camera_status') return cameraHub.update(ws.stationId, msg);
  return sendError(ws, 'bad_command', `Comando non ammesso: ${msg.type}`);
}

function handleMonitorMessage(ws, msg) {
  if (msg.type === 'rtc_signal') {
    // A preview that fails is a preview problem: it never raises a driver error.
    feedHub.relayToStation(msg.station, msg.data, ws.monitorId);
    return;
  }
  if (msg.type === 'preview') {
    // Look at one station before putting it on air, or (null) back at the air.
    const id = msg.station || null;
    if (id && !studio.get(id)) return sendError(ws, 'unknown_station', `Poltrona sconosciuta: ${id}`);
    const res = feedHub.setPreview(ws, id);
    if (!res.ok) sendError(ws, 'preview_unavailable', res.reason);
    broadcast();
    return;
  }
  return sendError(ws, 'bad_command', `Comando non ammesso: ${msg.type}`);
}

function handleControlMessage(ws, msg) {
  switch (msg.type) {
    case 'grant': {
      const res = studio.grant(msg.station, msg.countdown_s);
      if (res.ok) log.event('grant', { station: msg.station, countdown_s: msg.countdown_s ?? null });
      return handleResult(ws, res);
    }
    case 'grant_next': {
      const res = studio.grantNext(msg.countdown_s);
      if (res.ok) log.event('grant_next', { countdown_s: msg.countdown_s ?? null });
      return handleResult(ws, res);
    }
    case 'deny': {
      const res = studio.deny(msg.station);
      if (res.ok) log.event('deny', { station: msg.station });
      return handleResult(ws, res);
    }
    case 'close': {
      const res = studio.close(msg.station);
      return handleResult(ws, res);
    }
    case 'countdown_set': {
      const res = studio.countdownSet(msg.station, msg.seconds);
      if (res.ok) log.event('countdown_set', { station: msg.station, seconds: msg.seconds });
      return handleResult(ws, res);
    }
    case 'countdown_adjust': {
      const res = studio.countdownAdjust(msg.station, msg.delta_s);
      if (res.ok) log.event('countdown_adjust', { station: msg.station, delta_s: msg.delta_s });
      return handleResult(ws, res);
    }
    case 'set_name': {
      const res = studio.setName(msg.station, msg.name);
      if (res.ok) {
        log.event('set_name', { station: msg.station, name: studio.get(msg.station).name });
        saveNamesSoon();
        broadcast();
      }
      return res.ok ? undefined : sendError(ws, res.code, res.message);
    }
    case 'get_settings':
      return send(ws, { type: 'settings', settings: currentSettings() });

    case 'set_settings': {
      const clean = sanitizeSettings(msg.settings);
      if (!Object.keys(clean).length) return sendError(ws, 'bad_settings', 'Nessuna impostazione valida');
      Object.assign(config, clean);
      COLORS_REF.value = config.colors || COLORS_REF.value;

      const saved = saveConfig((onDisk) => Object.assign(onDisk, clean));
      log.event('settings_changed', { keys: Object.keys(clean), saved: saved.ok });
      if (!saved.ok) sendError(ws, 'not_persisted', 'Impostazioni applicate ma non salvate su config.json');

      reloadLightDrivers();
      enqueue(async () => {
        await resyncDrivers();
        broadcast();
      });
      send(ws, { type: 'settings', settings: currentSettings() });
      return;
    }

    case 'update_station': {
      const st = studio.get(msg.station);
      if (!st) return sendError(ws, 'unknown_station', `Poltrona sconosciuta: ${msg.station}`);
      if (msg.label !== undefined && String(msg.label).trim()) {
        st.label = String(msg.label).trim().slice(0, 40);
        st.config.label = st.label;
      }
      if (msg.wled_segment === null) delete st.config.wled_segment;
      else if (Number.isInteger(msg.wled_segment)) st.config.wled_segment = msg.wled_segment;
      if (msg.relay_url === null || msg.relay_url === '') delete st.config.relay_url;
      else if (typeof msg.relay_url === 'string') st.config.relay_url = msg.relay_url.trim().slice(0, 200);

      const savedStation = saveConfig();
      log.event('station_updated', { station: st.id, saved: savedStation.ok });
      appliedColor.delete(st.id); // the light moved: push its colour again
      enqueue(async () => {
        await syncLights();
        broadcast();
      });
      send(ws, { type: 'settings', settings: currentSettings() });
      return;
    }

    /** Fires a colour at one station's light for a moment, then puts it back. */
    case 'test_light': {
      const st = studio.get(msg.station);
      if (!st) return sendError(ws, 'unknown_station', `Poltrona sconosciuta: ${msg.station}`);
      if (st.state === 'LIVE') return sendError(ws, 'is_live', 'Poltrona in onda: la sua spia non si tocca');
      const key = ['requested', 'live', 'idle'].includes(msg.color) ? msg.color : 'live';
      enqueue(async () => {
        await applyColor(st, key);
        log.event('test_light', { station: st.id, color: key });
      });
      setTimeout(() => {
        enqueue(async () => {
          await syncLights();
          broadcast();
        });
      }, msg.ms && msg.ms <= 10000 ? msg.ms : 2500);
      return;
    }

    /** Pulses one station's LED bar, to find out which relay is which. */
    case 'test_relay': {
      const st = studio.get(msg.station);
      if (!st) return sendError(ws, 'unknown_station', `Poltrona sconosciuta: ${msg.station}`);
      if (st.state === 'LIVE') return sendError(ws, 'is_live', 'Poltrona in onda: la sua barra non si tocca');
      enqueue(async () => {
        await callDriver('relay', `test ${st.id}`, () => relay.set(st, true));
        log.event('test_relay', { station: st.id });
      });
      setTimeout(() => {
        enqueue(async () => {
          await callDriver('relay', `test off ${st.id}`, () => relay.set(st, false));
          broadcast();
        });
      }, msg.ms && msg.ms <= 10000 ? msg.ms : 2500);
      return;
    }

    case 'camera_nudge':
    case 'camera_zoom':
    case 'camera_goto': {
      const order = { ...msg, cmd: msg.type.slice('camera_'.length) };
      const res = cameraHub.command(msg.station, order);
      if (!res.ok) sendError(ws, res.code, res.message);
      return;
    }
    case 'camera_tracking': {
      const res = cameraHub.setTracking(msg.station, msg.mode, { onAir: msg.on_air === true });
      if (!res.ok) sendError(ws, res.code, res.message);
      return;
    }
    case 'camera_save_framing': {
      const res = cameraHub.saveFraming(msg.station);
      if (!res.ok) sendError(ws, res.code, res.message);
      return;
    }
    case 'camera_recall_framing': {
      const res = cameraHub.recallFraming(msg.station);
      if (!res.ok) sendError(ws, res.code, res.message);
      return;
    }

    case 'add_station': {
      const res = studio.addStation(msg.station || {});
      if (!res.ok) return sendError(ws, res.code, res.message);
      const saved = saveStations();
      log.event('station_added', { station: res.station.id, label: res.station.label, saved: saved.ok });
      if (!saved.ok) {
        sendError(ws, 'not_persisted', 'Poltrona aggiunta ma non salvata su config.json: sparira al riavvio');
      }
      broadcast();
      return;
    }
    case 'remove_station': {
      const id = msg.station;
      const res = studio.removeStation(id);
      if (!res.ok) return sendError(ws, res.code, res.message);

      // Drop everything that referenced it, so nothing keeps pointing at a
      // station that no longer exists.
      const socket = stationSockets.get(id);
      if (socket) {
        stationSockets.delete(id);
        socket.close(4004, 'removed');
      }
      appliedColor.delete(id);
      cameraHub.forget(id);
      const saved = saveStations();
      log.event('station_removed', { station: id, saved: saved.ok });
      if (!saved.ok) {
        sendError(ws, 'not_persisted', 'Poltrona rimossa ma non salvata su config.json: tornera al riavvio');
      }
      broadcast();
      return;
    }
    case 'manual_mode': {
      const res = studio.setManualMode(msg.enabled);
      log.event('manual_mode', { enabled: studio.manualMode });
      if (!studio.manualMode && res.changed) enqueue(async () => {
        await resyncDrivers();
        broadcast();
      });
      else broadcast();
      return;
    }
    default:
      return sendError(ws, 'bad_command', `Comando sconosciuto: ${msg.type}`);
  }
}

// --- timers -------------------------------------------------------------

// Heartbeat for the clients, ping/pong to detect dead station sockets.
setInterval(() => {
  const t = Date.now();
  const beat = JSON.stringify({ type: 'heartbeat', t });
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (t - ws.lastPong > OFFLINE_MS) {
      ws.terminate();
      continue;
    }
    ws.ping();
    ws.send(beat);
  }
}, HEARTBEAT_MS);

// DENIED expiry.
setInterval(() => {
  if (studio.tick()) enqueue(async () => {
    await syncLights();
    broadcast();
  });
}, 500);

// --- http ---------------------------------------------------------------

app.disable('x-powered-by');
app.get('/', (_req, res) => res.redirect('/regia/'));
app.get('/api/ui-config', (_req, res) =>
  res.json({
    countdown_presets_s: config.countdown_presets_s || [30, 60, 120, 300],
    heartbeat_interval_ms: HEARTBEAT_MS,
    offline_timeout_ms: OFFLINE_MS,
    webrtc_constraints: config.webrtc_constraints || null,
    webrtc_max_bitrate_kbps: config.webrtc_max_bitrate_kbps || null,
    webrtc_min_bitrate_kbps: config.webrtc_min_bitrate_kbps || null,
    webrtc_codec: config.webrtc_codec || null,
    webrtc_monitor_quality: config.webrtc_monitor_quality || null,
    webrtc_video_device: config.webrtc_video_device || null,
    webrtc_audio_device: config.webrtc_audio_device || null
  })
);
/**
 * Service endpoints for physical controls (Stream Deck and friends). Same
 * logic as the WebSocket commands, one HTTP call each: a hardware button
 * should not need a browser open to work.
 */
app.use(express.json({ limit: '16kb' }));

function apiAuth(req, res, next) {
  if (!config.control_token) return next();
  const token = req.get('X-Control-Token') || req.query.token;
  if (token === config.control_token) return next();
  res.status(401).json({ ok: false, error: 'token non valido' });
}

/** Runs a state-machine result through the same plan/broadcast path as WS. */
function runApi(res, result) {
  if (!result.ok) return res.status(409).json({ ok: false, error: result.message, code: result.code });
  enqueue(async () => {
    if (result.plan && result.plan.length) {
      broadcastHeld = true;
      try {
        await runPlan(result.plan);
      } finally {
        broadcastHeld = false;
      }
    }
    await syncLights();
    sendSnapshot();
  });
  const live = studio.liveStation();
  res.json({ ok: true, live: live ? live.id : null });
}

app.post('/api/grant-next', apiAuth, (req, res) => {
  const seconds = req.body && Number.isFinite(req.body.countdown_s) ? req.body.countdown_s : undefined;
  const result = studio.grantNext(seconds);
  if (result.ok) log.event('api_grant_next', { countdown_s: seconds ?? null });
  runApi(res, result);
});

app.post('/api/grant/:station', apiAuth, (req, res) => {
  const seconds = req.body && Number.isFinite(req.body.countdown_s) ? req.body.countdown_s : undefined;
  const result = studio.grant(req.params.station, seconds);
  if (result.ok) log.event('api_grant', { station: req.params.station });
  runApi(res, result);
});

// Without a station it closes whoever is on air, which is what a single
// physical button wants to do.
app.post('/api/close', apiAuth, (req, res) => {
  const live = studio.liveStation();
  const id = (req.body && req.body.station) || (live && live.id);
  if (!id) return res.status(409).json({ ok: false, error: 'nessuna poltrona in onda' });
  const result = studio.close(id);
  if (result.ok) log.event('api_close', { station: id });
  runApi(res, result);
});

app.post('/api/countdown/:seconds', apiAuth, (req, res) => {
  const live = studio.liveStation();
  if (!live) return res.status(409).json({ ok: false, error: 'nessuna poltrona in onda' });
  const raw = req.params.seconds;
  // "+30" and "-30" adjust, a bare number sets.
  const result = /^[+-]/.test(raw)
    ? studio.countdownAdjust(live.id, parseInt(raw, 10))
    : studio.countdownSet(live.id, parseInt(raw, 10));
  if (result.ok) log.event('api_countdown', { station: live.id, value: raw });
  runApi(res, result);
});

app.get('/api/state', apiAuth, (_req, res) => res.json(studio.snapshot(driverStatus, feedHub.status())));

// Camera diagnostics run on a station computer: the result lands in the event
// log, so it can be read in the control room without copying anything around.
app.post('/api/diagnostics', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  log.event('diagnostics', {
    from: req.ip,
    host: typeof body.host === 'string' ? body.host.slice(0, 100) : null,
    user_agent: typeof body.userAgent === 'string' ? body.userAgent.slice(0, 300) : null,
    platform: typeof body.platform === 'string' ? body.platform.slice(0, 50) : null,
    items: body.items && typeof body.items === 'object' ? body.items : null
  });
  console.log(`[diagnostica] risultato ricevuto da ${req.ip}`);
  res.json({ ok: true });
});

app.get('/api/log', apiAuth, (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  res.json(readLog(log.path, limit));
});

app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

server.listen(config.http_port || 8080, config.bind_host || '0.0.0.0', () => {
  const addr = server.address();
  const host = lanAddresses()[0] || 'localhost';
  console.log(`[regia] in ascolto su ${scheme}://${addr.address}:${addr.port}`);
  console.log(`[regia] dashboard: ${scheme}://localhost:${addr.port}/regia/`);
  console.log(`[regia] feed:      ${scheme}://localhost:${addr.port}/feed/`);
  console.log(`[regia] poltrona:  ${scheme}://${host}:${addr.port}/poltrona/?id=${config.stations[0].id}`);
  if (!tlsOptions) {
    console.log('[regia] ATTENZIONE: senza HTTPS le poltrone hanno webcam e microfono solo su localhost.');
    console.log('[regia]             genera un certificato con "npm run cert" (vedi README).');
  }
  console.log(`[regia] driver: video=${video.name} lights=${lights.name} relay=${relay.name}`);
  log.event('server_start', { port: addr.port, stations: studio.list().length });

  // Fail-safe on boot: the feed at rest is black and every light is off. Going
  // through the driver wrapper means an unreachable Studio Monitor shows up in
  // the dashboard banner immediately, instead of at the first grant.
  enqueue(async () => {
    await callDriver('video', 'boot black', () => video.setSource(null), video.timeoutMs);
    await syncLights();
    for (const st of studio.list()) await callDriver('relay', `boot off ${st.id}`, () => relay.set(st, false));
    broadcast();
  });
});

// Fail-safe: the feed at rest is black, including on the way out.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[regia] ${signal}: chiusura`);
  log.event('server_stop', { signal });
  Promise.resolve()
    .then(() => video.setSource(null))
    .catch(() => {})
    .finally(() => {
      log.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  // A driver or client bug must never kill the process during a live show.
  console.error(`[uncaught] ${e.stack || e.message}`);
  log.event('uncaught_exception', { message: e.message });
});
