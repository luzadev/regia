'use strict';

/**
 * Validation for the settings the control room can change at runtime.
 *
 * This is the one path where the network writes into config.json, so nothing
 * is trusted: only known keys, with the shape and range each one is supposed
 * to have, survive the trip.
 */

const SETTINGS_KEYS = [
  'lights_driver',
  'relay_driver',
  'wled_url',
  'wled_state_path',
  'wled_effects',
  'relay_on_url',
  'relay_off_url',
  'relay_auth',
  'colors',
  'driver_timeout_ms'
];

/** Accepts only known keys, with the shape each one is supposed to have. */
function sanitizeSettings(input) {
  const clean = {};
  if (!input || typeof input !== 'object') return clean;

  if (input.lights_driver === 'mock' || input.lights_driver === 'wled') clean.lights_driver = input.lights_driver;
  if (input.relay_driver === 'mock' || input.relay_driver === 'shelly') clean.relay_driver = input.relay_driver;
  for (const key of ['wled_url', 'wled_state_path', 'relay_on_url', 'relay_off_url']) {
    if (typeof input[key] === 'string') clean[key] = input[key].trim().slice(0, 300);
  }
  if (Number.isFinite(input.driver_timeout_ms)) {
    clean.driver_timeout_ms = Math.min(10000, Math.max(200, Math.round(input.driver_timeout_ms)));
  }
  if (input.wled_effects && typeof input.wled_effects === 'object') {
    clean.wled_effects = {};
    for (const [name, id] of Object.entries(input.wled_effects)) {
      if (/^[a-z_]{1,20}$/.test(name) && Number.isInteger(id) && id >= 0 && id < 200) clean.wled_effects[name] = id;
    }
  }
  if (input.relay_auth === null) clean.relay_auth = null;
  else if (input.relay_auth && typeof input.relay_auth.user === 'string') {
    clean.relay_auth = {
      user: input.relay_auth.user.slice(0, 60),
      password: typeof input.relay_auth.password === 'string' ? input.relay_auth.password.slice(0, 60) : ''
    };
  }
  if (input.colors && typeof input.colors === 'object') {
    clean.colors = {};
    for (const key of ['requested', 'live', 'idle']) {
      const c = input.colors[key];
      if (!c || typeof c !== 'object') continue;
      const rgb = Array.isArray(c.rgb) ? c.rgb.slice(0, 3).map((n) => Math.min(255, Math.max(0, Math.round(n) || 0))) : [0, 0, 0];
      const spec = { rgb, effect: typeof c.effect === 'string' ? c.effect.slice(0, 20) : 'solid' };
      if (Number.isInteger(c.bri)) spec.bri = Math.min(255, Math.max(0, c.bri));
      if (Number.isInteger(c.speed)) spec.speed = Math.min(255, Math.max(0, c.speed));
      clean.colors[key] = spec;
    }
  }
  return clean;
}

// --- drivers -----------------------------------------------------------

module.exports = { sanitizeSettings, SETTINGS_KEYS };
