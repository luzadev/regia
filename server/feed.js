'use strict';

/**
 * WebRTC feed hub.
 *
 * The clean feed to the mixer is a Chromium page (/feed/) running fullscreen on
 * the control room PC's second HDMI output. Stations publish webcam+microphone
 * over WebRTC; this hub decides which station the feed page is showing and
 * relays the signalling between the two, over the WebSocket we already have.
 *
 * Dashboards connect as monitors. A monitor either follows whatever is on air
 * (the default) or previews one station the operator picked - typically a
 * guest waiting in the queue, to check them before going on air. The clean
 * feed never follows a preview: only the station on air may reach it.
 *
 * No STUN, no TURN, no internet: peers are on the same LAN and exchange host
 * candidates only (rule §2.5).
 */

class FeedHub {
  constructor({ log, readyTimeoutMs = 4000, monitorQuality = null }) {
    this.log = log;
    this.readyTimeoutMs = readyTimeoutMs;
    // A preview must not cost the mini PC a second full-quality encode.
    this.monitorQuality = monitorQuality || { max_kbps: 600, scale: 2 };
    this.clients = new Set(); // clean feed receiver (one at a time)
    // Dashboards: ws -> { id, preview }. preview === null means "follow the air".
    this.monitors = new Map();
    this.nextMonitorId = 1;
    this.target = null; // station id currently requested on the feed
    this.ready = false; // the feed page reported the stream is playing
    this.audioBlocked = false; // the browser refused to play with sound
    this.pending = null; // { station, resolve, reject, timer }
    this.stationSocket = () => null; // injected by index.js
    this.onChange = () => {};
  }

  addClient(ws) {
    // One receiver at a time: there is a single clean output, and a station can
    // only hold one peer connection per receiver. Last one wins, like stations.
    for (const other of [...this.clients]) {
      if (other !== ws) {
        this.clients.delete(other);
        other.close(4000, 'replaced');
      }
    }
    this.clients.add(ws);
    // A receiver that connects mid-show must learn what to show AND get the
    // station publishing again, otherwise the feed stays black for good.
    this.send(ws, { type: 'feed_target', station: this.target });
    if (this.target) this.restartPublishing('nuovo ricevitore feed');
    this.onChange();
  }

  // --- monitors (dashboard previews) -------------------------------------

  /** The station a monitor is actually looking at right now. */
  watching(entry) {
    return entry.preview || this.target;
  }

  /**
   * Preview receivers get their own peer connection at reduced quality and are
   * best effort: they never gate the open sequence, never set `ready`, and never
   * raise a driver error.
   */
  addMonitor(ws) {
    const entry = { id: 'mon-' + this.nextMonitorId++, preview: null };
    this.monitors.set(ws, entry);
    this.send(ws, { type: 'preview_mode', station: null });
    this.send(ws, { type: 'feed_target', station: this.target });
    if (this.target) this.startPeer(this.target, entry.id, this.monitorQuality);
    this.onChange();
    return entry.id;
  }

  removeMonitor(ws) {
    const entry = this.monitors.get(ws);
    if (!entry) return;
    this.monitors.delete(ws);
    this.stopPeer(this.watching(entry), entry.id);
    this.onChange();
  }

  /**
   * Points one monitor at a station (preview) or back at the air (null).
   * Returns false when the station is not connected, so the dashboard can say
   * why the preview stays dark.
   */
  setPreview(ws, stationId) {
    const entry = this.monitors.get(ws);
    if (!entry) return { ok: false, reason: 'monitor sconosciuto' };

    const before = this.watching(entry);
    entry.preview = stationId || null;
    // Previewing the station already on air is the same as following the air.
    if (entry.preview && entry.preview === this.target) entry.preview = null;
    const after = this.watching(entry);

    this.send(ws, { type: 'preview_mode', station: entry.preview });
    if (before === after) return { ok: true };

    this.stopPeer(before, entry.id);
    this.send(ws, { type: 'feed_target', station: after });
    this.log.event('preview', { monitor: entry.id, station: entry.preview });

    if (!after) return { ok: true };
    if (!this.startPeer(after, entry.id, this.monitorQuality)) {
      return { ok: false, reason: `poltrona ${after} non collegata` };
    }
    return { ok: true };
  }

  /** A station that reconnects, or whose camera comes back, re-offers to its previews. */
  restartMonitorsFor(stationId) {
    let restarted = 0;
    for (const [ws, entry] of this.monitors) {
      if (this.watching(entry) !== stationId) continue;
      this.send(ws, { type: 'feed_target', station: stationId });
      if (this.startPeer(stationId, entry.id, this.monitorQuality)) restarted++;
    }
    return restarted;
  }

  monitorEntryByPeer(peerId) {
    for (const [ws, entry] of this.monitors) if (entry.id === peerId) return { ws, entry };
    return null;
  }

