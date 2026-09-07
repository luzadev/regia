/* Station page: renders only what the server says. The touch never decides. */
(function () {
  'use strict';

  var RING_R = 140;
  var RING_C = 2 * Math.PI * RING_R;

  var params = new URLSearchParams(location.search);
  var stationId = params.get('id');

  var views = {
    idle: document.getElementById('view-idle'),
    requested: document.getElementById('view-requested'),
    live: document.getElementById('view-live'),
    denied: document.getElementById('view-denied'),
    offline: document.getElementById('view-offline'),
    unknown: document.getElementById('view-unknown')
  };
  var ringFg = document.getElementById('ring-fg');
  var ringWrap = document.getElementById('ring-wrap');
  var clockEl = document.getElementById('clock');
  var expiredEl = document.getElementById('expired');
  var liveName = document.getElementById('live-name');

  ringFg.style.strokeDasharray = RING_C;
  ringFg.style.strokeDashoffset = 0;

  function show(name) {
    for (var key in views) views[key].hidden = key !== name;
  }

  if (!stationId) {
    document.getElementById('unknown-id').textContent = 'Manca il parametro ?id=';
    show('unknown');
    return;
  }

  var bridge = new Bridge({
    role: 'station',
    station: stationId,
    onSync: render,
    onLink: render,
    onError: function (msg) {
      if (msg.code === 'unknown_station') {
        document.getElementById('unknown-id').textContent = stationId;
        show('unknown');
      }
    }
  });

  document.getElementById('btn-request').addEventListener('click', function () {
    bridge.send({ type: 'request_floor' });
  });
  document.getElementById('btn-cancel').addEventListener('click', function () {
    bridge.send({ type: 'cancel_request' });
  });

  function render() {
    if (!bridge.online) return show('offline');
    var st = bridge.stationOf(stationId);
    if (!st) return show('offline');
    document.title = st.label + (st.name ? ' — ' + st.name : '');

    if (st.state === 'LIVE') {
      liveName.textContent = st.name || '';
      ringWrap.classList.toggle('hidden', st.deadline === null);
      show('live');
      renderCountdown(st);
    } else if (st.state === 'REQUESTED') {
      show('requested');
    } else if (st.state === 'DENIED') {
      show('denied');
    } else {
      show('idle');
    }
  }

  /** Thresholds are 60 s / 30 s, or 50% / 25% for countdowns shorter than that. */
  function thresholds(total) {
    return {
      warn: total > 60 ? 60 : total * 0.5,
      alert: total > 30 ? 30 : total * 0.25
    };
  }

  function renderCountdown(st) {
    if (st.deadline === null) return;
    var remaining = (st.deadline - bridge.serverNow()) / 1000;
    var total = st.countdown_total_s || 1;
    var th = thresholds(total);

    clockEl.textContent = formatClock(remaining <= 0 ? Math.floor(remaining) : Math.ceil(remaining));

    var frac = Math.max(0, Math.min(1, remaining / total));
    ringFg.style.strokeDashoffset = RING_C * (1 - frac);

    // Classes are only touched when the phase changes: rewriting them on every
    // tick would restart the colour transition and the blink animation.
    var ringCls = 'ring-fg';
    var clockCls = 'clock';
    var expired = false;

    if (remaining <= 0) {
      // Zero cuts nothing: it is signalling only (rule §2.2).
      ringCls += ' red blink';
      clockCls += ' red blink';
      expired = true;
    } else if (remaining <= th.alert) {
      ringCls += ' amber-deep';
    } else if (remaining <= th.warn) {
      ringCls += ' amber';
    }

    if (ringFg.getAttribute('class') !== ringCls) ringFg.setAttribute('class', ringCls);
    if (clockEl.className !== clockCls) clockEl.className = clockCls;
    if (expiredEl.hidden !== !expired) expiredEl.hidden = !expired;
  }

  // Local ticking: the server sends a deadline, not one message per second.
  setInterval(function () {
    if (!bridge.online) return;
    var st = bridge.stationOf(stationId);
    if (st && st.state === 'LIVE' && st.deadline !== null) renderCountdown(st);
  }, 200);

  bridge.start();
  show('offline');
})();
