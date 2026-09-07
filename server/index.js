'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { Studio } = require('./state');
const { createLog } = require('./log');

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
const COLORS = config.colors || {};

const log = createLog(path.resolve(ROOT, config.log_path || 'data/events.jsonl'));
const studio = new Studio(config);

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

// --- drivers -----------------------------------------------------------

const driverStatus = {
  video: { status: 'ok' },
  lights: { status: 'ok' },
  relay: { status: 'ok' }
};

function loadDriver(kind, name) {
  const file = path.join(__dirname, 'drivers', `${kind}.${name}.js`);
  try {
    return require(file).create(config, log);
  } catch (e) {
    console.error(`[driver] ${kind}.${name} non caricabile (${e.message}), uso il mock`);
    driverStatus[kind] = { status: 'error', message: `driver ${name} non disponibile` };
    return require(path.join(__dirname, 'drivers', `${kind}.mock.js`)).create(config, log);
  }
}

const video = loadDriver('video', config.video_driver || 'mock');
const lights = loadDriver('lights', config.lights_driver || 'mock');
const relay = loadDriver('relay', config.relay_driver || 'mock');

/** Runs a driver call with a short timeout. Never throws: the show goes on. */
async function callDriver(kind, label, fn) {
  if (studio.manualMode) return;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DRIVER_TIMEOUT_MS))
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
  const spec = COLORS[key] || { rgb: [0, 0, 0], effect: 'off' };
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
      broadcast();
      await callDriver('video', 'black', () => video.setSource(null));
      log.event('live_close', {
        station: st.id,
        name: st.name,
        intervention_id: step.intervention_id,
        duration_s: step.duration_s
      });
    } else if (step.op === 'open') {
      await callDriver('video', `source ${st.id}`, () => video.setSource(st));
      broadcast();
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
  await callDriver('video', 'resync', () => video.setSource(live));
  for (const st of studio.list()) {
    await applyColor(st, colorKeyFor(st));
    await callDriver('relay', `resync ${st.id}`, () => relay.set(st, st.state === 'LIVE'));
  }
}

// --- websocket hub ------------------------------------------------------

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** All authenticated sockets. Station sockets also live in `stationSockets`. */
const clients = new Set();
const stationSockets = new Map();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function sendError(ws, code, message) {
  send(ws, { type: 'error', code, message });
}

function broadcast() {
  const payload = JSON.stringify(studio.snapshot(driverStatus));
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(payload);
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
    if (result.plan && result.plan.length) await runPlan(result.plan);
    await syncLights();
    broadcast();
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
    return handleControlMessage(ws, msg);
  });

  ws.on('close', () => {
    clients.delete(ws);
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
    broadcast();
    return;
  }

  if (msg.role === 'control') {
    if (config.control_token && msg.token !== config.control_token) {
      sendError(ws, 'unauthorized', 'Token non valido');
      return ws.close(4003, 'unauthorized');
    }
    ws.role = 'control';
    clients.add(ws);
    send(ws, studio.snapshot(driverStatus));
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
    default:
      return sendError(ws, 'bad_command', `Comando non ammesso: ${msg.type}`);
  }
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
    offline_timeout_ms: OFFLINE_MS
  })
);
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

server.listen(config.http_port || 8080, config.bind_host || '0.0.0.0', () => {
  const addr = server.address();
  console.log(`[regia] in ascolto su http://${addr.address}:${addr.port}`);
  console.log(`[regia] dashboard: http://localhost:${addr.port}/regia/`);
  console.log(`[regia] poltrona:  http://localhost:${addr.port}/poltrona/?id=${config.stations[0].id}`);
  console.log(`[regia] driver: video=${video.name} lights=${lights.name} relay=${relay.name}`);
  log.event('server_start', { port: addr.port, stations: studio.list().length });
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
