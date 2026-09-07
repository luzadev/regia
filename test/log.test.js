'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLog, readInterventions } = require('../server/log');

function writeLog(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regia-log-')), 'events.jsonl');
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

const open = (id, station, name, ts, countdown) => ({
  ts, type: 'live_open', station, name, intervention_id: id, countdown_s: countdown ?? null
});
const close = (id, station, name, ts, duration) => ({
  ts, type: 'live_close', station, name, intervention_id: id, duration_s: duration
});

test('interventions are rebuilt by pairing open and close', () => {
  const file = writeLog([
    { ts: '2026-01-01T10:00:00.000Z', type: 'server_start' },
    open('a', 'post-01', 'Rossi', '2026-01-01T10:00:05.000Z', 60),
    close('a', 'post-01', 'Rossi', '2026-01-01T10:01:35.000Z', 90)
  ]);

  const { interventions, events } = readInterventions(file);
  assert.equal(interventions.length, 1);
  assert.deepEqual(interventions[0], {
    id: 'a',
    station: 'post-01',
    name: 'Rossi',
    start: '2026-01-01T10:00:05.000Z',
    countdown_s: 60,
    duration_s: 90,
    end: '2026-01-01T10:01:35.000Z'
  });
  assert.equal(events, 3, 'every line is counted, not just the interventions');
});

test('an intervention with no close is still on air', () => {
  const file = writeLog([open('b', 'post-02', 'Bianchi', '2026-01-01T11:00:00.000Z', 30)]);
  const { interventions } = readInterventions(file);
  assert.equal(interventions[0].live, true);
  assert.equal(interventions[0].duration_s, null);
});

test('the newest intervention comes first', () => {
  const file = writeLog([
    open('a', 'post-01', '', '2026-01-01T10:00:00.000Z'),
    close('a', 'post-01', '', '2026-01-01T10:01:00.000Z', 60),
    open('b', 'post-02', '', '2026-01-01T12:00:00.000Z'),
    close('b', 'post-02', '', '2026-01-01T12:00:30.000Z', 30)
  ]);
  assert.deepEqual(readInterventions(file).interventions.map((i) => i.id), ['b', 'a']);
});

test('speaking time is summed per station, longest first', () => {
  const file = writeLog([
    open('a', 'post-01', 'Rossi', '2026-01-01T10:00:00.000Z'),
    close('a', 'post-01', 'Rossi', '2026-01-01T10:01:00.000Z', 60),
    open('b', 'post-01', 'Rossi', '2026-01-01T10:05:00.000Z'),
    close('b', 'post-01', 'Rossi', '2026-01-01T10:06:00.000Z', 45),
    open('c', 'post-02', 'Verdi', '2026-01-01T10:10:00.000Z'),
    close('c', 'post-02', 'Verdi', '2026-01-01T10:11:00.000Z', 200)
  ]);

  const { totals } = readInterventions(file);
  assert.deepEqual(totals, [
    { station: 'post-02', name: 'Verdi', count: 1, total_s: 200 },
    { station: 'post-01', name: 'Rossi', count: 2, total_s: 105 }
  ]);
});

test('a torn line from a killed process does not lose the rest', () => {
  const file = writeLog([
    open('a', 'post-01', '', '2026-01-01T10:00:00.000Z'),
    '{"ts":"2026-01-01T10:00:30.000Z","type":"live_c',
    close('a', 'post-01', '', '2026-01-01T10:01:00.000Z', 60)
  ]);
  assert.equal(readInterventions(file).interventions.length, 1);
});

test('a close with no matching open is ignored', () => {
  const file = writeLog([close('ghost', 'post-01', '', '2026-01-01T10:00:00.000Z', 10)]);
  assert.deepEqual(readInterventions(file).interventions, []);
});

test('the limit applies to the newest interventions', () => {
  const lines = [];
  for (let i = 0; i < 10; i++) {
    const ts = `2026-01-01T10:${String(i).padStart(2, '0')}:00.000Z`;
    lines.push(open('i' + i, 'post-01', '', ts), close('i' + i, 'post-01', '', ts, 10));
  }
  const { interventions } = readInterventions(writeLog(lines), 3);
  assert.deepEqual(interventions.map((i) => i.id), ['i9', 'i8', 'i7']);
});

test('a missing log file gives an empty history, not a crash', () => {
  assert.deepEqual(readInterventions('/tmp/non-esiste-affatto.jsonl'), {
    interventions: [],
    totals: [],
    events: 0
  });
});

test('what the log writes is what the history reads back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regia-roundtrip-'));
  const file = path.join(dir, 'events.jsonl');
  const log = createLog(file);
  log.event('live_open', { station: 'post-04', name: 'Neri', intervention_id: 'x1', countdown_s: 120 });
  log.event('live_close', { station: 'post-04', name: 'Neri', intervention_id: 'x1', duration_s: 140 });
  log.close();

  return new Promise((resolve) => {
    setTimeout(() => {
      const { interventions } = readInterventions(file);
      assert.equal(interventions.length, 1);
      assert.equal(interventions[0].name, 'Neri');
      assert.equal(interventions[0].duration_s, 140);
      resolve();
    }, 50);
  });
});

test('an intervention left open by a restart is interrupted, not still on air', () => {
  const file = writeLog([
    open('a', 'post-01', 'Rossi', '2026-01-01T10:00:00.000Z'),
    { ts: '2026-01-01T11:00:00.000Z', type: 'server_start' },
    open('b', 'post-02', 'Verdi', '2026-01-01T11:05:00.000Z')
  ]);

  const byId = {};
  readInterventions(file).interventions.forEach((i) => (byId[i.id] = i));

  assert.equal(byId.a.interrupted, true, 'opened before the last restart: it cannot still be live');
  assert.equal(byId.a.live, undefined);
  assert.equal(byId.b.live, true, 'opened after the restart: this one really is on air');
  assert.equal(byId.b.interrupted, undefined);
});
