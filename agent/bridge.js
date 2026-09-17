'use strict';

/**
 * Loads the native OBSBOT bridge (agent/native) through koffi and exposes it
 * as promise-returning methods. Every SDK call runs on koffi's worker pool, so
 * a slow camera never blocks the agent's WebSocket heartbeat.
 *
 * Results are { ok: true, data } or { ok: false, code, error } - nothing throws.
 */

const path = require('path');

const CODES = { '-1': 'errore SDK', '-2': 'telecamera non trovata', '-3': 'buffer troppo piccolo' };

function libraryPath(dir) {
  const name = process.platform === 'win32' ? 'obsbot_bridge.dll'
    : process.platform === 'darwin' ? 'obsbot_bridge.dylib' : 'obsbot_bridge.so';
  return path.join(dir || path.join(__dirname, 'native'), name);
}

function loadBridge(options = {}) {
  const koffi = require('koffi');
  const lib = koffi.load(options.path || libraryPath(options.dir));

  const fns = {
    init: lib.func('int ob_init(int wait_ms, int log_level)'),
    info: lib.func('int ob_info(char *buf, int len)'),
    getState: lib.func('int ob_get_state(char *buf, int len)'),
    aiOff: lib.func('int ob_ai_off()'),
    setAiMode: lib.func('int ob_set_ai_mode(int mode, int sub_mode)'),
    wake: lib.func('int ob_wake()'),
    setAngle: lib.func('int ob_set_angle(float pitch, float yaw)'),
    setZoom: lib.func('int ob_set_zoom(float zoom)'),
    setGestures: lib.func('int ob_set_gestures(int enabled)')
  };

  const call = (fn, ...args) =>
    new Promise((resolve) => {
      fn.async(...args, (err, rc) => {
        if (err) return resolve({ ok: false, code: -1, error: err.message });
        if (rc !== 0) return resolve({ ok: false, code: rc, error: CODES[rc] || 'errore ' + rc });
        resolve({ ok: true });
      });
    });

  const callJson = async (fn) => {
    const buf = Buffer.alloc(1024);
    const res = await call(fn, buf, buf.length);
    if (!res.ok) return res;
    try {
      return { ok: true, data: JSON.parse(buf.toString('utf8', 0, buf.indexOf(0))) };
    } catch (e) {
      return { ok: false, code: -1, error: 'risposta non leggibile: ' + e.message };
    }
  };

  return {
    init: (waitMs = 8000, logLevel = 200) => call(fns.init, waitMs, logLevel),
    info: () => callJson(fns.info),
    getState: () => callJson(fns.getState),
    aiOff: () => call(fns.aiOff),
    setAiMode: (mode, subMode) => call(fns.setAiMode, mode, subMode),
    wake: () => call(fns.wake),
    setAngle: (pitch, yaw) => call(fns.setAngle, pitch, yaw),
    setZoom: (zoom) => call(fns.setZoom, zoom),
    setGestures: (enabled) => call(fns.setGestures, enabled ? 1 : 0)
  };
}

module.exports = { loadBridge, libraryPath };
