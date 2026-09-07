'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Append-only JSONL event log. Never throws: a failing log must not take the
 * show down, so write errors are reported once on stderr and then swallowed.
 */
function createLog(filePath) {
  const abs = path.resolve(filePath);
  let stream = null;
  let broken = false;

  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    stream = fs.createWriteStream(abs, { flags: 'a' });
    stream.on('error', (e) => {
      if (!broken) console.error(`[log] write error: ${e.message}`);
      broken = true;
    });
  } catch (e) {
    console.error(`[log] cannot open ${abs}: ${e.message}`);
    broken = true;
  }

  return {
    path: abs,
    event(type, data = {}) {
      const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data });
      if (!broken && stream) stream.write(line + '\n');
      return line;
    },
    close() {
      if (stream) stream.end();
    }
  };
}

/**
 * Rebuilds the interventions from the event log: `live_open` and `live_close`
 * share an intervention_id, so the history needs no separate bookkeeping.
 *
 * Only the tail of the file is read - a season of shows must not turn the
 * history page into a full-file scan - and a half line at the cut is dropped.
 */
const TAIL_BYTES = 4 * 1024 * 1024;

function readInterventions(filePath, limit = 100) {
  let text = '';
  try {
    const { size } = fs.statSync(filePath);
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return { interventions: [], totals: [], events: 0 };
  }

  const open = new Map();
  const done = [];
  let events = 0;
  let lastStart = null; // an intervention older than this can no longer be live

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a torn line at the end of a killed process
    }
    events++;

    if (e.type === 'server_start') lastStart = e.ts;

    if (e.type === 'live_open' && e.intervention_id) {
      open.set(e.intervention_id, {
        id: e.intervention_id,
        station: e.station,
        name: e.name || '',
        start: e.ts,
        countdown_s: e.countdown_s ?? null,
        duration_s: null,
        end: null
      });
    } else if (e.type === 'live_close' && e.intervention_id) {
      const rec = open.get(e.intervention_id);
      if (!rec) continue;
      open.delete(e.intervention_id);
      rec.end = e.ts;
      rec.duration_s = e.duration_s ?? null;
      if (e.name) rec.name = e.name;
      done.push(rec);
    }
  }

  // Whatever never got its close is either on air right now, or was cut short
  // by a server restart: without this every crash leaves a phantom "on air"
  // row in the history for good.
  const all = [
    ...done,
    ...[...open.values()].map((r) =>
      lastStart && r.start < lastStart ? { ...r, interrupted: true } : { ...r, live: true }
    )
  ];
  all.sort((a, b) => (a.start < b.start ? 1 : -1));

  const totals = new Map();
  for (const rec of all) {
    const t = totals.get(rec.station) || { station: rec.station, name: rec.name, count: 0, total_s: 0 };
    t.count++;
    t.total_s += rec.duration_s || 0;
    if (rec.name) t.name = rec.name;
    totals.set(rec.station, t);
  }

  return {
    interventions: all.slice(0, limit),
    totals: [...totals.values()].sort((a, b) => b.total_s - a.total_s),
    events
  };
}

module.exports = { createLog, readInterventions };
