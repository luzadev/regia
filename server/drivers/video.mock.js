'use strict';

/** Fake video router: logs the requested source, switches nothing. */
function create(config, log) {
  let current = null;
  return {
    name: 'video.mock',
    async setSource(station) {
      current = station ? station.config.ndi_source || station.id : null;
      log.event('driver_video', { driver: 'mock', source: current });
      console.log(`[video.mock] source -> ${current || 'BLACK'}`);
    },
    get current() {
      return current;
    }
  };
}

module.exports = { create };