  // --- peers -------------------------------------------------------------

  startPeer(stationId, peer, quality) {
    const station = this.stationSocket(stationId);
    if (!station) return false;
    this.send(station, { type: 'feed_start', peer, quality: quality || null });
    return true;
  }

  stopPeer(stationId, peer) {
    if (!stationId) return;
    const station = this.stationSocket(stationId);
    if (station) this.send(station, { type: 'feed_stop', peer });
  }

  /**
   * Re-negotiates the current target. The offer is created on the feed_start
   * edge, so anything that breaks the pair - a reloaded feed page, a station
   * that reconnects, a camera that only becomes available after the grant -
   * needs this to recover instead of leaving a black feed.
   */
  restartPublishing(reason) {
    if (!this.target || this.clients.size === 0) return false;
    const ws = this.stationSocket(this.target);
    if (!ws) return false;
    this.ready = false;
    this.log.event('feed_restart', { station: this.target, reason });
    this.broadcastToFeed({ type: 'feed_target', station: this.target });
    this.send(ws, { type: 'feed_start', peer: 'feed' });
    this.onChange();
    return true;
  }

  removeClient(ws) {
    if (!this.clients.delete(ws)) return;
    if (this.clients.size === 0) {
      this.ready = false;
      this.audioBlocked = false;
    }
    this.onChange();
  }

  send(ws, payload) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  broadcastToFeed(payload) {
    for (const ws of this.clients) this.send(ws, payload);
  }

  status() {
    let previews = 0;
    for (const entry of this.monitors.values()) if (entry.preview) previews++;
    return {
      receivers: this.clients.size,
      monitors: this.monitors.size,
      previews,
      target: this.target,
      ready: this.ready,
      audio_blocked: this.audioBlocked
    };
  }

  setAudioBlocked(blocked) {
    if (this.audioBlocked === !!blocked) return false;
    this.audioBlocked = !!blocked;
    this.log.event('feed_audio', { blocked: this.audioBlocked });
    this.onChange();
    return true;
  }

  // --- the air -----------------------------------------------------------

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

    if (previous && previous !== stationId) this.stopPeer(previous, 'feed');
    this.broadcastToFeed({ type: 'feed_target', station: stationId });

    const stationWs = stationId ? this.stationSocket(stationId) : null;

    for (const [ws, entry] of this.monitors) {
      if (entry.preview) {
        // The operator was previewing exactly this guest and put them on air:
        // the preview simply becomes "follow the air", nothing to renegotiate.
        if (entry.preview === stationId) {
          entry.preview = null;
          this.send(ws, { type: 'preview_mode', station: null });
        }
        // Any other preview is the operator's choice: the air changing does
        // not yank it away.
        continue;
      }
      // Following the air: move to the new station. Previews are independent
      // of the clean feed, so they start even while /feed/ is not open - the
      // usual situation during setup - and before anything below can reject.
      if (previous && previous !== stationId) this.stopPeer(previous, entry.id);
      this.send(ws, { type: 'feed_target', station: stationId });
      if (stationWs && previous !== stationId) this.startPeer(stationId, entry.id, this.monitorQuality);
    }
    this.onChange();

    if (stationId === null) {
      // Black is reached by stopping: nothing to wait for.
      return Promise.resolve();
    }
    if (this.clients.size === 0) {
      return Promise.reject(new Error('nessun ricevitore feed collegato (/feed/)'));
    }
    if (!stationWs) {
      return Promise.reject(new Error(`poltrona ${stationId} non collegata: nessun video da inviare`));
    }
    this.send(stationWs, { type: 'feed_start', peer: 'feed' });

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

  // --- signalling --------------------------------------------------------

  /**
   * Station -> receiver signalling. The clean feed only ever talks to the
   * station on air; a monitor only to the station it is watching.
   */
  relayFromStation(stationId, data, peer) {
    if (!peer || peer === 'feed') {
      if (stationId !== this.target) return false;
      this.broadcastToFeed({ type: 'rtc_signal', station: stationId, data });
      return true;
    }
    const found = this.monitorEntryByPeer(peer);
    if (!found || this.watching(found.entry) !== stationId) return false;
    this.send(found.ws, { type: 'rtc_signal', station: stationId, data });
    return true;
  }

  /** Receiver -> station signalling, with the same pairing rules. */
  relayToStation(stationId, data, peer) {
    const peerId = peer || 'feed';
    if (peerId === 'feed') {
      if (stationId !== this.target) return false;
    } else {
      const found = this.monitorEntryByPeer(peerId);
      if (!found || this.watching(found.entry) !== stationId) return false;
    }
    const ws = this.stationSocket(stationId);
    if (!ws) return false;
    this.send(ws, { type: 'rtc_signal', peer: peerId, data });
    return true;
  }
}

module.exports = { FeedHub };
