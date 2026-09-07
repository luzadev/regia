'use strict';

/**
 * LED bar relays over HTTP, one per station (`stations[].relay_url`).
 *
 * The on/off requests are templates so both Shelly generations - and any other
 * relay with an HTTP interface - work without touching the code:
 *
 *   gen 1 (default)  {url}?turn=on            with relay_url http://ip/relay/0
 *   gen 2            {url}/rpc/Switch.Set?id=0&on=true   with relay_url http://ip
 */

const DEFAULT_ON = '{url}?turn=on';
const DEFAULT_OFF = '{url}?turn=off';

function create(config, log) {
  const onTemplate = config.relay_on_url || DEFAULT_ON;
  const offTemplate = config.relay_off_url || DEFAULT_OFF;
  const timeoutMs = config.driver_timeout_ms ?? 1500;
  const auth = config.relay_auth || null;
  const warned = new Set();

  function headers() {
    const h = {};
    if (auth && auth.user) {
      h.Authorization = 'Basic ' + Buffer.from(`${auth.user}:${auth.password || ''}`).toString('base64');
    }
    return h;
  }

  return {
    name: 'relay.shelly',

    async set(station, on) {
      const relayUrl = station.config.relay_url;
      if (!relayUrl) {
        if (!warned.has(station.id)) {
          warned.add(station.id);
          console.log(`[relay.shelly] ${station.id} senza relay_url: nessuna barra da comandare`);
        }
        return;
      }

      const url = (on ? onTemplate : offTemplate).replace('{url}', relayUrl.replace(/\/+$/, ''));
      try {
        const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        log.event('driver_relay', { driver: 'shelly', station: station.id, on });
        console.log(`[relay.shelly] ${station.id} -> ${on ? 'ON' : 'OFF'}`);
      } catch (e) {
        log.event('driver_relay_error', { driver: 'shelly', station: station.id, on, message: e.message });
        throw new Error(`Relè ${station.id} non raggiungibile (${e.message})`);
      }
    }
  };
}

module.exports = { create, DEFAULT_ON, DEFAULT_OFF };
