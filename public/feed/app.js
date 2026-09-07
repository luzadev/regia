/* Feed page: fullscreen on the control room's second HDMI output, into the
 * mixer. It shows the station the server points it at, and black otherwise. */
(function () {
  'use strict';

  var debug = new URLSearchParams(location.search).has('debug');
  var video = document.getElementById('feed');
  var status = document.getElementById('status');
  status.hidden = !debug;

  function setStatus(text) {
    if (debug) status.textContent = text;
  }

  var bridge = new Bridge({
    role: 'feed',
    onMessage: function (msg) {
      receiver.handle(msg);
    },
    onReplaced: function () {
      receiver.setTarget(null);
      setStatus('sostituito da un altro ricevitore feed');
    },
    onLink: function (up) {
      if (!up) {
        // The server is gone: black is the only safe thing to send to the mixer.
        receiver.setTarget(null);
        setStatus('server offline');
      }
    }
  });

  var receiver = new FeedReceiver(bridge, video, {
    onState: setStatus,
    onAudioBlocked: function (blocked) {
      // Reported to the control room, never drawn on the feed itself.
      bridge.send({ type: 'feed_audio', blocked: blocked });
      if (blocked) setStatus('audio bloccato dal browser: clicca sulla pagina');
    }
  });

  // The server waits for this before telling the station it is on air.
  video.addEventListener('playing', function () {
    receiver.reportReady();
  });

  ['click', 'keydown', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, function () {
      receiver.unmute();
    });
  });

  bridge.start();
  setStatus('avvio');
})();
