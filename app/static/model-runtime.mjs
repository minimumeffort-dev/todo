// This module does not import Transformers.js or create a worker until activation.
const IDLE = Object.freeze({
  phase: 'idle', progress: null, message: 'Load and test EmbeddingGemma 2 on this device.',
});

export function createModelRuntime({
  createWorker = () => new Worker(new URL('./model-worker.mjs', import.meta.url), { type: 'module' }),
  supportsWebGPU = () => globalThis.isSecureContext === true
    && typeof globalThis.Worker === 'function' && !!globalThis.navigator?.gpu,
  inactivityTimeoutMs = 180_000,
} = {}) {
  let state = IDLE;
  let worker = null;
  let operation = null;
  let sequence = 0;
  let timer = null;
  const listeners = new Set();

  function notify(listener) {
    // A failing UI subscriber must not interrupt the model lifecycle.
    try { listener(state); } catch { /* Other subscribers still receive updates. */ }
  }

  function publish(phase, progress, message) {
    state = Object.freeze({ phase, progress, message });
    for (const listener of listeners) notify(listener);
  }

  function stopWorker() {
    clearTimeout(timer);
    timer = null;
    if (!worker) return;
    worker.onmessage = worker.onerror = worker.onmessageerror = null;
    worker.terminate();
    worker = null;
  }

  function fail(phase, message) {
    const pending = operation;
    operation = null;
    stopWorker();
    publish(phase, null, message);
    pending?.reject(new Error(message));
  }

  function watch() {
    clearTimeout(timer);
    const id = operation.id;
    timer = setTimeout(() => {
      if (operation?.id === id) fail('error',
        'The model stopped responding. Check your connection and GPU memory, then retry.');
    }, inactivityTimeoutMs);
    timer.unref?.();
  }

  function loadAndTest() {
    if (operation) return operation.promise;
    if (state.phase === 'ready') return Promise.resolve();

    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    const id = ++sequence;
    operation = { promise, resolve, reject, id };

    try {
      if (!supportsWebGPU()) {
        fail('unsupported', 'WebGPU and module workers are required. Use a WebGPU-capable browser on HTTPS or localhost.');
        return promise;
      }
      worker = createWorker();
      const startedWorker = worker;
      worker.onmessage = event => {
        const data = event.data;
        if (worker !== startedWorker || operation?.id !== id || data?.id !== id) return;
        if (data.phase === 'loading' || data.phase === 'testing') {
          if (state.phase === 'testing' && data.phase === 'loading') return;
          watch();
          const progress = data.phase === 'loading' && Number.isFinite(data.progress)
            ? Math.min(1, Math.max(0, data.progress)) : null;
          publish(data.phase, progress, typeof data.message === 'string' ? data.message
            : data.phase === 'testing' ? 'Testing a fixed sample on WebGPU…' : 'Loading EmbeddingGemma 2…');
        } else if (data.phase === 'ready' && state.phase === 'testing') {
          clearTimeout(timer);
          timer = null;
          const pending = operation;
          operation = null;
          publish('ready', 1, 'EmbeddingGemma 2 passed its sample test on WebGPU.');
          pending.resolve();
        } else if (data.phase === 'error' || data.phase === 'unsupported') {
          fail(data.phase, typeof data.message === 'string' ? data.message : 'The model could not run. Please retry.');
        } else {
          fail('error', 'The model worker returned an unexpected response. Please retry.');
        }
      };
      worker.onerror = event => {
        if (worker !== startedWorker || operation?.id !== id) return;
        event.preventDefault?.();
        fail('error', 'The model worker failed. Check browser support, connection and GPU memory, then retry.');
      };
      worker.onmessageerror = () => {
        if (worker === startedWorker && operation?.id === id) {
          fail('error', 'The model worker could not send its result. Please retry.');
        }
      };
      watch();
      publish('loading', null, 'Checking WebGPU and model setup…');
      // Never send task titles, drafts, or other user content to the worker.
      if (operation?.id === id) worker.postMessage({ type: 'load-and-test', id });
    } catch {
      fail('error', 'Could not start the model worker. Check browser support and reload, then retry.');
    }
    return promise;
  }

  function subscribe(listener) {
    listeners.add(listener);
    notify(listener);
    return () => listeners.delete(listener);
  }

  function dispose() {
    const pending = operation;
    operation = null;
    stopWorker();
    if (pending) {
      const error = new Error('Model loading was cancelled.');
      error.name = 'AbortError';
      pending.reject(error);
    }
    publish(IDLE.phase, IDLE.progress, IDLE.message);
  }

  return Object.freeze({ loadAndTest, subscribe, dispose });
}

export const modelRuntime = createModelRuntime();
