'use strict';

/**
 * Station state machine and request queue.
 *
 * Pure logic: no I/O, no timers, no network. Commands return either
 * { ok: true, plan } or { ok: false, code, message }. The caller (index.js)
 * executes the plan against the drivers and broadcasts the resulting snapshot.
 *
 * OFFLINE is not a state: it is the orthogonal `connected` flag, so a station
 * that drops while REQUESTED or LIVE keeps its place and nothing goes on or
 * off air by itself.
 */

const IDLE = 'IDLE';
const REQUESTED = 'REQUESTED';
const LIVE = 'LIVE';
const DENIED = 'DENIED';

const MAX_NAME_LENGTH = 40;

function err(code, message) {
  return { ok: false, code, message };
}

function makeStation(config) {
  return {
    id: config.id,
    label: config.label || config.id,
    name: '',
    state: IDLE,
    connected: false,
    requested_at: null,
    live_since: null,
    deadline: null,
    countdown_total_s: null,
    denied_until: null,
    intervention_id: null,
    media: { ok: null, message: null, warning: null, devices: null },
    config
  };
}

class Studio {
  /**
   * @param {object} config parsed config.json
   * @param {{ now?: () => number, newId?: () => string }} [opts] injectable clock/id for tests
   */
  constructor(config, opts = {}) {
    // The station list is owned from here on (it grows and shrinks at runtime),
    // so copy the array instead of mutating the caller's.
    this.config = { ...config, stations: [...config.stations] };
    this.now = opts.now || (() => Date.now());
    this.newId = opts.newId || (() => Math.random().toString(36).slice(2, 12));
    this.deniedDurationMs = (config.denied_duration_s ?? 5) * 1000;
    this.defaultCountdownS = config.countdown_default_s ?? null;
    this.manualMode = false;
    this.stations = new Map();

    for (const s of config.stations) this.stations.set(s.id, makeStation(s));
  }

  /**
   * Adds a station while the show is running. The definition is validated here
   * so the caller only has to persist it.
   */
  addStation(def) {
    const id = String((def && def.id) || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(id)) {
      return err('bad_id', 'Id non valido: usa lettere minuscole, cifre, - e _');
    }
    if (this.stations.has(id)) return err('duplicate_id', `La poltrona ${id} esiste gia`);

    const stationConfig = { id, label: String((def.label || '').trim() || id).slice(0, 40) };
    if (def.ndi_source) stationConfig.ndi_source = String(def.ndi_source).slice(0, 80);
    if (Number.isInteger(def.wled_segment)) stationConfig.wled_segment = def.wled_segment;
    if (def.relay_url) stationConfig.relay_url = String(def.relay_url).slice(0, 200);

    this.stations.set(id, makeStation(stationConfig));
    this.config.stations.push(stationConfig);
    return { ok: true, plan: [], station: stationConfig };
  }

  /** Removes a station. Never one that is on air. */
  removeStation(id) {
    const st = this.get(id);
    if (!st) return err('unknown_station', `Poltrona sconosciuta: ${id}`);
    if (st.state === LIVE) return err('is_live', "Chiudi l'intervento prima di rimuovere la poltrona");

    this.stations.delete(id);
    const i = this.config.stations.findIndex((s) => s.id === id);
    if (i !== -1) this.config.stations.splice(i, 1);
    return { ok: true, plan: [], removed: id };
  }

  get(id) {
    return this.stations.get(id) || null;
  }

  list() {
    return [...this.stations.values()];
  }

  liveStation() {
    return this.list().find((s) => s.state === LIVE) || null;
  }

  /** REQUESTED stations, oldest request first. */
  queue() {
    return this.list()
      .filter((s) => s.state === REQUESTED)
      .sort((a, b) => a.requested_at - b.requested_at);
  }

  // --- connection tracking ---------------------------------------------

  setConnected(id, connected) {
    const st = this.get(id);
    if (!st || st.connected === connected) return false;
    st.connected = connected;
    // A station that is gone tells us nothing about its camera any more.
    if (!connected) st.media = { ok: null, message: null, warning: null, devices: null };
    return true;
  }

  /** Camera/microphone availability reported by the station page. */
  setMedia(id, ok, message, extra = {}) {
    const st = this.get(id);
    if (!st) return err('unknown_station', `Poltrona sconosciuta: ${id}`);
    const label = (v) => (typeof v === 'string' ? v.slice(0, 120) : null);
    st.media = {
      ok: !!ok,
      message: message ? String(message).slice(0, 200) : null,
      // Working, but not with the devices that were asked for.
      warning: extra.warning ? String(extra.warning).slice(0, 200) : null,
      devices: extra.devices ? { video: label(extra.devices.video), audio: label(extra.devices.audio) } : null
    };
    return { ok: true, plan: [] };
  }

  // --- station commands -------------------------------------------------

  requestFloor(id) {
    const st = this.get(id);
    if (!st) return err('unknown_station', `Poltrona sconosciuta: ${id}`);
    if (st.state === REQUESTED || st.state === LIVE) {
      // Server-side debounce: one active request per station.
      return err('already_active', 'Richiesta già attiva');
    }
    if (st.state === DENIED) return err('denied_cooldown', 'Richiesta appena negata');
    st.state = REQUESTED;
    st.requested_at = this.now();
    return { ok: true, plan: [] };
  }

  cancelRequest(id) {
    const st = this.get(id);
    if (!st) return err('unknown_station', `Poltrona sconosciuta: ${id}`);
    if (st.state !== REQUESTED) return err('not_requested', 'Nessuna richiesta da annullare');
    this._toIdle(st);
    return { ok: true, plan: [] };
  }

  // --- control commands -------------------------------------------------

