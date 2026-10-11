import { modelCache, ModelCacheError } from './model-cache.mjs';
// Verified against the repository's immutable configuration and model card:
// embedding_gemma2, AutoTokenizer, text-only model_q4.onnx + its external data.
// The model card recommends q4 on WebGPU; Transformers.js 4.3.1 supports this
// architecture. Only a successful, validated inference can publish ready.
export const MODEL_ARTIFACT = Object.freeze({
  id: 'onnx-community/embeddinggemma-2-ONNX',
  revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0',
  dtype: 'q4',
  // text_config.embedding_dim in the pinned config.json.
  dimensions: 768,
});
export const TASK_INPUT_VERSION = 1;
export const TRANSFORMERS_VERSION = '4.3.1';
export const TRANSFORMERS_URL = '/vendor/transformers/transformers.min.js';
const SAMPLE = 'A small test sentence for the local to-do model.';
const SETUP_MESSAGE = 'EmbeddingGemma 2 setup is incomplete: its immutable ONNX revision, tokenizer and WebGPU weights must be verified before loading.';
const TASK_ICONS = new Set(['task', 'star', 'home', 'work', 'shopping', 'heart']);

export function taskSnapshot(task) {
  if (typeof task?.title !== 'string' || !task.title.trim() || [...task.title].length > 500
    || !TASK_ICONS.has(task.icon)) {
    throw new Error('A saved task title and icon are required for embedding.');
  }
  return { title: task.title, icon: task.icon };
}

export function queryText(query) {
  if (typeof query !== 'string' || !query.trim() || [...query.trim()].length > 500) {
    throw new Error('Use a search query with 1–500 characters.');
  }
  return query.trim();
}

class ModelFailure extends Error {
  constructor(phase, message) {
    super(message);
    this.phase = phase;
  }
}

function validateEmbedding(output, dimensions) {
  const embedding = output?.sentence_embedding;
  if (!embedding || !['float32', 'float64'].includes(embedding.type)
    || embedding.dims?.length !== 2 || embedding.dims[0] !== 1
    || embedding.dims[1] !== dimensions
    || embedding.data?.length !== embedding.dims[1]) {
    throw new ModelFailure('error', 'EmbeddingGemma 2 returned an invalid sample embedding. Please retry.');
  }
  let norm = 0;
  for (const value of embedding.data) {
    if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
      throw new ModelFailure('error', 'EmbeddingGemma 2 returned non-finite sample output. Please retry.');
    }
    norm += Math.fround(value) ** 2;
  }
  if (!Number.isFinite(norm) || norm <= 0) {
    throw new ModelFailure('error', 'EmbeddingGemma 2 returned an empty sample embedding. Please retry.');
  }
  // Copy before releasing the GPU-backed output tensor.
  return Array.from(embedding.data, value => Math.fround(value));
}

function discardTensors(...collections) {
  const tensors = new Set(collections.flatMap(collection => Object.values(collection ?? {})));
  for (const tensor of tensors) {
    try { tensor?.dispose?.(); } catch { /* Continue releasing the other outputs. */ }
  }
}

async function loadModelWithRejections(load, errorEvents) {
  let rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  const onRejection = event => {
    // Transformers.js 4.3.1's external-data loader uses an async Promise
    // executor without forwarding its rejection. The outer model load hangs,
    // but the worker still reports this event. Confine it to the model panel.
    event.preventDefault?.();
    rejectFailure(event.reason ?? new Error('Model loading failed'));
  };
  errorEvents.addEventListener?.('unhandledrejection', onRejection);
  const pending = Promise.resolve().then(load);
  let accepted = false;
  try {
    const model = await Promise.race([pending, failure]);
    accepted = true;
    return model;
  } finally {
    errorEvents.removeEventListener?.('unhandledrejection', onRejection);
    // A load that finishes after failure must not retain its GPU resources.
    if (!accepted) void pending.then(model => model?.dispose?.()).catch(() => {});
  }
}

