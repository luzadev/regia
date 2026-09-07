/* Control room dashboard. Every action is a command to the server; the page
 * renders only the last state_sync it received. */
(function () {
  'use strict';

  var bridge = new Bridge({
    role: 'control',
    onSync: render,
    onLink: onLink,
    onError: toast
  });

  var el = {
    bannerOffline: document.getElementById('banner-offline'),
    bannerDrivers: document.getElementById('banner-drivers'),
    bannerManual: document.getElementById('banner-manual'),
    manual: document.getElementById('manual-mode'),
    queue: document.getElementById('queue'),
    queueEmpty: document.getElementById('queue-empty'),
    grantNext: document.getElementById('btn-grant-next'),
    grantCountdown: document.getElementById('grant-countdown'),
    liveNone: document.getElementById('live-none'),
    liveBox: document.getElementById('live-box'),
    liveLabel: document.getElementById('live-label'),
    liveName: document.getElementById('live-name'),
    liveClock: document.getElementById('live-clock'),
    liveExpired: document.getElementById('live-expired'),
    presets: document.getElementById('presets'),
    close: document.getElementById('btn-close'),
    grid: document.getElementById('grid'),
    toast: document.getElementById('toast')
  };

  var presets = [30, 60, 120, 300];
  var cards = {};
  var toastTimer = null;

  // --- setup ------------------------------------------------------------

  fetch('/api/ui-config')
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      if (cfg.countdown_presets_s && cfg.countdown_presets_s.length) presets = cfg.countdown_presets_s;
      if (cfg.offline_timeout_ms) bridge.offlineMs = cfg.offline_timeout_ms;
      buildPresets();
    })
    .catch(buildPresets);

  function buildPresets() {
    el.grantCountdown.innerHTML = '';
    var none = document.createElement('option');
    none.value = '';
    none.textContent = 'Senza countdown';
    el.grantCountdown.appendChild(none);
    presets.forEach(function (s) {
      var o = document.createElement('option');
      o.value = String(s);
      o.textContent = formatClock(s);
      el.grantCountdown.appendChild(o);
    });

    el.presets.innerHTML = '';
    presets.forEach(function (s) {
      var b = document.createElement('button');
      b.textContent = formatClock(s);
      b.addEventListener('click', function () {
        var live = liveStation();
        if (live) bridge.send({ type: 'countdown_set', station: live.id, seconds: s });
      });
      el.presets.appendChild(b);
    });
  }

  function grantCountdown() {
    var v = el.grantCountdown.value;
    return v === '' ? null : Number(v);
  }

  el.grantNext.addEventListener('click', function () {
    bridge.send({ type: 'grant_next', countdown_s: grantCountdown() });
  });

  el.close.addEventListener('click', function () {
    var live = liveStation();
    if (live) bridge.send({ type: 'close', station: live.id });
  });

  document.querySelectorAll('.adjust button[data-delta]').forEach(function (b) {
    b.addEventListener('click', function () {
      var live = liveStation();
      if (live) bridge.send({ type: 'countdown_adjust', station: live.id, delta_s: Number(b.dataset.delta) });
    });
  });

  document.getElementById('btn-countdown-off').addEventListener('click', function () {
    var live = liveStation();
    if (live) bridge.send({ type: 'countdown_set', station: live.id, seconds: null });
  });

  el.manual.addEventListener('change', function () {
    bridge.send({ type: 'manual_mode', enabled: el.manual.checked });
  });

  // --- rendering --------------------------------------------------------

  function liveStation() {
    var snap = bridge.snapshot;
    if (!snap || !snap.live) return null;
    return bridge.stationOf(snap.live);
  }

  function onLink(up) {
    el.bannerOffline.hidden = up;
    render();
  }

  function render() {
    var snap = bridge.snapshot;
    if (!snap) return;

    el.bannerManual.hidden = !snap.manual_mode;
    if (document.activeElement !== el.manual) el.manual.checked = snap.manual_mode;

    var broken = [];
    for (var kind in snap.drivers) {
      if (snap.drivers[kind] && snap.drivers[kind].status === 'error') {
        broken.push(kind.toUpperCase() + ': ' + (snap.drivers[kind].message || 'errore'));
      }
    }
    el.bannerDrivers.hidden = broken.length === 0;
    el.bannerDrivers.textContent = 'DRIVER IN ERRORE — ' + broken.join(' · ');

    renderQueue(snap);
    renderLive();
    renderGrid(snap);
  }

  function renderQueue(snap) {
    var queue = snap.stations
      .filter(function (s) { return s.state === 'REQUESTED'; })
      .sort(function (a, b) { return a.requested_at - b.requested_at; });

    el.queue.innerHTML = '';
    el.queueEmpty.hidden = queue.length > 0;
    el.grantNext.disabled = queue.length === 0;

    queue.forEach(function (s, i) {
      var li = document.createElement('li');

      var pos = document.createElement('div');
      pos.className = 'pos';
      pos.textContent = String(i + 1);

      var who = document.createElement('div');
      who.className = 'who';
      var strong = document.createElement('strong');
      strong.textContent = s.name || s.label;
      var span = document.createElement('span');
      span.textContent = s.name ? s.label : 'senza nome';
      who.appendChild(strong);
      who.appendChild(span);

      var wait = document.createElement('div');
      wait.className = 'wait';
      wait.dataset.since = s.requested_at;
      wait.textContent = formatClock((bridge.serverNow() - s.requested_at) / 1000);

      var grant = document.createElement('button');
      grant.className = 'primary';
      grant.textContent = 'Autorizza';
      grant.addEventListener('click', function () {
        bridge.send({ type: 'grant', station: s.id, countdown_s: grantCountdown() });
      });

      var deny = document.createElement('button');
      deny.textContent = 'Nega';
      deny.addEventListener('click', function () {
        bridge.send({ type: 'deny', station: s.id });
      });

      li.appendChild(pos);
      li.appendChild(who);
      li.appendChild(wait);
      li.appendChild(grant);
      li.appendChild(deny);
      el.queue.appendChild(li);
    });
  }

  function renderLive() {
    var live = liveStation();
    el.liveBox.hidden = !live;
    el.liveNone.hidden = !!live;
    if (!live) return;

    el.liveLabel.textContent = live.label;
    el.liveName.textContent = live.name || '—';

    el.liveClock.classList.remove('warn', 'alert', 'over', 'blink');
    el.liveExpired.hidden = true;

    if (live.deadline === null) {
      el.liveClock.textContent = live.live_since
        ? formatClock((bridge.serverNow() - live.live_since) / 1000)
        : '--:--';
      return;
    }

    var remaining = (live.deadline - bridge.serverNow()) / 1000;
    var total = live.countdown_total_s || 1;
    var warn = total > 60 ? 60 : total * 0.5;
    var alert = total > 30 ? 30 : total * 0.25;

    el.liveClock.textContent = formatClock(remaining <= 0 ? Math.floor(remaining) : Math.ceil(remaining));
    if (remaining <= 0) {
      el.liveClock.classList.add('over', 'blink');
      el.liveExpired.hidden = false;
    } else if (remaining <= alert) {
      el.liveClock.classList.add('alert');
    } else if (remaining <= warn) {
      el.liveClock.classList.add('warn');
    }
  }

  function renderGrid(snap) {
    snap.stations.forEach(function (s) {
      var card = cards[s.id] || createCard(s);
      card.root.className = 'card ' + s.state.toLowerCase() + (s.connected ? '' : ' disconnected');
      card.state.className = 'badge ' + s.state.toLowerCase();
      card.state.textContent = s.state;
      card.link.className = 'badge ' + (s.connected ? 'idle' : 'offline');
      card.link.textContent = s.connected ? 'online' : 'offline';
      if (document.activeElement !== card.name) card.name.value = s.name || '';

      var isLive = s.state === 'LIVE';
      card.go.hidden = isLive;
      card.go.disabled = false;
      card.go.textContent = s.state === 'REQUESTED' ? 'Autorizza' : 'Forza in onda';
      card.stop.hidden = !isLive;
    });
  }

  function createCard(s) {
    var root = document.createElement('div');
    root.className = 'card';

    var head = document.createElement('div');
    head.className = 'head';
    var label = document.createElement('div');
    label.className = 'label';
    label.textContent = s.label;
    var badges = document.createElement('div');
    badges.className = 'badges';
    var state = document.createElement('span');
    var link = document.createElement('span');
    badges.appendChild(state);
    badges.appendChild(link);
    head.appendChild(label);
    head.appendChild(badges);

    var name = document.createElement('input');
    name.type = 'text';
    name.placeholder = 'Nome ospite';
    name.maxLength = 40;
    var nameTimer = null;
    function pushName() {
      bridge.send({ type: 'set_name', station: s.id, name: name.value });
    }
    name.addEventListener('input', function () {
      clearTimeout(nameTimer);
      nameTimer = setTimeout(pushName, 400);
    });
    name.addEventListener('blur', pushName);

    var actions = document.createElement('div');
    actions.className = 'actions';
    var go = document.createElement('button');
    go.className = 'primary';
    go.addEventListener('click', function () {
      bridge.send({ type: 'grant', station: s.id, countdown_s: grantCountdown() });
    });
    var stop = document.createElement('button');
    stop.className = 'danger';
    stop.textContent = 'Chiudi';
    stop.addEventListener('click', function () {
      bridge.send({ type: 'close', station: s.id });
    });
    actions.appendChild(go);
    actions.appendChild(stop);

    root.appendChild(head);
    root.appendChild(name);
    root.appendChild(actions);
    el.grid.appendChild(root);

    cards[s.id] = { root: root, state: state, link: link, name: name, go: go, stop: stop };
    return cards[s.id];
  }

  function toast(msg) {
    el.toast.textContent = msg.message || msg.code;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.hidden = true;
    }, 2500);
  }

  // Local ticking for waiting times and the live countdown.
  setInterval(function () {
    if (!bridge.snapshot) return;
    renderLive();
    el.queue.querySelectorAll('.wait').forEach(function (w) {
      w.textContent = formatClock((bridge.serverNow() - Number(w.dataset.since)) / 1000);
    });
  }, 500);

  bridge.start();
})();
