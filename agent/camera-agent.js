'use strict';

/**
 * Regia camera agent - runs on each station computer next to the kiosk.
 *
 * It drives the OBSBOT gimbal and zoom through the vendor SDK (native bridge)
 * and takes orders only from the Regia server, over the same WebSocket
 * protocol as everything else: the station never moves its camera on its own
 * initiative, apart from the safety rules below (rule §2.6).
 *
 * Safety rules applied as soon as the camera is found:
 *   - AI tracking off: the framing must not drift while a guest is on air;
 *   - hand gestures off: a guest raising a hand to ask for the floor must not
 *     zoom or retarget the camera;
 *   - kept awake: a Tiny with no stream falls asleep and parks its gimbal, then
 *     swings back on wake - possibly just as the guest goes on air.
 *
 * Usage:
 *   node camera-agent.js --server wss://192.168.10.10:8080/ws --station post-01
 *     [--token <control token>] [--ca certs/server.crt] [--fingerprint AB:CD:...]
 */

const fs = require('fs');

const LIMITS = { pitch: [-90, 90], yaw: [-180, 180], zoom: [1, 4] };

// SDK AiWorkModeType / AiSubModeType for the Tiny 2 series.
const TRACKING = {
  off: { mode: 0, sub: 0 },
  normal: { mode: 2, sub: 0 }, // single person
  upper: { mode: 2, sub: 1 }, // upper body
  closeup: { mode: 2, sub: 2 } // close-up
};
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
// toFixed avoids reporting -18.900000000000002 for -18.9.
const round = (v, decimals) => Number(Number(v).toFixed(decimals));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createAgent(options) {
  const {
    bridge,
    WebSocketImpl,
    url,
    station,
    token = null,
    wsOptions = {},
    pollMs = 3000,
    settleMs = 1200,
    initWaitMs = 8000,
    safety = { aiOff: true, gesturesOff: true, keepAwake: true },
    onReplaced = () => {},
    log = (...a) => console.log('[agente]', ...a)
  } = options;

  let ws = null;
  let stopped = false;
  let backoff = 1000;
  let cameraReady = false;
  let info = null;
  let last = null; // last reported status, to avoid chatter
  let pollTimer = null;
  let busy = Promise.resolve(); // SDK calls run one at a time

  const serial = (fn) => {
    busy = busy.then(fn, fn);
    return busy;
  };

  function send(payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
  }

  function report(state, extra = {}) {
    const status = {
      type: 'camera_status',
      ok: cameraReady && !!state,
      info,
      state: state
        ? {
            pitch: round(state.pitch, 1),
            yaw: round(state.yaw, 1),
            zoom: round(state.zoom, 2),
            ai_mode: state.ai_mode,
            asleep: state.dev_status === 3
          }
        : null,
      ...extra
    };
    last = status;
    send(status);
    return status;
  }

  /**
   * Wakes the camera and waits until it really is awake: the Tiny takes a few
   * seconds to leave sleep and swing its gimbal back, and reporting before then
   * would tell the control room something false.
   */
  async function wakeAndWait(timeoutMs = 8000) {
    const r = await bridge.wake();
    if (!r.ok) return r;
    const end = Date.now() + timeoutMs;
    for (;;) {
      await sleep(Math.min(500, settleMs || 500));
      const s = await bridge.getState();
      if (s.ok && s.data.dev_status !== 3) return { ok: true };
      if (Date.now() >= end) return { ok: false, error: 'la telecamera non si sveglia' };
    }
  }

  /** Finds the camera and applies the safety rules. Idempotent. */
  async function ensureCamera() {
    if (cameraReady) return true;
    const init = await bridge.init(initWaitMs);
    if (!init.ok) {
      report(null, { error: init.error });
      return false;
    }
    const i = await bridge.info();
    info = i.ok ? i.data : null;
    cameraReady = true;
    log('telecamera trovata:', info ? `${info.model} sn ${info.sn} firmware ${info.firmware}` : '(info non disponibili)');

    const applied = [];
    if (safety.keepAwake) {
      const s = await bridge.getState();
      if (s.ok && s.data.dev_status === 3) {
        const r = await wakeAndWait();
        applied.push('sveglia:' + (r.ok ? 'ok' : r.error));
      }
    }
    if (safety.aiOff) {
      const r = await bridge.aiOff();
      applied.push('tracking AI spento:' + (r.ok ? 'ok' : r.error));
    }
    if (safety.gesturesOff) {
      const r = await bridge.setGestures(false);
      applied.push('gesti spenti:' + (r.ok ? 'ok' : r.error));
    }
    if (applied.length) log('regole di sicurezza:', applied.join(', '));

    const s = await bridge.getState();
    report(s.ok ? s.data : null, { safety: applied });
    return true;
  }

  /** Periodic check: camera still there, still awake. */
  async function poll() {
    if (stopped) return;
    await serial(async () => {
      if (!(await ensureCamera())) return;
      const s = await bridge.getState();
      if (!s.ok) {
        // The camera went away: forget it, the next round re-acquires it.
        log('telecamera persa:', s.error);
        cameraReady = false;
        report(null, { error: s.error });
        return;
      }
      if (safety.keepAwake && s.data.dev_status === 3) {
        log('telecamera in sospensione: la sveglio');
        await wakeAndWait();
        const after = await bridge.getState();
        report(after.ok ? after.data : null, { woke: true });
        return;
      }
      const prev = last && last.state;
      const moved = !prev || Math.abs(prev.pitch - s.data.pitch) > 0.5 || Math.abs(prev.yaw - s.data.yaw) > 0.5 ||
        Math.abs(prev.zoom - s.data.zoom) > 0.05 || prev.ai_mode !== s.data.ai_mode || prev.asleep !== (s.data.dev_status === 3);
      if (moved || !last || !last.ok) report(s.data);
    });
    if (!stopped) pollTimer = setTimeout(poll, pollMs);
  }

  /** Orders from the server. Returns the status sent back. */
  async function handleCommand(msg) {
    return serial(async () => {
      const reply = { reply_to: msg.id || null };
      if (!(await ensureCamera())) return report(null, { ...reply, error: 'telecamera non disponibile' });

      const s0 = await bridge.getState();
      if (!s0.ok) return report(null, { ...reply, error: s0.error });
      const cur = s0.data;

      let target = null;
      let zoom = null;
      if (msg.cmd === 'goto') {
        target = { pitch: Number(msg.pitch), yaw: Number(msg.yaw) };
        if (msg.zoom !== undefined && msg.zoom !== null) zoom = Number(msg.zoom);
      } else if (msg.cmd === 'nudge') {
        target = { pitch: cur.pitch + Number(msg.dpitch || 0), yaw: cur.yaw + Number(msg.dyaw || 0) };
      } else if (msg.cmd === 'zoom') {
        zoom = msg.zoom !== undefined ? Number(msg.zoom) : cur.zoom + Number(msg.dzoom || 0);
      } else if (msg.cmd === 'tracking') {
        const t = TRACKING[msg.mode];
        if (!t) return report(cur, { ...reply, error: 'modo di tracking sconosciuto: ' + msg.mode });
        if (cur.dev_status === 3) await wakeAndWait();
        const r = await bridge.setAiMode(t.mode, t.sub);
        await sleep(settleMs);
        const s1 = await bridge.getState();
        return report(s1.ok ? s1.data : null, { ...reply, tracking: msg.mode, ...(r.ok ? {} : { error: 'tracking: ' + r.error }) });
      } else if (msg.cmd !== 'state') {
        return report(cur, { ...reply, error: 'comando sconosciuto: ' + msg.cmd });
      }

      const errors = [];
      if (target && Number.isFinite(target.pitch) && Number.isFinite(target.yaw)) {
        // The SDK ignores manual gimbal moves while AI tracking is active.
        if (cur.ai_mode !== 0) {
          const r = await bridge.aiOff();
          if (!r.ok) errors.push('tracking AI: ' + r.error);
        }
        if (cur.dev_status === 3) await wakeAndWait();
        const r = await bridge.setAngle(clamp(target.pitch, LIMITS.pitch), clamp(target.yaw, LIMITS.yaw));
        if (!r.ok) errors.push('gimbal: ' + r.error);
      }
      if (zoom !== null && Number.isFinite(zoom)) {
        const r = await bridge.setZoom(clamp(zoom, LIMITS.zoom));
        if (!r.ok) errors.push('zoom: ' + r.error);
      }
      if (target || zoom !== null) await sleep(settleMs);

      const s1 = await bridge.getState();
      return report(s1.ok ? s1.data : null, { ...reply, ...(errors.length ? { error: errors.join(' · ') } : {}) });
    });
  }

  function connect() {
    if (stopped) return;
    ws = new WebSocketImpl(url, wsOptions);
    ws.on('open', () => {
      backoff = 1000;
      log('collegato a', url, 'come', station);
      send({ type: 'hello', role: 'camera', station, token });
      if (last) send(last);
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'camera_cmd') handleCommand(msg);
      else if (msg.type === 'error') log('errore dal server:', msg.message || msg.code);
    });
    ws.on('close', (code) => {
      if (stopped) return;
      // Replaced by another agent for the same station: do not fight over it.
      if (code === 4000) {
        log('un altro agente ha preso questa poltrona: mi fermo');
        stop();
        onReplaced();
        return;
      }
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10000);
    });
    ws.on('error', () => {});
  }

  function start() {
    connect();
    poll();
  }

  function stop() {
    stopped = true;
    clearTimeout(pollTimer);
    if (ws) try { ws.close(); } catch {}
  }

  return { start, stop, handleCommand, ensureCamera, poll };
}

