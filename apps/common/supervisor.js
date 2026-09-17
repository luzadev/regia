'use strict';

/**
 * Keeps a child process alive: the Regia server inside the control room app,
 * the camera agent inside the station app.
 *
 * A child that dies is started again with a growing delay (reset once it has
 * stayed up for a while), unless `isFinal` says the exit means "do not retry":
 * a port already taken, an agent replaced by another computer. Retrying those
 * would only hide the reason behind an endless loop.
 */

function createSupervisor({
  spawn,
  isFinal = () => false,
  onMessage = () => {},
  onExit = () => {},
  onFinal = () => {},
  restartDelayMs = 1000,
  maxDelayMs = 30000,
  stableMs = 30000,
  stopTimeoutMs = 3000,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let child = null;
  let timer = null;
  let stopping = false;
  let delay = restartDelayMs;
  let startedAt = 0;
  let restarts = 0;
  let lastMessage = null;

  function start() {
    stopping = false;
    clearTimer(timer);
    timer = null;
    lastMessage = null;
    startedAt = now();
    const proc = spawn();
    child = proc;

    proc.on('message', (m) => {
      lastMessage = m;
      onMessage(m, proc);
    });
    proc.on('exit', (code, signal) => {
      if (child !== proc) return;
      child = null;
      const info = { code, signal, lastMessage, uptimeMs: now() - startedAt, restarts };
      onExit(info);
      if (stopping) return;
      if (isFinal(info)) {
        onFinal(info);
        return;
      }
      if (info.uptimeMs >= stableMs) delay = restartDelayMs;
      restarts++;
      timer = setTimer(start, delay);
      delay = Math.min(delay * 2, maxDelayMs);
    });
    // A child that cannot even be spawned reports through 'error' and may
    // never emit 'exit': treat it as an exit so the retry logic still runs.
    proc.on('error', () => {
      if (child === proc && proc.exitCode === null && !proc.pid) proc.emit('exit', null, null);
    });
    return proc;
  }

  /** Asks the child to shut down cleanly, then kills it if it does not. */
  function stop() {
    stopping = true;
    clearTimer(timer);
    timer = null;
    const proc = child;
    if (!proc) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = setTimer(() => {
        try { proc.kill(); } catch {}
      }, stopTimeoutMs);
      proc.once('exit', () => {
        clearTimer(kill);
        resolve();
      });
      try {
        if (proc.connected) proc.send({ type: 'shutdown' });
        else proc.kill();
      } catch {
        try { proc.kill(); } catch {}
      }
    });
  }

  return {
    start,
    stop,
    get running() { return !!child; },
    get restarts() { return restarts; }
  };
}

module.exports = { createSupervisor };
