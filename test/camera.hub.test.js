'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Studio } = require('../server/state');
const { CameraHub } = require('../server/camera');

function fakeSocket() {
  return {
    readyState: 1, OPEN: 1, sent: [], closedWith: null,
    send(raw) { this.sent.push(JSON.parse(raw)); },
    close(code, reason) { this.closedWith = { code, reason }; }
  };
}

function setup({ framing } = {}) {
  const studio = new Studio({
    stations: [
      { id: 'post-01', label: 'Poltrona 1', ...(framing ? { framing } : {}) },
      { id: 'post-02', label: 'Poltrona 2' }
    ]
  });
  let saves = 0;
  const hub = new CameraHub({ studio, log: { event() {} }, saveConfig: () => { saves++; return { ok: true }; } });
  return { studio, hub, saves: () => saves };
}

const okStatus = (state = { pitch: -19.1, yaw: 12.4, zoom: 1, ai_mode: 0, asleep: false }) => ({
  type: 'camera_status', ok: true, info: { model: 'Tiny 2 Lite' }, state
});

test('an agent coming online is shown connected, and a second one replaces the first', () => {
  const { studio, hub } = setup();
  const a = fakeSocket();
  const b = fakeSocket();
  hub.addAgent(a, 'post-01');
  assert.equal(studio.get('post-01').camera.connected, true);

  hub.addAgent(b, 'post-01');
  assert.deepEqual(a.closedWith, { code: 4000, reason: 'replaced' });
});

test('orders reach the agent of that station, clamped to safe steps', () => {
  const { hub } = setup();
  const agent = fakeSocket();
  hub.addAgent(agent, 'post-01');

  assert.deepEqual(hub.command('post-01', { cmd: 'nudge', dpitch: 3, dyaw: -500 }), { ok: true });
  const sent = agent.sent.pop();
  assert.equal(sent.type, 'camera_cmd');
  assert.equal(sent.cmd, 'nudge');
  assert.equal(sent.dpitch, 3);
  assert.equal(sent.dyaw, -30, 'a single nudge can never swing the camera away');

  hub.command('post-01', { cmd: 'zoom', zoom: 9 });
  assert.equal(agent.sent.pop().zoom, 4);
  hub.command('post-01', { cmd: 'goto', pitch: -200, yaw: 12, zoom: 0.5 });
  const g = agent.sent.pop();
  assert.deepEqual([g.pitch, g.yaw, g.zoom], [-90, 12, 1]);
});

