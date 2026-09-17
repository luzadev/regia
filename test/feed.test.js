'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { FeedHub } = require('../server/feed');

const noopLog = { event() {} };

/** Minimal stand-in for a WebSocket that records what it was sent. */
function fakeSocket() {
  return {
    readyState: 1,
    OPEN: 1,
    sent: [],
    closedWith: null,
    send(raw) { this.sent.push(JSON.parse(raw)); },
    close(code, reason) { this.closedWith = { code, reason }; }
  };
}

function makeHub({ stations = {}, readyTimeoutMs = 100 } = {}) {
  const hub = new FeedHub({ log: noopLog, readyTimeoutMs });
  hub.stationSocket = (id) => stations[id] || null;
  return hub;
}

test('a receiver that connects mid-show is told what to display AND restarts the station', () => {
  const station = fakeSocket();
  const hub = makeHub({ stations: { 'post-01': station } });
  const feed = fakeSocket();
  hub.addClient(feed);
  hub.setTarget('post-01').catch(() => {}); // this test only cares about the side effects
  station.sent.length = 0;

  const late = fakeSocket();
  hub.addClient(late);

  assert.deepEqual(late.sent[0], { type: 'feed_target', station: 'post-01' });
  // Without this the offer is never re-created and the feed stays black for good.
  assert.deepEqual(station.sent.pop(), { type: 'feed_start', peer: 'feed' });
});

test('only one receiver at a time: the previous one is closed, not left fighting', () => {
  const hub = makeHub({ stations: { 'post-01': fakeSocket() } });
  const first = fakeSocket();
  const second = fakeSocket();
  hub.addClient(first);
  hub.addClient(second);

  assert.deepEqual(first.closedWith, { code: 4000, reason: 'replaced' });
  assert.equal(hub.status().receivers, 1);
});

test('publishing restarts when the camera shows up after the grant', async () => {
  const station = fakeSocket();
  const hub = makeHub({ stations: { 'post-01': station }, readyTimeoutMs: 60 });
  hub.addClient(fakeSocket());
  await assert.rejects(() => hub.setTarget('post-01'), /non ha confermato/);

  station.sent.length = 0;
  assert.equal(hub.restartPublishing('webcam disponibile'), true);
  assert.deepEqual(station.sent.pop(), { type: 'feed_start', peer: 'feed' });
  assert.equal(hub.status().ready, false);
});

test('restart does nothing without a target, a station or a receiver', () => {
  const station = fakeSocket();
  const hub = makeHub({ stations: { 'post-01': station } });
  assert.equal(hub.restartPublishing('nessun target'), false);

  hub.target = 'post-01';
  assert.equal(hub.restartPublishing('nessun ricevitore'), false, 'no receiver: nothing to renegotiate');

  hub.addClient(fakeSocket());
  hub.target = 'post-02';
  assert.equal(hub.restartPublishing('poltrona scollegata'), false, 'station not connected');
});

test('blocked feed audio is reported to the dashboard, never drawn on the feed', () => {
  const hub = makeHub();
  const feed = fakeSocket();
  hub.addClient(feed);

  assert.equal(hub.setAudioBlocked(true), true);
  assert.equal(hub.status().audio_blocked, true);
  assert.equal(hub.setAudioBlocked(true), false, 'no repeated broadcasts for the same state');

  hub.removeClient(feed);
  assert.equal(hub.status().audio_blocked, false, 'a gone receiver cannot still have blocked audio');
});

test('pointing the feed at a station starts it and resolves when the feed is playing', async () => {
  const station = fakeSocket();
  const feed = fakeSocket();
  const hub = makeHub({ stations: { 'post-01': station } });
  hub.addClient(feed);

  const pending = hub.setTarget('post-01');
  assert.deepEqual(station.sent, [{ type: 'feed_start', peer: 'feed' }]);
  assert.deepEqual(feed.sent.pop(), { type: 'feed_target', station: 'post-01' });

  hub.markReady('post-01');
  await pending;
  assert.equal(hub.status().ready, true);
});

