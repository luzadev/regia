/* Settings page: reads and writes the light and relay configuration, and can
 * fire a light or a bar for a moment to find out which is which. */
(function () {
  'use strict';

  var el = function (id) {
    return document.getElementById(id);
  };

  var COLOR_ROWS = [
    { key: 'requested', title: 'Richiesta in attesa', hint: 'mentre l’ospite aspetta la regia' },
    { key: 'live', title: 'In onda', hint: 'la spia che conta' },
    { key: 'idle', title: 'A riposo', hint: 'spegne solo il segmento della poltrona' }
  ];
  var EFFECTS = [
    { value: 'solid', label: 'fisso' },
    { value: 'blink', label: 'lampeggiante' },
    { value: 'off', label: 'spento' }
  ];

  var settings = null;
  var dirtyStations = {};
  var toastTimer = null;
  var savedTimer = null;

  var bridge = new Bridge({
    role: 'control',
    onSync: renderDrivers,
    onLink: function (up) {
      el('banner-offline').hidden = up;
      document.body.classList.toggle('link-down', !up);
      if (up) bridge.send({ type: 'get_settings' });
    },
    onMessage: function (msg) {
      if (msg.type === 'settings') {
        settings = msg.settings;
        dirtyStations = {};
        render();
        markClean();
      }
    },
    onError: toast
  });

  // --- rendering ---------------------------------------------------------

  function hex(rgb) {
    return (
      '#' +
      (rgb || [0, 0, 0])
        .map(function (n) {
          return ('0' + Math.max(0, Math.min(255, n | 0)).toString(16)).slice(-2);
        })
        .join('')
    );
  }

  function rgb(hexValue) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hexValue || '');
    if (!m) return [0, 0, 0];
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function render() {
    if (!settings) return;
    el('lights-driver').value = settings.lights_driver || 'mock';
    el('relay-driver').value = settings.relay_driver || 'mock';
    el('driver-timeout').value = settings.driver_timeout_ms || 1500;
    el('wled-url').value = settings.wled_url || '';
    el('wled-path').value = settings.wled_state_path || '/json/state';
    el('fx-solid').value = (settings.wled_effects && settings.wled_effects.solid) || 0;
    el('fx-blink').value = (settings.wled_effects && settings.wled_effects.blink) || 1;
    el('relay-on').value = settings.relay_on_url || '{url}?turn=on';
    el('relay-off').value = settings.relay_off_url || '{url}?turn=off';
    el('relay-user').value = (settings.relay_auth && settings.relay_auth.user) || '';
    el('relay-pass').value = (settings.relay_auth && settings.relay_auth.password) || '';

    renderColors();
    renderStations();
  }

  function renderColors() {
    var box = el('colors');
    box.innerHTML = '';
    COLOR_ROWS.forEach(function (row) {
      var spec = (settings.colors && settings.colors[row.key]) || { rgb: [0, 0, 0], effect: 'off' };

      var wrap = document.createElement('div');
      wrap.className = 'color-row';

      var what = document.createElement('div');
      what.className = 'what';
      what.textContent = row.title;
      var hint = document.createElement('small');
      hint.textContent = row.hint;
      what.appendChild(hint);

      var color = document.createElement('input');
      color.type = 'color';
      color.value = hex(spec.rgb);
      color.dataset.key = row.key;
      color.addEventListener('input', markDirty);

      var effect = document.createElement('select');
      EFFECTS.forEach(function (e) {
        var o = document.createElement('option');
        o.value = e.value;
        o.textContent = e.label;
        effect.appendChild(o);
      });
      effect.value = spec.effect || 'solid';
      effect.dataset.key = row.key;
      effect.addEventListener('change', markDirty);

      var bri = document.createElement('input');
      bri.type = 'number';
      bri.min = 0;
      bri.max = 255;
      bri.value = Number.isInteger(spec.bri) ? spec.bri : 255;
      bri.title = 'Luminosità 0-255';
      bri.dataset.key = row.key;
      bri.addEventListener('input', markDirty);

      wrap.appendChild(what);
      wrap.appendChild(color);
      wrap.appendChild(effect);
      wrap.appendChild(bri);
      box.appendChild(wrap);
    });
  }

  function renderStations() {
    var body = el('stations');
    body.innerHTML = '';
    settings.stations.forEach(function (st) {
      var tr = document.createElement('tr');

      var who = document.createElement('td');
      who.className = 'who';
      var strong = document.createElement('strong');
      strong.textContent = st.label;
      var span = document.createElement('span');
      span.textContent = st.id;
      who.appendChild(strong);
      who.appendChild(span);

      var segCell = document.createElement('td');
      var seg = document.createElement('input');
      seg.type = 'number';
      seg.min = 0;
      seg.max = 99;
      seg.value = st.wled_segment === null ? '' : st.wled_segment;
      seg.placeholder = 'nessuno';
      seg.addEventListener('input', function () {
        dirtyStations[st.id] = true;
        markDirty();
      });
      segCell.appendChild(seg);

      var relayCell = document.createElement('td');
      var relay = document.createElement('input');
      relay.type = 'url';
      relay.value = st.relay_url || '';
      relay.placeholder = 'http://192.168.10.41/relay/0';
      relay.addEventListener('input', function () {
        dirtyStations[st.id] = true;
        markDirty();
      });
      relayCell.appendChild(relay);

      var testCell = document.createElement('td');
      var tests = document.createElement('div');
      tests.className = 'tests';
      tests.appendChild(testButton('Spia', function () {
        bridge.send({ type: 'test_light', station: st.id, color: 'live' });
      }));
      tests.appendChild(testButton('Barra', function () {
        bridge.send({ type: 'test_relay', station: st.id });
      }));
      testCell.appendChild(tests);

      tr.appendChild(who);
      tr.appendChild(segCell);
      tr.appendChild(relayCell);
      tr.appendChild(testCell);
      body.appendChild(tr);

      tr.dataset.id = st.id;
      tr.segInput = seg;
      tr.relayInput = relay;
    });
  }

  function testButton(label, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', function () {
      onClick();
      b.disabled = true;
      setTimeout(function () {
        b.disabled = false;
      }, 2600);
    });
    return b;
  }

  /** Driver health comes from the same state_sync the dashboard uses. */
  function renderDrivers(snap) {
    var broken = [];
    for (var kind in snap.drivers) {
      if (snap.drivers[kind] && snap.drivers[kind].status === 'error') {
        broken.push(kind.toUpperCase() + ': ' + (snap.drivers[kind].message || 'errore'));
      }
    }
    el('banner-drivers').hidden = broken.length === 0;
    el('banner-drivers').textContent = 'DRIVER IN ERRORE — ' + broken.join(' · ');
  }

  // --- saving ------------------------------------------------------------

  function markDirty() {
    el('save-hint').textContent = 'Modifiche non ancora salvate.';
    el('save-hint').classList.add('dirty');
  }

  function markClean() {
    el('save-hint').textContent = 'Scritte in config.json, applicate subito ai driver senza riavviare.';
    el('save-hint').classList.remove('dirty');
  }

  function collectColors() {
    var out = {};
    [].forEach.call(el('colors').children, function (row) {
      var key = row.querySelector('input[type="color"]').dataset.key;
      out[key] = {
        rgb: rgb(row.querySelector('input[type="color"]').value),
        effect: row.querySelector('select').value,
        bri: parseInt(row.querySelector('input[type="number"]').value, 10) || 0
      };
    });
    return out;
  }

  el('save').addEventListener('click', function () {
    bridge.send({
      type: 'set_settings',
      settings: {
        lights_driver: el('lights-driver').value,
        relay_driver: el('relay-driver').value,
        driver_timeout_ms: parseInt(el('driver-timeout').value, 10),
        wled_url: el('wled-url').value,
        wled_state_path: el('wled-path').value,
        wled_effects: {
          solid: parseInt(el('fx-solid').value, 10),
          blink: parseInt(el('fx-blink').value, 10)
        },
        relay_on_url: el('relay-on').value,
        relay_off_url: el('relay-off').value,
        relay_auth: el('relay-user').value ? { user: el('relay-user').value, password: el('relay-pass').value } : null,
        colors: collectColors()
      }
    });

    // Per-station fields go one by one: each is its own entry in config.json.
    [].forEach.call(el('stations').children, function (tr) {
      if (!dirtyStations[tr.dataset.id]) return;
      var seg = tr.segInput.value.trim();
      bridge.send({
        type: 'update_station',
        station: tr.dataset.id,
        wled_segment: seg === '' ? null : parseInt(seg, 10),
        relay_url: tr.relayInput.value.trim()
      });
    });

    el('banner-saved').hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(function () {
      el('banner-saved').hidden = true;
    }, 3000);
  });

  ['lights-driver', 'relay-driver', 'driver-timeout', 'wled-url', 'wled-path', 'fx-solid', 'fx-blink',
    'relay-on', 'relay-off', 'relay-user', 'relay-pass'].forEach(function (id) {
    el(id).addEventListener('input', markDirty);
  });

  function toast(msg) {
    el('toast').textContent = msg.message || msg.code;
    el('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el('toast').hidden = true;
    }, 3000);
  }

  var guide = document.getElementById('guide');
  el('btn-guide').addEventListener('click', function () {
    guide.showModal();
  });

  // Whoever opens this page for the first time is the one who needs the guide;
  // afterwards it stays one click away.
  try {
    if (!localStorage.getItem('regia.guida-impostazioni')) {
      guide.showModal();
      localStorage.setItem('regia.guida-impostazioni', '1');
    }
  } catch (e) {
    /* private window or storage disabled: the button is enough */
  }

  bridge.start();
})();
