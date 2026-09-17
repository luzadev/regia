'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const selfsigned = require('selfsigned');
const WebSocket = require('ws');

const pairing = require('../lib/pairing');
const { fingerprint, sameFingerprint, pemToDer, derToPem } = require('../../common/cert');
const { pinnedWsOptions } = require('../../../agent/camera-agent');

const STATE = { stations: [{ id: 'post-01', label: 'Poltrona 1', name: 'Rossi', connected: true, extra: 1 }] };

async function certificate() {
  return selfsigned.generate([{ name: 'commonName', value: 'Regia test' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }
    ]
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const handler = (req, res) => {
  if (req.url === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(STATE));
  } else {
    res.writeHead(404);
    res.end();
  }
};

test('addresses typed by a technician', () => {
  assert.deepEqual(pairing.parseAddress('192.168.10.10'), { host: '192.168.10.10', port: 8080 });
  assert.deepEqual(pairing.parseAddress(' 192.168.10.10:9000 '), { host: '192.168.10.10', port: 9000 });
  assert.deepEqual(pairing.parseAddress('https://regia.local:8080/regia/'), { host: 'regia.local', port: 8080 });
  assert.equal(pairing.parseAddress(''), null);
  assert.equal(pairing.parseAddress('http://:99999'), null);
});

test('urls and completeness', () => {
  const p = { host: '10.0.0.5', port: 8080, scheme: 'https', station: 'post-03', fingerprint: 'AA', pem: 'x' };
  assert.equal(pairing.stationUrl(p), 'https://10.0.0.5:8080/poltrona/?id=post-03');
  assert.equal(pairing.wsUrl(p), 'wss://10.0.0.5:8080/ws');
  assert.equal(pairing.wsUrl({ ...p, scheme: 'http' }), 'ws://10.0.0.5:8080/ws');
  assert.ok(pairing.isComplete(p));
  assert.ok(!pairing.isComplete({ ...p, fingerprint: null }), 'https without a pinned certificate is not usable');
  assert.ok(pairing.isComplete({ ...p, scheme: 'http', fingerprint: null, pem: null }));
  assert.ok(!pairing.isComplete({ ...p, station: 'Poltrona 3' }));
  assert.ok(!pairing.isComplete({}));
});

test('save and load round trip, missing file is empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regia-pair-'));
  const file = path.join(dir, 'sub', 'pairing.json');
  assert.deepEqual(pairing.load(file), {});
  const saved = pairing.save(file, { host: 'h', port: 1, scheme: 'https', station: 'post-01', fingerprint: 'F', pem: 'P', stations: [] });
  assert.equal(saved.stations, undefined, 'only the pairing is stored, not the probe');
  assert.deepEqual(pairing.load(file), saved);
});

test('certificate helpers', async () => {
  const pems = await certificate();
  const der = pemToDer(pems.cert);
  assert.equal(fingerprint(pems.cert), fingerprint(der));
  assert.equal(fingerprint(derToPem(der)), fingerprint(pems.cert));
  assert.ok(sameFingerprint(fingerprint(der), fingerprint(der).toLowerCase().replace(/:/g, '')));
  assert.ok(!sameFingerprint(null, null));
});

test('probe reads certificate and stations over https', async (t) => {
  const pems = await certificate();
  const server = https.createServer({ key: pems.private, cert: pems.cert }, handler);
  const port = await listen(server);
  t.after(() => server.close());

  const r = await pairing.probe(`127.0.0.1:${port}`);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.scheme, 'https');
  assert.equal(r.fingerprint, fingerprint(pems.cert));
  assert.deepEqual(r.stations, [{ id: 'post-01', label: 'Poltrona 1', name: 'Rossi', connected: true }]);
});

test('probe falls back to http and says so', async (t) => {
  const server = http.createServer(handler);
  const port = await listen(server);
  t.after(() => server.close());
  const r = await pairing.probe(`127.0.0.1:${port}`);
  assert.equal(r.ok, true);
  assert.equal(r.scheme, 'http');
  assert.equal(r.fingerprint, undefined);
});

test('probe: nothing listening, or not a Regia server', async (t) => {
  const closed = http.createServer();
  const port = await listen(closed);
  await new Promise((r) => closed.close(r));
  assert.equal((await pairing.probe(`127.0.0.1:${port}`, { timeout: 1000 })).ok, false);

  const other = http.createServer((req, res) => { res.writeHead(200); res.end('{"hello":1}'); });
  const port2 = await listen(other);
  t.after(() => other.close());
  const r = await pairing.probe(`127.0.0.1:${port2}`);
  assert.equal(r.ok, false);
  assert.match(r.message, /non sembra un server Regia/);
});

test('camera agent pinning: the paired certificate only, at any address', async (t) => {
  const pems = await certificate();
  const other = await certificate();
  const server = https.createServer({ key: pems.private, cert: pems.cert });
  const wss = new WebSocket.Server({ server });
  wss.on('connection', (ws) => ws.send('ciao'));
  const port = await listen(server);
  t.after(() => { wss.close(); server.close(); });

  const connect = (options, host = '127.0.0.1') => new Promise((resolve) => {
    const ws = new WebSocket(`wss://${host}:${port}`, options);
    ws.on('message', () => { ws.close(); resolve('ok'); });
    ws.on('error', (e) => resolve(e.message));
  });

  assert.equal(await connect(pinnedWsOptions(pems.cert, fingerprint(pems.cert))), 'ok');
  // "localhost" is not in the certificate: pinning does not care about names.
  assert.equal(await connect(pinnedWsOptions(pems.cert, fingerprint(pems.cert)), 'localhost'), 'ok');
  assert.match(await connect(pinnedWsOptions(pems.cert, fingerprint(other.cert))), /diverso da quello abbinato/);
  assert.notEqual(await connect(pinnedWsOptions(other.cert, fingerprint(other.cert))), 'ok', 'a server with another certificate is refused');
});
