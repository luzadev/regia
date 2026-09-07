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
  assert.deepEqual(station.sent.pop(), { type: 'feed_start' });
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
  assert.deepEqual(station.sent.pop(), { type: 'feed_start' });
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
  assert.deepEqual(station.sent, [{ type: 'feed_start' }]);
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

  assert.deepEqual(station.sent, [{ type: 'feed_stop' }]);
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

  assert.deepEqual(a.sent.pop(), { type: 'feed_stop' });
  assert.deepEqual(b.sent.pop(), { type: 'feed_start' });
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
  assert.deepEqual(station.sent.pop(), { type: 'rtc_signal', data: { sdp: 'answer' } });
});

test('the last receiver leaving clears the ready state', async () => {
  const feed = fakeSocket();
  const hub = makeHub({ stations: { 'post-01': fakeSocket() } });
  hub.addClient(feed);
  const pending = hub.setTarget('post-01');
  hub.markReady('post-01');
  await pending;

  hub.removeClient(feed);
  assert.deepEqual(hub.status(), { receivers: 0, target: 'post-01', ready: false, audio_blocked: false });
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
