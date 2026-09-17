'use strict';

/**
 * End-to-end checks of the video path against a real server process: the
 * signalling rules, the rigid open order and the dashboard preview. Stations,
 * feed and dashboard are plain WebSocket clients playing their part of the
 * protocol, so this runs anywhere without a camera or a browser.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for a condition instead of a fixed delay: the suite runs test files in
 * parallel, and a busy machine must not turn a correct server into a red test.
 */
async function until(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (check()) return true;
    } catch {
      /* not there yet */
    }
    await sleep(50);
  }
  return false;
}

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regia-it-'));
  const port = 18000 + Math.floor(Math.random() * 2000);
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  Object.assign(config, {
    http_port: port,
    bind_host: '127.0.0.1',
    tls: null,
    video_driver: 'webrtc',
    lights_driver: 'mock',
    relay_driver: 'mock',
    webrtc_ready_timeout_ms: 800,
    log_path: path.join(dir, 'events.jsonl'),
    names_path: path.join(dir, 'names.json')
  });
  config.stations = config.stations.slice(0, 3);
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));

  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, REGIA_CONFIG: configPath },
    stdio: 'ignore'
  });

  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ui-config`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  return { port, proc, stop: () => proc.kill('SIGKILL') };
}

/** A protocol client that records what it receives and can answer it. */
function client(port, hello, onMessage) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.snap = null;
    ws.events = [];
    ws.errors = [];
    ws.on('open', () => ws.send(JSON.stringify(hello)));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'state_sync') {
        ws.snap = m;
        if (!ws.ready) {
          ws.ready = true;
          resolve(ws);
        }
      } else if (m.type === 'error') ws.errors.push(m);
      else if (m.type !== 'heartbeat') ws.events.push(m);
      if (onMessage) onMessage(ws, m);
    });
  });
}

const send = (ws, payload) => ws.send(JSON.stringify(payload));
const stationIn = (ws, id) => ws.snap.stations.find((s) => s.id === id);

/** A station that answers every feed_start with an offer for that peer. */
function publishingStation(port, id, seen) {
  return client(port, { type: 'hello', role: 'station', station: id }, (ws, m) => {
    if (m.type === 'feed_start') {
      if (seen) seen.push({ type: 'feed_start', peer: m.peer || 'feed' });
      send(ws, { type: 'rtc_signal', peer: m.peer || 'feed', data: { sdp: { type: 'offer', sdp: 'v=0 prova' } } });
    }
    if (m.type === 'feed_stop' && seen) seen.push({ type: 'feed_stop', peer: m.peer || 'feed' });
    if (m.type === 'state_sync' && seen) {
      const me = m.stations.find((s) => s.id === id);
      const last = seen[seen.length - 1];
      if (me && me.state === 'LIVE' && !(last && last.type === 'live_view')) seen.push({ type: 'live_view' });
    }
  });
}

/** A feed page that answers any offer and confirms the stream is playing. */
function playingFeed(port, offers) {
  return client(port, { type: 'hello', role: 'feed' }, (ws, m) => {
    if (m.type === 'rtc_signal' && m.data && m.data.sdp) {
      if (offers) offers.push(m.station);
      send(ws, { type: 'rtc_signal', station: m.station, data: { sdp: { type: 'answer', sdp: 'v=0' } } });
      send(ws, { type: 'feed_ready', station: m.station });
    }
  });
}

test('video path: rigid order, pairing rules and recovery', { timeout: 30000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const { port } = server;

  const control = await client(port, { type: 'hello', role: 'control' });
  const seen1 = [];
  const s1 = await publishingStation(port, 'post-01', seen1);
  const s2 = await publishingStation(port, 'post-02');
  await sleep(200);

  await t.test('without a feed receiver the station still goes live, and the banner says why', async () => {
    send(control, { type: 'grant', station: 'post-01', countdown_s: 60 });
    await until(() => control.snap.drivers.video.status === 'error');
    assert.equal(stationIn(control, 'post-01').state, 'LIVE');
    assert.equal(control.snap.drivers.video.status, 'error');
    assert.equal(control.snap.feed.receivers, 0);
    send(control, { type: 'close', station: 'post-01' });
    await until(() => control.snap.live === null);
  });

  const offers = [];
  const feed = await playingFeed(port, offers);
  await until(() => control.snap.feed.receivers === 1);

  await t.test('the station sees "on air" only after the feed confirms the video', async () => {
    seen1.length = 0;
    send(control, { type: 'grant', station: 'post-01', countdown_s: 60 });
    await until(() => control.snap.feed.ready === true && control.snap.drivers.video.status === 'ok');
    const order = seen1.filter((e) => e.peer === 'feed' || e.type === 'live_view').map((e) => e.type);
    assert.deepEqual(order.slice(0, 2), ['feed_start', 'live_view']);
    assert.deepEqual(offers, ['post-01']);
    assert.equal(control.snap.feed.ready, true);
    assert.equal(control.snap.drivers.video.status, 'ok', 'a feed that recovers clears the banner');
  });

  await t.test('a station that is not on air cannot reach the feed', async () => {
    send(s2, { type: 'rtc_signal', peer: 'feed', data: { sdp: 'intruso' } });
    await until(() => s2.errors.some((e) => e.code === 'not_on_feed'));
    assert.ok(s2.errors.some((e) => e.code === 'not_on_feed'));
  });

  await t.test('switching station stops the outgoing one and the feed follows', async () => {
    seen1.length = 0;
    send(control, { type: 'grant', station: 'post-02' });
    await until(() => control.snap.feed.target === 'post-02' && seen1.some((e) => e.type === 'feed_stop'));
    assert.ok(seen1.some((e) => e.type === 'feed_stop' && e.peer === 'feed'));
    assert.equal(control.snap.feed.target, 'post-02');
    send(control, { type: 'close', station: 'post-02' });
    await until(() => control.snap.feed.target === null);
    assert.equal(control.snap.feed.target, null);
  });

  s1.close();
  s2.close();
  feed.close();
  control.close();
});

test('dashboard preview: see a queued guest without putting them on air', { timeout: 30000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const { port } = server;

  const control = await client(port, { type: 'hello', role: 'control' });
  const offersToFeed = [];
  const feed = await playingFeed(port, offersToFeed);
  const seen3 = [];
  const s3 = await publishingStation(port, 'post-03', seen3);

  const modes = [];
  const previewOffers = [];
  const monitor = await client(port, { type: 'hello', role: 'monitor' }, (ws, m) => {
    if (m.type === 'preview_mode') modes.push(m.station);
    if (m.type === 'rtc_signal' && m.data && m.data.sdp) {
      previewOffers.push(m.station);
      send(ws, { type: 'rtc_signal', station: m.station, data: { sdp: { type: 'answer', sdp: 'v=0' } } });
    }
  });
  await sleep(200);

  send(s3, { type: 'request_floor' });
  await until(() => stationIn(control, 'post-03').state === 'REQUESTED');

  await t.test('choosing a queued guest opens a preview to that station only', async () => {
    send(monitor, { type: 'preview', station: 'post-03' });
    await until(() => previewOffers.length === 1 && control.snap.feed.previews === 1);
    assert.deepEqual(modes[modes.length - 1], 'post-03');
    assert.ok(seen3.some((e) => e.type === 'feed_start' && /^mon-/.test(e.peer)), 'the station publishes to the dashboard');
    assert.deepEqual(previewOffers, ['post-03'], 'the dashboard receives the station offer');
    assert.equal(control.snap.feed.previews, 1);
  });

  await t.test('the guest stays off air and the clean feed never hears about it', async () => {
    assert.equal(stationIn(control, 'post-03').state, 'REQUESTED');
    assert.equal(control.snap.live, null);
    assert.equal(control.snap.feed.target, null);
    assert.deepEqual(offersToFeed, []);
  });

  await t.test('granting the previewed guest turns the preview into "follow the air"', async () => {
    send(control, { type: 'grant', station: 'post-03' });
    await until(() => control.snap.live === 'post-03' && offersToFeed.length === 1 && control.snap.feed.previews === 0);
    assert.equal(control.snap.live, 'post-03');
    assert.equal(modes[modes.length - 1], null);
    assert.equal(control.snap.feed.previews, 0);
    assert.deepEqual(offersToFeed, ['post-03'], 'the feed now receives the station, through its own peer');
  });

  await t.test('an unknown station cannot be previewed', async () => {
    send(monitor, { type: 'preview', station: 'post-99' });
    await until(() => monitor.errors.some((e) => e.code === 'unknown_station'));
    assert.ok(monitor.errors.some((e) => e.code === 'unknown_station'));
  });

  s3.close();
  feed.close();
  monitor.close();
  control.close();
});
