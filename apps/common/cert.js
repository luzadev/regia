'use strict';

/**
 * Certificate pinning shared by the two desktop apps.
 *
 * The studio server uses a self-signed certificate. Instead of installing it
 * among the trusted roots of eight Windows machines (certutil, one by one),
 * each app remembers the certificate's SHA-256 fingerprint and accepts that
 * certificate - and only that one - whatever address the server is reached at.
 *
 * Fingerprints are uppercase hex pairs joined by colons, the way Windows and
 * Chrome print them, so a technician can compare them by eye.
 */

const crypto = require('crypto');

function pemToDer(pem) {
  const body = String(pem)
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----[\s\S]*$/, '')
    .replace(/\s+/g, '');
  return Buffer.from(body, 'base64');
}

function derToPem(der) {
  const lines = Buffer.from(der).toString('base64').match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** SHA-256 of the DER bytes. Accepts a PEM string or a DER buffer. */
function fingerprint(cert) {
  const der = Buffer.isBuffer(cert) ? cert : pemToDer(cert);
  if (!der.length) return null;
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':');
}

/** The first bytes, enough to compare two screens at a glance. */
function shortFingerprint(fp) {
  return fp ? fp.split(':').slice(0, 8).join(':') : '';
}

function sameFingerprint(a, b) {
  const norm = (v) => String(v || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return !!a && !!b && norm(a) === norm(b);
}

module.exports = { pemToDer, derToPem, fingerprint, shortFingerprint, sameFingerprint };
