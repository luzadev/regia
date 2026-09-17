'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const selfsigned = require('selfsigned');

const { ensureConfig, ensureCertificate, normalizePaths } = require('../lib/setup');
const { pickFeedDisplay, describe } = require('../lib/displays');
const { fingerprint } = require('../../common/cert');

const EXAMPLE = path.resolve(__dirname, '../../../config.example.json');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'regia-app-'));

test('first start: config.json in the data folder, WebRTC and HTTPS on, absolute paths', () => {
  const dir = tmp();
  const r = ensureConfig(dir, EXAMPLE);
  assert.equal(r.created, true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(onDisk, r.config);
  assert.equal(onDisk.video_driver, 'webrtc');
  assert.equal(onDisk.log_path, path.join(dir, 'data/events.jsonl'));
  assert.equal(onDisk.names_path, path.join(dir, 'data/names.json'));
  assert.deepEqual(onDisk.tls, { cert: path.join(dir, 'certs/server.crt'), key: path.join(dir, 'certs/server.key') });
  assert.ok(onDisk.stations.length > 0);

  const again = ensureConfig(dir, EXAMPLE);
  assert.equal(again.created, false);
  assert.deepEqual(again.config, r.config);
});

test('a config copied from a manual installation keeps its choices, paths become absolute', () => {
  const dir = tmp();
  const manual = { ...JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')), lights_driver: 'wled', tls: { cert: 'certs/server.crt', key: 'certs/server.key' } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(manual));
  const r = ensureConfig(dir, EXAMPLE);
  assert.equal(r.config.lights_driver, 'wled');
  assert.equal(r.config.tls.cert, path.join(dir, 'certs/server.crt'));
  assert.equal(JSON.parse(fs.readFileSync(r.file, 'utf8')).tls.key, path.join(dir, 'certs/server.key'));

  assert.equal(normalizePaths({ ...r.config }, dir).changed, false, 'already normalized');
  assert.equal(normalizePaths({ tls: null }, dir).config.tls, null, 'no TLS stays no TLS');
});

test('certificate: generated once, usable by an https server, pinned by fingerprint', async (t) => {
  const dir = tmp();
  const { config } = ensureConfig(dir, EXAMPLE);
  const first = await ensureCertificate(config, selfsigned, { hostname: 'regia-pc', ips: ['192.168.10.10'] });
  assert.equal(first.generated, true);
  assert.deepEqual(first.addresses, ['127.0.0.1', '192.168.10.10']);
  const pem = fs.readFileSync(config.tls.cert, 'utf8');
  const second = await ensureCertificate(config, selfsigned);
  assert.equal(second.generated, false, 'an existing certificate is never replaced: the stations are paired to it');
  assert.equal(fs.readFileSync(config.tls.cert, 'utf8'), pem);

  const srv = https.createServer({ cert: pem, key: fs.readFileSync(config.tls.key) }, (_q, res) => res.end('ok'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const seen = await new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: srv.address().port, ca: pem }, (res) => {
      resolve(fingerprint(res.socket.getPeerCertificate().raw));
      res.resume();
    }).on('error', reject);
  });
  assert.equal(seen, fingerprint(pem), 'trusted as its own authority for 127.0.0.1 (SAN present)');

  assert.deepEqual(await ensureCertificate({ tls: null }, selfsigned), { tls: false });
});

test('feed screen: the non-primary one, a chosen one while connected', () => {
  const main = { id: 1, label: 'Monitor regia', bounds: { width: 1920, height: 1080 } };
  const mixer = { id: 2, label: 'HDMI mixer', bounds: { width: 1920, height: 1080 } };
  const third = { id: 3, label: 'Terzo', bounds: { width: 1280, height: 720 } };

  assert.equal(pickFeedDisplay([main], 1, null), null, 'one screen: nowhere to put the feed');
  assert.equal(pickFeedDisplay([main, mixer], 1, null), mixer);
  assert.equal(pickFeedDisplay([main, mixer, third], 1, { id: 3, label: 'Terzo' }), third);
  assert.equal(pickFeedDisplay([main, mixer, { ...third, id: 9 }], 1, { id: 3, label: 'Terzo' }).id, 9, 'replugged: found by name');
  assert.equal(pickFeedDisplay([main, mixer], 1, { id: 3, label: 'Terzo' }), mixer, 'chosen one unplugged: automatic');
  assert.equal(pickFeedDisplay([main, mixer], 1, { id: 1, label: 'Monitor regia' }), main, 'the primary only if chosen');
  assert.equal(describe(mixer, 1, 1), 'HDMI mixer — 1920×1080');
  assert.equal(describe({ id: 1, bounds: { width: 800, height: 600 } }, 0, 1), 'Schermo 1 — 800×600 (principale)');
});
