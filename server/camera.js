'use strict';

/**
 * Camera hub: the station camera agents (role "camera") and the framing of
 * each station.
 *
 * The server is the only one that decides when a camera moves (rule §2.6). A
 * station on air is never moved: reframing happens in preview, before the
 * guest goes live, because a moving picture on the mixer output is exactly
 * what the control room must never cause by accident.
 *
 * A station's saved framing lives in config.json (stations[].framing) and is
 * put back automatically whenever its camera comes (back) online - after a
 * power cut, a reboot or an agent restart - as long as it is not on air.
 */

const LIMITS = { pitch: [-90, 90], yaw: [-180, 180], zoom: [1, 4] };
// How the camera frames its guest: fixed, or following them (SDK single-person
// tracking and its two tighter variants).
const TRACKING_MODES = ['off', 'normal', 'upper', 'closeup'];
const STEP_LIMITS = { dpitch: 30, dyaw: 30, dzoom: 1 };
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

class CameraHub {
  constructor({ studio, log, saveConfig }) {
    this.studio = studio;
    this.log = log;
    this.saveConfig = saveConfig || (() => ({ ok: true }));
    this.sockets = new Map(); // station id -> ws
    this.recalled = new Set(); // stations whose framing was restored since the camera came up
    this.nextId = 1;
    this.onChange = () => {};
  }

  send(ws, payload) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  addAgent(ws, stationId) {
    const previous = this.sockets.get(stationId);
    if (previous && previous !== ws) previous.close(4000, 'replaced');
    this.sockets.set(stationId, ws);
    this.recalled.delete(stationId);
    this.studio.setCamera(stationId, { connected: true, ok: false, info: null, state: null, error: null });
    this.log.event('camera_agent_online', { station: stationId });
    this.onChange();
  }

  removeAgent(ws, stationId) {
    if (this.sockets.get(stationId) !== ws) return;
    this.sockets.delete(stationId);
    this.recalled.delete(stationId);
    this.studio.setCamera(stationId, { connected: false, ok: false, info: null, state: null, error: null });
    this.log.event('camera_agent_offline', { station: stationId });
    this.onChange();
  }

  /** Forgets a station that was removed from the configuration. */
  forget(stationId) {
    const ws = this.sockets.get(stationId);
    this.sockets.delete(stationId);
    this.recalled.delete(stationId);
    if (ws) ws.close(4004, 'station removed');
  }

  /** A status report from an agent. */
  update(stationId, msg) {
    const st = this.studio.get(stationId);
    if (!st) return;
    const camera = {
      connected: true,
      ok: !!msg.ok,
      info: msg.info || null,
      state: msg.state || null,
      error: msg.error || null
    };
    this.studio.setCamera(stationId, camera);

    // Camera lost: its framing must be restored again when it comes back.
    if (!camera.ok) this.recalled.delete(stationId);

    if (camera.ok && camera.state && !this.recalled.has(stationId)) {
      this.recalled.add(stationId);
      // Nothing changes by itself on a station that is on air.
      if (st.state !== 'LIVE') {
        const tracking = st.config.tracking || 'off';
        const ws = this.sockets.get(stationId);
        if (tracking !== 'off') {
          // A tracking station frames its guest itself: put that back, not a fixed position.
          this.log.event('camera_tracking_restored', { station: stationId, tracking });
          this.send(ws, { type: 'camera_cmd', id: this.nextId++, cmd: 'tracking', mode: tracking });
        } else if (st.config.framing) {
          this.log.event('camera_framing_restored', { station: stationId, framing: st.config.framing });
          this.send(ws, { type: 'camera_cmd', id: this.nextId++, cmd: 'goto', ...st.config.framing });
        }
      }
    }
    this.onChange();
  }

