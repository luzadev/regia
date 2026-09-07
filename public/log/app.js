/* History of interventions, rebuilt from the event log by the server. */
(function () {
  'use strict';

  var rowsEl = document.getElementById('rows');
  var totalsEl = document.getElementById('totals');

  function clock(seconds) {
    if (seconds === null || seconds === undefined) return '—';
    return formatClock(seconds);
  }

  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    var pad = function (n) {
      return (n < 10 ? '0' : '') + n;
    };
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function load() {
    fetch('/api/log?limit=300')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(render)
      .catch(function (e) {
        var b = document.getElementById('banner-error');
        b.hidden = false;
        b.textContent = 'Impossibile leggere la cronologia — ' + e.message;
      });
  }

  function render(data) {
    document.getElementById('banner-error').hidden = true;
    document.getElementById('count').textContent =
      data.interventions.length + ' interventi · ' + data.events + ' eventi nel log';
    document.getElementById('empty').hidden = data.interventions.length > 0;

    rowsEl.innerHTML = '';
    data.interventions.forEach(function (rec) {
      var tr = document.createElement('tr');

      var td1 = document.createElement('td');
      td1.className = 'when';
      td1.textContent = when(rec.start);

      var td2 = document.createElement('td');
      td2.textContent = rec.station;

      var td3 = document.createElement('td');
      td3.className = 'who';
      if (rec.name) td3.textContent = rec.name;
      else {
        td3.className = 'who anon';
        td3.textContent = 'senza nome';
      }
      if (rec.live || rec.interrupted) {
        var pill = document.createElement('span');
        pill.className = rec.live ? 'live-pill' : 'cut-pill';
        pill.textContent = rec.live ? 'IN ONDA' : 'INTERROTTO';
        pill.title = rec.live ? '' : 'Il server si è fermato prima della chiusura: durata non registrata';
        td3.appendChild(pill);
      }

      var td4 = document.createElement('td');
      td4.className = 'num';
      td4.textContent = rec.live || rec.interrupted ? '—' : clock(rec.duration_s);
      // Went past the countdown it was given: worth seeing at a glance.
      if (rec.countdown_s && rec.duration_s > rec.countdown_s) td4.className = 'num over';

      var td5 = document.createElement('td');
      td5.className = 'num';
      td5.textContent = rec.countdown_s ? clock(rec.countdown_s) : '—';

      [td1, td2, td3, td4, td5].forEach(function (td) {
        tr.appendChild(td);
      });
      rowsEl.appendChild(tr);
    });

    totalsEl.innerHTML = '';
    var longest = data.totals.reduce(function (m, t) {
      return Math.max(m, t.total_s);
    }, 0);
    data.totals.forEach(function (t) {
      var row = document.createElement('div');
      row.className = 'total-row';

      var who = document.createElement('div');
      who.className = 'who';
      var strong = document.createElement('strong');
      strong.textContent = t.name || t.station;
      var span = document.createElement('span');
      span.textContent = t.name ? t.station + ' · ' + t.count + ' interventi' : t.count + ' interventi';
      who.appendChild(strong);
      who.appendChild(span);

      var time = document.createElement('div');
      time.className = 'time';
      time.textContent = clock(t.total_s);

      var bar = document.createElement('div');
      bar.className = 'bar';
      var fill = document.createElement('i');
      fill.style.width = longest ? Math.round((t.total_s / longest) * 100) + '%' : '0%';
      bar.appendChild(fill);

      row.appendChild(who);
      row.appendChild(time);
      row.appendChild(bar);
      totalsEl.appendChild(row);
    });
  }

  document.getElementById('reload').addEventListener('click', load);
  load();
})();
