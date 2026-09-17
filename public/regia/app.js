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
  // The station this dashboard is previewing, or null while it follows the air.
  var previewing = null;

  var previewBridge = new Bridge({
    role: 'monitor',
    onMessage: function (msg) {
      if (msg.type === 'preview_mode') {
        previewing = msg.station || null;
        render();
        return;
      }
      preview.handle(msg);
    },
    onLink: function (up) {
      if (!up) {
        preview.setTarget(null);
        // A reconnected monitor starts by following the air again.
        previewing = null;
      }
      render();
    },
    onError: toast
  });

  function watch(stationId) {
    previewBridge.send({ type: 'preview', station: stationId });
  }

  document.getElementById('preview-back').addEventListener('click', function () {
    watch(null);
  });

  // Camera moves go over the control connection, and only for the station being
  // previewed: the server refuses anything aimed at a station on air anyway.
  document.querySelectorAll('#camera-bar [data-dp]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!previewing) return;
      bridge.send({ type: 'camera_nudge', station: previewing, dpitch: Number(b.dataset.dp), dyaw: Number(b.dataset.dy) });
    });
  });
  document.querySelectorAll('#camera-bar [data-dz]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!previewing) return;
      bridge.send({ type: 'camera_zoom', station: previewing, dzoom: Number(b.dataset.dz) });
    });
  });
  document.querySelectorAll('#camera-bar [data-track]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (previewing) bridge.send({ type: 'camera_tracking', station: previewing, mode: b.dataset.track });
    });
  });
  // On air: first click arms, second click (within 4 s) confirms.
  var airArmed = null;
  var airTimer = null;
  function disarmAir() {
    airArmed = null;
    clearTimeout(airTimer);
    document.querySelectorAll('#air-tracking [data-air-track]').forEach(function (b) {
      b.classList.remove('confirm');
      b.textContent = b.dataset.label || b.textContent;
    });
  }
  document.querySelectorAll('#air-tracking [data-air-track]').forEach(function (b) {
    b.dataset.label = b.textContent;
    b.addEventListener('click', function () {
      var live = liveStation();
      if (!live || previewing) return;
      if (b.getAttribute('aria-checked') === 'true') return;
      if (airArmed === b.dataset.airTrack) {
        disarmAir();
        bridge.send({ type: 'camera_tracking', station: live.id, mode: b.dataset.airTrack, on_air: true });
        return;
      }
      disarmAir();
      airArmed = b.dataset.airTrack;
      b.classList.add('confirm');
      b.textContent = 'Confermi?';
      airTimer = setTimeout(disarmAir, 4000);
    });
  });

  document.getElementById('cam-save').addEventListener('click', function () {
    if (previewing) bridge.send({ type: 'camera_save_framing', station: previewing });
  });
  document.getElementById('cam-recall').addEventListener('click', function () {
    if (previewing) bridge.send({ type: 'camera_recall_framing', station: previewing });
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
    renderPreviewFrame(snap);
  }

  /** Makes it impossible to mistake a preview for what the mixer is receiving. */
  function renderPreviewFrame(snap) {
    var wrap = document.getElementById('preview-wrap');
    var tag = document.getElementById('preview-tag');
    var empty = document.getElementById('preview-empty');
    var back = document.getElementById('preview-back');
    var watched = previewing ? bridge.stationOf(previewing) : liveStation();

    wrap.classList.toggle('previewing', !!previewing);
    back.hidden = !previewing;

    if (previewing) {
      tag.className = 'preview-tag preview';
      tag.textContent = 'ANTEPRIMA · ' + (watched ? watched.name || watched.label : previewing) + ' · NON IN ONDA';
    } else {
      tag.className = 'preview-tag on-air';
      tag.textContent = watched ? 'IN ONDA · ' + (watched.name || watched.label) : 'IN ONDA';
    }

    if (!watched) {
      empty.hidden = false;
      empty.textContent = previewing ? 'Poltrona non disponibile' : 'Nessuna poltrona in onda';
    } else if (!watched.connected) {
      empty.hidden = false;
      empty.textContent = (watched.name || watched.label) + ' non è collegata';
    } else if (watched.media && watched.media.ok === false) {
      empty.hidden = false;
      empty.textContent = 'Webcam non disponibile su ' + (watched.name || watched.label);
    } else {
      empty.hidden = true;
    }
    tag.hidden = !watched && !previewing;
    renderCameraBar(previewing ? watched : null);
    renderAirTracking(previewing ? null : watched);
  }

  /** Framing mode for the station on air, when it has a camera agent. */
  function renderAirTracking(live) {
    var box = document.getElementById('air-tracking');
    var cam = live && live.camera;
    box.hidden = !live || live.state !== 'LIVE' || !cam || !cam.connected;
    if (box.hidden) {
      if (airArmed) disarmAir();
      return;
    }
    var tracking = live.tracking || 'off';
    var usable = cam.ok && !!cam.state;
    box.querySelectorAll('[data-air-track]').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.airTrack === tracking));
      b.disabled = !usable;
    });
  }

  function renderCameraBar(station) {
    var bar = document.getElementById('camera-bar');
    var hint = document.getElementById('camera-hint');
    var cam = station && station.camera;
    // Only a previewed station, not on air, with a camera agent connected.
    bar.hidden = !station || station.state === 'LIVE' || !cam || !cam.connected;
    // Previewing a station whose camera cannot be driven: say so, otherwise the
    // missing controls look like a fault.
    hint.hidden = !(station && station.state !== 'LIVE' && (!cam || !cam.connected));
    if (!hint.hidden) {
      hint.textContent = 'Comandi telecamera non disponibili per ' + (station.name || station.label) +
        ': nessun agente telecamera collegato su quella poltrona (app poltrona senza ponte OBSBOT, telecamera scollegata, o agente fermo: vedi logs\\agent.log sulla poltrona).';
    }
    if (bar.hidden) return;

    var info = document.getElementById('cam-info');
    var fmt = function (n, d) { return Number(n).toFixed(d).replace('.', ','); };
    var parts = [];
    if (cam.info) parts.push('<b>' + escapeHtml(cam.info.model) + '</b>');
    if (cam.ok && cam.state) {
      parts.push('pitch ' + fmt(cam.state.pitch, 1) + '° · yaw ' + fmt(cam.state.yaw, 1) + '° · zoom ' + fmt(cam.state.zoom, 2));
    } else {
      parts.push('telecamera non disponibile' + (cam.error ? ': ' + escapeHtml(cam.error) : ''));
    }
    var tracking = station.tracking || 'off';
    var labels = { normal: 'segue l\'ospite', upper: 'segue l\'ospite a mezzo busto', closeup: 'segue l\'ospite in primo piano' };
    if (tracking !== 'off') {
      // Manual moves would switch tracking off in the camera: say why they are unavailable.
      parts.push('<b>La telecamera ' + labels[tracking] + '</b>: scegli «Fissa» per muoverla a mano');
    } else {
      parts.push(station.framing ? 'inquadratura salvata' : 'nessuna inquadratura salvata');
    }
    info.innerHTML = parts.join('<br>');

    var usable = cam.ok && !!cam.state;
    bar.querySelectorAll('[data-track]').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.track === tracking));
      b.disabled = !usable;
    });
    bar.querySelectorAll('.cam-pad button, .cam-zoom button, #cam-save').forEach(function (b) {
      b.disabled = !usable || tracking !== 'off' || (b.id === 'cam-recall' && !station.framing);
    });
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
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

      var look = document.createElement('button');
      look.className = 'watch';
      look.textContent = previewing === s.id ? 'In anteprima' : 'Guarda';
      look.disabled = previewing === s.id;
      look.title = 'Vedi questo ospite prima di mandarlo in onda';
      look.addEventListener('click', function () {
        watch(s.id);
      });
      if (previewing === s.id) li.classList.add('previewing');

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
      li.appendChild(look);
      li.appendChild(grant);
      li.appendChild(deny);
      el.queue.appendChild(li);
    });
  }

  function renderLive() {
    var live = liveStation();
    el.liveBox.hidden = !live;
    el.liveNone.hidden = !!live || !!previewing;
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

      var camera = s.camera || {};
      card.ptz.hidden = !camera.connected;
      card.ptz.className = 'badge ' + (camera.ok ? 'ptz-ok' : 'ptz-ko');
      card.ptz.textContent = camera.ok ? 'ptz' : 'ptz ko';
      card.ptz.title = camera.ok
        ? (camera.info ? camera.info.model : 'telecamera comandabile') +
          (s.tracking && s.tracking !== 'off' ? ' · segue l\'ospite' : s.framing ? ' · inquadratura salvata' : '')
        : camera.error || 'agente collegato, telecamera non disponibile';

      var media = s.media || {};
      card.cam.hidden = media.ok === null || media.ok === undefined;
      card.cam.className = 'badge ' + (!media.ok ? 'cam-ko' : media.warning ? 'cam-warn' : 'cam-ok');
      card.cam.textContent = !media.ok ? 'cam ko' : media.warning ? 'cam !' : 'cam';
      var inUse = media.devices ? [media.devices.video, media.devices.audio].filter(Boolean).join(' · ') : '';
      card.cam.title = [media.message, media.warning, inUse].filter(Boolean).join('\n');
      if (document.activeElement !== card.name) card.name.value = s.name || '';

      var isLive = s.state === 'LIVE';
      card.root.classList.toggle('previewing', previewing === s.id);
      // Nothing to preview on the station already on air: the box shows it.
      card.look.hidden = isLive;
      card.look.disabled = previewing === s.id || !s.connected;
      card.look.textContent = previewing === s.id ? 'In anteprima' : 'Guarda';
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
    var ptz = document.createElement('span');
    ptz.hidden = true;
    badges.appendChild(state);
    badges.appendChild(link);
    badges.appendChild(cam);
    badges.appendChild(ptz);
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
    var look = document.createElement('button');
    look.className = 'watch';
    look.title = 'Vedi questa poltrona prima di mandarla in onda';
    look.addEventListener('click', function () {
      watch(s.id);
    });

    var stop = document.createElement('button');
    stop.className = 'danger';
    stop.textContent = 'Chiudi';
    stop.addEventListener('click', function () {
      bridge.send({ type: 'close', station: s.id });
    });
    actions.appendChild(look);
    actions.appendChild(go);
    actions.appendChild(stop);

    root.appendChild(head);
    root.appendChild(idLink);
    root.appendChild(name);
    root.appendChild(actions);
    root.appendChild(remove);
    el.grid.appendChild(root);

    cards[s.id] = { root: root, state: state, link: link, cam: cam, ptz: ptz, name: name, look: look, go: go, stop: stop };
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
