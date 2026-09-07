'use strict';

/**
 * Generates a self-signed certificate for the studio LAN.
 *
 *   npm run cert                       # localhost + every LAN address found
 *   npm run cert -- 172.31.31.110 regia.local
 *
 * Browsers hand over webcam and microphone only in a secure context, and
 * http://<ip> is not one: without this the station pages work on localhost and
 * nowhere else. The certificate covers IPs as well as names, because the
 * stations are reached by address.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'certs');
const KEY = path.join(DIR, 'server.key');
const CRT = path.join(DIR, 'server.crt');
const DAYS = 3650;

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

const extra = process.argv.slice(2);
const ips = ['127.0.0.1', ...lanAddresses(), ...extra.filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))];
const names = ['localhost', os.hostname(), ...extra.filter((a) => !/^\d+\.\d+\.\d+\.\d+$/.test(a))];

const san = [
  ...new Set([...names.map((n) => `DNS:${n}`), ...ips.map((i) => `IP:${i}`)])
].join(',');

console.log('Certificato per:');
[...new Set(names)].forEach((n) => console.log(`  nome  ${n}`));
[...new Set(ips)].forEach((i) => console.log(`  ip    ${i}`));

fs.mkdirSync(DIR, { recursive: true });

try {
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-days', String(DAYS),
      '-keyout', KEY,
      '-out', CRT,
      '-subj', '/CN=Regia studio',
      '-addext', `subjectAltName=${san}`,
      '-addext', 'basicConstraints=critical,CA:TRUE'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
} catch (e) {
  console.error('\nGenerazione fallita.');
  console.error(String(e.stderr || e.message).trim());
  console.error('\nServe openssl: su macOS e Linux c\'è già, su Windows arriva con Git for Windows');
  console.error('(C:\\Program Files\\Git\\usr\\bin\\openssl.exe).');
  process.exit(1);
}

console.log(`\nScritti:\n  ${path.relative(ROOT, CRT)}\n  ${path.relative(ROOT, KEY)}`);
console.log('\nAggiungi a config.json:');
console.log('  "tls": { "cert": "certs/server.crt", "key": "certs/server.key" }');
console.log('\nPoi riavvia il server: le pagine saranno su https://<indirizzo>:8080/');
console.log('Il certificato è auto-firmato: la prima volta ogni dispositivo mostra un avviso,');
console.log('oppure installa certs/server.crt tra le autorità attendibili di quel dispositivo.');
