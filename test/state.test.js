'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Studio } = require('../server/state');

const CONFIG = {
  denied_duration_s: 5,
  countdown_default_s: null,
  stations: [
    { id: 'post-01', label: 'Poltrona 1' },
    { id: 'post-02', label: 'Poltrona 2' },
    { id: 'post-03', label: 'Poltrona 3' }
  ]
};

/** Studio with a controllable clock. */
function makeStudio(overrides = {}) {
  const clock = { t: 1_000_000 };
  const studio = new Studio({ ...CONFIG, ...overrides }, { now: () => clock.t, newId: () => 'iv-1' });
  return { studio, clock };
}

test('IDLE -> REQUESTED on request_floor', () => {
  const { studio, clock } = makeStudio();
  const res = studio.requestFloor('post-01');
  assert.equal(res.ok, true);
  assert.equal(studio.get('post-01').state, 'REQUESTED');
  assert.equal(studio.get('post-01').requested_at, clock.t);
});

test('debounce: a second request while REQUESTED is rejected and does not move the queue position', () => {
  const { studio, clock } = makeStudio();
  studio.requestFloor('post-01');
  const first = studio.get('post-01').requested_at;
  clock.t += 5000;
  const res = studio.requestFloor('post-01');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'already_active');
  assert.equal(studio.get('post-01').requested_at, first);
});

test('a LIVE station cannot request the floor again', () => {
  const { studio } = makeStudio();
  studio.grant('post-01');
  assert.equal(studio.requestFloor('post-01').code, 'already_active');
});

test('guest cancel brings REQUESTED back to IDLE', () => {
  const { studio } = makeStudio();
  studio.requestFloor('post-01');
  assert.equal(studio.cancelRequest('post-01').ok, true);
  assert.equal(studio.get('post-01').state, 'IDLE');
  assert.equal(studio.cancelRequest('post-01').code, 'not_requested');
});

test('deny -> DENIED, then back to IDLE after denied_duration_s', () => {
  const { studio, clock } = makeStudio();
  studio.requestFloor('post-01');
  studio.deny('post-01');
  assert.equal(studio.get('post-01').state, 'DENIED');

  clock.t += 4000;
  assert.equal(studio.tick(), false);
  assert.equal(studio.get('post-01').state, 'DENIED');

  clock.t += 1500;
  assert.equal(studio.tick(), true);
  assert.equal(studio.get('post-01').state, 'IDLE');
  assert.equal(studio.get('post-01').denied_until, null);
});

test('requests are ignored during the DENIED cooldown', () => {
  const { studio } = makeStudio();
  studio.requestFloor('post-01');
  studio.deny('post-01');
  assert.equal(studio.requestFloor('post-01').code, 'denied_cooldown');
});

test('deny only applies to a pending request', () => {
  const { studio } = makeStudio();
  assert.equal(studio.deny('post-01').code, 'not_requested');
  studio.grant('post-02');
  assert.equal(studio.deny('post-02').code, 'not_requested');
});

test('grant moves REQUESTED -> LIVE and plans the open sequence', () => {
  const { studio } = makeStudio();
  studio.requestFloor('post-01');
  const res = studio.grant('post-01', 120);
  assert.equal(res.ok, true);
  assert.deepEqual(res.plan.map((s) => s.op), ['open']);
  assert.equal(studio.get('post-01').state, 'LIVE');
  assert.equal(studio.get('post-01').countdown_total_s, 120);
});

test('grant is allowed from IDLE (forza in onda)', () => {
  const { studio } = makeStudio();
  const res = studio.grant('post-03');
  assert.equal(res.ok, true);
  assert.equal(studio.get('post-03').state, 'LIVE');
});

test('single LIVE constraint: granting B closes A first, in order', () => {
  const { studio } = makeStudio();
  studio.grant('post-01', 60);
  studio.requestFloor('post-02');
  const res = studio.grant('post-02', 60);

  assert.deepEqual(res.plan.map((s) => s.op), ['close', 'open']);
  assert.equal(res.plan[0].id, 'post-01');
  assert.equal(res.plan[1].id, 'post-02');
  assert.equal(studio.get('post-01').state, 'IDLE');
  assert.equal(studio.get('post-02').state, 'LIVE');
  assert.equal(studio.list().filter((s) => s.state === 'LIVE').length, 1);
});

