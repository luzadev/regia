'use strict';

/** Fake light controller: logs the colour each station should show. */
function create(config, log) {
  return {
    name: 'lights.mock',
    async apply(station, colorKey, colorSpec) {
      log.event('driver_lights', { driver: 'mock', station: station.id, color: colorKey });
      console.log(
        `[lights.mock] ${station.id} -> ${colorKey} ` +
          `(rgb ${JSON.stringify(colorSpec.rgb)}, ${colorSpec.effect})`
      );
    }
  };
}

module.exports = { create };
