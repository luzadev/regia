/* Camera diagnostics: runs on the station computer and reports to the server,
 * so the result can be read in the control room log without copying anything. */
(function () {
  'use strict';

  var checks = document.getElementById('checks');
  var report = {
    host: location.host,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    at: new Date().toISOString(),
    items: {}
  };
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };

  function item(key, title) {
    var li = document.createElement('li');
    li.className = 'wait';
    li.innerHTML = '<div class="mark">…</div><div><b></b><span>in corso</span></div>';
    li.querySelector('b').textContent = title;
    checks.appendChild(li);
    return function (state, text, data) {
      li.className = state;
      li.querySelector('.mark').textContent = state === 'ok' ? '✓' : state === 'ko' ? '✗' : '!';
      li.querySelector('span').textContent = text;
      report.items[key] = { state: state, text: text, data: data === undefined ? null : data };
    };
  }

  function send() {
    return fetch('/api/diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report)
    })
      .then(function (r) {
        document.getElementById('sent').textContent = r.ok
          ? 'Risultato inviato alla regia (registro eventi).'
          : 'Invio alla regia non riuscito (HTTP ' + r.status + ').';
      })
      .catch(function () {
        document.getElementById('sent').textContent = 'Invio alla regia non riuscito: server non raggiungibile.';
      });
  }

  async function run() {
    var cfg = {};
    try {
      cfg = await (await fetch('/api/ui-config')).json();
    } catch (e) {}
    var videoName = cfg.webrtc_video_device || 'OBSBOT';
    var audioName = cfg.webrtc_audio_device || 'OBSBOT';

    var secure = item('secure', 'Connessione sicura');
    if (!window.isSecureContext || !navigator.mediaDevices) {
      secure('ko', 'Pagina aperta in ' + location.protocol + ': webcam e microfono sono bloccati. Serve https://');
      document.getElementById('ask').hidden = true;
      return send();
    }
    secure('ok', location.protocol + '//' + location.host);

    // 1) devices, by the names the stations are configured to use
    var devs = item('devices', 'Telecamera e microfono');
    var probe;
    try {
      probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      devs('ko', 'Permesso negato o dispositivo occupato: ' + e.name);
      document.getElementById('ask').hidden = true;
      return send();
    }
    probe.getTracks().forEach(function (t) {
      t.stop();
    });
    var list = await navigator.mediaDevices.enumerateDevices();
    var pick = function (kind, name) {
      return list.find(function (d) {
        return d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications' &&
          d.label.toLowerCase().indexOf(String(name).toLowerCase()) !== -1;
      });
    };
    var cam = pick('videoinput', videoName);
    var mic = pick('audioinput', audioName);
    var all = list.filter(function (d) {
      return d.kind !== 'audiooutput';
    }).map(function (d) {
      return d.kind + ': ' + d.label;
    });
    if (cam && mic) devs('ok', cam.label + ' · ' + mic.label, all);
    else devs(cam || mic ? 'warn' : 'ko',
      (cam ? cam.label : 'telecamera «' + videoName + '» non trovata') + ' · ' +
      (mic ? mic.label : 'microfono «' + audioName + '» non trovato'), all);

    // 2) video modes the camera really delivers
    var modes = item('modes', 'Risoluzioni disponibili');
    var results = [];
    var wanted = [[3840, 2160, 30], [1920, 1080, 60], [1920, 1080, 30], [1280, 720, 60], [1280, 720, 30]];
    for (var i = 0; i < wanted.length; i++) {
      var w = wanted[i];
      try {
        var m = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: cam ? { exact: cam.deviceId } : undefined, width: { exact: w[0] }, height: { exact: w[1] }, frameRate: { ideal: w[2] } }
        });
        var st = m.getVideoTracks()[0].getSettings();
        results.push(w[0] + 'x' + w[1] + '@' + Math.round(st.frameRate));
        m.getTracks().forEach(function (t) {
          t.stop();
        });
      } catch (e) {
        results.push(w[0] + 'x' + w[1] + '@' + w[2] + ' no');
      }
    }
    modes(results.some(function (r) { return /^1280x720/.test(r) && !/ no$/.test(r); }) ? 'ok' : 'warn', results.join(' · '), results);

    // 3) pan / tilt / zoom, which Chrome only reports when asked for explicitly
    var ptz = item('ptz', 'Movimenti PTZ dal browser');
    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: cam ? { exact: cam.deviceId } : undefined, pan: true, tilt: true, zoom: true }
      });
    } catch (e) {
      ptz('ko', 'Richiesta PTZ rifiutata: ' + e.name);
      document.getElementById('ask').hidden = true;
      return send();
    }
    document.getElementById('video').srcObject = stream;
    document.getElementById('ask').hidden = true;
    var track = stream.getVideoTracks()[0];
    var caps = track.getCapabilities();
    var perm = 'n/d';
    try {
      perm = (await navigator.permissions.query({ name: 'camera', panTiltZoom: true })).state;
    } catch (e) {}
    var exposed = ['pan', 'tilt', 'zoom'].filter(function (k) {
      return caps[k];
    });
    var data = { permission: perm, pan: caps.pan || null, tilt: caps.tilt || null, zoom: caps.zoom || null, moves: [] };

    if (!exposed.length) {
      ptz('ko', 'Chrome non espone pan, tilt e zoom su questo computer (permesso: ' + perm + ')', data);
      return send();
    }

    ptz('warn', 'Controlli presenti: ' + exposed.join(', ') + '. Ora la telecamera si muove per qualche secondo…', data);
    var start = track.getSettings();
    var move = async function (k, frac) {
      if (!caps[k]) return;
      var value = caps[k].min + (caps[k].max - caps[k].min) * frac;
      try {
        await track.applyConstraints({ advanced: [{ [k]: value }] });
        await sleep(1800);
        data.moves.push(k + ' ' + value.toFixed(1) + ' -> letto ' + track.getSettings()[k]);
      } catch (e) {
        data.moves.push(k + ' ERRORE ' + e.name);
      }
    };
    await move('pan', 0.3);
    await move('pan', 0.7);
    await move('tilt', 0.65);
    await move('zoom', 0.5);
    var back = {};
    exposed.forEach(function (k) {
      if (start[k] !== undefined) back[k] = start[k];
    });
    try {
      await track.applyConstraints({ advanced: [back] });
    } catch (e) {}

    var failed = data.moves.filter(function (x) {
      return /ERRORE/.test(x);
    }).length;
    ptz(failed ? 'warn' : 'ok',
      failed ? 'Controlli presenti ma ' + failed + ' movimenti rifiutati' : 'Pan, tilt e zoom comandabili dal browser (' + exposed.join(', ') + ')',
      data);
    document.getElementById('pad').hidden = false;

    document.querySelectorAll('button[data-k]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var k = b.dataset.k;
        if (!caps[k]) return;
        var now = track.getSettings()[k];
        var step = (caps[k].max - caps[k].min) / 12;
        try {
          await track.applyConstraints({ advanced: [{ [k]: Math.min(caps[k].max, Math.max(caps[k].min, now + step * Number(b.dataset.d))) }] });
        } catch (e) {}
      });
    });

    return send();
  }

  run();
})();
