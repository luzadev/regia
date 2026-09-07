'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sanitizeSettings } = require('../server/settings');

/**
 * This is the one path where the network writes into config.json, so what it
 * refuses matters as much as what it accepts.
 */

test('unknown keys never reach the configuration', () => {
  const clean = sanitizeSettings({
    lights_driver: 'wled',
    http_port: 9999,
    stations: [{ id: 'intruso' }],
    tls: { cert: '/etc/passwd' },
    log_path: '/tmp/altrove'
  });
  assert.deepEqual(Object.keys(clean), ['lights_driver'], 'only whitelisted keys survive');
});

test('driver names are checked against the ones that exist', () => {
  assert.equal(sanitizeSettings({ lights_driver: 'wled' }).lights_driver, 'wled');
  assert.equal(sanitizeSettings({ lights_driver: 'mock' }).lights_driver, 'mock');
  assert.equal(sanitizeSettings({ lights_driver: '../../etc/passwd' }).lights_driver, undefined);
  assert.equal(sanitizeSettings({ relay_driver: 'ndi' }).relay_driver, undefined);
  assert.equal(sanitizeSettings({ relay_driver: 'shelly' }).relay_driver, 'shelly');
});

test('the driver timeout is clamped to a range that keeps the show safe', () => {
  assert.equal(sanitizeSettings({ driver_timeout_ms: 3000 }).driver_timeout_ms, 3000);
  assert.equal(sanitizeSettings({ driver_timeout_ms: 5 }).driver_timeout_ms, 200, 'too short to ever succeed');
  assert.equal(sanitizeSettings({ driver_timeout_ms: 60000 }).driver_timeout_ms, 10000, 'a long timeout stalls a switch');
  assert.equal(sanitizeSettings({ driver_timeout_ms: 'presto' }).driver_timeout_ms, undefined);
});

test('effect ids must be plausible effect ids', () => {
  const ok = sanitizeSettings({ wled_effects: { solid: 0, blink: 12 } });
  assert.deepEqual(ok.wled_effects, { solid: 0, blink: 12 });

  const bad = sanitizeSettings({ wled_effects: { solid: -1, blink: 900, 'drop table': 2, ok_name: 3 } });
  assert.deepEqual(bad.wled_effects, { ok_name: 3 });
});

test('colours are clamped to real RGB values and keep their effect', () => {
  const clean = sanitizeSettings({
    colors: {
      live: { rgb: [300, -20, 12.6], effect: 'solid', bri: 400 },
      requested: { rgb: [255, 170, 0], effect: 'blink', speed: 120 },
      pippo: { rgb: [1, 2, 3] }
    }
  });
  assert.deepEqual(clean.colors.live.rgb, [255, 0, 13]);
  assert.equal(clean.colors.live.bri, 255);
  assert.equal(clean.colors.requested.speed, 120);
  assert.equal(clean.colors.pippo, undefined, 'only the three known states exist');
});

test('relay credentials can be set and cleared', () => {
  assert.deepEqual(sanitizeSettings({ relay_auth: { user: 'admin', password: 'x' } }).relay_auth, {
    user: 'admin',
    password: 'x'
  });
  assert.equal(sanitizeSettings({ relay_auth: null }).relay_auth, null);
  assert.equal(sanitizeSettings({ relay_auth: { password: 'senza utente' } }).relay_auth, undefined);
});

test('urls and templates are trimmed and bounded', () => {
  const clean = sanitizeSettings({ wled_url: '  http://192.168.10.31  ', relay_on_url: 'x'.repeat(500) });
  assert.equal(clean.wled_url, 'http://192.168.10.31');
  assert.equal(clean.relay_on_url.length, 300);
});

test('garbage in gives an empty result, not a broken config', () => {
  assert.deepEqual(sanitizeSettings(null), {});
  assert.deepEqual(sanitizeSettings('tutto'), {});
  assert.deepEqual(sanitizeSettings({}), {});
});
