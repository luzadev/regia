'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { create } = require('../server/drivers/video.ndi');

const noopLog = { event() {} };

/** Fake NDI Studio Monitor recording the requests it receives. */
function fakeMonitor(handler) {
  const requests = [];
  const respond =
    handler ||
    ((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    respond(req, res);
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

const station = (ndiSource) => ({ id: 'post-03', config: { ndi_source: ndiSource } });

test('connect asks Studio Monitor for the station source, URL-encoded', async () => {
  const monitor = await fakeMonitor();
  const driver = create({ ndi_monitor_url: monitor.url }, noopLog);

  await driver.setSource(station('STUDIO (POLTRONA 3)'));

  assert.equal(monitor.requests.length, 1);
  assert.equal(monitor.requests[0].url, '/v1/connect?name=STUDIO%20(POLTRONA%203)');
  assert.equal(driver.current, 'STUDIO (POLTRONA 3)');
  await monitor.close();
});

test('setSource(null) disconnects, so the feed at rest is black', async () => {
  const monitor = await fakeMonitor();
  const driver = create({ ndi_monitor_url: monitor.url }, noopLog);

  await driver.setSource(null);

  assert.equal(monitor.requests[0].url, '/v1/disconnect');
  assert.equal(driver.current, null);
  await monitor.close();
});

test('the station id is used when ndi_source is not configured', async () => {
  const monitor = await fakeMonitor();
  const driver = create({ ndi_monitor_url: monitor.url }, noopLog);

  await driver.setSource({ id: 'post-03', config: {} });

  assert.equal(monitor.requests[0].url, '/v1/connect?name=post-03');
  await monitor.close();
});

test('paths are templates, so another Studio Monitor version needs no code change', async () => {
  const monitor = await fakeMonitor();
  const driver = create(
    {
      ndi_monitor_url: monitor.url + '/',
      ndi_connect_path: '/v1/switch?src={source}&plain={source_plain}',
      ndi_disconnect_path: '/v1/black'
    },
    noopLog
  );

  await driver.setSource(station('CAM-3'));
  await driver.setSource(null);

  assert.equal(monitor.requests[0].url, '/v1/switch?src=CAM-3&plain=CAM-3');
  assert.equal(monitor.requests[1].url, '/v1/black');
  await monitor.close();
});

test('basic auth is sent when configured', async () => {
  const monitor = await fakeMonitor();
  const driver = create(
    { ndi_monitor_url: monitor.url, ndi_monitor_auth: { user: 'admin', password: 'secret' } },
    noopLog
  );

  await driver.setSource(station('CAM-3'));

  assert.equal(monitor.requests[0].auth, 'Basic ' + Buffer.from('admin:secret').toString('base64'));
  await monitor.close();
});

test('an error response is reported, not swallowed', async () => {
  const monitor = await fakeMonitor((_req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  const driver = create({ ndi_monitor_url: monitor.url }, noopLog);

  await assert.rejects(() => driver.setSource(station('CAM-3')), /HTTP 500/);
  assert.equal(driver.current, null, 'a failed switch must not be recorded as current');
  await monitor.close();
});

test('an unreachable Studio Monitor fails fast within the driver timeout', async () => {
  const monitor = await fakeMonitor((_req, res) => {
    // Never answers: this is the "Studio Monitor hung" case.
    setTimeout(() => res.end(), 10_000).unref();
  });
  const driver = create({ ndi_monitor_url: monitor.url, driver_timeout_ms: 200 }, noopLog);

  const started = Date.now();
  await assert.rejects(() => driver.setSource(station('CAM-3')), /non raggiungibile/);
  assert.ok(Date.now() - started < 2000, 'must not hang on a silent Studio Monitor');
  await monitor.close();
});

test('a closed port is reported as unreachable', async () => {
  const driver = create({ ndi_monitor_url: 'http://127.0.0.1:1', driver_timeout_ms: 500 }, noopLog);
  await assert.rejects(() => driver.setSource(null), /non raggiungibile/);
});
