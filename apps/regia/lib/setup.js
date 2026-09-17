'use strict';

/**
 * First start of the control room app: a config.json and an HTTPS certificate
 * in the app's data folder (%APPDATA%\Regia on Windows), never inside the
 * installation, which an update replaces.
 *
 * Plain Node, no Electron: runs under `node --test`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Paths inside config.json that the server resolves: relative ones would point
// into the installation folder, so they are made absolute in the data folder.
const PATH_KEYS = [
  ['log_path', 'data/events.jsonl'],
  ['names_path', 'data/names.json']
];

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * Makes every path in the config absolute, relative to the data folder.
 * Returns { config, changed }. A config copied from a manual installation
 * (paths like "certs/server.crt") therefore works once dropped in the folder.
 */
function normalizePaths(config, dataDir) {
  const out = { ...config };
  let changed = false;
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(dataDir, p));
  for (const [key, fallback] of PATH_KEYS) {
    const value = abs(out[key] || fallback);
    if (value !== out[key]) {
      out[key] = value;
      changed = true;
    }
  }
  if (out.tls && out.tls.cert && out.tls.key) {
    const tls = { ...out.tls, cert: abs(out.tls.cert), key: abs(out.tls.key) };
    if (tls.cert !== out.tls.cert || tls.key !== out.tls.key) {
      out.tls = tls;
      changed = true;
    }
  }
  return { config: out, changed };
}

/**
 * Creates config.json from the example on first start (WebRTC video, HTTPS
 * on), or normalizes an existing one. Returns the path and the config.
 */
function ensureConfig(dataDir, examplePath) {
  const file = path.join(dataDir, 'config.json');
  let config;
  let created = false;
  if (fs.existsSync(file)) {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    config = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
    config.video_driver = 'webrtc';
    config.tls = { cert: 'certs/server.crt', key: 'certs/server.key' };
    created = true;
  }
  const norm = normalizePaths(config, dataDir);
  if (created || norm.changed) writeJsonAtomic(file, norm.config);
  return { file, config: norm.config, created };
}

/**
 * Generates the self-signed certificate if the config asks for TLS and the
 * files are missing. `selfsigned` is passed in (it is a dependency of the app,
 * not of the repository). Covers localhost, the computer name and every LAN
 * address, like `npm run cert`.
 */
async function ensureCertificate(config, selfsigned, { hostname = os.hostname(), ips = lanAddresses() } = {}) {
  const tls = config.tls;
  if (!tls || !tls.cert || !tls.key) return { tls: false };
  if (fs.existsSync(tls.cert) && fs.existsSync(tls.key)) return { tls: true, generated: false };

  const names = [...new Set(['localhost', hostname].filter(Boolean))];
  const addresses = [...new Set(['127.0.0.1', ...ips])];
  const notBeforeDate = new Date(Date.now() - 24 * 3600 * 1000);
  const notAfterDate = new Date(notBeforeDate);
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Regia studio' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [...names.map((value) => ({ type: 2, value })), ...addresses.map((ip) => ({ type: 7, ip }))]
      }
    ]
  });
  fs.mkdirSync(path.dirname(tls.cert), { recursive: true });
  fs.mkdirSync(path.dirname(tls.key), { recursive: true });
  fs.writeFileSync(tls.key, pems.private, { mode: 0o600 });
  fs.writeFileSync(tls.cert, pems.cert);
  return { tls: true, generated: true, names, addresses };
}

module.exports = { ensureConfig, ensureCertificate, normalizePaths, lanAddresses, writeJsonAtomic };
