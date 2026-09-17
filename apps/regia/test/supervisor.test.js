'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createSupervisor } = require('../../common/supervisor');

function fakeChild() {
  const c = new EventEmitter();
  c.pid = 1;
  c.exitCode = null;
  c.connected = true;
  c.sent = [];
  c.send = (m) => c.sent.push(m);
  c.kill = () => c.emit('exit', null, 'SIGTERM');
  return c;
}

function harness(options = {}) {
  let t = 0;
  const timers = [];
  const children = [];
  const sup = createSupervisor({
    spawn: () => {
      const c = fakeChild();
      children.push(c);
      return c;
    },
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { fn, at: t + ms, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const i = timers.indexOf(timer);
      if (i >= 0) timers.splice(i, 1);
    },
    ...options
  });
  const advance = (ms) => {
    t += ms;
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (timer.at <= t) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fn();
      }
    }
  };
  return { sup, children, timers, advance };
}

test('a crashed child is restarted with a growing delay, reset after a stable run', () => {
  const h = harness({ restartDelayMs: 1000, maxDelayMs: 4000, stableMs: 10000 });
  h.sup.start();
  const delays = [];
  for (let i = 0; i < 4; i++) {
    h.children.at(-1).emit('exit', 1, null);
    delays.push(h.timers[0].ms);
    h.advance(h.timers[0].ms);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 4000]);
  assert.equal(h.children.length, 5);

  h.advance(20000); // stable
  h.children.at(-1).emit('exit', 1, null);
  assert.equal(h.timers[0].ms, 1000);
});

test('a final exit is not retried and is reported once', () => {
  const finals = [];
  const h = harness({ isFinal: ({ code }) => code === 3, onFinal: (info) => finals.push(info.code) });
  h.sup.start();
  h.children[0].emit('exit', 3, null);
  assert.equal(h.timers.length, 0);
  assert.deepEqual(finals, [3]);
  assert.equal(h.sup.running, false);
});

test('the last IPC message is available to decide (port already taken)', () => {
  const h = harness({ isFinal: ({ lastMessage }) => !!lastMessage && lastMessage.type === 'listen_error' });
  h.sup.start();
  h.children[0].emit('message', { type: 'listen_error', code: 'EADDRINUSE' });
  h.children[0].emit('exit', 1, null);
  assert.equal(h.timers.length, 0);
});

test('stop asks politely over IPC, kills after the timeout, never restarts', async () => {
  const h = harness({ stopTimeoutMs: 3000 });
  h.sup.start();
  const child = h.children[0];
  child.send = (m) => child.sent.push(m); // ignores the request
  const stopped = h.sup.stop();
  assert.deepEqual(child.sent, [{ type: 'shutdown' }]);
  h.advance(3000);
  await stopped;
  assert.equal(h.children.length, 1);
  assert.equal(h.timers.length, 0);

  const h2 = harness();
  h2.sup.start();
  h2.children[0].send = () => h2.children[0].emit('exit', 0, null); // obeys
  await h2.sup.stop();
  assert.equal(h2.children.length, 1);
});