test('the closed station does not go back into the queue', () => {
  const { studio } = makeStudio();
  studio.requestFloor('post-01');
  studio.grant('post-01');
  studio.grant('post-02');
  assert.deepEqual(studio.queue().map((s) => s.id), []);
});

test('granting an already LIVE station is rejected', () => {
  const { studio } = makeStudio();
  studio.grant('post-01');
  assert.equal(studio.grant('post-01').code, 'already_live');
});

test('close is the only way out of LIVE and reports the duration', () => {
  const { studio, clock } = makeStudio();
  studio.grant('post-01', 60);
  clock.t += 90_000;
  const res = studio.close('post-01');
  assert.equal(res.ok, true);
  assert.equal(res.plan[0].op, 'close');
  assert.equal(res.plan[0].duration_s, 90);
  assert.equal(res.plan[0].intervention_id, 'iv-1');
  assert.equal(studio.get('post-01').state, 'IDLE');
  assert.equal(studio.get('post-01').deadline, null);
});

test('close on a station that is not live is rejected', () => {
  const { studio } = makeStudio();
  assert.equal(studio.close('post-01').code, 'not_live');
});

test('the countdown never closes an intervention: it only goes negative', () => {
  const { studio, clock } = makeStudio();
  studio.grant('post-01', 30);
  clock.t += 120_000;
  assert.equal(studio.tick(), false);
  assert.equal(studio.get('post-01').state, 'LIVE');
  assert.ok(studio.get('post-01').deadline < clock.t);
});

test('grant without countdown_s uses countdown_default_s', () => {
  const noCountdown = makeStudio();
  noCountdown.studio.grant('post-01');
  assert.equal(noCountdown.studio.get('post-01').deadline, null);

  const withDefault = makeStudio({ countdown_default_s: 90 });
  withDefault.studio.grant('post-01');
  assert.equal(withDefault.studio.get('post-01').countdown_total_s, 90);
  assert.equal(withDefault.studio.get('post-01').deadline, withDefault.clock.t + 90_000);
});

test('countdown_set is absolute and only applies to a LIVE station', () => {
  const { studio, clock } = makeStudio();
  assert.equal(studio.countdownSet('post-01', 60).code, 'not_live');
  studio.grant('post-01', 30);
  studio.countdownSet('post-01', 300);
  assert.equal(studio.get('post-01').deadline, clock.t + 300_000);
  assert.equal(studio.get('post-01').countdown_total_s, 300);
});

test('countdown_adjust accumulates: two +30 s add a minute', () => {
  const { studio, clock } = makeStudio();
  studio.grant('post-01', 60);
  clock.t += 10_000; // 50 s left
  studio.countdownAdjust('post-01', 30);
  studio.countdownAdjust('post-01', 30);
  assert.equal(Math.round((studio.get('post-01').deadline - clock.t) / 1000), 110);
  assert.equal(studio.get('post-01').countdown_total_s, 110);
});

test('countdown_adjust downwards stops at zero without closing', () => {
  const { studio, clock } = makeStudio();
  studio.grant('post-01', 20);
  studio.countdownAdjust('post-01', -30);
  assert.equal(studio.get('post-01').deadline, clock.t);
  assert.equal(studio.get('post-01').state, 'LIVE');
});

test('queue is FIFO by request time and grant_next takes the oldest', () => {
  const { studio, clock } = makeStudio();
  studio.requestFloor('post-02');
  clock.t += 1000;
  studio.requestFloor('post-03');
  clock.t += 1000;
  studio.requestFloor('post-01');
  assert.deepEqual(studio.queue().map((s) => s.id), ['post-02', 'post-03', 'post-01']);

  studio.grantNext(60);
  assert.equal(studio.get('post-02').state, 'LIVE');
  assert.deepEqual(studio.queue().map((s) => s.id), ['post-03', 'post-01']);
});

test('grant_next on an empty queue is rejected', () => {
  const { studio } = makeStudio();
  assert.equal(studio.grantNext().code, 'empty_queue');
});

