'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * The SDP tuning runs in the browser, but a malformed offer kills the whole
 * video path silently, so it is loaded here and tested like server code.
 */
function loadBrowserModule() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'shared', 'rtc.js'), 'utf8');
  const sandbox = { window: {}, navigator: {}, RTCPeerConnection: function () {} };
  sandbox.window.RTCPeerConnection = sandbox.RTCPeerConnection;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window;
}

const { tuneVideoBitrate } = loadBrowserModule();

// Shaped like a Chrome offer: VP8 with no fmtp, H264 with one, plus rtx/red.
const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:98 H264/90000',
  'a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=1',
  'a=rtpmap:99 red/90000',
  ''
].join('\r\n');

test('the tuned SDP stays well formed and keeps its trailing CRLF', () => {
  const out = tuneVideoBitrate(SDP, 1500, 4000);
  assert.ok(out.endsWith('\r\n'), 'an SDP that does not end with CRLF breaks negotiation');
  assert.ok(!out.includes('\r\n\r\n'), 'no blank lines may appear inside the SDP');
  assert.equal(out.split('\r\n').filter((l) => l === '').length, 1, 'exactly one trailing empty line');
});

test('a codec without an fmtp line gets one, inside the video section', () => {
  const lines = tuneVideoBitrate(SDP, 1500, 4000).split('\r\n');
  const vp8 = lines.indexOf('a=rtpmap:96 VP8/90000');
  assert.equal(lines[vp8 + 1], 'a=fmtp:96 x-google-start-bitrate=1500;x-google-min-bitrate=1500;x-google-max-bitrate=4000');
  // It must land before the section ends, not after the end of the SDP.
  assert.ok(vp8 + 1 < lines.length - 1);
});

test('an existing fmtp line is extended, not replaced', () => {
  const out = tuneVideoBitrate(SDP, 1500, 4000);
  assert.ok(
    out.includes('a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=1;x-google-start-bitrate=1500'),
    'the original H264 parameters must survive'
  );
});

test('rtx, red and the whole audio section are left alone', () => {
  const out = tuneVideoBitrate(SDP, 1500, 4000);
  assert.ok(out.includes('a=fmtp:97 apt=96\r\n'), 'rtx parameters must not be touched');
  assert.ok(!out.includes('a=fmtp:99'), 'red must not get bitrate hints');
  assert.ok(out.includes('a=fmtp:111 minptime=10;useinbandfec=1'), 'audio must not be touched');
  assert.equal(out.split('b=AS:').length - 1, 1, 'only the video section gets a bandwidth line');
});

test('the bandwidth line follows the video connection line', () => {
  const lines = tuneVideoBitrate(SDP, 1500, 4000).split('\r\n');
  const video = lines.findIndex((l) => l.startsWith('m=video'));
  assert.ok(lines[video + 1].startsWith('c='));
  assert.equal(lines[video + 2], 'b=AS:4000');
});

test('an SDP with no video codecs is returned untouched', () => {
  const audioOnly = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=rtpmap:111 opus/48000/2', ''].join('\r\n');
  assert.equal(tuneVideoBitrate(audioOnly, 1500, 4000), audioOnly);
});

test('garbage in gives the original back rather than a broken offer', () => {
  assert.equal(tuneVideoBitrate('', 1500, 4000), '');
  assert.equal(tuneVideoBitrate(null, 1500, 4000), null);
});
