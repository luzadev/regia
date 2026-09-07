/* Feed page: fullscreen on the control room's second HDMI output, into the
 * mixer. It shows the station the server points it at, and black otherwise. */
(function () {
  'use strict';

  var debug = new URLSearchParams(location.search).has('debug');
  var video = document.getElementById('feed');
  var unlock = document.getElementById('unlock');
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
    onBlocked: function () {
      unlock.hidden = false;
    }
  });

  // The server waits for this before telling the station it is on air.
  video.addEventListener('playing', function () {
    unlock.hidden = true;
    receiver.reportReady();
  });

  unlock.addEventListener('click', function () {
    unlock.hidden = true;
    video.play();
  });

  bridge.start();
  setStatus('avvio');
})();