test('connected is orthogonal: dropping while REQUESTED keeps the place in queue', () => {
  const { studio } = makeStudio();
  studio.setConnected('post-01', true);
  studio.requestFloor('post-01');
  assert.equal(studio.setConnected('post-01', false), true);
  assert.equal(studio.get('post-01').state, 'REQUESTED');
  assert.deepEqual(studio.queue().map((s) => s.id), ['post-01']);
});

test('a LIVE station that drops stays LIVE: nothing goes off air by itself', () => {
  const { studio } = makeStudio();
  studio.setConnected('post-01', true);
  studio.grant('post-01', 60);
  studio.setConnected('post-01', false);
  assert.equal(studio.get('post-01').state, 'LIVE');
  assert.equal(studio.liveStation().id, 'post-01');
});

test('unknown stations are rejected, never created', () => {
  const { studio } = makeStudio();
  assert.equal(studio.requestFloor('post-99').code, 'unknown_station');
  assert.equal(studio.grant('post-99').code, 'unknown_station');
  assert.equal(studio.list().length, 3);
});

test('names are trimmed and capped', () => {
  const { studio } = makeStudio();
  studio.setName('post-01', '   Rossi   ');
  assert.equal(studio.get('post-01').name, 'Rossi');
  studio.setName('post-01', 'x'.repeat(80));
  assert.equal(studio.get('post-01').name.length, 40);
});

test('snapshot is the full documented state and hides internals', () => {
  const { studio, clock } = makeStudio();
  studio.setName('post-01', 'Rossi');
  studio.requestFloor('post-01');
  studio.grant('post-01', 60);
  const snap = studio.snapshot({ video: { status: 'ok' } });

  assert.equal(snap.type, 'state_sync');
  assert.equal(snap.server_t, clock.t);
  assert.equal(snap.live, 'post-01');
  assert.equal(snap.manual_mode, false);
  assert.deepEqual(snap.drivers, { video: { status: 'ok' } });
  assert.equal(snap.stations.length, 3);
  assert.deepEqual(Object.keys(snap.stations[0]).sort(), [
    'camera', 'connected', 'countdown_total_s', 'deadline', 'denied_until', 'framing', 'id',
    'label', 'live_since', 'media', 'name', 'requested_at', 'state', 'tracking'
  ]);
});

test('manual mode is a flag, not a state change', () => {
  const { studio } = makeStudio();
  studio.grant('post-01', 60);
  const res = studio.setManualMode(true);
  assert.equal(res.changed, true);
  assert.equal(studio.manualMode, true);
  assert.equal(studio.get('post-01').state, 'LIVE');
  assert.equal(studio.setManualMode(true).changed, false);
});

test('media status is reported per station and cleared when it disconnects', () => {
  const { studio } = makeStudio();
  const empty = { ok: null, message: null, warning: null, devices: null };
  studio.setConnected('post-01', true);
  assert.deepEqual(studio.get('post-01').media, empty);

  studio.setMedia('post-01', true);
  assert.deepEqual(studio.get('post-01').media, { ok: true, message: null, warning: null, devices: null });

  studio.setMedia('post-01', false, 'Permesso negato');
  assert.equal(studio.get('post-01').media.ok, false);
  assert.equal(studio.get('post-01').media.message, 'Permesso negato');

  // A station that is gone tells us nothing about its camera any more.
  studio.setConnected('post-01', false);
  assert.deepEqual(studio.get('post-01').media, empty);
  assert.equal(studio.setMedia('post-99', true).code, 'unknown_station');
});

test('a working station can still warn that it is not using the devices asked for', () => {
  const { studio } = makeStudio();
  studio.setMedia('post-01', true, null, {
    warning: 'microfono «OBSBOT» non trovato, uso il predefinito',
    devices: { video: 'OBSBOT Tiny 2 Lite StreamCamera', audio: 'Microfono MacBook Pro' }
  });
  const media = studio.get('post-01').media;
  assert.equal(media.ok, true, 'a warning does not take the station off air');
  assert.match(media.warning, /non trovato/);
  assert.deepEqual(media.devices, { video: 'OBSBOT Tiny 2 Lite StreamCamera', audio: 'Microfono MacBook Pro' });
});

