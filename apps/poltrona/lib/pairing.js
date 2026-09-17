'use strict';

/**
 * Station app pairing: which server, which station, which certificate.
 *
 * Everything here is plain Node (no Electron), so it runs under `node --test`.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { derToPem, fingerprint } = require('../../common/cert');

const DEFAULT_PORT = 8080;
const STATION_ID = /^[a-z0-9][a-z0-9_-]{0,30}$/;

/**
 * Accepts what a technician types: "192.168.10.10", "192.168.10.10:8080",
 * "https://regia.local:8080/regia/". Returns { host, port } or null.
 */
function parseAddress(input) {
  let text = String(input || '').trim();
  if (!text) return null;
  if (!/^[a-z]+:\/\//i.test(text)) text = 'https://' + text;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port };
}

const hostPart = (host) => (host.includes(':') ? `[${host}]` : host);

function origin(pairing) {
  return `${pairing.scheme}://${hostPart(pairing.host)}:${pairing.port}`;
}

function stationUrl(pairing) {
  return `${origin(pairing)}/poltrona/?id=${encodeURIComponent(pairing.station)}`;
}

function wsUrl(pairing) {
  return `${pairing.scheme === 'https' ? 'wss' : 'ws'}://${hostPart(pairing.host)}:${pairing.port}/ws`;
}

/** A pairing is usable when it names a server, a station and (for https) a certificate. */
function isComplete(p) {
  return !!(p && p.host && p.port && STATION_ID.test(p.station || '') &&
    (p.scheme === 'http' || (p.scheme === 'https' && p.fingerprint && p.pem)));
}

function load(file) {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

function save(file, pairing) {
  const clean = {
    host: pairing.host,
    port: pairing.port,
    scheme: pairing.scheme,
    station: pairing.station,
    fingerprint: pairing.scheme === 'https' ? pairing.fingerprint : null,
    pem: pairing.scheme === 'https' ? pairing.pem : null,
    paired_at: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, file);
  return clean;
}

function getJson(mod, options) {
  return new Promise((resolve, reject) => {
    const req = mod.request({ method: 'GET', ...options }, (res) => {
      const cert = res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`risposta HTTP ${res.statusCode}`));
        try {
          resolve({ json: JSON.parse(body), cert });
        } catch {
          reject(new Error('non sembra un server Regia'));
        }
      });
    });
    req.setTimeout(options.timeout || 4000, () => req.destroy(new Error('nessuna risposta')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Reaches a Regia server and reads what pairing needs: its certificate (taken
 * as presented - the technician confirms the fingerprint against the one the
 * control room app shows) and its list of stations.
 *
 * Tries HTTPS first; a server running without TLS answers over HTTP, and the
 * result says so, because without HTTPS the station gets no camera.
 */
async function probe(address, { timeout = 4000 } = {}) {
  const target = parseAddress(address);
  if (!target) return { ok: false, message: 'Indirizzo non valido' };
  const base = { hostname: target.host, port: target.port, path: '/api/state', timeout };

  let scheme = 'https';
  let result;
  try {
    result = await getJson(https, { ...base, rejectUnauthorized: false });
  } catch (e) {
    try {
      result = await getJson(http, base);
      scheme = 'http';
    } catch {
      return { ok: false, message: `Server non raggiungibile su ${target.host}:${target.port} (${e.message})` };
    }
  }

  const stations = Array.isArray(result.json.stations)
    ? result.json.stations.map((s) => ({ id: s.id, label: s.label, name: s.name || null, connected: !!s.connected }))
    : null;
  if (!stations) return { ok: false, message: 'Il server risponde ma non sembra un server Regia' };

  const out = { ok: true, host: target.host, port: target.port, scheme, stations };
  if (scheme === 'https') {
    if (!result.cert || !result.cert.raw) return { ok: false, message: 'Certificato del server non leggibile' };
    out.pem = derToPem(result.cert.raw);
    out.fingerprint = fingerprint(result.cert.raw);
  }
  return out;
}

module.exports = { parseAddress, origin, stationUrl, wsUrl, isComplete, load, save, probe, DEFAULT_PORT };