test('without a feed receiver the switch fails loudly', async () => {
  const hub = makeHub({ stations: { 'post-01': fakeSocket() } });
  await assert.rejects(() => hub.setTarget('post-01'), /nessun ricevitore feed/);
});

test('a station that is not connected cannot be put on the feed', async () => {
  const hub = makeHub();
  hub.addClient(fakeSocket());
  await assert.rejects(() => hub.setTarget('post-01'), /non collegata/);
});

test('a feed that never confirms times out instead of hanging the sequence', async () => {
  const hub = makeHub({ stations: { 'post-01': fakeSocket() }, readyTimeoutMs: 60 });
  hub.addClient(fakeSocket());
  await assert.rejects(() => hub.setTarget('post-01'), /non ha confermato/);
});

test('going to black stops the previous station and needs no confirmation', async () => {
  const station = fakeSocket();
  const feed = fakeSocket();
  const hub = makeHub({ stations: { 'post-01': station } });
  hub.addClient(feed);

  const pending = hub.setTarget('post-01');
  hub.markReady('post-01');
  await pending;

  station.sent.length = 0;
  await hub.setTarget(null);

  assert.deepEqual(station.sent, [{ type: 'feed_stop', peer: 'feed' }]);
  assert.deepEqual(feed.sent.pop(), { type: 'feed_target', station: null });
  assert.equal(hub.status().target, null);
  assert.equal(hub.status().ready, false);
});

test('switching stations stops the outgoing one before starting the next', async () => {
  const a = fakeSocket();
  const b = fakeSocket();
  const hub = makeHub({ stations: { 'post-01': a, 'post-02': b } });
  hub.addClient(fakeSocket());

  const first = hub.setTarget('post-01');
  hub.markReady('post-01');
  await first;

  const second = hub.setTarget('post-02');
  hub.markReady('post-02');
  await second;

  assert.deepEqual(a.sent.pop(), { type: 'feed_stop', peer: 'feed' });
  assert.deepEqual(b.sent.pop(), { type: 'feed_start', peer: 'feed' });
});

test('only the station on the feed may exchange signalling', () => {
  const station = fakeSocket();
  const feed = fakeSocket();
  const hub = makeHub({ stations: { 'post-01': station, 'post-02': fakeSocket() } });
  hub.addClient(feed);
  hub.setTarget('post-01').catch(() => {}); // this test only cares about the relay guards

  assert.equal(hub.relayFromStation('post-02', { sdp: 'x' }), false, 'a station off air must not reach the feed');
  assert.equal(hub.relayToStation('post-02', { sdp: 'x' }), false);

  assert.equal(hub.relayFromStation('post-01', { sdp: 'offer' }), true);
  assert.deepEqual(feed.sent.pop(), { type: 'rtc_signal', station: 'post-01', data: { sdp: 'offer' } });

  assert.equal(hub.relayToStation('post-01', { sdp: 'answer' }), true);
  assert.deepEqual(station.sent.pop(), { type: 'rtc_signal', peer: 'feed', data: { sdp: 'answer' } });
});

test('the last receiver leaving clears the ready state', async () => {
  const feed = fakeSocket();
  const hub = makeHub({ stations: { 'post-01': fakeSocket() } });
  hub.addClient(feed);
  const pending = hub.setTarget('post-01');
  hub.markReady('post-01');
  await pending;

  hub.removeClient(feed);
  assert.deepEqual(hub.status(), { receivers: 0, monitors: 0, previews: 0, target: 'post-01', ready: false, audio_blocked: false });
});

test('a superseded switch rejects instead of leaving a promise pending forever', async () => {
  const hub = makeHub({ stations: { 'post-01': fakeSocket(), 'post-02': fakeSocket() }, readyTimeoutMs: 1000 });
  hub.addClient(fakeSocket());

  const first = hub.setTarget('post-01');
  const rejected = assert.rejects(() => first, /sostituito/);
  const second = hub.setTarget('post-02');
  hub.markReady('post-02');
  await second;
  await rejected;
});

