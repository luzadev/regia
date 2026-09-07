'use strict';

/**
 * Video "router" for the in-house WebRTC path: instead of talking to an
 * external device, it points the /feed/ page at a station and waits until that
 * page reports the stream is actually playing.
 *
 * That makes the rigid open sequence stronger than with an external switcher:
 * the station only sees "SEI IN ONDA" after the feed is really carrying it.
 */

function create(config, log, bus) {
  if (!bus || typeof bus.setTarget !== 'function') {
    throw new Error('il driver webrtc richiede il feed hub');
  }

  let current = null;

  return {
    name: 'video.webrtc',
    // The WebRTC handshake needs more room than an HTTP call to a switcher.
    timeoutMs: config.webrtc_ready_timeout_ms ?? 5000,

    async setSource(station) {
      const id = station ? station.id : null;
      await bus.setTarget(id);
      current = id;
      log.event('driver_video', { driver: 'webrtc', source: id });
      console.log(`[video.webrtc] feed -> ${id || 'BLACK'}`);
    },

    get current() {
      return current;
    }
  };
}

module.exports = { create };
