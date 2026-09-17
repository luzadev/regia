'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** Device selection runs in the browser: load the module the same way. */
function loadBrowserModule() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'shared', 'rtc.js'), 'utf8');
  const sandbox = { window: {}, navigator: {}, RTCPeerConnection: function () {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window;
}

const { pickDevice, withDevice } = loadBrowserModule();

// What Chrome reported on the machine with the OBSBOT plugged in, 17/9/2026.
const DEVICES = [
  { kind: 'audioinput', deviceId: 'default', label: 'Predefinito - Microfono MacBook Pro (Built-in)' },
  { kind: 'audioinput', deviceId: 'a-iphone', label: 'Microfono di iPhone LuZa' },
  { kind: 'audioinput', deviceId: 'a-obsbot', label: 'OBSBOT Tiny 2 Lite Microphone (3564:fef9)' },
  { kind: 'audioinput', deviceId: 'a-blackhole', label: 'BlackHole 2ch (Virtual)' },
  { kind: 'audioinput', deviceId: 'a-builtin', label: 'Microfono MacBook Pro (Built-in)' },
  { kind: 'videoinput', deviceId: 'v-obsbot', label: 'OBSBOT Tiny 2 Lite StreamCamera (3564:fef9)' },
  { kind: 'videoinput', deviceId: 'v-facetime', label: 'Fotocamera HD FaceTime (2C0E:82E3)' },
  { kind: 'audiooutput', deviceId: 'o-obsbot', label: 'OBSBOT speaker, not a microphone' }
];

test('the OBSBOT camera and its own microphone are found by name', () => {
  assert.equal(pickDevice(DEVICES, 'videoinput', 'OBSBOT').deviceId, 'v-obsbot');
  assert.equal(pickDevice(DEVICES, 'audioinput', 'OBSBOT').deviceId, 'a-obsbot');
});

test('matching ignores case', () => {
  assert.equal(pickDevice(DEVICES, 'audioinput', 'obsbot tiny').deviceId, 'a-obsbot');
});

test('the kind matters: an output with a matching name is not a microphone', () => {
  const onlyOutput = DEVICES.filter((d) => d.kind === 'audiooutput');
  assert.equal(pickDevice(onlyOutput, 'audioinput', 'OBSBOT'), null);
});

test('Chrome\'s "default" alias is skipped for the concrete device', () => {
  // "Predefinito - Microfono MacBook Pro" comes first, but it is only an alias.
  assert.equal(pickDevice(DEVICES, 'audioinput', 'MacBook').deviceId, 'a-builtin');
});

test('no match, or no name configured, gives nothing to force', () => {
  assert.equal(pickDevice(DEVICES, 'videoinput', 'Logitech'), null);
  assert.equal(pickDevice(DEVICES, 'videoinput', null), null);
  assert.equal(pickDevice(DEVICES, 'videoinput', ''), null);
});

test('devices with no label yet (permission not granted) are never picked', () => {
  const unlabeled = [{ kind: 'videoinput', deviceId: 'x', label: '' }];
  assert.equal(pickDevice(unlabeled, 'videoinput', 'OBSBOT'), null);
});

test('the chosen device is added without losing the existing constraints', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(withDevice({ width: 1280, height: 720, frameRate: 30 }, 'v-obsbot'))),
    { width: 1280, height: 720, frameRate: 30, deviceId: { exact: 'v-obsbot' } }
  );
  assert.deepEqual(JSON.parse(JSON.stringify(withDevice(true, 'a-obsbot'))), { deviceId: { exact: 'a-obsbot' } });
});

test('audio processing settings survive the device choice', () => {
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  const out = JSON.parse(JSON.stringify(withDevice(audio, 'a-obsbot')));
  assert.equal(out.echoCancellation, false);
  assert.equal(out.autoGainControl, false);
  assert.deepEqual(out.deviceId, { exact: 'a-obsbot' });
});
