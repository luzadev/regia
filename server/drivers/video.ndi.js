'use strict';

/**
 * Video router driven by the HTTP interface of NDI Studio Monitor.
 *
 * Studio Monitor's web control has changed shape across versions, so the two
 * request paths are templates in config.json rather than constants here:
 *
 *   ndi_connect_path     e.g. "/v1/connect?name={source}"
 *   ndi_disconnect_path  e.g. "/v1/disconnect"
 *
 * Placeholders: {source} (URL-encoded NDI name) and {source_plain}.
 *
 * Failures are thrown, never swallowed: index.js turns them into a driver
 * error banner and a log line, and the show carries on regardless (rule §2.7).
 */

const DEFAULT_CONNECT_PATH = '/v1/connect?name={source}';
const DEFAULT_DISCONNECT_PATH = '/v1/disconnect';

function create(config, log) {
  const base = (config.ndi_monitor_url || 'http://127.0.0.1:81').replace(/\/+$/, '');
  const connectPath = config.ndi_connect_path || DEFAULT_CONNECT_PATH;
  const disconnectPath = config.ndi_disconnect_path || DEFAULT_DISCONNECT_PATH;
  const timeoutMs = config.driver_timeout_ms ?? 1500;
  const auth = config.ndi_monitor_auth || null;

  let current = null;

  function buildUrl(path, sourceName) {
    const filled = path
      .replace('{source}', encodeURIComponent(sourceName || ''))
      .replace('{source_plain}', sourceName || '');
    return base + (filled.startsWith('/') ? filled : '/' + filled);
  }

  async function request(url) {
    const headers = {};
    if (auth && auth.user) {
      headers.Authorization = 'Basic ' + Buffer.from(`${auth.user}:${auth.password || ''}`).toString('base64');
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status} da ${url}`);
    return res;
  }

  const driver = {
    name: 'video.ndi',

    /** station === null puts the feed back to black (no source). */
    async setSource(station) {
      const sourceName = station ? station.config.ndi_source || station.id : null;
      const url = sourceName ? buildUrl(connectPath, sourceName) : buildUrl(disconnectPath, null);
      try {
        await request(url);
        current = sourceName;
        log.event('driver_video', { driver: 'ndi', source: sourceName, url });
        console.log(`[video.ndi] source -> ${sourceName || 'BLACK'}`);
      } catch (e) {
        log.event('driver_video_error', { driver: 'ndi', source: sourceName, url, message: e.message });
        throw new Error(`NDI Studio Monitor non raggiungibile (${e.message})`);
      }
    },

    get current() {
      return current;
    }
  };

  return driver;
}

module.exports = { create, DEFAULT_CONNECT_PATH, DEFAULT_DISCONNECT_PATH };
