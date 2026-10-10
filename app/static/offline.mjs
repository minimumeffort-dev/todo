export function createOfflineRuntime({ navigator = globalThis.navigator,
  secure = globalThis.isSecureContext === true, timeoutMs = 180_000 } = {}) {
  let state = Object.freeze({ phase: 'idle', message: 'App cache has not been checked.', persistent: null });
  let pending = null;
  const listeners = new Set();
  function notify(listener) { try { listener(state); } catch { /* Isolate UI listeners. */ } }
  function publish(phase, message, persistent = state.persistent) {
    state = Object.freeze({ phase, message, persistent });
    for (const listener of listeners) notify(listener);
  }
  function initialize() {
    if (pending) return pending;
    if (!secure || !navigator?.serviceWorker) {
      publish('unsupported', 'Offline app caching requires a secure browser with service workers.');
      return Promise.resolve(state);
    }
    publish('caching', 'Caching app files…');
    pending = (async () => {
      let persistent = null;
      try { persistent = await navigator.storage?.persist?.() ?? null; } catch { /* Denial is distinct from cache failure. */ }
      publish('caching', 'Caching app files…', persistent);
      const registration = await navigator.serviceWorker.register('/service-worker.mjs', { type: 'module', scope: '/', updateViaCache: 'none' });
      let worker = registration.installing ?? registration.waiting ?? registration.active;
      if (!worker) throw Error('No app cache worker');
      if (worker.state !== 'activated') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { finish(); reject(Error('App cache installation timed out')); }, timeoutMs);
          const finish = () => { clearTimeout(timer); worker.removeEventListener('statechange', changed); };
          const changed = () => {
            if (worker.state === 'activated') { finish(); resolve(); }
            if (worker.state === 'redundant') { finish(); reject(Error('App cache installation failed')); }
          };
          worker.addEventListener('statechange', changed); changed();
        });
      }
      const result = await new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); reject(Error('App cache check timed out')); }, timeoutMs);
        channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
        worker.postMessage({ type: 'prepare-shell' }, [channel.port2]);
      });
      if (!result?.ready) throw Error(result?.message ?? 'App caching failed');
      publish('ready', persistent === false ? 'App cached. Persistent storage permission was not granted.' : 'App cached for offline use.');
      return state;
    })().catch(error => {
      publish('error', error.message || 'App caching failed. Connect and retry.');
      throw error;
    }).finally(() => { pending = null; });
    return pending;
  }
  return Object.freeze({ initialize, recover: initialize,
    subscribe(listener) { listeners.add(listener); notify(listener); return () => listeners.delete(listener); } });
}
export const offlineRuntime = createOfflineRuntime();
