'use strict';

/**
 * Video router driven by the HTTP interface of NDI Studio Monitor.
 *
 * The documented API is a JSON POST to /v1/configuration:
 *
 *   {"version":1,"NDI_source":"MACHINE (Stream)"}   -> switch to that source
 *   {"version":1,"NDI_source":""}                   -> no source, black
 *
 * A GET on the same path returns the current configuration, and /v1/sources
 * lists what Studio Monitor can see (used by `npm run ndi:sources`).
 *
 * Port note: the FIRST Studio Monitor window listens on 80, the second on 81,
 * the third on 82, and so on - so ndi_monitor_url must match the window that
 * is showing on the clean feed output.
 *
 * Failures are thrown, never swallowed: index.js turns them into a driver
 * error banner and a log line, and the show carries on regardless (rule §2.7).
 */

const DEFAULT_CONFIG_PATH = '/v1/configuration';
const DEFAULT_SOURCES_PATH = '/v1/sources';
const DEFAULT_SOURCE_FIELD = 'NDI_source';
const DEFAULT_API_VERSION = 1;

function create(config, log) {
  const base = (config.ndi_monitor_url || 'http://127.0.0.1:80').replace(/\/+$/, '');
  const configPath = config.ndi_config_path || DEFAULT_CONFIG_PATH;
  const sourcesPath = config.ndi_sources_path || DEFAULT_SOURCES_PATH;
  const sourceField = config.ndi_source_field || DEFAULT_SOURCE_FIELD;
  const apiVersion = config.ndi_api_version ?? DEFAULT_API_VERSION;
  const timeoutMs = config.driver_timeout_ms ?? 1500;
  const auth = config.ndi_monitor_auth || null;

  let current = null;

  function headers(extra) {
    const h = { ...extra };
    if (auth && auth.user) {
      h.Authorization = 'Basic ' + Buffer.from(`${auth.user}:${auth.password || ''}`).toString('base64');
    }
    return h;
  }

  async function request(path, options) {
    const url = base + path;
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status} da ${url}`);
    return res;
  }

  return {
    name: 'video.ndi',

    /** station === null clears the source, so the feed at rest is black. */
    async setSource(station) {
      const sourceName = station ? station.config.ndi_source || station.id : '';
      const body = { version: apiVersion, [sourceField]: sourceName };
      try {
        await request(configPath, {
          method: 'POST',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body)
        });
        current = sourceName || null;
        log.event('driver_video', { driver: 'ndi', source: current });
        console.log(`[video.ndi] source -> ${current || 'BLACK'}`);
      } catch (e) {
        log.event('driver_video_error', { driver: 'ndi', source: sourceName || null, message: e.message });
        throw new Error(`NDI Studio Monitor non raggiungibile (${e.message})`);
      }
    },

    /** Diagnostics: what Studio Monitor currently sees on the network. */
    async sources() {
      const res = await request(sourcesPath, { method: 'GET', headers: headers({}) });
      return res.json();
    },

    /** Diagnostics: Studio Monitor's current configuration. */
    async configuration() {
      const res = await request(configPath, { method: 'GET', headers: headers({}) });
      return res.json();
    },

    get current() {
      return current;
    }
  };
}

module.exports = { create, DEFAULT_CONFIG_PATH, DEFAULT_SOURCES_PATH };
