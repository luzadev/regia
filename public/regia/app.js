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
    bannerFeed: document.getElementById('banner-feed'),
    bannerAudio: document.getElementById('banner-audio'),
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
    liveCaption: document.getElementById('live-caption'),
    liveClock: document.getElementById('live-clock'),
    liveExpired: document.getElementById('live-expired'),
    presets: document.getElementById('presets'),
    close: document.getElementById('btn-close'),
    grid: document.getElementById('grid'),
    toast: document.getElementById('toast')
  };

  // The preview is a second connection with its own role: the clean feed keeps
  // its single receiver, and a preview problem never touches what is on air.
  var previewVideo = document.getElementById('preview');
  var previewBridge = new Bridge({
    role: 'monitor',
    onMessage: function (msg) {
      preview.handle(msg);
    },
    onLink: function (up) {
      if (!up) preview.setTarget(null);
    }
  });
  var preview = new FeedReceiver(previewBridge, previewVideo, { preview: true });

  var previewAudio = document.getElementById('preview-audio');
  previewAudio.addEventListener('click', function () {
    previewVideo.muted = !previewVideo.muted;
    previewAudio.textContent = previewVideo.muted ? 'AUDIO OFF' : 'AUDIO ON';
    previewAudio.classList.toggle('on', !previewVideo.muted);
    if (!previewVideo.muted) previewVideo.play().catch(function () {});
  });

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

  document.getElementById('btn-guide').addEventListener('click', function () {
    document.getElementById('guida').showModal();
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
    // While the link is down the page shows the last known state: freeze it and
    // block the controls, so nobody clicks Autorizza into a closed socket.
    document.body.classList.toggle('link-down', !up);
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

    // Without a feed receiver nothing can reach the mixer, whatever the queue says.
    el.bannerFeed.hidden = !snap.feed || snap.feed.receivers > 0;
    el.bannerAudio.hidden = !snap.feed || !snap.feed.audio_blocked;

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

    if (live.deadline === null) {
      // No countdown: show how long the intervention has been running instead.
      setClockClass('live-clock');
      el.liveExpired.hidden = true;
      el.liveCaption.textContent = 'IN ONDA DA';
      el.liveClock.textContent = live.live_since
        ? formatClock((bridge.serverNow() - live.live_since) / 1000)
        : '--:--';
      return;
    }
    el.liveCaption.textContent = 'TEMPO RESIDUO';

    var remaining = (live.deadline - bridge.serverNow()) / 1000;
    var total = live.countdown_total_s || 1;
    var warn = total > 60 ? 60 : total * 0.5;
    var alert = total > 30 ? 30 : total * 0.25;

    el.liveClock.textContent = formatClock(remaining <= 0 ? Math.floor(remaining) : Math.ceil(remaining));

    var cls = 'live-clock';
    if (remaining <= 0) cls += ' over blink';
    else if (remaining <= alert) cls += ' alert';
    else if (remaining <= warn) cls += ' warn';
    setClockClass(cls);
    if (el.liveExpired.hidden !== !(remaining <= 0)) el.liveExpired.hidden = !(remaining <= 0);
  }

  /** Rewriting the class every tick would restart the blink animation. */
  function setClockClass(cls) {
    if (el.liveClock.className !== cls) el.liveClock.className = cls;
  }

  function renderGrid(snap) {
    // Stations can now be added and removed while the show runs: drop the cards
    // of the ones that are gone before updating the rest.
    var present = {};
    snap.stations.forEach(function (s) {
      present[s.id] = true;
    });
    Object.keys(cards).forEach(function (id) {
      if (!present[id]) {
        cards[id].root.remove();
        delete cards[id];
      }
    });

    snap.stations.forEach(function (s) {
      var card = cards[s.id] || createCard(s);
      card.root.className = 'card ' + s.state.toLowerCase() + (s.connected ? '' : ' disconnected');
      card.state.className = 'badge ' + s.state.toLowerCase();
      card.state.textContent = s.state;
      card.link.className = 'badge ' + (s.connected ? 'idle' : 'offline');
      card.link.textContent = s.connected ? 'online' : 'offline';

      var media = s.media || {};
      card.cam.hidden = media.ok === null || media.ok === undefined;
      card.cam.className = 'badge ' + (media.ok ? 'cam-ok' : 'cam-ko');
      card.cam.textContent = media.ok ? 'cam' : 'cam ko';
      card.cam.title = media.message || '';
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
    var cam = document.createElement('span');
    cam.hidden = true;
    badges.appendChild(state);
    badges.appendChild(link);
    badges.appendChild(cam);
    head.appendChild(label);
    head.appendChild(badges);

    var idLink = document.createElement('a');
    idLink.className = 'id';
    idLink.textContent = s.id;
    idLink.href = '/poltrona/?id=' + encodeURIComponent(s.id);
    idLink.target = '_blank';
    idLink.rel = 'noopener';
    idLink.title = 'Apri la pagina di questa poltrona';

    // Two steps rather than a browser dialog: a modal in the control room
    // blocks everything else while someone is on air.
    var remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '\u00d7';
    remove.title = 'Rimuovi questa poltrona';
    var armed = null;
    remove.addEventListener('click', function () {
      if (armed) {
        clearTimeout(armed);
        armed = null;
        remove.classList.remove('confirm');
        remove.textContent = '\u00d7';
        bridge.send({ type: 'remove_station', station: s.id });
        return;
      }
      remove.classList.add('confirm');
      remove.textContent = 'Rimuovere?';
      armed = setTimeout(function () {
        armed = null;
        remove.classList.remove('confirm');
        remove.textContent = '\u00d7';
      }, 4000);
    });

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
    root.appendChild(idLink);
    root.appendChild(name);
    root.appendChild(actions);
    root.appendChild(remove);
    el.grid.appendChild(root);

    cards[s.id] = { root: root, state: state, link: link, cam: cam, name: name, go: go, stop: stop };
    return cards[s.id];
  }

  // --- adding a station -------------------------------------------------

  var addForm = document.getElementById('add-station');
  var addToggle = document.getElementById('btn-add-station');
  var newId = document.getElementById('new-id');
  var newLabel = document.getElementById('new-label');
  var newSegment = document.getElementById('new-segment');
  var newRelay = document.getElementById('new-relay');

  /** Suggests the next free id and label, so the common case is one click. */
  function suggestStation() {
    var snap = bridge.snapshot;
    var used = {};
    var highest = 0;
    if (snap) {
      snap.stations.forEach(function (s) {
        used[s.id] = true;
        var m = /^post-(\d+)$/.exec(s.id);
        if (m) highest = Math.max(highest, parseInt(m[1], 10));
      });
    }
    var n = highest + 1;
    while (used['post-' + (n < 10 ? '0' : '') + n]) n++;
    newId.value = 'post-' + (n < 10 ? '0' : '') + n;
    newLabel.value = 'Poltrona ' + n;
    newSegment.value = snap ? String(snap.stations.length) : '';
    newRelay.value = '';
  }

  addToggle.addEventListener('click', function () {
    var opening = addForm.hidden;
    addForm.hidden = !opening;
    addToggle.textContent = opening ? 'Chiudi' : '+ Aggiungi poltrona';
    if (opening) {
      suggestStation();
      newId.focus();
    }
  });

  document.getElementById('btn-add-cancel').addEventListener('click', function () {
    addForm.hidden = true;
    addToggle.textContent = '+ Aggiungi poltrona';
  });

  addForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var station = { id: newId.value.trim().toLowerCase(), label: newLabel.value.trim() };
    if (newSegment.value !== '') station.wled_segment = parseInt(newSegment.value, 10);
    if (newRelay.value.trim()) station.relay_url = newRelay.value.trim();
    bridge.send({ type: 'add_station', station: station });
    addForm.hidden = true;
    addToggle.textContent = '+ Aggiungi poltrona';
  });

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
    if (!bridge.snapshot || !bridge.online) return;
    renderLive();
    el.queue.querySelectorAll('.wait').forEach(function (w) {
      w.textContent = formatClock((bridge.serverNow() - Number(w.dataset.since)) / 1000);
    });
  }, 500);

  bridge.start();
  previewBridge.start();
})();