test('a station on air never has its camera moved', () => {
  const { studio, hub } = setup();
  const agent = fakeSocket();
  hub.addAgent(agent, 'post-01');
  studio.grant('post-01');

  const res = hub.command('post-01', { cmd: 'nudge', dpitch: 2 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'is_live');
  assert.deepEqual(agent.sent, [], 'nothing may reach the camera');
});

test('no agent, no order: the dashboard is told why', () => {
  const { hub } = setup();
  assert.equal(hub.command('post-02', { cmd: 'nudge', dpitch: 1 }).code, 'camera_offline');
  assert.equal(hub.command('post-99', { cmd: 'nudge' }).code, 'unknown_station');
});

test('saving a framing stores where the camera points now, and persists it', () => {
  const { studio, hub, saves } = setup();
  hub.addAgent(fakeSocket(), 'post-01');
  hub.update('post-01', okStatus({ pitch: -19.13, yaw: 12.44, zoom: 1.234, ai_mode: 0, asleep: false }));

  const res = hub.saveFraming('post-01');
  assert.equal(res.ok, true);
  assert.deepEqual(studio.get('post-01').config.framing, { pitch: -19.1, yaw: 12.4, zoom: 1.23 });
  assert.equal(saves(), 1);
});

test('nothing to save while the camera is not available', () => {
  const { hub } = setup();
  assert.equal(hub.saveFraming('post-01').code, 'camera_offline');
});

test('recalling a framing sends the saved position; without one, says so', () => {
  const { hub } = setup({ framing: { pitch: -10, yaw: 5, zoom: 1.5 } });
  const agent = fakeSocket();
  hub.addAgent(agent, 'post-01');
  hub.update('post-01', okStatus()); // triggers the automatic restore once
  agent.sent.length = 0;

  assert.equal(hub.recallFraming('post-01').ok, true);
  assert.deepEqual(
    (({ cmd, pitch, yaw, zoom }) => ({ cmd, pitch, yaw, zoom }))(agent.sent.pop()),
    { cmd: 'goto', pitch: -10, yaw: 5, zoom: 1.5 }
  );
  assert.equal(hub.recallFraming('post-02').code, 'no_framing');
});

test('a camera coming online is put back on its saved framing, once', () => {
  const { hub } = setup({ framing: { pitch: -10, yaw: 5, zoom: 1.5 } });
  const agent = fakeSocket();
  hub.addAgent(agent, 'post-01');

  hub.update('post-01', okStatus());
  hub.update('post-01', okStatus());
  const gotos = agent.sent.filter((m) => m.cmd === 'goto');
  assert.equal(gotos.length, 1, 'restored when it comes up, not on every status report');
});

test('a camera that was lost and comes back is restored again', () => {
  const { hub } = setup({ framing: { pitch: -10, yaw: 5, zoom: 1.5 } });
  const agent = fakeSocket();
  hub.addAgent(agent, 'post-01');
  hub.update('post-01', okStatus());
  hub.update('post-01', { type: 'camera_status', ok: false, error: 'telecamera non trovata' });
  hub.update('post-01', okStatus());
  assert.equal(agent.sent.filter((m) => m.cmd === 'goto').length, 2);
});

test('the automatic restore never moves a station that is on air', () => {
  const { studio, hub } = setup({ framing: { pitch: -10, yaw: 5, zoom: 1.5 } });
  const agent = fakeSocket();
  studio.grant('post-01');
  hub.addAgent(agent, 'post-01');
  hub.update('post-01', okStatus());
  assert.equal(agent.sent.filter((m) => m.cmd === 'goto').length, 0);
});

test('a disconnected agent is shown offline, and a removed station drops its agent', () => {
  const { studio, hub } = setup();
  const agent = fakeSocket();
  hub.addAgent(agent, 'post-01');
  hub.removeAgent(agent, 'post-01');
  assert.equal(studio.get('post-01').camera.connected, false);

  const other = fakeSocket();
  hub.addAgent(other, 'post-02');
  hub.forget('post-02');
  assert.equal(other.closedWith.code, 4004);
});

// --- tracking -----------------------------------------------------------------

test('choosing a tracking mode is saved and sent to the camera', () => {
  const { studio, hub, saves } = setup();
  const agent = fakeSocket();
  hub.addAgent(agent, 'post-01');

  assert.deepEqual(hub.setTracking('post-01', 'upper'), { ok: true });
  assert.equal(studio.get('post-01').config.tracking, 'upper');
  assert.equal(saves(), 1);
  const cmd = agent.sent.pop();
  assert.deepEqual([cmd.cmd, cmd.mode], ['tracking', 'upper']);

  hub.setTracking('post-01', 'off');
  assert.equal(studio.get('post-01').config.tracking, undefined, 'fixed is the default: nothing left in config');
  assert.equal(studio.snapshot().stations.find((s) => s.id === 'post-01').tracking, 'off');
});

test('on air the framing mode changes only with an explicit confirmation', () => {
  const { studio, hub } = setup();
  const agent = fakeSocket();
  hub.addAgent(agent, 'post-01');
  studio.grant('post-01');

  // A stray click must not change the picture on the mixer.
  assert.equal(hub.setTracking('post-01', 'normal').code, 'is_live');
  assert.deepEqual(agent.sent, []);

  // The guest has to stand up: the operator confirms, the camera follows them.
  assert.deepEqual(hub.setTracking('post-01', 'normal', { onAir: true }), { ok: true });
  const cmd = agent.sent.pop();
  assert.deepEqual([cmd.cmd, cmd.mode], ['tracking', 'normal']);

  // Back to fixed once seated again, still on air.
  assert.deepEqual(hub.setTracking('post-01', 'off', { onAir: true }), { ok: true });
  assert.equal(agent.sent.pop().mode, 'off');
});

test('arrows and zoom stay preview-only, even after a confirmed change on air', () => {
  const { studio, hub } = setup();
  const agent = fakeSocket();
  hub.addAgent(agent, 'post-01');
  studio.grant('post-01');
  hub.setTracking('post-01', 'off', { onAir: true });
  agent.sent.length = 0;

  assert.equal(hub.command('post-01', { cmd: 'nudge', dpitch: 2 }).code, 'is_live');
  assert.equal(hub.command('post-01', { cmd: 'zoom', dzoom: 0.2 }).code, 'is_live');
  assert.deepEqual(agent.sent, []);
});

test('unknown modes are refused', () => {
  const { hub } = setup();
  assert.equal(hub.setTracking('post-01', 'group').code, 'bad_tracking');
  assert.equal(hub.setTracking('post-99', 'off').code, 'unknown_station');
});

test('while the camera follows the guest, manual moves and saving are refused', () => {
  const { hub } = setup();
  const agent = fakeSocket();
  hub.addAgent(agent, 'post-01');
  hub.update('post-01', okStatus());
  hub.setTracking('post-01', 'normal');
  agent.sent.length = 0;

  for (const order of [{ cmd: 'nudge', dpitch: 2 }, { cmd: 'zoom', dzoom: 0.2 }, { cmd: 'goto', pitch: 0, yaw: 0 }]) {
    assert.equal(hub.command('post-01', order).code, 'tracking_on', order.cmd);
  }
  assert.equal(hub.saveFraming('post-01').code, 'tracking_on');
  assert.deepEqual(agent.sent, [], 'a manual move would silently switch tracking off in the camera');
});

test('the mode can be chosen with no agent connected, and applies when the camera comes online', () => {
  const { hub } = setup({ framing: { pitch: -10, yaw: 5, zoom: 1.5 } });
  assert.deepEqual(hub.setTracking('post-01', 'closeup'), { ok: true });

  const agent = fakeSocket();
  hub.addAgent(agent, 'post-01');
  hub.update('post-01', okStatus());
  const cmds = agent.sent.map((m) => m.cmd);
  assert.deepEqual(cmds, ['tracking'], 'a tracking station gets its mode back, not the fixed framing');
  assert.equal(agent.sent[0].mode, 'closeup');
});
