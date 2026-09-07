'use strict';

/**
 * Station tally lights over the WLED JSON API.
 *
 * One WLED controller drives every station: each station owns a segment
 * (`stations[].wled_segment`) and the colours come from `colors` in config.
 *
 *   POST /json/state
 *   {"on":true,"transition":0,"seg":[{"id":2,"on":true,"col":[[255,0,0]],"fx":0}]}
 *
 * Effect ids are configurable (`wled_effects`) rather than hardcoded: WLED
 * builds and custom effect lists do not always number them the same way.
 *
 * Failures are thrown, never swallowed: index.js turns them into the dashboard
 * banner and the show carries on (rule §2.7).
 */

const DEFAULT_EFFECTS = { solid: 0, blink: 1 };
const DEFAULT_STATE_PATH = '/json/state';

function create(config, log) {
  const base = (config.wled_url || 'http://127.0.0.1').replace(/\/+$/, '');
  const statePath = config.wled_state_path || DEFAULT_STATE_PATH;
  const effects = { ...DEFAULT_EFFECTS, ...(config.wled_effects || {}) };
  const timeoutMs = config.driver_timeout_ms ?? 1500;
  const warned = new Set();

  function payloadFor(segment, colorKey, colorSpec) {
    const spec = colorSpec || {};
    const seg = { id: segment };

    if (spec.effect === 'off' || colorKey === 'idle') {
      // The segment goes dark while the controller itself stays on, so the
      // other stations keep their colour.
      seg.on = false;
    } else {
      const rgb = Array.isArray(spec.rgb) ? spec.rgb.slice(0, 3) : [255, 255, 255];
      seg.on = true;
      seg.col = [rgb];
      seg.fx = effects[spec.effect] ?? effects.solid;
      seg.bri = Number.isInteger(spec.bri) ? spec.bri : 255;
      if (Number.isInteger(spec.speed)) seg.sx = spec.speed;
    }

    // transition 0: a tally light must switch, not fade.
    return { on: true, transition: 0, seg: [seg] };
  }

  return {
    name: 'lights.wled',

    async apply(station, colorKey, colorSpec) {
      const segment = station.config.wled_segment;
      if (!Number.isInteger(segment)) {
        // A station added without a segment simply has no light: that is a
        // configuration choice, not a fault.
        if (!warned.has(station.id)) {
          warned.add(station.id);
          console.log(`[lights.wled] ${station.id} senza wled_segment: nessuna luce da comandare`);
        }
        return;
      }

      const url = base + statePath;
      const body = payloadFor(segment, colorKey, colorSpec);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        log.event('driver_lights', { driver: 'wled', station: station.id, color: colorKey, segment });
        console.log(`[lights.wled] ${station.id} (seg ${segment}) -> ${colorKey}`);
      } catch (e) {
        log.event('driver_lights_error', { driver: 'wled', station: station.id, message: e.message });
        throw new Error(`WLED non raggiungibile (${e.message})`);
      }
    }
  };
}

module.exports = { create, DEFAULT_EFFECTS, DEFAULT_STATE_PATH };
