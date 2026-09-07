/* WebRTC media path: the station publishes webcam+microphone, the feed page
 * receives them and puts them on the clean HDMI output.
 *
 * Peers are on the same LAN, so there are no ICE servers at all: host
 * candidates only, no STUN, no TURN, nothing that touches the internet. */
(function () {
  'use strict';

  var RTC_CONFIG = { iceServers: [] };

  /** Runs on the station page. */
  function StationPublisher(bridge, options) {
    this.bridge = bridge;
    this.constraints = options.constraints;
    this.onStatus = options.onStatus || function () {};
    this.stream = null;
    this.pc = null;
    this.retryTimer = null;
  }

  StationPublisher.prototype.start = function () {
    var self = this;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return this.fail('Questo browser non espone webcam e microfono');
    }
    navigator.mediaDevices
      .getUserMedia(this.constraints)
      .then(function (stream) {
        self.stream = stream;
        self.onStatus(true, null);
        self.bridge.send({ type: 'media_status', ok: true });
        // A camera unplugged mid-show must show up in the dashboard.
        stream.getTracks().forEach(function (track) {
          track.onended = function () {
            self.fail('Dispositivo scollegato');
            self.retryLater();
          };
        });
      })
      .catch(function (e) {
        self.fail(e.name === 'NotAllowedError' ? 'Permesso negato per webcam/microfono' : e.message);
        self.retryLater();
      });
  };

  StationPublisher.prototype.fail = function (message) {
    this.stream = null;
    this.onStatus(false, message);
    this.bridge.send({ type: 'media_status', ok: false, message: message });
  };

  StationPublisher.prototype.retryLater = function () {
    var self = this;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(function () {
      self.start();
    }, 5000);
  };

  /** Server-driven: the station never decides on its own to go on the feed. */
  StationPublisher.prototype.handle = function (msg) {
    if (msg.type === 'feed_start') return this.openPeer();
    if (msg.type === 'feed_stop') return this.closePeer();
    if (msg.type === 'rtc_signal') return this.onSignal(msg.data);
  };

  StationPublisher.prototype.openPeer = function () {
    var self = this;
    this.closePeer();
    if (!this.stream) {
      this.bridge.send({ type: 'media_status', ok: false, message: 'Nessun flusso da inviare' });
      return;
    }
    var pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;

    this.stream.getTracks().forEach(function (track) {
      pc.addTrack(track, self.stream);
    });

    pc.onicecandidate = function (ev) {
      if (ev.candidate) self.bridge.send({ type: 'rtc_signal', data: { candidate: ev.candidate } });
    };

    pc.createOffer()
      .then(function (offer) {
        return pc.setLocalDescription(offer);
      })
      .then(function () {
        self.bridge.send({ type: 'rtc_signal', data: { sdp: pc.localDescription } });
      })
      .catch(function (e) {
        self.bridge.send({ type: 'media_status', ok: false, message: 'Offerta WebRTC fallita: ' + e.message });
      });
  };

  StationPublisher.prototype.closePeer = function () {
    if (!this.pc) return;
    try {
      this.pc.close();
    } catch (e) {}
    this.pc = null;
  };

  StationPublisher.prototype.onSignal = function (data) {
    if (!this.pc || !data) return;
    if (data.sdp) this.pc.setRemoteDescription(data.sdp);
    else if (data.candidate) this.pc.addIceCandidate(data.candidate);
  };

  /** Runs on the feed page (the clean output to the mixer). */
  function FeedReceiver(bridge, videoEl, options) {
    options = options || {};
    this.bridge = bridge;
    this.video = videoEl;
    this.onState = options.onState || function () {};
    this.onBlocked = options.onBlocked || function () {};
    this.target = null;
    this.pc = null;
    this.queuedCandidates = [];
  }

  FeedReceiver.prototype.handle = function (msg) {
    if (msg.type === 'feed_target') return this.setTarget(msg.station);
    if (msg.type === 'rtc_signal') return this.onSignal(msg.station, msg.data);
  };

  FeedReceiver.prototype.setTarget = function (station) {
    this.target = station;
    this.teardown();
    this.onState(station ? 'attesa ' + station : 'nero');
    if (station) this.createPeer();
  };

  FeedReceiver.prototype.createPeer = function () {
    var self = this;
    var pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;
    this.queuedCandidates = [];

    pc.onicecandidate = function (ev) {
      if (ev.candidate) {
        self.bridge.send({ type: 'rtc_signal', station: self.target, data: { candidate: ev.candidate } });
      }
    };

    pc.ontrack = function (ev) {
      if (self.video.srcObject !== ev.streams[0]) {
        self.video.srcObject = ev.streams[0];
        self.play();
      }
    };

    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed') {
        self.bridge.send({ type: 'feed_error', station: self.target, message: 'connessione WebRTC fallita' });
      }
    };
  };

  FeedReceiver.prototype.play = function () {
    var self = this;
    var attempt = this.video.play();
    if (!attempt || !attempt.catch) return;
    attempt.catch(function () {
      // Chromium blocks autoplay with sound without a user gesture or the
      // --autoplay-policy=no-user-gesture-required kiosk flag.
      self.onBlocked();
    });
  };

  FeedReceiver.prototype.onSignal = function (station, data) {
    var self = this;
    if (station !== this.target || !data) return;
    if (!this.pc) this.createPeer();
    var pc = this.pc;

    if (data.sdp) {
      pc.setRemoteDescription(data.sdp)
        .then(function () {
          self.queuedCandidates.forEach(function (c) {
            pc.addIceCandidate(c);
          });
          self.queuedCandidates = [];
          return pc.createAnswer();
        })
        .then(function (answer) {
          return pc.setLocalDescription(answer);
        })
        .then(function () {
          self.bridge.send({ type: 'rtc_signal', station: station, data: { sdp: pc.localDescription } });
        })
        .catch(function (e) {
          self.bridge.send({ type: 'feed_error', station: station, message: e.message });
        });
    } else if (data.candidate) {
      if (pc.remoteDescription && pc.remoteDescription.type) pc.addIceCandidate(data.candidate);
      else this.queuedCandidates.push(data.candidate);
    }
  };

  /** Called when the video element actually starts playing: this is the moment
   *  the feed is really carrying the station, and what the server waits for. */
  FeedReceiver.prototype.reportReady = function () {
    if (this.target) this.bridge.send({ type: 'feed_ready', station: this.target });
    this.onState('in onda ' + this.target);
  };

  FeedReceiver.prototype.teardown = function () {
    if (this.pc) {
      try {
        this.pc.close();
      } catch (e) {}
      this.pc = null;
    }
    this.video.srcObject = null;
    this.queuedCandidates = [];
  };

  window.StationPublisher = StationPublisher;
  window.FeedReceiver = FeedReceiver;
})();
