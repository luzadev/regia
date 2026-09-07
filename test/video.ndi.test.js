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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
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

const station = (ndiSource) => ({ id: 'post-03', config: { ndi_source: ndiSource } });

test('a grant posts the NDI source name to /v1/configuration', async () => {
  const monitor = await fakeMonitor();
  const driver = create({ ndi_monitor_url: monitor.url }, noopLog);

  await driver.setSource(station('REGIA-PC (POLTRONA 3)'));

  assert.equal(monitor.requests.length, 1);
  assert.equal(monitor.requests[0].method, 'POST');
  assert.equal(monitor.requests[0].url, '/v1/configuration');
  assert.deepEqual(JSON.parse(monitor.requests[0].body), {
    version: 1,
    NDI_source: 'REGIA-PC (POLTRONA 3)'
  });
  assert.equal(driver.current, 'REGIA-PC (POLTRONA 3)');
  await monitor.close();
});

test('setSource(null) posts an empty source, so the feed at rest is black', async () => {
  const monitor = await fakeMonitor();
  const driver = create({ ndi_monitor_url: monitor.url }, noopLog);

  await driver.setSource(null);

  assert.deepEqual(JSON.parse(monitor.requests[0].body), { version: 1, NDI_source: '' });
  assert.equal(driver.current, null);
  await monitor.close();
});

test('the station id is used when ndi_source is not configured', async () => {
  const monitor = await fakeMonitor();
  const driver = create({ ndi_monitor_url: monitor.url }, noopLog);

  await driver.setSource({ id: 'post-03', config: {} });

  assert.equal(JSON.parse(monitor.requests[0].body).NDI_source, 'post-03');
  await monitor.close();
});

test('path, field and api version stay configurable for other Studio Monitor builds', async () => {
  const monitor = await fakeMonitor();
  const driver = create(
    {
      ndi_monitor_url: monitor.url + '/',
      ndi_config_path: '/v2/config',
      ndi_source_field: 'NDI_overlay',
      ndi_api_version: 2
    },
    noopLog
  );

  await driver.setSource(station('CAM-3'));

  assert.equal(monitor.requests[0].url, '/v2/config');
  assert.deepEqual(JSON.parse(monitor.requests[0].body), { version: 2, NDI_overlay: 'CAM-3' });
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

test('sources() reads the list Studio Monitor can see', async () => {
  const monitor = await fakeMonitor((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url === '/v1/sources' ? '{"ndi_sources":["A","B"]}' : '{}');
  });
  const driver = create({ ndi_monitor_url: monitor.url }, noopLog);

  assert.deepEqual(await driver.sources(), { ndi_sources: ['A', 'B'] });
  assert.equal(monitor.requests[0].method, 'GET');
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

test('a hung Studio Monitor fails fast within the driver timeout', async () => {
  const monitor = await fakeMonitor((_req, res) => {
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