test('a preview gets its own peer at reduced quality, without touching the feed', () => {
  const station = fakeSocket();
  const hub = makeHub({ stations: { 'post-01': station } });
  const feed = fakeSocket();
  hub.addClient(feed);
  hub.setTarget('post-01').catch(() => {});
  station.sent.length = 0;

  const dashboard = fakeSocket();
  const id = hub.addMonitor(dashboard);

  assert.equal(feed.closedWith, null, 'a preview must never kick the clean feed out');
  assert.deepEqual(dashboard.sent[0], { type: 'preview_mode', station: null }, 'a new dashboard follows the air');
  assert.deepEqual(dashboard.sent[1], { type: 'feed_target', station: 'post-01' });
  const start = station.sent.pop();
  assert.equal(start.type, 'feed_start');
  assert.equal(start.peer, id);
  assert.deepEqual(start.quality, { max_kbps: 600, scale: 2 }, 'a preview must not cost a second full encode');
  assert.equal(hub.status().monitors, 1);
  assert.equal(hub.status().receivers, 1);
});

test('a preview never makes the feed ready and never blocks the sequence', async () => {
  const station = fakeSocket();
  const hub = makeHub({ stations: { 'post-01': station }, readyTimeoutMs: 60 });
  hub.addClient(fakeSocket());
  hub.addMonitor(fakeSocket());

  // Only the clean feed's confirmation counts.
  await assert.rejects(() => hub.setTarget('post-01'), /non ha confermato/);
  assert.equal(hub.status().ready, false);
});

test('signalling is routed to the right receiver', () => {
  const station = fakeSocket();
  const feed = fakeSocket();
  const dashboard = fakeSocket();
  const hub = makeHub({ stations: { 'post-01': station } });
  hub.addClient(feed);
  hub.setTarget('post-01').catch(() => {});
  const id = hub.addMonitor(dashboard);
  feed.sent.length = 0;
  dashboard.sent.length = 0;

  hub.relayFromStation('post-01', { sdp: 'per-il-feed' }, 'feed');
  assert.deepEqual(feed.sent.pop().data, { sdp: 'per-il-feed' });
  assert.equal(dashboard.sent.length, 0, 'the preview must not see the feed negotiation');

  hub.relayFromStation('post-01', { sdp: 'per-l-anteprima' }, id);
  assert.deepEqual(dashboard.sent.pop().data, { sdp: 'per-l-anteprima' });

  station.sent.length = 0;
  hub.relayToStation('post-01', { sdp: 'risposta' }, id);
  assert.deepEqual(station.sent.pop(), { type: 'rtc_signal', peer: id, data: { sdp: 'risposta' } });

  assert.equal(hub.relayFromStation('post-01', { sdp: 'x' }, 'mon-999'), false, 'unknown peers are dropped');
});

test('closing the dashboard stops only its own peer', () => {
  const station = fakeSocket();
  const hub = makeHub({ stations: { 'post-01': station } });
  hub.addClient(fakeSocket());
  hub.setTarget('post-01').catch(() => {});
  const dashboard = fakeSocket();
  const id = hub.addMonitor(dashboard);
  station.sent.length = 0;

  hub.removeMonitor(dashboard);
  assert.deepEqual(station.sent, [{ type: 'feed_stop', peer: id }]);
  assert.equal(hub.status().monitors, 0);
  assert.equal(hub.status().target, 'post-01', 'the on-air station is unaffected');
});

test('switching station stops every peer, previews included', async () => {
  const a = fakeSocket();
  const b = fakeSocket();
  const hub = makeHub({ stations: { 'post-01': a, 'post-02': b } });
  hub.addClient(fakeSocket());
  const id = hub.addMonitor(fakeSocket());
  const first = hub.setTarget('post-01');
  hub.markReady('post-01');
  await first;
  a.sent.length = 0;

  const second = hub.setTarget('post-02');
  hub.markReady('post-02');
  await second;

  assert.deepEqual(a.sent.map((m) => m.peer).sort(), ['feed', id].sort());
  assert.ok(a.sent.every((m) => m.type === 'feed_stop'));
  assert.ok(b.sent.some((m) => m.type === 'feed_start' && m.peer === id), 'the preview follows the new station');
});