// Dependency injection keeps lifecycle tests offline; the deployed handler uses
// the constants above and receives no runtime/model configuration from the UI.
export function createModelWorker({
  postMessage,
  gpu = globalThis.navigator?.gpu,
  importRuntime = () => import(TRANSFORMERS_URL),
  artifact = MODEL_ARTIFACT,
  errorEvents = globalThis,
  cache = modelCache,
} = {}) {
  let active = null;
  let model = null;
  let tokenizer = null;
  let generation = 0;
  let queue = Promise.resolve();
  let ready = false;

  async function releaseModel() {
    const previous = model;
    model = tokenizer = null;
    ready = false;
    try { await previous?.dispose(); } catch { /* Parent termination releases the worker context too. */ }
  }

  async function run(id, current) {
    const emit = (phase, progress, message) => {
      if (current === generation) postMessage({ id, phase, progress, message });
    };
    const checkCurrent = () => {
      if (current !== generation) throw new Error('Cancelled');
    };
    let stage = 'runtime';
    let inputs;
    let output;
    try {
      checkCurrent();
      await releaseModel();
      checkCurrent();
      if (artifact.id !== MODEL_ARTIFACT.id || !/^[a-f0-9]{40}$/.test(artifact.revision ?? '')
        || !['fp32', 'fp16', 'q8', 'q4', 'q4f16'].includes(artifact.dtype)
        || !Number.isSafeInteger(artifact.dimensions) || artifact.dimensions < 1) {
        throw new ModelFailure('error', SETUP_MESSAGE);
      }
      if (!gpu) throw new ModelFailure('unsupported', 'WebGPU is unavailable in this browser’s model worker. Use a WebGPU-capable browser on HTTPS or localhost.');
      let adapter;
      try { adapter = await gpu.requestAdapter(); } catch { /* Report unsupported below. */ }
      checkCurrent();
      if (!adapter) throw new ModelFailure('unsupported', 'No WebGPU adapter is available. Enable hardware acceleration or try another WebGPU-capable browser.');
      if (['fp16', 'q4f16'].includes(artifact.dtype) && !adapter.features.has('shader-f16')) {
        throw new ModelFailure('unsupported', 'These EmbeddingGemma 2 weights require WebGPU shader-f16 support. Use a compatible GPU and browser.');
      }
      emit('loading', null, 'Loading the pinned Transformers.js runtime…');
      const { AutoConfig, AutoTokenizer, AutoModel, env } = await importRuntime();
      checkCurrent();
      if (env.version !== TRANSFORMERS_VERSION) throw new ModelFailure('error', 'The model runtime version does not match its pin. Reload and retry.');
      stage = 'cache';
      const saved = await cache.prepare(info => emit('loading', info.progress, info.message));
      checkCurrent();
      if (!saved.complete) throw new ModelCacheError('Model files have not finished saving. Please retry.');
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.localModelPath = '/models/';
      env.remotePathTemplate = `{model}/resolve/${artifact.revision}/`;
      env.useBrowserCache = env.useFSCache = false;
      env.useCustomCache = true;
      env.customCache = saved.customCache;
      env.backends.onnx.wasm.wasmPaths = '/vendor/onnx/';
      // Inference stays in this worker even when cross-origin isolation is absent.
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;

      const options = { revision: artifact.revision, local_files_only: true };
      stage = 'configuration';
      emit('loading', null, 'Loading the pinned EmbeddingGemma 2 configuration…');
      const config = await AutoConfig.from_pretrained(artifact.id, options);
      checkCurrent();
      if (config.model_type !== 'embedding_gemma2'
        || config.text_config?.embedding_dim !== artifact.dimensions) {
        throw new ModelFailure('error', 'The pinned artifact is not a supported EmbeddingGemma 2 model. Model setup must be checked.');
      }
      // The published runtime explicitly supports text-only loading this way.
      // No image/audio encoders or task content are needed for this fixed test.
      config.vision_config = config.audio_config = null;
      stage = 'tokenizer';
      tokenizer = await AutoTokenizer.from_pretrained(artifact.id, options);
      checkCurrent();
      stage = 'model';
      let lastProgressAt = 0;
      let lastProgress = null;
      model = await loadModelWithRejections(() => AutoModel.from_pretrained(artifact.id, {
        ...options, config, device: 'webgpu', dtype: artifact.dtype,
        progress_callback: info => {
          if (info.status === 'progress_total') {
            const progress = Number.isFinite(info.progress) && info.total > 0
              ? Math.min(1, Math.max(0, info.progress / 100)) : null;
            const now = Date.now();
            // Limit chunk updates to keep task controls responsive during a
            // large download, while preserving unknown totals and completion.
            if (progress === null || lastProgress === null || progress === 1 || now - lastProgressAt >= 100) {
              lastProgressAt = now;
              lastProgress = progress;
              emit('loading', progress, 'Loading saved EmbeddingGemma 2 weights…');
            }
          }
        },
      }), errorEvents);
      checkCurrent();
      stage = 'inference';
      emit('testing', null, 'Testing a fixed sample on WebGPU…');
      inputs = tokenizer(SAMPLE, { padding: true, truncation: true, max_length: 64 });
      output = await model(inputs);
      checkCurrent();
      validateEmbedding(output, artifact.dimensions);
      discardTensors(inputs, output);
      inputs = output = null;
      ready = true;
      emit('ready', 1, 'EmbeddingGemma 2 passed its sample test on WebGPU.');
    } catch (error) {
      discardTensors(inputs, output);
      await releaseModel();
      const message = error instanceof ModelFailure || error instanceof ModelCacheError ? error.message
        : stage === 'runtime' ? 'Could not load the local Transformers.js runtime. Reload the app or repair its offline cache, then retry.'
          : stage === 'inference' ? 'The EmbeddingGemma 2 test failed. Check available GPU memory or restart the browser, then retry.'
            : 'Could not load EmbeddingGemma 2. Check access to huggingface.co and model download hosts, connection and GPU memory, then retry.';
      emit(error instanceof ModelFailure ? error.phase : 'error', null, message);
    }
  }

  async function runEmbedding(message, current) {
    let inputs;
    let output;
    const send = data => {
      if (current === generation) postMessage({ id: message.id, ...data });
    };
    try {
      if (current !== generation) return;
      const isQuery = message.type === 'embed-query';
      const snapshot = isQuery ? {} : taskSnapshot(message);
      const text = isQuery ? queryText(message.query) : `Icon: ${snapshot.icon}\nTask: ${snapshot.title}`;
      if (!ready || !model || !tokenizer) throw new Error('Load the model before embedding.');
      // Input format v1 is one text embedding with the saved icon's text key.
      // Titles are bounded to 500 characters; retain their entire tokenized input.
      inputs = tokenizer(text, { padding: true, truncation: false });
      output = await model(inputs);
      if (current !== generation) return;
      const vector = validateEmbedding(output, artifact.dimensions);
      send({ type: 'embedding', result: {
        ...snapshot, vector, model: artifact.id, revision: artifact.revision,
        input_version: TASK_INPUT_VERSION, dimensions: artifact.dimensions,
      } });
    } catch {
      // A task failure is separate from model loading. Keep the resident model
      // and allow a retry; crashes/timeouts are handled by the parent runtime.
      send({ type: 'embedding-error', message: message.type === 'embed-query'
        ? 'Could not search with this query. Please retry.' : 'Could not embed this task. Please retry.' });
    } finally {
      discardTensors(inputs, output);
    }
  }

  function enqueue(runOperation) {
    const pending = queue.then(runOperation);
    queue = pending.catch(() => {});
    return pending;
  }

  function handleMessage(message) {
    if (!Number.isSafeInteger(message?.id) || message.id < 1) return Promise.resolve();
    if (message.type === 'embed-task' || message.type === 'embed-query') {
      const current = generation;
      // Capture source fields now so a queued caller cannot change the snapshot.
      const snapshot = { type: message.type, id: message.id,
        title: message.title, icon: message.icon, query: message.query };
      return enqueue(() => runEmbedding(snapshot, current));
    }
    if (message.type !== 'load-and-test') return Promise.resolve();
    if (active) return active;
    // Start in a microtask so duplicate activations always share this operation.
    const current = generation;
    active = enqueue(() => run(message.id, current)).finally(() => { active = null; });
    return active;
  }

  async function dispose() {
    ++generation;
    await releaseModel();
  }

  return { handleMessage, dispose };
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  const handler = createModelWorker({ postMessage: message => globalThis.postMessage(message) });
  globalThis.onmessage = event => { void handler.handleMessage(event.data); };
}
