'use strict';

const $ = (id) => document.getElementById(id);
const api = window.regiaSetup;
let info = null;

function note(el, text, kind) {
  el.hidden = !text;
  el.textContent = text || '';
  el.className = 'note' + (kind ? ' ' + kind : '');
}

function renderStations(probe) {
  const box = $('stations');
  box.textContent = '';
  for (const s of probe.stations) {
    const b = document.createElement('button');
    const mine = info.pairing && info.pairing.station === s.id && info.pairing.host === probe.host;
    if (mine) b.classList.add('current');
    if (s.connected && !mine) b.classList.add('taken');
    const title = document.createElement('b');
    title.textContent = s.label;
    const sub = document.createElement('small');
    sub.textContent = s.id + (mine ? ' · questa' : s.connected ? ' · già collegata altrove' : '');
    b.append(title, sub);
    b.addEventListener('click', () => choose(s, b));
    box.append(b);
  }
}

let armed = null;
async function choose(station, button) {
  // A station already open on another computer is taken over by this one:
  // ask for a second tap instead of doing it silently.
  const taken = button.classList.contains('taken');
  if (taken && armed !== station.id) {
    armed = station.id;
    note($('save-msg'), `${station.label} risulta già collegata da un altro computer: tocca di nuovo per prenderla su questo.`, 'warn');
    return;
  }
  for (const b of $('stations').querySelectorAll('button')) b.disabled = true;
  note($('save-msg'), 'Salvo…');
  const r = await api.save(station.id);
  if (!r || !r.ok) {
    note($('save-msg'), (r && r.message) || 'Salvataggio non riuscito', 'err');
    for (const b of $('stations').querySelectorAll('button')) b.disabled = false;
  }
}

$('find').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('find-btn').disabled = true;
  $('trust').hidden = true;
  $('choose').hidden = true;
  armed = null;
  note($('find-msg'), 'Cerco il server…');
  const r = await api.probe($('address').value);
  $('find-btn').disabled = false;
  if (!r || !r.ok) return note($('find-msg'), (r && r.message) || 'Server non trovato', 'err');
  note($('find-msg'), `Trovato: ${r.scheme}://${r.host}:${r.port} · ${r.stations.length} poltrone`);
  $('trust').hidden = false;
  // Break lines between bytes, never inside one.
  $('fp').textContent = (r.fingerprint || '—').replace(/:/g, ':\u200b');
  $('fp').hidden = !r.fingerprint;
  $('http-warn').hidden = r.scheme === 'https';
  const changed = info.pairing && info.pairing.fingerprint && r.fingerprint && info.pairing.fingerprint !== r.fingerprint;
  if (changed) note($('save-msg'), 'Attenzione: l\'impronta è diversa da quella abbinata finora.', 'warn');
  else note($('save-msg'), '');
  $('choose').hidden = false;
  renderStations(r);
});

$('back').addEventListener('click', () => api.close());
$('quit').addEventListener('click', () => api.quit());

(async () => {
  info = await api.info();
  if (info.pairing) {
    $('address').value = info.pairing.port === 8080 ? info.pairing.host : `${info.pairing.host}:${info.pairing.port}`;
    $('back').hidden = false;
  }
  $('bridge').textContent = info.bridge.found
    ? `Telecamera: ponte OBSBOT trovato in ${info.bridge.found}`
    : `Telecamera: ponte OBSBOT non installato (copia ${info.bridge.file} e le DLL dell'SDK in ${info.bridge.dirs[0]}) · controlli PTZ disattivati`;
  $('address').focus();
})();
