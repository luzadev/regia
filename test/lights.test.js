'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const wled = require('../server/drivers/lights.wled');
const shelly = require('../server/drivers/relay.shelly');

const noopLog = { event() {} };

/** Fake controller recording what it was asked to do. */
function fakeDevice(handler) {
  const requests = [];
  const respond =
    handler ||
    ((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"success":true}');
    });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
      respond(req, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(r);
          })
      })
    );
  });
}

const COLORS = {
  requested: { rgb: [255, 170, 0], effect: 'blink' },
  live: { rgb: [255, 0, 0], effect: 'solid' },
  idle: { rgb: [0, 0, 0], effect: 'off' }
};

const station = (extra) => ({ id: 'post-03', config: { id: 'post-03', ...extra } });

// --- WLED ----------------------------------------------------------------

test('going live posts a solid red segment, without a fade', async () => {
  const device = await fakeDevice();
  const driver = wled.create({ wled_url: device.url }, noopLog);

  await driver.apply(station({ wled_segment: 2 }), 'live', COLORS.live);

  const req = device.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/json/state');
  const body = JSON.parse(req.body);
  assert.equal(body.on, true, 'the controller itself must be on');
  assert.equal(body.transition, 0, 'a tally light switches, it does not fade');
  assert.deepEqual(body.seg, [{ id: 2, on: true, col: [[255, 0, 0]], fx: 0, bri: 255 }]);
  await device.close();
});

test('a pending request blinks amber', async () => {
  const device = await fakeDevice();
  const driver = wled.create({ wled_url: device.url }, noopLog);

  await driver.apply(station({ wled_segment: 0 }), 'requested', COLORS.requested);

  const seg = JSON.parse(device.requests[0].body).seg[0];
  assert.deepEqual(seg.col, [[255, 170, 0]]);
  assert.equal(seg.fx, 1, 'blink');
  await device.close();
});

test('idle switches the segment off and leaves the other stations alone', async () => {
  const device = await fakeDevice();
  const driver = wled.create({ wled_url: device.url }, noopLog);

  await driver.apply(station({ wled_segment: 5 }), 'idle', COLORS.idle);

  const body = JSON.parse(device.requests[0].body);
  assert.deepEqual(body.seg, [{ id: 5, on: false }]);
  assert.equal(body.on, true, 'only the segment goes dark, not the whole controller');
  await device.close();
});

test('effect ids and path stay configurable for other WLED builds', async () => {
  const device = await fakeDevice();
  const driver = wled.create(
    { wled_url: device.url + '/', wled_state_path: '/api/state', wled_effects: { solid: 12, blink: 34 } },
    noopLog
  );

  await driver.apply(station({ wled_segment: 1 }), 'requested', COLORS.requested);

  assert.equal(device.requests[0].url, '/api/state');
  assert.equal(JSON.parse(device.requests[0].body).seg[0].fx, 34);
  await device.close();
});

test('brightness and effect speed are passed through when configured', async () => {
  const device = await fakeDevice();
  const driver = wled.create({ wled_url: device.url }, noopLog);

  await driver.apply(station({ wled_segment: 1 }), 'live', { rgb: [255, 0, 0], effect: 'solid', bri: 120, speed: 200 });

  const seg = JSON.parse(device.requests[0].body).seg[0];
  assert.equal(seg.bri, 120);
  assert.equal(seg.sx, 200);
  await device.close();
});

test('a station with no segment is skipped, not treated as a fault', async () => {
  const device = await fakeDevice();
  const driver = wled.create({ wled_url: device.url }, noopLog);

  await driver.apply(station({}), 'live', COLORS.live);

  assert.equal(device.requests.length, 0, 'a station added without a segment simply has no light');
  await device.close();
});

test('an unreachable WLED is reported, and fails fast', async () => {
  const driver = wled.create({ wled_url: 'http://127.0.0.1:1', driver_timeout_ms: 400 }, noopLog);
  await assert.rejects(() => driver.apply(station({ wled_segment: 0 }), 'live', COLORS.live), /WLED non raggiungibile/);
});

test('an error response from WLED is not swallowed', async () => {
  const device = await fakeDevice((_req, res) => {
    res.writeHead(503);
    res.end('busy');
  });
  const driver = wled.create({ wled_url: device.url }, noopLog);
  await assert.rejects(() => driver.apply(station({ wled_segment: 0 }), 'live', COLORS.live), /HTTP 503/);
  await device.close();
});

// --- relay ---------------------------------------------------------------

test('the LED bar is switched with the Shelly gen 1 calls by default', async () => {
  const device = await fakeDevice();
  const driver = shelly.create({}, noopLog);
  const st = station({ relay_url: device.url + '/relay/0' });

  await driver.set(st, true);
  await driver.set(st, false);

  assert.deepEqual(device.requests.map((r) => r.url), ['/relay/0?turn=on', '/relay/0?turn=off']);
  await device.close();
});

test('the on/off calls are templates, so gen 2 needs no code change', async () => {
  const device = await fakeDevice();
  const driver = shelly.create(
    {
      relay_on_url: '{url}/rpc/Switch.Set?id=0&on=true',
      relay_off_url: '{url}/rpc/Switch.Set?id=0&on=false'
    },
    noopLog
  );
  const st = station({ relay_url: device.url });

  await driver.set(st, true);
  assert.equal(device.requests[0].url, '/rpc/Switch.Set?id=0&on=true');
  await device.close();
});

test('relay basic auth is sent when configured', async () => {
  const device = await fakeDevice();
  const driver = shelly.create({ relay_auth: { user: 'admin', password: 'x' } }, noopLog);

  await driver.set(station({ relay_url: device.url + '/relay/0' }), true);

  assert.equal(device.requests[0].auth, 'Basic ' + Buffer.from('admin:x').toString('base64'));
  await device.close();
});

test('a station with no relay_url is skipped', async () => {
  const device = await fakeDevice();
  const driver = shelly.create({}, noopLog);

  await driver.set(station({}), true);

  assert.equal(device.requests.length, 0);
  await device.close();
});

test('an unreachable relay is reported per station', async () => {
  const driver = shelly.create({ driver_timeout_ms: 400 }, noopLog);
  await assert.rejects(
    () => driver.set(station({ relay_url: 'http://127.0.0.1:1/relay/0' }), true),
    /Rel. post-03 non raggiungibile/
  );
});