test('the preview runs even with no clean feed receiver: setup needs it most', async () => {
  const station = fakeSocket();
  const hub = makeHub({ stations: { 'post-01': station } });
  const dashboard = fakeSocket();
  const id = hub.addMonitor(dashboard);

  // No /feed/ page open: the switch fails, but the preview must still start.
  await assert.rejects(() => hub.setTarget('post-01'), /nessun ricevitore feed/);

  const start = station.sent.find((m) => m.type === 'feed_start' && m.peer === id);
  assert.ok(start, 'the station must be told to publish to the preview');
  assert.deepEqual(start.quality, { max_kbps: 600, scale: 2 });
});

// --- preview before going on air ------------------------------------------

/** Hub with a clean feed on air and one dashboard, ready for preview tests. */
function previewSetup({ live = 'post-01' } = {}) {
  const stations = { 'post-01': fakeSocket(), 'post-02': fakeSocket(), 'post-03': fakeSocket() };
  const hub = makeHub({ stations });
  const feed = fakeSocket();
  hub.addClient(feed);
  if (live) hub.setTarget(live).catch(() => {});
  const dashboard = fakeSocket();
  const id = hub.addMonitor(dashboard);
  for (const ws of [...Object.values(stations), feed, dashboard]) ws.sent.length = 0;
  return { hub, stations, feed, dashboard, id };
}

test('previewing a queued guest opens a reduced-quality peer to that station only', () => {
  const { hub, stations, dashboard, id } = previewSetup();

  assert.deepEqual(hub.setPreview(dashboard, 'post-02'), { ok: true });

  assert.deepEqual(stations['post-01'].sent, [{ type: 'feed_stop', peer: id }], 'the dashboard stops watching the air');
  assert.deepEqual(stations['post-02'].sent, [{ type: 'feed_start', peer: id, quality: { max_kbps: 600, scale: 2 } }]);
  assert.deepEqual(dashboard.sent, [
    { type: 'preview_mode', station: 'post-02' },
    { type: 'feed_target', station: 'post-02' }
  ]);
  assert.equal(hub.status().previews, 1);
});

test('a preview never touches the clean feed', () => {
  const { hub, feed, dashboard } = previewSetup();
  hub.setPreview(dashboard, 'post-02');
  assert.deepEqual(feed.sent, [], 'the mixer output does not even hear about it');
  assert.equal(hub.status().target, 'post-01');
});

test('a station being previewed may reach that dashboard, and nobody else', () => {
  const { hub, stations, feed, dashboard, id } = previewSetup();
  hub.setPreview(dashboard, 'post-02');
  dashboard.sent.length = 0;

  assert.equal(hub.relayFromStation('post-02', { sdp: 'offerta' }, id), true);
  assert.deepEqual(dashboard.sent.pop(), { type: 'rtc_signal', station: 'post-02', data: { sdp: 'offerta' } });

  // The previewed station is still not on air: it can never reach the feed.
  assert.equal(hub.relayFromStation('post-02', { sdp: 'x' }, 'feed'), false);
  assert.equal(hub.relayToStation('post-02', { sdp: 'x' }, 'feed'), false);
  assert.deepEqual(feed.sent, []);

  // A third station cannot hijack the dashboard's preview channel.
  assert.equal(hub.relayFromStation('post-03', { sdp: 'intruso' }, id), false);
  assert.equal(hub.relayToStation('post-03', { sdp: 'intruso' }, id), false);

  stations['post-02'].sent.length = 0;
  assert.equal(hub.relayToStation('post-02', { sdp: 'risposta' }, id), true);
  assert.deepEqual(stations['post-02'].sent.pop(), { type: 'rtc_signal', peer: id, data: { sdp: 'risposta' } });
});

test('putting the previewed guest on air keeps the same connection and follows the air', () => {
  const { hub, stations, dashboard, id } = previewSetup();
  hub.setPreview(dashboard, 'post-02');
  stations['post-02'].sent.length = 0;
  dashboard.sent.length = 0;

  hub.setTarget('post-02').catch(() => {});

  assert.ok(
    !stations['post-02'].sent.some((m) => m.peer === id),
    'the preview is already connected to this station: no restart, no flicker'
  );
  assert.deepEqual(dashboard.sent, [{ type: 'preview_mode', station: null }]);
  assert.equal(hub.status().previews, 0);
});

