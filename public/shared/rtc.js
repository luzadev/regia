/* WebRTC media path: the station publishes webcam+microphone, the feed page
 * receives them and puts them on the clean HDMI output.
 *
 * Peers are on the same LAN, so there are no ICE servers at all: host
 * candidates only, no STUN, no TURN, nothing that touches the internet. */
(function () {
  'use strict';

  var RTC_CONFIG = { iceServers: [] };

  /**
   * Chrome's bandwidth estimator starts around 300 kbit/s and climbs over tens
   * of seconds, so the first shot on air is soft. On a dedicated LAN there is
   * nothing to be careful about: tell the encoder its floor, start and ceiling
   * directly in the SDP.
   *
   * Every edit stays INSIDE the video media section, and any problem falls back
   * to the original SDP - a soft picture is bad, a broken offer is worse.
   */
  function tuneVideoBitrate(sdp, minKbps, maxKbps) {
    try {
      var lines = sdp.split('\r\n');
      var codecPayloads = {};
      var hasFmtp = {};
      var inVideo = false;
      var i;

      // Pass 1: which payload types are real video codecs, and which already
      // carry an fmtp line. rtx/red/ulpfec must never be touched.
      for (i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('m=') === 0) inVideo = lines[i].indexOf('m=video') === 0;
        if (!inVideo) continue;
        var rtpmap = /^a=rtpmap:(\d+) ([A-Za-z0-9]+)\//.exec(lines[i]);
        if (rtpmap && /^(VP8|VP9|H264|AV1)$/i.test(rtpmap[2])) codecPayloads[rtpmap[1]] = true;
        var fmtp = /^a=fmtp:(\d+) /.exec(lines[i]);
        if (fmtp) hasFmtp[fmtp[1]] = true;
      }
      if (!Object.keys(codecPayloads).length) return sdp;

      var params =
        'x-google-start-bitrate=' + minKbps +
        ';x-google-min-bitrate=' + minKbps +
        ';x-google-max-bitrate=' + maxKbps;

      // Pass 2: rebuild, adding what is missing where it belongs.
      var out = [];
      inVideo = false;
      for (i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('m=') === 0) inVideo = line.indexOf('m=video') === 0;

        if (inVideo) {
          var existing = /^a=fmtp:(\d+) (.*)$/.exec(line);
          if (existing && codecPayloads[existing[1]]) {
            out.push('a=fmtp:' + existing[1] + ' ' + existing[2] + ';' + params);
            continue;
          }
        }

        out.push(line);

        if (!inVideo) continue;
        // b= belongs right after the c= line of its media section.
        if (line.indexOf('c=') === 0) out.push('b=AS:' + maxKbps);
        // A codec with no fmtp line at all gets one, right after its rtpmap.
        var map = /^a=rtpmap:(\d+) /.exec(line);
        if (map && codecPayloads[map[1]] && !hasFmtp[map[1]]) {
          out.push('a=fmtp:' + map[1] + ' ' + params);
        }
      }
      return out.join('\r\n');
    } catch (e) {
      return sdp;
    }
  }

  /** Runs on the station page. */
  function StationPublisher(bridge, options) {
    this.bridge = bridge;
    this.constraints = options.constraints;
    this.maxBitrateKbps = options.maxBitrateKbps || 4000;
    this.minBitrateKbps = options.minBitrateKbps || 1500;
    this.codec = options.codec || null;
    this.onStatus = options.onStatus || function () {};
    this.stream = null;
    this.peers = {}; // peer id -> RTCPeerConnection (the clean feed, plus previews)
    this.retryTimer = null;
  }

  StationPublisher.prototype.start = function () {
    var self = this;
    // Browsers only hand over camera and microphone in a secure context:
    // https, or http://localhost. Over plain http to an IP address the API is
    // not even defined, which looks like a broken page unless we say why.
    if (!window.isSecureContext) {
      return this.fail(
        'il browser blocca webcam e microfono su ' +
          location.protocol +
          '//' +
          location.host +
          ' — serve HTTPS (vedi README)'
      );
    }
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
    if (msg.type === 'feed_start') return this.openPeer(msg.peer || 'feed', msg.quality);
    if (msg.type === 'feed_stop') return this.closePeer(msg.peer || 'feed');
    if (msg.type === 'rtc_signal') return this.onSignal(msg.peer || 'feed', msg.data);
  };

  /**
   * `quality` is set for previews (the dashboard): a second full-resolution
   * encode would cost the mini PC as much as the on-air one for no reason.
   */
  StationPublisher.prototype.openPeer = function (peerId, quality) {
    var self = this;
    this.closePeer(peerId);
    if (!this.stream) {
      this.bridge.send({ type: 'media_status', ok: false, message: 'Nessun flusso da inviare' });
      return;
    }

    var maxKbps = quality && quality.max_kbps ? quality.max_kbps : this.maxBitrateKbps;
    var minKbps = quality && quality.max_kbps ? Math.round(quality.max_kbps / 2) : this.minBitrateKbps;
    var scale = quality && quality.scale ? quality.scale : 1;

    var pc = new RTCPeerConnection(RTC_CONFIG);
    this.peers[peerId] = pc;
    if (peerId === 'feed') window.regiaPeer = pc; // diagnostics: pc.getStats()

    this.stream.getTracks().forEach(function (track) {
      pc.addTrack(track, self.stream);
    });

    var videoSender = pc.getSenders().filter(function (s) {
      return s.track && s.track.kind === 'video';
    })[0];

    // Optional codec preference: H264 usually means hardware encoding on the
    // mini PCs, VP9/AV1 mean better quality per bit but more CPU.
    if (this.codec && videoSender && window.RTCRtpSender && RTCRtpSender.getCapabilities) {
      try {
        var wanted = 'video/' + this.codec.toLowerCase();
        var caps = RTCRtpSender.getCapabilities('video').codecs;
        var preferred = caps.filter(function (c) { return c.mimeType.toLowerCase() === wanted; });
        var others = caps.filter(function (c) { return c.mimeType.toLowerCase() !== wanted; });
        var transceiver = pc.getTransceivers().filter(function (t) { return t.sender === videoSender; })[0];
        if (preferred.length && transceiver && transceiver.setCodecPreferences) {
          transceiver.setCodecPreferences(preferred.concat(others));
        }
      } catch (e) {
        /* the browser keeps its own preference order */
      }
    }

    // WebRTC starts low and ramps up over a few seconds. On air that is a
    // visibly soft first shot, so ask for the target quality straight away and
    // keep resolution over frame rate when the network tightens.
    if (videoSender && videoSender.getParameters) {
      try {
        var params = videoSender.getParameters();
        params.degradationPreference = 'maintain-resolution';
        params.encodings = [{ maxBitrate: maxKbps * 1000, scaleResolutionDownBy: scale }];
        videoSender.setParameters(params);
      } catch (e) {
        /* older browsers: the defaults still work, just softer at the start */
      }
    }

    pc.onicecandidate = function (ev) {
      if (ev.candidate) {
        self.bridge.send({ type: 'rtc_signal', peer: peerId, data: { candidate: ev.candidate } });
      }
    };

    pc.createOffer()
      .then(function (offer) {
        offer.sdp = tuneVideoBitrate(offer.sdp, minKbps, maxKbps);
        return pc.setLocalDescription(offer);
      })
      .then(function () {
        self.bridge.send({ type: 'rtc_signal', peer: peerId, data: { sdp: pc.localDescription } });
      })
      .catch(function (e) {
        if (peerId === 'feed') {
          self.bridge.send({ type: 'media_status', ok: false, message: 'Offerta WebRTC fallita: ' + e.message });
        }
      });
  };

  StationPublisher.prototype.closePeer = function (peerId) {
    var pc = this.peers[peerId];
    if (!pc) return;
    try {
      pc.close();
    } catch (e) {}
    delete this.peers[peerId];
  };

  StationPublisher.prototype.closeAllPeers = function () {
    var self = this;
    Object.keys(this.peers).forEach(function (id) {
      self.closePeer(id);
    });
  };

  StationPublisher.prototype.onSignal = function (peerId, data) {
    var pc = this.peers[peerId];
    if (!pc || !data) return;
    if (data.sdp) pc.setRemoteDescription(data.sdp);
    else if (data.candidate) pc.addIceCandidate(data.candidate);
  };

  /** Runs on the feed page (the clean output to the mixer). */
  function FeedReceiver(bridge, videoEl, options) {
    options = options || {};
    this.bridge = bridge;
    this.video = videoEl;
    this.onState = options.onState || function () {};
    this.onAudioBlocked = options.onAudioBlocked || function () {};
    this.audioBlocked = false;
    // A preview never gates the on-air sequence and stays silent: the control
    // room does not need the guest's voice out of a second speaker.
    this.preview = options.preview === true;
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
    if (!this.preview) window.regiaPeer = pc; // diagnostics: pc.getStats()
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
      if (pc.connectionState === 'failed' && !self.preview) {
        self.bridge.send({ type: 'feed_error', station: self.target, message: 'connessione WebRTC fallita' });
      }
    };
  };

  FeedReceiver.prototype.play = function () {
    var self = this;
    if (this.preview) {
      this.video.muted = true;
      this.video.play().catch(function () {});
      return;
    }
    this.video.muted = false;
    var attempt = this.video.play();
    if (!attempt || !attempt.catch) return;
    attempt.catch(function () {
      // Chromium blocks autoplay with sound without a user gesture or the
      // --autoplay-policy=no-user-gesture-required kiosk flag. Going on air
      // silent beats not going on air, and NOTHING may be drawn on the clean
      // feed to say so - the mixer would put that text on the show. The
      // dashboard raises the alarm instead.
      self.video.muted = true;
      self.video.play().catch(function () {});
      self.audioBlocked = true;
      self.onAudioBlocked(true);
    });
  };

  /** Any interaction with the feed page is enough to release the audio. */
  FeedReceiver.prototype.unmute = function () {
    var self = this;
    if (!this.audioBlocked) return;
    this.video.muted = false;
    var attempt = this.video.play();
    if (attempt && attempt.then) {
      attempt
        .then(function () {
          self.audioBlocked = false;
          self.onAudioBlocked(false);
        })
        .catch(function () {
          self.video.muted = true;
        });
    } else {
      this.audioBlocked = false;
      this.onAudioBlocked(false);
    }
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
          if (!self.preview) self.bridge.send({ type: 'feed_error', station: station, message: e.message });
        });
    } else if (data.candidate) {
      if (pc.remoteDescription && pc.remoteDescription.type) pc.addIceCandidate(data.candidate);
      else this.queuedCandidates.push(data.candidate);
    }
  };

  /** Called when the video element actually starts playing: this is the moment
   *  the feed is really carrying the station, and what the server waits for. */
  FeedReceiver.prototype.reportReady = function () {
    if (this.target && !this.preview) this.bridge.send({ type: 'feed_ready', station: this.target });
    this.onState((this.preview ? 'anteprima ' : 'in onda ') + this.target);
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

  window.tuneVideoBitrate = tuneVideoBitrate; // exported for tests and diagnostics
  window.StationPublisher = StationPublisher;
  window.FeedReceiver = FeedReceiver;
})();