test('snapshot carries the feed status for the dashboard', () => {
  const { studio } = makeStudio();
  const feed = { receivers: 1, target: 'post-01', ready: true };
  assert.deepEqual(studio.snapshot({}, feed).feed, feed);
  assert.equal(studio.snapshot({}).feed, null);
});

test('a station can be added while the show runs', () => {
  const { studio } = makeStudio();
  const res = studio.addStation({ id: 'post-04', label: '  Divano  ', wled_segment: 3 });

  assert.equal(res.ok, true);
  assert.equal(studio.list().length, 4);
  assert.equal(studio.get('post-04').state, 'IDLE');
  assert.equal(studio.get('post-04').label, 'Divano');
  assert.deepEqual(res.station, { id: 'post-04', label: 'Divano', wled_segment: 3 });
  // The config array is what gets persisted, so it must follow along.
  assert.equal(studio.config.stations.length, 4);
});

test('a new station works like any other: it can request and go live', () => {
  const { studio } = makeStudio();
  studio.addStation({ id: 'post-04', label: 'Divano' });
  studio.requestFloor('post-04');
  assert.deepEqual(studio.queue().map((s) => s.id), ['post-04']);
  assert.equal(studio.grant('post-04').ok, true);
  assert.equal(studio.liveStation().id, 'post-04');
});

test('bad and duplicate ids are refused', () => {
  const { studio } = makeStudio();
  assert.equal(studio.addStation({ id: 'post-01' }).code, 'duplicate_id');
  assert.equal(studio.addStation({ id: 'Post 04' }).code, 'bad_id');
  assert.equal(studio.addStation({ id: '' }).code, 'bad_id');
  assert.equal(studio.addStation({ id: '-nope' }).code, 'bad_id');
  assert.equal(studio.addStation({}).code, 'bad_id');
  assert.equal(studio.list().length, 3, 'nothing may be created by a refused add');
});

test('the label falls back to the id, and optional fields stay out when empty', () => {
  const { studio } = makeStudio();
  const res = studio.addStation({ id: 'post-04' });
  assert.equal(res.station.label, 'post-04');
  assert.deepEqual(Object.keys(res.station), ['id', 'label'], 'no empty keys in the saved config');
});

test('a station can be removed, but never while it is on air', () => {
  const { studio } = makeStudio();
  studio.grant('post-01');
  assert.equal(studio.removeStation('post-01').code, 'is_live');
  assert.equal(studio.list().length, 3);

  studio.close('post-01');
  assert.equal(studio.removeStation('post-01').ok, true);
  assert.equal(studio.get('post-01'), null);
  assert.equal(studio.config.stations.length, 2, 'the persisted config follows the removal');
  assert.equal(studio.removeStation('post-01').code, 'unknown_station');
});

test('removing a queued station takes it out of the queue', () => {
  const { studio } = makeStudio();
  studio.requestFloor('post-02');
  studio.requestFloor('post-03');
  studio.removeStation('post-02');
  assert.deepEqual(studio.queue().map((s) => s.id), ['post-03']);
});

test('camera agent status is kept per station, with the saved framing', () => {
  const { studio } = makeStudio();
  assert.equal(studio.get('post-01').camera.connected, false);

  studio.setCamera('post-01', {
    connected: true, ok: true,
    info: { model: 'Tiny 2 Lite', sn: 'X1' },
    state: { pitch: -19.1, yaw: 12.4, zoom: 1, ai_mode: 0, asleep: false }
  });
  studio.get('post-01').config.framing = { pitch: -19.1, yaw: 12.4, zoom: 1 };

  const snap = studio.snapshot().stations.find((s) => s.id === 'post-01');
  assert.equal(snap.camera.ok, true);
  assert.equal(snap.camera.info.model, 'Tiny 2 Lite');
  assert.deepEqual(snap.framing, { pitch: -19.1, yaw: 12.4, zoom: 1 });
  assert.equal(studio.setCamera('post-99', {}).code, 'unknown_station');
});
