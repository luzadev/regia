'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createAgent } = require('../agent/camera-agent');

/** A camera that remembers what it was told. */
function fakeBridge(initial = {}) {
  const cam = { pitch: -19, yaw: 12, zoom: 1, ai_mode: 2, dev_status: 1, present: true, ...initial };
  const calls = [];
  const ok = (data) => Promise.resolve(data === undefined ? { ok: true } : { ok: true, data });
  const missing = () => Promise.resolve({ ok: false, code: -2, error: 'telecamera non trovata' });
  return {
    cam,
    calls,
    init: () => { calls.push('init'); return cam.present ? ok() : missing(); },
    info: () => ok({ model: 'Tiny 2 Lite', sn: 'TEST', firmware: '6.2.8.1' }),
    getState: () => (cam.present ? ok({ pitch: cam.pitch, yaw: cam.yaw, zoom: cam.zoom, ai_mode: cam.ai_mode, dev_status: cam.dev_status }) : missing()),
    aiOff: () => { calls.push('aiOff'); cam.ai_mode = 0; return ok(); },
    setAiMode: (mode, sub) => { calls.push(`ai:${mode}:${sub}`); cam.ai_mode = mode; return ok(); },
    wake: () => { calls.push('wake'); cam.dev_status = 1; return ok(); },
    setGestures: (on) => { calls.push('gestures:' + on); return ok(); },
    setAngle: (pitch, yaw) => { calls.push(`angle:${pitch}:${yaw}`); cam.pitch = pitch; cam.yaw = yaw; return ok(); },
    setZoom: (z) => { calls.push('zoom:' + z); cam.zoom = z; return ok(); }
  };
}

/** A WebSocket that records outgoing messages. */
class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    FakeWs.last = this;
  }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() {}
}

function makeAgent(bridge) {
  return createAgent({
    bridge, WebSocketImpl: FakeWs, url: 'wss://test/ws', station: 'post-03',
    pollMs: 60000, settleMs: 0, log: () => {}
  });
}

test('on finding the camera the agent turns tracking and gestures off', async () => {
  const bridge = fakeBridge({ ai_mode: 2 });
  const agent = makeAgent(bridge);
  assert.equal(await agent.ensureCamera(), true);
  assert.ok(bridge.calls.includes('aiOff'), 'framing must not drift on air');
  assert.ok(bridge.calls.includes('gestures:false'), 'a raised hand must not zoom the camera');
});

test('a sleeping camera is woken before anything else', async () => {
  const bridge = fakeBridge({ dev_status: 3, pitch: 85 });
  const agent = makeAgent(bridge);
  await agent.ensureCamera();
  assert.equal(bridge.calls.indexOf('wake') > -1 && bridge.calls.indexOf('wake') < bridge.calls.indexOf('aiOff'), true);
});

test('the agent introduces itself as the camera of its station', () => {
  const agent = makeAgent(fakeBridge());
  agent.start();
  FakeWs.last.emit('open');
  assert.deepEqual(FakeWs.last.sent[0], { type: 'hello', role: 'camera', station: 'post-03', token: null });
  agent.stop();
});

test('a nudge moves relative to where the camera is now', async () => {
  const bridge = fakeBridge({ pitch: -19, yaw: 12, ai_mode: 0 });
  const agent = makeAgent(bridge);
  const status = await agent.handleCommand({ type: 'camera_cmd', id: 7, cmd: 'nudge', dpitch: 3, dyaw: -5 });
  assert.ok(bridge.calls.includes('angle:-16:7'));
  assert.equal(status.reply_to, 7);
  assert.equal(status.ok, true);
  assert.equal(status.state.pitch, -16);
});

test('a manual move turns AI tracking off first, as the SDK requires', async () => {
  const bridge = fakeBridge({ ai_mode: 2 });
  const agent = makeAgent(bridge);
  await agent.ensureCamera();
  bridge.cam.ai_mode = 2; // someone turned it back on
  bridge.calls.length = 0;
  await agent.handleCommand({ cmd: 'goto', pitch: -10, yaw: 5 });
  assert.ok(bridge.calls.indexOf('aiOff') < bridge.calls.indexOf('angle:-10:5'));
});

test('positions and zoom are clamped to what the gimbal accepts', async () => {
  const bridge = fakeBridge({ ai_mode: 0 });
  const agent = makeAgent(bridge);
  await agent.handleCommand({ cmd: 'goto', pitch: -300, yaw: 999, zoom: 12 });
  assert.ok(bridge.calls.includes('angle:-90:180'));
  assert.ok(bridge.calls.includes('zoom:4'));
});

test('a missing camera is reported, never thrown', async () => {
  const bridge = fakeBridge({ present: false });
  const agent = makeAgent(bridge);
  const status = await agent.handleCommand({ cmd: 'nudge', dpitch: 1 });
  assert.equal(status.ok, false);
  assert.match(status.error, /non disponibile/);
});

test('an unknown command is refused without moving anything', async () => {
  const bridge = fakeBridge({ ai_mode: 0 });
  const agent = makeAgent(bridge);
  await agent.ensureCamera();
  bridge.calls.length = 0;
  const status = await agent.handleCommand({ cmd: 'selfdestruct' });
  assert.match(status.error, /sconosciuto/);
  assert.ok(!bridge.calls.some((c) => c.startsWith('angle') || c.startsWith('zoom')));
});

test('the periodic check wakes a camera that fell asleep', async () => {
  const bridge = fakeBridge({ ai_mode: 0 });
  const agent = makeAgent(bridge);
  await agent.ensureCamera();
  bridge.cam.dev_status = 3;
  bridge.calls.length = 0;
  await agent.poll();
  agent.stop();
  assert.ok(bridge.calls.includes('wake'));
});

test('tracking modes map to the SDK single-person tracking and its variants', async () => {
  const bridge = fakeBridge({ ai_mode: 0 });
  const agent = makeAgent(bridge);
  await agent.ensureCamera();
  for (const [mode, call] of [['normal', 'ai:2:0'], ['upper', 'ai:2:1'], ['closeup', 'ai:2:2'], ['off', 'ai:0:0']]) {
    bridge.calls.length = 0;
    const status = await agent.handleCommand({ cmd: 'tracking', mode });
    assert.ok(bridge.calls.includes(call), mode);
    assert.equal(status.tracking, mode);
  }
});

test('an unknown tracking mode changes nothing', async () => {
  const bridge = fakeBridge({ ai_mode: 0 });
  const agent = makeAgent(bridge);
  await agent.ensureCamera();
  bridge.calls.length = 0;
  const status = await agent.handleCommand({ cmd: 'tracking', mode: 'whiteboard' });
  assert.match(status.error, /sconosciuto/);
  assert.ok(!bridge.calls.some((c) => c.startsWith('ai:')));
});
