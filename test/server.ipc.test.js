'use strict';

/**
 * The control room desktop app runs the server as a child process and talks to
 * it over IPC: it must hear when the server is up, why it could not start, and
 * be able to stop it cleanly on Windows, where there is no SIGTERM to catch.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { fork } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function configFor(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regia-ipc-'));
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  Object.assign(config, {
    http_port: port,
    bind_host: '127.0.0.1',
    tls: null,
    log_path: path.join(dir, 'events.jsonl'),
    names_path: path.join(dir, 'names.json')
  });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

function start(port) {
  const child = fork(path.join(ROOT, 'server/index.js'), [], {
    env: { ...process.env, REGIA_CONFIG: configFor(port) },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  const messages = [];
  child.on('message', (m) => messages.push(m));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, messages, exited };
}

const waitFor = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test('announces itself, and stops on request with exit code 0', async () => {
  const port = 20000 + Math.floor(Math.random() * 2000);
  const s = start(port);
  assert.ok(await waitFor(() => s.messages.some((m) => m.type === 'listening')), 'listening message');
  assert.deepEqual(s.messages.find((m) => m.type === 'listening'), { type: 'listening', port, scheme: 'http' });
  s.child.send({ type: 'shutdown' });
  assert.equal(await s.exited, 0);
});

test('a taken port is reported before exiting', async (t) => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  t.after(() => blocker.close());
  const s = start(blocker.address().port);
  assert.equal(await s.exited, 1);
  assert.deepEqual(s.messages, [{ type: 'listen_error', code: 'EADDRINUSE', port: blocker.address().port }]);
});
