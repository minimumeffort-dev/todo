// This module does not import Transformers.js or create a worker until activation.
import { MODEL_ARTIFACT, TASK_INPUT_VERSION, taskSnapshot } from './model-worker.mjs';

const IDLE = Object.freeze({
  phase: 'idle', progress: null, message: 'Load EmbeddingGemma 2 on this device.',
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
  let embedding = null;
  const queue = [];
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
    const requests = [embedding, ...queue.splice(0)].filter(Boolean);
    operation = null;
    embedding = null;
    stopWorker();
    publish(phase, null, message);
    pending?.reject(new Error(message));
    for (const request of requests) request.reject(new Error(message));
  }

  function watch() {
    clearTimeout(timer);
    const pending = operation ?? embedding;
    timer = setTimeout(() => {
      if (pending && (operation === pending || embedding === pending)) fail('error',
        'The model stopped responding. Check your connection and GPU memory, then retry.');
    }, inactivityTimeoutMs);
    timer.unref?.();
  }

  function finishEmbedding(error, result) {
    const pending = embedding;
    embedding = null;
    clearTimeout(timer);
    timer = null;
    if (error) pending.reject(error);
    else pending.resolve(result);
    startNextEmbedding();
  }

  function startNextEmbedding() {
    if (embedding || !queue.length || !worker || state.phase !== 'ready') return;
    embedding = queue.shift();
    watch();
    try {
      worker.postMessage({ type: 'embed-task', id: embedding.id, ...embedding.snapshot });
    } catch {
      fail('error', 'The model worker could not receive this task. Reload the model and retry.');
    }
  }

  function handleEmbedding(data) {
    if (data.type === 'embedding-error') {
      finishEmbedding(new Error(typeof data.message === 'string' ? data.message
        : 'Could not embed this task. Please retry.'));
      return;
    }
    const result = data.result;
    const valid = data.type === 'embedding'
      && result?.title === embedding.snapshot.title && result?.icon === embedding.snapshot.icon
      && result.model === MODEL_ARTIFACT.id && result.revision === MODEL_ARTIFACT.revision
      && result.input_version === TASK_INPUT_VERSION && result.dimensions === MODEL_ARTIFACT.dimensions
      && Array.isArray(result.vector) && result.vector.length === MODEL_ARTIFACT.dimensions
      && Array.from(result.vector).every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value)))
      && result.vector.some(value => Math.fround(value) !== 0);
    if (!valid) {
      finishEmbedding(new Error('The model returned an invalid task embedding. Please retry.'));
      return;
    }
    finishEmbedding(null, { ...result, vector: [...result.vector] });
  }

  function embedTask(task) {
    let snapshot;
    try { snapshot = taskSnapshot(task); } catch (error) { return Promise.reject(error); }
    if (state.phase !== 'ready' || !worker) {
      return Promise.reject(new Error('Load the model before embedding a task.'));
    }
    const promise = new Promise((resolve, reject) => {
      queue.push({ id: ++sequence, snapshot, resolve, reject });
    });
    startNextEmbedding();
    return promise;
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
        if (worker !== startedWorker) return;
        if (embedding && data?.id === embedding.id) {
          handleEmbedding(data);
          return;
        }
        if (operation?.id !== id || data?.id !== id) return;
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
          startNextEmbedding();
        } else if (data.phase === 'error' || data.phase === 'unsupported') {
          fail(data.phase, typeof data.message === 'string' ? data.message : 'The model could not run. Please retry.');
        } else {
          fail('error', 'The model worker returned an unexpected response. Please retry.');
        }
      };
      worker.onerror = event => {
        if (worker !== startedWorker) return;
        event.preventDefault?.();
        fail('error', 'The model worker failed. Check browser support, connection and GPU memory, then retry.');
      };
      worker.onmessageerror = () => {
        if (worker === startedWorker) {
          fail('error', 'The model worker could not send its result. Please retry.');
        }
      };
      watch();
      publish('loading', null, 'Checking WebGPU and model setup…');
      // Activation uses only a fixed sample. Saved task content is sent separately
      // by embedTask; drafts and other UI state are never sent implicitly.
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
    const requests = [embedding, ...queue.splice(0)].filter(Boolean);
    operation = null;
    embedding = null;
    stopWorker();
    if (pending || requests.length) {
      const error = new Error('Model work was cancelled.');
      error.name = 'AbortError';
      pending?.reject(error);
      for (const request of requests) request.reject(error);
    }
    publish(IDLE.phase, IDLE.progress, IDLE.message);
  }

  return Object.freeze({ loadAndTest, embedTask, subscribe, dispose });
}

export const modelRuntime = createModelRuntime();
