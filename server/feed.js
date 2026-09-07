'use strict';

/**
 * WebRTC feed hub.
 *
 * The clean feed to the mixer is a Chromium page (/feed/) running fullscreen on
 * the control room PC's second HDMI output. Stations publish webcam+microphone
 * over WebRTC; this hub decides which station the feed page is showing and
 * relays the signalling between the two, over the WebSocket we already have.
 *
 * No STUN, no TURN, no internet: peers are on the same LAN and exchange host
 * candidates only (rule §2.5).
 */

class FeedHub {
  constructor({ log, readyTimeoutMs = 4000 }) {
    this.log = log;
    this.readyTimeoutMs = readyTimeoutMs;
    this.clients = new Set(); // feed receiver sockets
    this.target = null; // station id currently requested on the feed
    this.ready = false; // the feed page reported the stream is playing
    this.pending = null; // { station, resolve, reject, timer }
    this.stationSocket = () => null; // injected by index.js
    this.onChange = () => {};
  }

  addClient(ws) {
    this.clients.add(ws);
    // A receiver that connects mid-show must immediately learn what to show.
    this.send(ws, { type: 'feed_target', station: this.target });
    this.onChange();
  }

  removeClient(ws) {
    if (!this.clients.delete(ws)) return;
    if (this.clients.size === 0) this.ready = false;
    this.onChange();
  }

  send(ws, payload) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  broadcastToFeed(payload) {
    for (const ws of this.clients) this.send(ws, payload);
  }

  status() {
    return { receivers: this.clients.size, target: this.target, ready: this.ready };
  }

  /**
   * Points the feed at a station (or to black), and resolves once the feed page
   * reports the stream is actually playing. Rejects on timeout or when nothing
   * can carry the video - index.js turns that into the dashboard banner.
   */
  setTarget(stationId) {
    this.cancelPending();
    const previous = this.target;
    this.target = stationId;
    this.ready = false;

    if (previous && previous !== stationId) {
      const prevWs = this.stationSocket(previous);
      if (prevWs) this.send(prevWs, { type: 'feed_stop' });
    }

    this.broadcastToFeed({ type: 'feed_target', station: stationId });
    this.onChange();

    if (stationId === null) {
      // Black is reached by stopping: nothing to wait for.
      return Promise.resolve();
    }

    if (this.clients.size === 0) {
      return Promise.reject(new Error('nessun ricevitore feed collegato (/feed/)'));
    }

    const stationWs = this.stationSocket(stationId);
    if (!stationWs) {
      return Promise.reject(new Error(`poltrona ${stationId} non collegata: nessun video da inviare`));
    }
    this.send(stationWs, { type: 'feed_start' });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`il feed non ha confermato ${stationId} entro ${this.readyTimeoutMs} ms`));
      }, this.readyTimeoutMs);
      this.pending = { station: stationId, resolve, reject, timer };
    });
  }

  cancelPending() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(new Error('sostituito da un altro comando'));
    this.pending = null;
  }

  /** The feed page reports the stream is playing. */
  markReady(stationId) {
    if (stationId !== this.target) return;
    this.ready = true;
    if (this.pending && this.pending.station === stationId) {
      clearTimeout(this.pending.timer);
      this.pending.resolve();
      this.pending = null;
    }
    this.onChange();
  }

  /** The feed page could not play the stream. */
  markError(stationId, message) {
    if (this.pending && this.pending.station === stationId) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error(message || 'errore del ricevitore feed'));
      this.pending = null;
    }
    this.log.event('feed_error', { station: stationId, message });
  }

  /** Station -> feed signalling. Only the station on air may reach the feed. */
  relayFromStation(stationId, data) {
    if (stationId !== this.target) return false;
    this.broadcastToFeed({ type: 'rtc_signal', station: stationId, data });
    return true;
  }

  /** Feed -> station signalling. */
  relayToStation(stationId, data) {
    if (stationId !== this.target) return false;
    const ws = this.stationSocket(stationId);
    if (!ws) return false;
    this.send(ws, { type: 'rtc_signal', data });
    return true;
  }
}

module.exports = { FeedHub };