/* ---------------------------------------------------------------------- */

/**
 * TLS options that accept exactly one certificate, identified by its SHA-256
 * fingerprint, whatever address the server is reached at. The desktop station
 * app pairs with the server this way instead of installing its certificate.
 */
function pinnedWsOptions(pem, fingerprint) {
  const crypto = require('crypto');
  const norm = (v) => String(v || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return {
    ca: pem,
    checkServerIdentity: (_host, cert) => {
      const got = crypto.createHash('sha256').update(cert.raw).digest('hex');
      return norm(got) === norm(fingerprint) ? undefined : new Error('certificato del server diverso da quello abbinato');
    }
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const url = args.server || process.env.REGIA_SERVER;
  const station = args.station || process.env.REGIA_STATION;
  if (!url || !station) {
    console.error('uso: node camera-agent.js --server wss://<ip-server>:8080/ws --station post-01 [--token ...] [--ca certs/server.crt [--fingerprint AB:CD:...]]');
    process.exit(1);
  }
  const ca = args.ca || process.env.REGIA_CA;
  const pin = args.fingerprint || process.env.REGIA_FINGERPRINT;
  const wsOptions = ca && pin ? pinnedWsOptions(fs.readFileSync(ca), pin)
    : ca ? { ca: fs.readFileSync(ca) } : { rejectUnauthorized: false };
  if (!ca && url.startsWith('wss:')) {
    console.warn('[agente] nessun --ca: accetto il certificato del server senza verificarlo (solo LAN chiusa)');
  }

  const { loadBridge } = require('./bridge');
  const agent = createAgent({
    bridge: loadBridge({ dir: args.native }),
    WebSocketImpl: require('ws'),
    url,
    station,
    token: args.token || process.env.REGIA_TOKEN || null,
    wsOptions,
    // Exit code 3 tells a supervisor not to restart us into a tug of war.
    onReplaced: () => process.exit(3)
  });
  agent.start();
  const quit = () => {
    agent.stop();
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  // Started by the station app: it asks over IPC (Windows has no SIGTERM to catch).
  process.on('message', (m) => {
    if (m && m.type === 'shutdown') quit();
  });
}

module.exports = { createAgent, pinnedWsOptions, LIMITS, TRACKING };
