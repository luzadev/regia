'use strict';

/**
 * Station simulator: opens one WebSocket per station so the whole loop can be
 * tried without the mini PCs.
 *
 *   npm run sim                    # all stations from config, idle
 *   npm run sim -- --auto          # they also ask for the floor on their own
 *   npm run sim -- --stations post-02,post-05 --auto
 *   npm run sim -- --url ws://192.168.10.10:8080/ws
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
}
const auto = argv.includes('--auto');
const url = arg('--url', `ws://localhost:${config.http_port || 8080}/ws`);
const ids = arg('--stations', '')
  ? arg('--stations', '').split(',').map((s) => s.trim()).filter(Boolean)
  : config.stations.map((s) => s.id);

console.log(`[sim] ${ids.length} poltrone -> ${url}${auto ? ' (richieste automatiche)' : ''}`);

for (const id of ids) connect(id);

function connect(id) {
  const ws = new WebSocket(url);
  let state = null;
  let timer = null;

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', role: 'station', station: id }));
    console.log(`[sim] ${id} connessa`);
    if (auto) schedule();
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'error') return console.log(`[sim] ${id} errore: ${msg.code}`);
    if (msg.type !== 'state_sync') return;
    const me = msg.stations.find((s) => s.id === id);
    if (me && me.state !== state) {
      state = me.state;
      console.log(`[sim] ${id} -> ${state}`);
    }
  });

  ws.on('close', () => {
    clearTimeout(timer);
    console.log(`[sim] ${id} disconnessa, riprovo tra 2 s`);
    setTimeout(() => connect(id), 2000);
  });

  ws.on('error', (e) => console.log(`[sim] ${id} ws error: ${e.message}`));

  function schedule() {
    const delay = 5000 + Math.random() * 15000;
    timer = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN && state === 'IDLE') {
        console.log(`[sim] ${id} chiede la parola`);
        ws.send(JSON.stringify({ type: 'request_floor' }));
      }
      schedule();
    }, delay);
  }
}

process.on('SIGINT', () => {
  console.log('\n[sim] chiusura');
  process.exit(0);
});
