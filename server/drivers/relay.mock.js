'use strict';

/** Fake relay: logs the LED bar on/off it would switch. */
function create(config, log) {
  return {
    name: 'relay.mock',
    async set(station, on) {
      log.event('driver_relay', { driver: 'mock', station: station.id, on });
      console.log(`[relay.mock] ${station.id} -> ${on ? 'ON' : 'OFF'}`);
    }
  };
}

module.exports = { create };