  /**
   * Moves a station's camera. `order` is { cmd: 'nudge', dpitch, dyaw } |
   * { cmd: 'zoom', dzoom | zoom } | { cmd: 'goto', pitch, yaw, zoom }.
   */
  command(stationId, order) {
    const st = this.studio.get(stationId);
    if (!st) return { ok: false, code: 'unknown_station', message: `Poltrona sconosciuta: ${stationId}` };
    const ws = this.sockets.get(stationId);
    if (!ws) return { ok: false, code: 'camera_offline', message: `Nessun agente telecamera collegato per ${st.label}` };
    if (st.state === 'LIVE') {
      return { ok: false, code: 'is_live', message: 'Poltrona in onda: la telecamera non si muove. Regola in anteprima.' };
    }
    // The SDK drops tracking on the first manual move: refuse instead of
    // silently undoing the mode the operator chose.
    if ((st.config.tracking || 'off') !== 'off') {
      return { ok: false, code: 'tracking_on', message: 'La telecamera segue l\'ospite: scegli «Fissa» per muoverla a mano.' };
    }

    const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
    let payload;
    if (order.cmd === 'nudge') {
      const dpitch = clamp(num(order.dpitch) || 0, [-STEP_LIMITS.dpitch, STEP_LIMITS.dpitch]);
      const dyaw = clamp(num(order.dyaw) || 0, [-STEP_LIMITS.dyaw, STEP_LIMITS.dyaw]);
      payload = { cmd: 'nudge', dpitch, dyaw };
    } else if (order.cmd === 'zoom') {
      if (num(order.zoom) !== null) payload = { cmd: 'zoom', zoom: clamp(num(order.zoom), LIMITS.zoom) };
      else payload = { cmd: 'zoom', dzoom: clamp(num(order.dzoom) || 0, [-STEP_LIMITS.dzoom, STEP_LIMITS.dzoom]) };
    } else if (order.cmd === 'goto') {
      const pitch = num(order.pitch);
      const yaw = num(order.yaw);
      if (!Number.isFinite(pitch) || !Number.isFinite(yaw)) {
        return { ok: false, code: 'bad_framing', message: 'Inquadratura non valida' };
      }
      payload = { cmd: 'goto', pitch: clamp(pitch, LIMITS.pitch), yaw: clamp(yaw, LIMITS.yaw) };
      if (num(order.zoom) !== null) payload.zoom = clamp(num(order.zoom), LIMITS.zoom);
    } else {
      return { ok: false, code: 'bad_command', message: `Comando telecamera sconosciuto: ${order.cmd}` };
    }

    this.send(ws, { type: 'camera_cmd', id: this.nextId++, ...payload });
    this.log.event('camera_cmd', { station: stationId, ...payload });
    return { ok: true };
  }

  /**
   * Chooses how a station's camera frames its guest. Saved in config.json and
   * put back whenever the camera comes online. Never changed on air: switching
   * to tracking moves the picture.
   */
  setTracking(stationId, mode) {
    const st = this.studio.get(stationId);
    if (!st) return { ok: false, code: 'unknown_station', message: `Poltrona sconosciuta: ${stationId}` };
    if (!TRACKING_MODES.includes(mode)) {
      return { ok: false, code: 'bad_tracking', message: `Modo di inquadratura sconosciuto: ${mode}` };
    }
    if (st.state === 'LIVE') {
      return { ok: false, code: 'is_live', message: 'Poltrona in onda: il modo di inquadratura non si cambia in onda.' };
    }

    if (mode === 'off') delete st.config.tracking;
    else st.config.tracking = mode;
    const saved = this.saveConfig();
    this.log.event('camera_tracking', { station: stationId, tracking: mode, saved: saved.ok });

    // With no agent connected the choice still counts: it applies when the camera comes online.
    const ws = this.sockets.get(stationId);
    if (ws) this.send(ws, { type: 'camera_cmd', id: this.nextId++, cmd: 'tracking', mode });
    this.onChange();
    return saved.ok ? { ok: true } : { ok: false, code: 'not_persisted', message: 'Modo applicato ma non salvato su config.json' };
  }

  /** Stores where the camera is pointing now as this station's framing. */
  saveFraming(stationId) {
    const st = this.studio.get(stationId);
    if (!st) return { ok: false, code: 'unknown_station', message: `Poltrona sconosciuta: ${stationId}` };
    if ((st.config.tracking || 'off') !== 'off') {
      return { ok: false, code: 'tracking_on', message: 'La telecamera segue l\'ospite: una posizione fissa non si salva finché il tracking è attivo.' };
    }
    const cam = st.camera;
    if (!cam || !cam.ok || !cam.state) {
      return { ok: false, code: 'camera_offline', message: 'Telecamera non disponibile: niente da salvare' };
    }
    st.config.framing = {
      pitch: Math.round(cam.state.pitch * 10) / 10,
      yaw: Math.round(cam.state.yaw * 10) / 10,
      zoom: Math.round(cam.state.zoom * 100) / 100
    };
    const saved = this.saveConfig();
    this.log.event('camera_framing_saved', { station: stationId, framing: st.config.framing, saved: saved.ok });
    this.onChange();
    return saved.ok ? { ok: true, framing: st.config.framing } : { ok: false, code: 'not_persisted', message: 'Inquadratura applicata ma non salvata su config.json' };
  }

  recallFraming(stationId) {
    const st = this.studio.get(stationId);
    if (!st) return { ok: false, code: 'unknown_station', message: `Poltrona sconosciuta: ${stationId}` };
    if (!st.config.framing) return { ok: false, code: 'no_framing', message: `${st.label} non ha un'inquadratura salvata` };
    return this.command(stationId, { cmd: 'goto', ...st.config.framing });
  }
}

module.exports = { CameraHub, LIMITS, TRACKING_MODES };
