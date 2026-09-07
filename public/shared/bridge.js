/* Shared WebSocket client: reconnection with backoff, heartbeat watchdog and
 * server clock offset. No local state is authoritative: everything the pages
 * render comes from the last state_sync. */
(function () {
  'use strict';

  function Bridge(options) {
    this.role = options.role;
    this.station = options.station || null;
    this.token = options.token || null;
    this.offlineMs = options.offlineMs || 6000;
    this.onSync = options.onSync || function () {};
    this.onLink = options.onLink || function () {};
    this.onError = options.onError || function () {};
    this.onMessage = options.onMessage || function () {};

    this.ws = null;
    this.offset = 0; // serverNow - Date.now(), so drifting kiosk clocks don't matter
    this.lastBeat = 0;
    this.online = false;
    this.backoff = 500;
    this.snapshot = null;
  }

  Bridge.prototype.start = function () {
    var self = this;
    this._connect();
    setInterval(function () {
      self._checkLink();
    }, 500);
  };

  Bridge.prototype._connect = function () {
    var self = this;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws;
    try {
      ws = new WebSocket(proto + '//' + location.host + '/ws');
    } catch (e) {
      return this._retry();
    }
    this.ws = ws;

    ws.onopen = function () {
      self.backoff = 500;
      self.lastBeat = Date.now();
      ws.send(
        JSON.stringify({ type: 'hello', role: self.role, station: self.station, token: self.token })
      );
    };

    ws.onmessage = function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.type === 'heartbeat') {
        self.lastBeat = Date.now();
        self.offset = msg.t - Date.now();
        self._setLink(true);
      } else if (msg.type === 'state_sync') {
        self.lastBeat = Date.now();
        self.offset = msg.server_t - Date.now();
        self.snapshot = msg;
        self._setLink(true);
        self.onSync(msg);
      } else if (msg.type === 'error') {
        self.onError(msg);
      } else {
        self.onMessage(msg);
      }
    };

    ws.onclose = function () {
      self._setLink(false);
      self._retry();
    };

    ws.onerror = function () {
      try {
        ws.close();
      } catch (e) {}
    };
  };

  Bridge.prototype._retry = function () {
    var self = this;
    setTimeout(function () {
      self._connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 5000);
  };

  Bridge.prototype._checkLink = function () {
    if (this.online && Date.now() - this.lastBeat > this.offlineMs) this._setLink(false);
  };

  Bridge.prototype._setLink = function (up) {
    if (this.online === up) return;
    this.online = up;
    this.onLink(up);
  };

  Bridge.prototype.send = function (msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  };

  /** Server time, corrected for the local clock offset. */
  Bridge.prototype.serverNow = function () {
    return Date.now() + this.offset;
  };

  Bridge.prototype.stationOf = function (id) {
    if (!this.snapshot) return null;
    for (var i = 0; i < this.snapshot.stations.length; i++) {
      if (this.snapshot.stations[i].id === id) return this.snapshot.stations[i];
    }
    return null;
  };

  window.Bridge = Bridge;

  /** mm:ss, with a leading minus while in overtime. */
  window.formatClock = function (seconds) {
    var neg = seconds < 0;
    var s = Math.abs(Math.round(seconds));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return (neg ? '-' : '') + m + ':' + (r < 10 ? '0' : '') + r;
  };
})();