  /** REQUESTED -> LIVE, or IDLE -> LIVE ("forza in onda"). Closes the current LIVE first. */
  grant(id, countdownS) {
    const st = this.get(id);
    if (!st) return err('unknown_station', `Poltrona sconosciuta: ${id}`);
    if (st.state === LIVE) return err('already_live', 'Poltrona già in onda');

    const plan = [];
    const current = this.liveStation();
    if (current) {
      // Single LIVE constraint: full close sequence before the open sequence.
      const closed = this._closeStation(current);
      plan.push({ op: 'close', id: current.id, intervention_id: closed.intervention_id, duration_s: closed.duration_s });
    }

    const seconds = countdownS === undefined || countdownS === null ? this.defaultCountdownS : countdownS;
    const t = this.now();
    st.state = LIVE;
    st.live_since = t;
    st.denied_until = null;
    st.intervention_id = this.newId();
    this._setCountdown(st, seconds, t);
    plan.push({ op: 'open', id: st.id, intervention_id: st.intervention_id });
    return { ok: true, plan };
  }

  /** Grants the oldest pending request. */
  grantNext(countdownS) {
    const next = this.queue()[0];
    if (!next) return err('empty_queue', 'Nessuna richiesta in coda');
    return this.grant(next.id, countdownS);
  }

  deny(id) {
    const st = this.get(id);
    if (!st) return err('unknown_station', `Poltrona sconosciuta: ${id}`);
    if (st.state !== REQUESTED) return err('not_requested', 'Nessuna richiesta da negare');
    st.state = DENIED;
    st.requested_at = null;
    st.denied_until = this.now() + this.deniedDurationMs;
    return { ok: true, plan: [] };
  }

  close(id) {
    const st = this.get(id);
    if (!st) return err('unknown_station', `Poltrona sconosciuta: ${id}`);
    if (st.state !== LIVE) return err('not_live', 'Poltrona non in onda');
    const closed = this._closeStation(st);
    return {
      ok: true,
      plan: [{ op: 'close', id: st.id, intervention_id: closed.intervention_id, duration_s: closed.duration_s }]
    };
  }

  /** Absolute countdown, on a LIVE station. `seconds === null` removes it. */
  countdownSet(id, seconds) {
    const st = this.get(id);
    if (!st) return err('unknown_station', `Poltrona sconosciuta: ${id}`);
    if (st.state !== LIVE) return err('not_live', 'Poltrona non in onda');
    this._setCountdown(st, seconds, this.now());
    return { ok: true, plan: [] };
  }

  /** Relative countdown change (+/- 30 s), computed server-side so rapid clicks add up. */
  countdownAdjust(id, deltaS) {
    const st = this.get(id);
    if (!st) return err('unknown_station', `Poltrona sconosciuta: ${id}`);
    if (st.state !== LIVE) return err('not_live', 'Poltrona non in onda');
    const t = this.now();
    const remainingS = st.deadline === null ? 0 : Math.round((st.deadline - t) / 1000);
    const next = remainingS + deltaS;
    if (next <= 0) {
      st.deadline = t;
      st.countdown_total_s = st.countdown_total_s || Math.max(remainingS, 0);
      return { ok: true, plan: [] };
    }
    st.deadline = t + next * 1000;
    // The ring scale keeps the largest value the countdown has had.
    st.countdown_total_s = Math.max(st.countdown_total_s || 0, next);
    return { ok: true, plan: [] };
  }

  setName(id, name) {
    const st = this.get(id);
    if (!st) return err('unknown_station', `Poltrona sconosciuta: ${id}`);
    st.name = String(name || '').trim().slice(0, MAX_NAME_LENGTH);
    return { ok: true, plan: [] };
  }

  setManualMode(enabled) {
    const was = this.manualMode;
    this.manualMode = !!enabled;
    return { ok: true, plan: [], changed: was !== this.manualMode };
  }

  /** Clears expired DENIED states. Returns true when something changed. */
  tick() {
    const t = this.now();
    let changed = false;
    for (const st of this.stations.values()) {
      if (st.state === DENIED && st.denied_until !== null && st.denied_until <= t) {
        this._toIdle(st);
        changed = true;
      }
    }
    return changed;
  }

  /** Full, idempotent state for `state_sync`. */
  snapshot(drivers = {}, feed = null) {
    const live = this.liveStation();
    return {
      type: 'state_sync',
      server_t: this.now(),
      manual_mode: this.manualMode,
      live: live ? live.id : null,
      drivers,
      feed,
      stations: this.list().map((s) => ({
        id: s.id,
        label: s.label,
        name: s.name,
        state: s.state,
        connected: s.connected,
        requested_at: s.requested_at,
        live_since: s.live_since,
        deadline: s.deadline,
        countdown_total_s: s.countdown_total_s,
        denied_until: s.denied_until,
        media: s.media
      }))
    };
  }

  // --- internals --------------------------------------------------------

  _toIdle(st) {
    st.state = IDLE;
    st.requested_at = null;
    st.live_since = null;
    st.deadline = null;
    st.countdown_total_s = null;
    st.denied_until = null;
    st.intervention_id = null;
  }

  _closeStation(st) {
    const interventionId = st.intervention_id;
    const durationS = st.live_since === null ? null : Math.round((this.now() - st.live_since) / 1000);
    this._toIdle(st);
    return { intervention_id: interventionId, duration_s: durationS };
  }

  _setCountdown(st, seconds, t) {
    if (seconds === null || seconds === undefined) {
      st.deadline = null;
      st.countdown_total_s = null;
      return;
    }
    const s = Math.max(0, Math.round(seconds));
    st.deadline = t + s * 1000;
    st.countdown_total_s = s;
  }
}

module.exports = { Studio, IDLE, REQUESTED, LIVE, DENIED };