test('the air changing does not yank away a preview the operator chose', () => {
  const { hub, stations, dashboard, id } = previewSetup();
  hub.setPreview(dashboard, 'post-03');
  for (const ws of Object.values(stations)) ws.sent.length = 0;
  dashboard.sent.length = 0;

  hub.setTarget('post-02').catch(() => {});

  assert.ok(!stations['post-03'].sent.some((m) => m.peer === id), 'still watching post-03');
  assert.ok(!stations['post-02'].sent.some((m) => m.peer === id), 'not pulled to the new air');
  assert.ok(!dashboard.sent.some((m) => m.type === 'feed_target'));
});

test('closing the air does not stop a preview of another station', () => {
  const { hub, stations, dashboard, id } = previewSetup();
  hub.setPreview(dashboard, 'post-02');
  stations['post-02'].sent.length = 0;

  hub.setTarget(null);

  assert.deepEqual(stations['post-02'].sent, [], 'the guest in the queue is still visible after the close');
});

test('back to the air: the preview peer stops and the dashboard follows what is on air', () => {
  const { hub, stations, dashboard, id } = previewSetup();
  hub.setPreview(dashboard, 'post-02');
  for (const ws of Object.values(stations)) ws.sent.length = 0;
  dashboard.sent.length = 0;

  hub.setPreview(dashboard, null);

  assert.deepEqual(stations['post-02'].sent, [{ type: 'feed_stop', peer: id }]);
  assert.deepEqual(stations['post-01'].sent, [{ type: 'feed_start', peer: id, quality: { max_kbps: 600, scale: 2 } }]);
  assert.deepEqual(dashboard.sent, [
    { type: 'preview_mode', station: null },
    { type: 'feed_target', station: 'post-01' }
  ]);
});

test('previewing the station already on air is simply following the air', () => {
  const { hub, stations, dashboard } = previewSetup();
  assert.deepEqual(hub.setPreview(dashboard, 'post-01'), { ok: true });
  assert.equal(hub.status().previews, 0);
  assert.deepEqual(stations['post-01'].sent, [], 'nothing to renegotiate');
});

test('a preview of a station that is not connected says why it stays dark', () => {
  const { hub, dashboard } = previewSetup();
  const res = hub.setPreview(dashboard, 'post-09');
  assert.equal(res.ok, false);
  assert.match(res.reason, /non collegata/);
});

test('each dashboard previews on its own', () => {
  const { hub, stations } = previewSetup();
  const a = fakeSocket();
  const b = fakeSocket();
  const idA = hub.addMonitor(a);
  const idB = hub.addMonitor(b);
  hub.setPreview(a, 'post-02');
  hub.setPreview(b, 'post-03');

  assert.equal(hub.relayFromStation('post-02', { sdp: 'x' }, idA), true);
  assert.equal(hub.relayFromStation('post-02', { sdp: 'x' }, idB), false, 'B is watching post-03, not post-02');
  assert.equal(hub.status().previews, 2);
});

test('a previewed station that reconnects re-offers to its dashboard', () => {
  const { hub, stations, dashboard, id } = previewSetup();
  hub.setPreview(dashboard, 'post-02');
  stations['post-02'].sent.length = 0;

  assert.equal(hub.restartMonitorsFor('post-02'), 1);
  assert.deepEqual(stations['post-02'].sent, [{ type: 'feed_start', peer: id, quality: { max_kbps: 600, scale: 2 } }]);
});

test('a closed dashboard stops the peer on the station it was previewing', () => {
  const { hub, stations, dashboard, id } = previewSetup();
  hub.setPreview(dashboard, 'post-02');
  stations['post-02'].sent.length = 0;

  hub.removeMonitor(dashboard);
  assert.deepEqual(stations['post-02'].sent, [{ type: 'feed_stop', peer: id }]);
});
