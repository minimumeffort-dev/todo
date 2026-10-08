import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createModelRuntime, modelRuntime } from '../app/static/model-runtime.mjs';
import {
  createModelWorker, MODEL_ARTIFACT, TRANSFORMERS_URL, TRANSFORMERS_VERSION,
} from '../app/static/model-worker.mjs';

class StubWorker {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.messages = [];
    this.terminated = false;
  }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(phase, extra = {}) {
    this.onmessage?.({ data: { id: this.messages[0].id, phase, ...extra } });
  }
  succeed() {
    this.emit('testing');
    this.emit('ready');
  }
}

function runtimeFixture(options = {}) {
  const workers = [];
  const states = [];
  const runtime = createModelRuntime({
    supportsWebGPU: () => true,
    createWorker: () => { const worker = new StubWorker(); workers.push(worker); return worker; },
    ...options,
  });
  runtime.subscribe(state => states.push(state));
  return { runtime, workers, states };
}

test('import and immediate subscriptions do not activate a worker or check WebGPU', () => {
  let checked = false;
  const { runtime, workers, states } = runtimeFixture({ supportsWebGPU: () => { checked = true; return true; } });
  assert.equal(checked, false);
  assert.equal(workers.length, 0);
  assert.deepEqual(states.map(state => state.phase), ['idle']);
  assert.deepEqual(Object.keys(states[0]), ['phase', 'progress', 'message']);
  assert.ok(Object.isFrozen(states[0]));
  let initial;
  const unsubscribe = modelRuntime.subscribe(state => { initial = state; });
  assert.equal(initial.phase, 'idle');
  unsubscribe();
  runtime.dispose();
});

test('activation uses one module worker and concurrent calls share a promise', async () => {
  const savedWorker = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class extends StubWorker {
    constructor(...args) { super(...args); workers.push(this); }
  };
  const runtime = createModelRuntime({ supportsWebGPU: () => true });
  try {
    const first = runtime.loadAndTest();
    const second = runtime.loadAndTest();
    assert.equal(first, second);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].options.type, 'module');
    assert.equal(workers[0].url.pathname, new URL('../app/static/model-worker.mjs', import.meta.url).pathname);
    assert.deepEqual(workers[0].messages, [{ type: 'load-and-test', id: 1 }]);
    workers[0].succeed();
    assert.equal(await first, undefined);
    await runtime.loadAndTest();
    assert.equal(workers.length, 1);
    assert.equal(workers[0].messages.length, 1);
  } finally {
    runtime.dispose();
    if (savedWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = savedWorker;
  }
});

test('progress stays null or a finite fraction; inference is required before ready', async () => {
  const { runtime, workers, states } = runtimeFixture();
  const pending = runtime.loadAndTest();
  const worker = workers[0];
  worker.emit('loading', { progress: 0.25 });
  worker.emit('loading', { progress: Infinity });
  worker.emit('loading', { progress: -20 });
  worker.emit('loading', { progress: 250 });
  worker.emit('testing', { progress: 0.5 });
  worker.emit('loading', { progress: 0.5 }); // Ignore stale download callbacks after testing begins.
  worker.emit('ready');
  await pending;
  assert.deepEqual(states.map(state => state.phase), ['idle', 'loading', 'loading', 'loading', 'loading', 'loading', 'testing', 'ready']);
  assert.deepEqual(states.map(state => state.progress), [null, null, 0.25, null, 0, 1, null, 1]);
  runtime.dispose();

  const early = runtimeFixture();
  const earlyPending = early.runtime.loadAndTest();
  early.workers[0].emit('ready');
  await assert.rejects(earlyPending, /unexpected response/);
  assert.equal(early.states.at(-1).phase, 'error');
  assert.equal(early.workers[0].terminated, true);
});

test('unsupported browsers do not create a worker and activation can retry later', async () => {
  let supported = false;
  const { runtime, workers, states } = runtimeFixture({ supportsWebGPU: () => supported });
  await assert.rejects(runtime.loadAndTest(), /WebGPU.*HTTPS or localhost/);
  assert.equal(states.at(-1).phase, 'unsupported');
  assert.equal(workers.length, 0);
  supported = true;
  const retry = runtime.loadAndTest();
  workers[0].succeed();
  await retry;
  assert.equal(states.at(-1).phase, 'ready');
  runtime.dispose();
});

test('worker errors terminate resources and retry uses a fresh worker', async () => {
  for (const kind of ['error', 'unsupported', 'crash', 'messageerror']) {
    const { runtime, workers, states } = runtimeFixture();
    const failed = runtime.loadAndTest();
    const worker = workers[0];
    const staleCrash = worker.onerror;
    if (kind === 'crash') {
      let prevented = false;
      worker.onerror({ preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true);
    } else if (kind === 'messageerror') worker.onmessageerror();
    else worker.emit(kind, { message: 'Please retry this sample test.' });
    await assert.rejects(failed);
    assert.equal(states.at(-1).phase, kind === 'unsupported' ? kind : 'error');
    assert.equal(states.at(-1).progress, null);
    assert.equal(worker.terminated, true);
    assert.equal(worker.onmessage, null);
    const retry = runtime.loadAndTest();
    assert.equal(workers.length, 2);
    staleCrash({}); // An already queued error from the old worker cannot fail the retry.
    workers[1].emit('ready', { id: 1 }); // A stale request cannot make it ready.
    assert.equal(states.at(-1).phase, 'loading');
    workers[1].succeed();
    await retry;
    runtime.dispose();
  }
});

test('worker construction and postMessage failures become panel errors', async () => {
  const brokenConstructor = runtimeFixture({ createWorker: () => { throw new Error('blocked'); } });
  await assert.rejects(brokenConstructor.runtime.loadAndTest(), /start the model worker/);
  assert.equal(brokenConstructor.states.at(-1).phase, 'error');
  const worker = new StubWorker();
  worker.postMessage = () => { throw new Error('closed'); };
  const brokenPost = runtimeFixture({ createWorker: () => worker });
  await assert.rejects(brokenPost.runtime.loadAndTest(), /start the model worker/);
  assert.equal(worker.terminated, true);
});

test('unresponsive workers time out and release resources', async () => {
  const { runtime, workers, states } = runtimeFixture({ inactivityTimeoutMs: 10 });
  const assertion = assert.rejects(runtime.loadAndTest(), /stopped responding/);
  await delay(30);
  await assertion;
  assert.equal(workers[0].terminated, true);
  assert.equal(states.at(-1).phase, 'error');
});

test('disposal cancels pending work, resets to idle and permits later activation', async () => {
  const { runtime, workers, states } = runtimeFixture();
  const pending = runtime.loadAndTest();
  const staleMessage = workers[0].onmessage;
  runtime.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(workers[0].terminated, true);
  assert.equal(states.at(-1).phase, 'idle');
  const next = runtime.loadAndTest();
  staleMessage({ data: { id: 1, phase: 'ready' } });
  assert.equal(states.at(-1).phase, 'loading');
  workers[1].succeed();
  await next;
  runtime.dispose();
  assert.equal(workers[1].terminated, true);
  runtime.dispose();
  assert.equal(states.at(-1).phase, 'idle');
});

test('subscriptions can unsubscribe, fail or dispose during an update', async () => {
  const { runtime, workers } = runtimeFixture();
  let updates = 0;
  runtime.subscribe(() => { throw new Error('bad subscriber'); });
  const unsubscribe = runtime.subscribe(() => { updates++; });
  assert.equal(updates, 1);
  unsubscribe();
  runtime.subscribe(state => { if (state.phase === 'loading') runtime.dispose(); });
  await assert.rejects(runtime.loadAndTest(), { name: 'AbortError' });
  assert.equal(updates, 1);
  assert.equal(workers[0].messages.length, 0);
  assert.equal(workers[0].terminated, true);
});

function embeddingResult(snapshot, changes = {}) {
  return {
    ...snapshot, vector: [0.5, -0.25, ...Array(MODEL_ARTIFACT.dimensions - 2).fill(0)],
    model: MODEL_ARTIFACT.id, revision: MODEL_ARTIFACT.revision,
    input_version: 1, dimensions: MODEL_ARTIFACT.dimensions, ...changes,
  };
}

function answerEmbedding(worker, result, id = worker.messages.at(-1).id) {
  worker.onmessage({ data: { id, type: 'embedding', result } });
}

test('task embedding requires explicit readiness and rejects invalid saved inputs without activation', async () => {
  const { runtime, workers } = runtimeFixture();
  await assert.rejects(runtime.embedTask({ title: 'First task', icon: 'task' }), /Load the model/);
  assert.equal(workers.length, 0);
  const loading = runtime.loadAndTest();
  await assert.rejects(runtime.embedTask({ title: 'During loading', icon: 'task' }), /Load the model/);
  workers[0].succeed();
  await loading;
  for (const task of [null, {}, { title: '', icon: 'task' }, { title: '  ', icon: 'task' },
    { title: 'x'.repeat(501), icon: 'task' }, { title: 12, icon: 'task' }, { title: 'Valid', icon: 'bad' }]) {
    await assert.rejects(runtime.embedTask(task), /saved task title and icon/);
  }
  assert.equal(workers[0].messages.length, 1);
  runtime.dispose();
});

test('first and consecutive task embeddings capture saved values, serialize requests and reuse the loaded worker', async () => {
  const { runtime, workers, states } = runtimeFixture();
  const loading = runtime.loadAndTest();
  workers[0].succeed();
  await loading;
  const worker = workers[0];
  const source = { title: 'Buy groceries', icon: 'shopping' };
  const original = { ...source };
  const first = runtime.embedTask(source);
  source.title = 'Unsaved draft';
  const secondSource = { title: 'Clean home', icon: 'home' };
  const second = runtime.embedTask(secondSource);
  secondSource.icon = 'heart';
  assert.equal(worker.messages.length, 2, 'Only one embedding can be active');
  assert.deepEqual(worker.messages[1], { type: 'embed-task', id: 2, ...original });
  // Late duplicate load messages and unrelated IDs cannot settle a task.
  worker.emit('ready');
  answerEmbedding(worker, embeddingResult({ title: 'Unrelated', icon: 'star' }), 999);
  assert.equal(worker.messages.length, 2);
  const firstResult = embeddingResult(original);
  answerEmbedding(worker, firstResult);
  assert.equal(worker.messages.length, 3);
  assert.deepEqual(worker.messages[2], { type: 'embed-task', id: 3, title: 'Clean home', icon: 'home' });
  const returned = await first;
  assert.deepEqual(returned, firstResult);
  firstResult.vector[0] = 42;
  assert.equal(returned.vector[0], 0.5, 'Result owns its vector data');
  answerEmbedding(worker, embeddingResult({ title: 'Clean home', icon: 'home' }));
  assert.equal((await second).icon, 'home');
  await runtime.loadAndTest();
  assert.equal(workers.length, 1);
  assert.equal(worker.terminated, false);
  assert.deepEqual(states.map(state => state.phase), ['idle', 'loading', 'testing', 'ready']);
  runtime.dispose();
});

test('individual inference errors reject only their request, drain the queue and permit a retry without reloading', async () => {
  const { runtime, workers, states } = runtimeFixture();
  const loading = runtime.loadAndTest();
  workers[0].succeed();
  await loading;
  const source = { title: 'Task for retry', icon: 'work' };
  const first = runtime.embedTask(source);
  const second = runtime.embedTask(source);
  const rejection = assert.rejects(first, /Temporary GPU failure/);
  workers[0].onmessage({ data: { type: 'embedding-error', id: 2, message: 'Temporary GPU failure' } });
  await rejection;
  answerEmbedding(workers[0], embeddingResult(source));
  await second;
  const retry = runtime.embedTask(source);
  answerEmbedding(workers[0], embeddingResult(source));
  await retry;
  assert.equal(states.at(-1).phase, 'ready');
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages.filter(message => message.type === 'load-and-test').length, 1);
  runtime.dispose();
});

test('runtime rejects invalid output and incompatible metadata independently from model lifecycle', async () => {
  const { runtime, workers, states } = runtimeFixture();
  const loading = runtime.loadAndTest();
  workers[0].succeed();
  await loading;
  const source = { title: 'Validate output', icon: 'heart' };
  for (const changes of [
    { title: 'Different source' }, { icon: 'shopping' }, { model: 'other' }, { revision: 'main' },
    { input_version: 2 }, { dimensions: 2 }, { vector: [1, 2] },
    { vector: Array(768).fill(0) }, { vector: Array(768).fill(NaN) },
    { vector: Array(768).fill(Infinity) }, { vector: Array(768).fill(1e100) },
    { vector: Array(768).fill(1e-100) }, { vector: Array(768).fill('0.1') },
  ]) {
    const pending = runtime.embedTask(source);
    const rejection = assert.rejects(pending, /invalid task embedding/);
    answerEmbedding(workers[0], embeddingResult(source, changes));
    await rejection;
    assert.equal(states.at(-1).phase, 'ready');
  }
  runtime.dispose();
});

test('embedding timeouts reject active and queued work, release resources and allow reload then retry', async () => {
  const { runtime, workers, states } = runtimeFixture({ inactivityTimeoutMs: 10 });
  const loading = runtime.loadAndTest();
  workers[0].succeed();
  await loading;
  const source = { title: 'Timed out', icon: 'task' };
  const first = runtime.embedTask(source);
  const second = runtime.embedTask(source);
  const assertions = Promise.all([assert.rejects(first, /stopped responding/), assert.rejects(second, /stopped responding/)]);
  const staleResult = workers[0].onmessage;
  await delay(30);
  await assertions;
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].messages.length, 2, 'Queued requests are never sent to a timed out worker');
  assert.equal(states.at(-1).phase, 'error');
  const reload = runtime.loadAndTest();
  workers[1].succeed();
  await reload;
  const retry = runtime.embedTask(source);
  staleResult({ data: { id: 2, type: 'embedding', result: embeddingResult(source) } });
  answerEmbedding(workers[1], embeddingResult(source));
  await retry;
  runtime.dispose();
});

test('worker crashes, message errors and disposal settle every pending embedding', async () => {
  for (const kind of ['crash', 'messageerror', 'dispose', 'post-failure']) {
    const { runtime, workers, states } = runtimeFixture();
    const loading = runtime.loadAndTest();
    workers[0].succeed();
    await loading;
    const source = { title: 'Interrupted', icon: 'star' };
    const first = runtime.embedTask(source);
    const second = runtime.embedTask(source);
    const expected = kind === 'dispose' ? { name: 'AbortError' } : /model worker/i;
    const assertions = Promise.all([assert.rejects(first, expected), assert.rejects(second, expected)]);
    if (kind === 'crash') workers[0].onerror({});
    if (kind === 'messageerror') workers[0].onmessageerror();
    if (kind === 'dispose') runtime.dispose();
    if (kind === 'post-failure') {
      workers[0].postMessage = () => { throw new Error('Worker closed'); };
      workers[0].onmessage({ data: { id: 2, type: 'embedding-error', message: 'The model worker failed this task' } });
    }
    await assertions;
    assert.equal(workers[0].terminated, true);
    assert.equal(states.at(-1).phase, kind === 'dispose' ? 'idle' : 'error');
    runtime.dispose();
  }
});

test('queries trim and validate text, serialize with tasks, and return only query metadata', async () => {
  const { runtime, workers } = runtimeFixture();
  await assert.rejects(runtime.embedQuery('shopping'), /Load the model/);
  for (const query of [null, 1, {}, '', '  ', 'x'.repeat(501)]) {
    await assert.rejects(runtime.embedQuery(query), /1–500/);
  }
  assert.equal(workers.length, 0);
  const loading = runtime.loadAndTest();
  workers[0].succeed();
  await loading;
  const worker = workers[0];
  const task = runtime.embedTask({ title: 'Saved groceries', icon: 'shopping' });
  const query = runtime.embedQuery('  buy food  ');
  const nextTask = runtime.embedTask({ title: 'Saved chores', icon: 'home' });
  assert.equal(worker.messages.length, 2);
  answerEmbedding(worker, embeddingResult({ title: 'Saved groceries', icon: 'shopping' }));
  await task;
  assert.deepEqual(worker.messages.at(-1), { type: 'embed-query', id: 3, query: 'buy food' });
  const result = embeddingResult({});
  answerEmbedding(worker, result);
  const received = await query;
  assert.deepEqual(received, result);
  result.vector[0] = 42;
  assert.equal(received.vector[0], 0.5);
  assert.deepEqual(worker.messages.at(-1), { type: 'embed-task', id: 4, title: 'Saved chores', icon: 'home' });
  answerEmbedding(worker, embeddingResult({ title: 'Saved chores', icon: 'home' }));
  await nextTask;
  runtime.dispose();
});

test('query metadata failures reject independently and a subsequent query can succeed', async () => {
  const { runtime, workers, states } = runtimeFixture();
  const loading = runtime.loadAndTest();
  workers[0].succeed();
  await loading;
  for (const changes of [{ model: 'wrong' }, { revision: 'main' }, { input_version: 2 },
    { dimensions: 2 }, { vector: [] }, { vector: Array(768).fill(0) },
    { vector: Array(768).fill(NaN) }, { vector: Array(768).fill(1e100) },
    { vector: Array(768).fill(1e-100) }, { vector: Array(768).fill('1') }]) {
    const query = runtime.embedQuery('food');
    const rejection = assert.rejects(query, /invalid query embedding/);
    answerEmbedding(workers[0], embeddingResult({}, changes));
    await rejection;
    assert.equal(states.at(-1).phase, 'ready');
  }
  const failure = runtime.embedQuery('food');
  const rejected = assert.rejects(failure, /Temporary query failure/);
  workers[0].onmessage({ data: { id: workers[0].messages.at(-1).id,
    type: 'embedding-error', message: 'Temporary query failure' } });
  await rejected;
  const retry = runtime.embedQuery('food');
  answerEmbedding(workers[0], embeddingResult({}));
  await retry;
  assert.equal(workers.length, 1);
  runtime.dispose();
});

test('query timeouts, worker failures and disposal also reject queued tasks', async () => {
  for (const kind of ['timeout', 'crash', 'messageerror', 'dispose']) {
    const { runtime, workers } = runtimeFixture({ inactivityTimeoutMs: 10 });
    const loading = runtime.loadAndTest();
    workers[0].succeed();
    await loading;
    const query = runtime.embedQuery('food');
    const task = runtime.embedTask({ title: 'Queued task', icon: 'task' });
    const expectation = kind === 'dispose' ? { name: 'AbortError' } : /stopped responding|worker/i;
    const rejected = Promise.all([assert.rejects(query, expectation), assert.rejects(task, expectation)]);
    if (kind === 'timeout') await delay(30);
    if (kind === 'crash') workers[0].onerror({});
    if (kind === 'messageerror') workers[0].onmessageerror();
    if (kind === 'dispose') runtime.dispose();
    await rejected;
    assert.equal(workers[0].terminated, true);
    runtime.dispose();
  }
});

// Deliberately fictional offline fixtures, never selected by the app.
const fixtureArtifact = { id: MODEL_ARTIFACT.id, revision: 'a'.repeat(40), dtype: 'fp32', dimensions: 2 };

function tensor(values = [0.6, 0.8], dims = [1, 2]) {
  return { type: 'float32', dims, data: new Float32Array(values), disposed: false,
    dispose() { this.disposed = true; } };
}

class RejectionEvents extends EventTarget {
  listeners = new Set();
  addEventListener(type, listener) {
    super.addEventListener(type, listener);
    if (type === 'unhandledrejection') this.listeners.add(listener);
  }
  removeEventListener(type, listener) {
    super.removeEventListener(type, listener);
    this.listeners.delete(listener);
  }
  reject(reason) {
    const event = new Event('unhandledrejection', { cancelable: true });
    event.reason = reason;
    this.dispatchEvent(event);
    return event;
  }
}

function workerFixture({ artifact = fixtureArtifact, output = { sentence_embedding: tensor() }, failure, gpu,
  loadModel, inference, tokenize, version = TRANSFORMERS_VERSION } = {}) {
  const states = [];
  const calls = [];
  const input = { input_ids: tensor([1, 2]), attention_mask: tensor([1, 1]) };
  const config = { model_type: 'embedding_gemma2', text_config: { embedding_dim: artifact.dimensions }, vision_config: {}, audio_config: {} };
  const errorEvents = new RejectionEvents();
  const model = async inputs => {
    calls.push(['inference', inputs]);
    if (failure === 'inference') throw new Error('GPU lost');
    return inference ? await inference(inputs) : output;
  };
  model.disposed = false;
  model.dispose = async () => { model.disposed = true; };
  const env = { version, allowLocalModels: true, allowRemoteModels: false,
    backends: { onnx: { wasm: { numThreads: 4, proxy: true } } } };
  const runtime = {
    env,
    AutoConfig: { from_pretrained: async (id, options) => {
      calls.push(['configuration', id, options]);
      if (failure === 'configuration') throw new Error('download blocked');
      return config;
    } },
    AutoTokenizer: { from_pretrained: async (id, options) => {
      calls.push(['tokenizer', id, options]);
      if (failure === 'tokenizer') throw new Error('download blocked');
      return (text, options) => { calls.push(['tokenize', text, options]); return tokenize ? tokenize(text, options) : input; };
    } },
    AutoModel: { from_pretrained: async (id, options) => {
      calls.push(['model', id, options]);
      if (failure === 'model') throw new Error('GPU allocation failed');
      options.progress_callback({ status: 'progress_total', progress: 25, total: 100 });
      options.progress_callback({ status: 'progress_total', progress: NaN, total: 0 });
      return loadModel ? await loadModel(model) : model;
    } },
  };
  const handler = createModelWorker({
    artifact,
    errorEvents,
    gpu: gpu === undefined ? { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } : gpu,
    postMessage: state => states.push(state),
    importRuntime: async () => {
      calls.push(['import']);
      if (failure === 'runtime') throw new Error('CDN blocked');
      return runtime;
    },
  });
  return { handler, states, calls, model, output, input, env, config, errorEvents };
}

test('production artifact pins the verified EmbeddingGemma 2 revision and browser q4 format', () => {
  assert.equal(MODEL_ARTIFACT.id, 'onnx-community/embeddinggemma-2-ONNX');
  assert.equal(MODEL_ARTIFACT.revision, 'daa72c51243991dfcaf9f9137d2c573d8f7790c0');
  assert.equal(MODEL_ARTIFACT.dtype, 'q4');
  assert.equal(MODEL_ARTIFACT.dimensions, 768);
  assert.match(TRANSFORMERS_URL, /@4\.3\.1\/dist\/transformers\.min\.js$/);
});

test('unverified artifacts block activation before any runtime or model download', async () => {
  const { handler, calls, states } = workerFixture({ artifact: { ...MODEL_ARTIFACT, revision: null, dtype: null } });
  assert.equal(calls.length, 0);
  assert.equal(states.length, 0);
  await handler.handleMessage({ type: 'load-and-test', id: 1 });
  assert.equal(calls.length, 0);
  assert.equal(states.at(-1).phase, 'error');
  assert.match(states.at(-1).message, /setup is incomplete.*must be verified/);
  for (const artifact of [
    { ...fixtureArtifact, revision: 'main' },
    { ...fixtureArtifact, dtype: 'auto' },
    { ...fixtureArtifact, id: 'some-other-model' },
  ]) {
    const invalid = workerFixture({ artifact });
    await invalid.handler.handleMessage({ type: 'load-and-test', id: 1 });
    assert.equal(invalid.calls.length, 0);
    assert.equal(invalid.states.at(-1).phase, 'error');
  }
});

test('missing worker WebGPU, unavailable adapters and unsupported precision do not download', async () => {
  for (const gpu of [null, { requestAdapter: async () => null },
    { requestAdapter: async () => { throw new Error('GPU denied'); } },
    { requestAdapter: async () => ({ features: new Set() }) }]) {
    const fixture = workerFixture({ gpu, artifact: { ...fixtureArtifact, dtype: 'fp16' } });
    await fixture.handler.handleMessage({ type: 'load-and-test', id: 1 });
    assert.equal(fixture.states.at(-1).phase, 'unsupported');
    assert.equal(fixture.calls.length, 0);
    assert.match(fixture.states.at(-1).message, /WebGPU/);
  }
});

test('worker pins all assets, loads only text encoders, validates and discards a fixed sample', async () => {
  const { handler, states, calls, output, input, env, config, model } = workerFixture();
  const request = handler.handleMessage({ type: 'load-and-test', id: 1, text: 'DO NOT USE THIS TASK' });
  const duplicate = handler.handleMessage({ type: 'load-and-test', id: 1 });
  assert.equal(request, duplicate);
  await request;
  assert.deepEqual(calls.map(call => call[0]), ['import', 'configuration', 'tokenizer', 'model', 'tokenize', 'inference']);
  for (const call of calls.filter(call => ['configuration', 'tokenizer', 'model'].includes(call[0]))) {
    assert.equal(call[1], fixtureArtifact.id);
    assert.equal(call[2].revision, fixtureArtifact.revision);
  }
  const options = calls.find(call => call[0] === 'model')[2];
  assert.equal(options.device, 'webgpu');
  assert.equal(options.dtype, 'fp32');
  assert.equal(config.vision_config, null);
  assert.equal(config.audio_config, null);
  assert.equal(env.allowLocalModels, false);
  assert.equal(env.allowRemoteModels, true);
  assert.equal(env.remotePathTemplate, `{model}/resolve/${fixtureArtifact.revision}/`);
  assert.equal(env.backends.onnx.wasm.numThreads, 1);
  assert.equal(env.backends.onnx.wasm.proxy, false);
  const sample = calls.find(call => call[0] === 'tokenize');
  assert.equal(sample[1], 'A small test sentence for the local to-do model.');
  assert.deepEqual(sample[2], { padding: true, truncation: true, max_length: 64 });
  assert.ok(states.some(state => state.phase === 'loading' && state.progress === 0.25));
  assert.ok(states.some(state => state.phase === 'loading' && state.progress === null));
  assert.deepEqual(states.slice(-2).map(state => state.phase), ['testing', 'ready']);
  assert.equal(states.at(-1).progress, 1);
  assert.ok(states.every(state => state.id === 1 && Object.keys(state).length === 4));
  assert.equal(output.sentence_embedding.disposed, true);
  assert.equal(input.input_ids.disposed, true);
  assert.equal(input.attention_mask.disposed, true);
  assert.equal(model.disposed, false);
  await handler.dispose();
  assert.equal(model.disposed, true);
});

test('worker failures report actionable states and release loaded resources', async () => {
  for (const failure of ['runtime', 'configuration', 'tokenizer', 'model', 'inference']) {
    const fixture = workerFixture({ failure });
    await fixture.handler.handleMessage({ type: 'load-and-test', id: 1 });
    assert.equal(fixture.states.at(-1).phase, 'error');
    assert.match(fixture.states.at(-1).message, /retry/);
    assert.ok(!fixture.states.some(state => state.phase === 'ready'));
    assert.equal(fixture.errorEvents.listeners.size, 0);
    if (failure === 'inference') {
      assert.equal(fixture.model.disposed, true);
      assert.equal(fixture.input.input_ids.disposed, true);
    }
  }
});

test('unhandled external weight failures settle a hung load, release late resources and permit retry', {
  timeout: 1000,
}, async () => {
  let finishLoad;
  let attempts = 0;
  const hungLoad = new Promise(resolve => { finishLoad = resolve; });
  const fixture = workerFixture({ loadModel: model => ++attempts === 1 ? hungLoad : model });
  const operation = fixture.handler.handleMessage({ type: 'load-and-test', id: 1 });
  await delay(0);
  assert.equal(fixture.errorEvents.listeners.size, 1);
  const event = fixture.errorEvents.reject(new TypeError('External model weight download blocked'));
  await operation;
  assert.equal(event.defaultPrevented, true);
  assert.equal(fixture.states.at(-1).phase, 'error');
  assert.equal(fixture.states.at(-1).id, 1);
  assert.match(fixture.states.at(-1).message, /model download hosts.*retry/);
  assert.equal(fixture.errorEvents.listeners.size, 0);
  assert.ok(!fixture.calls.some(call => call[0] === 'inference'));

  let released = false;
  finishLoad({ dispose: async () => { released = true; } });
  await delay(0);
  assert.equal(released, true);
  await fixture.handler.handleMessage({ type: 'load-and-test', id: 2 });
  assert.equal(fixture.states.at(-1).phase, 'ready');
  assert.equal(fixture.states.at(-1).id, 2);
  assert.equal(fixture.errorEvents.listeners.size, 0);
  const states = [...fixture.states];
  fixture.errorEvents.reject(new Error('Unrelated late rejection'));
  assert.deepEqual(fixture.states, states);
  await fixture.handler.dispose();
  assert.equal(fixture.model.disposed, true);
});

test('handled optional metadata errors do not abort a successful model load', async () => {
  const fixture = workerFixture({ loadModel: async model => {
    await Promise.reject(new Error('Optional metadata unavailable')).catch(() => {});
    return model;
  } });
  await fixture.handler.handleMessage({ type: 'load-and-test', id: 1 });
  assert.equal(fixture.states.at(-1).phase, 'ready');
  assert.equal(fixture.errorEvents.listeners.size, 0);
  await fixture.handler.dispose();
});

test('runtime version or model architecture mismatch cannot run inference', async () => {
  const version = workerFixture({ version: '0.0.0' });
  await version.handler.handleMessage({ type: 'load-and-test', id: 1 });
  assert.match(version.states.at(-1).message, /version.*pin/);
  assert.deepEqual(version.calls.map(call => call[0]), ['import']);
  const architecture = workerFixture();
  architecture.config.model_type = 'gemma';
  await architecture.handler.handleMessage({ type: 'load-and-test', id: 1 });
  assert.match(architecture.states.at(-1).message, /not a supported EmbeddingGemma 2/);
  assert.ok(!architecture.calls.some(call => call[0] === 'model'));
});

test('missing, malformed, zero, NaN or infinite sample output never produces ready', async () => {
  for (const output of [
    {}, { last_hidden_state: tensor() }, { sentence_embedding: tensor([], [1, 0]) },
    { sentence_embedding: tensor([1, 2], [2, 1]) }, { sentence_embedding: tensor([1], [1, 2]) },
    { sentence_embedding: tensor([NaN, 1]) }, { sentence_embedding: tensor([Infinity, 1]) },
    { sentence_embedding: tensor([0, 0]) },
  ]) {
    const fixture = workerFixture({ output });
    await fixture.handler.handleMessage({ type: 'load-and-test', id: 1 });
    assert.equal(fixture.states.at(-1).phase, 'error');
    assert.equal(fixture.model.disposed, true);
    assert.ok(!fixture.states.some(state => state.phase === 'ready'));
    assert.equal(fixture.input.input_ids.disposed, true);
    assert.ok(Object.values(output).every(tensor => tensor.disposed));
  }
});

test('configuration and output dimensions must match the pinned embedding dimension', async () => {
  const config = workerFixture();
  config.config.text_config.embedding_dim = 3;
  await config.handler.handleMessage({ type: 'load-and-test', id: 1 });
  assert.equal(config.states.at(-1).phase, 'error');
  assert.ok(!config.calls.some(call => call[0] === 'inference'));
  const wrongOutput = workerFixture({ output: { sentence_embedding: tensor([1, 2, 3], [1, 3]) } });
  await wrongOutput.handler.handleMessage({ type: 'load-and-test', id: 1 });
  assert.equal(wrongOutput.states.at(-1).phase, 'error');
  assert.equal(wrongOutput.output.sentence_embedding.disposed, true);
});

test('worker embeds the combined saved title and icon, copies output and releases all tensors', async () => {
  const inputs = [];
  const outputs = [];
  const fixture = workerFixture({
    tokenize: text => {
      const input = { input_ids: tensor(), attention_mask: tensor() };
      inputs.push(input);
      return input;
    },
    inference: async () => {
      const output = { sentence_embedding: tensor(), last_hidden_state: tensor([1, 2]) };
      outputs.push(output);
      return output;
    },
  });
  await fixture.handler.handleMessage({ type: 'load-and-test', id: 1 });
  const source = { title: 'Buy groceries ✓', icon: 'shopping' };
  await fixture.handler.handleMessage({ type: 'embed-task', id: 2, ...source });
  const result = fixture.states.at(-1);
  assert.deepEqual(result, { id: 2, type: 'embedding', result: {
    ...source, vector: Array.from(new Float32Array([0.6, 0.8])),
    model: fixtureArtifact.id, revision: fixtureArtifact.revision, input_version: 1, dimensions: 2,
  } });
  const tokenization = fixture.calls.filter(call => call[0] === 'tokenize').at(-1);
  assert.equal(tokenization[1], 'Icon: shopping\nTask: Buy groceries ✓');
  assert.deepEqual(tokenization[2], { padding: true, truncation: false });
  assert.ok([...inputs, ...outputs].every(collection => Object.values(collection).every(value => value.disposed)));
  outputs.at(-1).sentence_embedding.data.fill(0);
  assert.notDeepEqual(result.result.vector, [0, 0]);
  assert.equal(fixture.model.disposed, false);
  assert.equal(fixture.calls.filter(call => call[0] === 'model').length, 1);
  await fixture.handler.dispose();
});

test('worker queues direct inference calls and does not let queued source snapshots change', async () => {
  let release;
  let inFlight = 0;
  let maximum = 0;
  let calls = 0;
  const inputs = [];
  const fixture = workerFixture({
    tokenize: () => { const input = { input_ids: tensor() }; inputs.push(input); return input; },
    inference: async () => {
      ++calls;
      ++inFlight;
      maximum = Math.max(maximum, inFlight);
      if (calls === 2) await new Promise(resolve => { release = resolve; });
      --inFlight;
      return { sentence_embedding: tensor() };
    },
  });
  await fixture.handler.handleMessage({ type: 'load-and-test', id: 1 });
  const first = fixture.handler.handleMessage({ type: 'embed-task', id: 2, title: 'First', icon: 'task' });
  const request = { type: 'embed-task', id: 3, title: 'Second', icon: 'home' };
  const second = fixture.handler.handleMessage(request);
  request.title = 'Later draft';
  await delay(0);
  assert.equal(calls, 2, 'Sample plus first inference are the only calls before release');
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 3);
  assert.equal(maximum, 1);
  assert.deepEqual(fixture.states.filter(state => state.type === 'embedding').map(state => state.id), [2, 3]);
  assert.equal(fixture.states.at(-1).result.title, 'Second');
  assert.ok(inputs.every(input => input.input_ids.disposed));
  assert.equal(fixture.calls.filter(call => call[0] === 'model').length, 1);
  await fixture.handler.dispose();
});

test('worker inference errors and malformed task vectors release tensors and retain a retryable resident model', async () => {
  const inputs = [];
  const outputs = [];
  let mode = 'success';
  const fixture = workerFixture({
    tokenize: () => { const input = { input_ids: tensor() }; inputs.push(input); return input; },
    inference: async () => {
      if (mode === 'throw') throw new Error('Transient inference failure');
      const values = mode === 'zero' ? [0, 0] : mode === 'nan' ? [NaN, 1] : [0.6, 0.8];
      const output = { sentence_embedding: tensor(values) };
      outputs.push(output);
      return output;
    },
  });
  await fixture.handler.handleMessage({ type: 'load-and-test', id: 1 });
  for (const failure of ['throw', 'zero', 'nan']) {
    mode = failure;
    await fixture.handler.handleMessage({ type: 'embed-task', id: 2, title: 'Retry me', icon: 'work' });
    assert.equal(fixture.states.at(-1).type, 'embedding-error');
    assert.ok(!('phase' in fixture.states.at(-1)));
    assert.equal(fixture.model.disposed, false);
    mode = 'success';
    await fixture.handler.handleMessage({ type: 'embed-task', id: 3, title: 'Retry me', icon: 'work' });
    assert.equal(fixture.states.at(-1).type, 'embedding');
  }
  assert.ok(inputs.every(input => input.input_ids.disposed));
  assert.ok(outputs.every(output => output.sentence_embedding.disposed));
  assert.equal(fixture.calls.filter(call => call[0] === 'model').length, 1);
  await fixture.handler.dispose();
});

test('invalid and unloaded task messages cannot download or infer', async () => {
  const fixture = workerFixture();
  await fixture.handler.handleMessage({ type: 'embed-task', id: 1, title: 'No model', icon: 'task' });
  assert.equal(fixture.states.at(-1).type, 'embedding-error');
  assert.equal(fixture.calls.length, 0);
  await fixture.handler.handleMessage({ type: 'load-and-test', id: 2 });
  const calls = fixture.calls.length;
  for (const source of [{ title: '', icon: 'task' }, { title: 'Valid', icon: 'missing' }]) {
    await fixture.handler.handleMessage({ type: 'embed-task', id: 3, ...source });
    assert.equal(fixture.states.at(-1).type, 'embedding-error');
  }
  assert.equal(fixture.calls.length, calls);
  await fixture.handler.dispose();
});

test('worker query and task inference share one resident model and release query tensors', async () => {
  let release;
  let calls = 0;
  let inFlight = 0;
  let maximum = 0;
  const inputs = [];
  const outputs = [];
  const fixture = workerFixture({
    tokenize: () => { const input = { input_ids: tensor() }; inputs.push(input); return input; },
    inference: async () => {
      ++calls;
      maximum = Math.max(maximum, ++inFlight);
      if (calls === 2) await new Promise(resolve => { release = resolve; });
      --inFlight;
      const output = { sentence_embedding: tensor() };
      outputs.push(output);
      return output;
    },
  });
  await fixture.handler.handleMessage({ type: 'embed-query', id: 1, query: 'No model' });
  assert.equal(fixture.states.at(-1).type, 'embedding-error');
  assert.equal(fixture.calls.length, 0);
  await fixture.handler.handleMessage({ type: 'load-and-test', id: 2 });
  const query = fixture.handler.handleMessage({ type: 'embed-query', id: 3, query: '  buy food  ' });
  const task = fixture.handler.handleMessage({ type: 'embed-task', id: 4, title: 'Saved task', icon: 'task' });
  await delay(0);
  assert.equal(calls, 2);
  release();
  await Promise.all([query, task]);
  assert.equal(maximum, 1);
  assert.deepEqual(fixture.calls.filter(call => call[0] === 'tokenize').slice(-2).map(call => call[1]),
    ['buy food', 'Icon: task\nTask: Saved task']);
  assert.deepEqual(fixture.states.find(state => state.id === 3), { id: 3, type: 'embedding', result: {
    vector: Array.from(new Float32Array([0.6, 0.8])), model: fixtureArtifact.id,
    revision: fixtureArtifact.revision, input_version: 1, dimensions: 2,
  } });
  const before = fixture.calls.length;
  for (const invalid of ['', '   ', 12, 'x'.repeat(501)]) {
    await fixture.handler.handleMessage({ type: 'embed-query', id: 5, query: invalid });
    assert.equal(fixture.states.at(-1).type, 'embedding-error');
  }
  assert.equal(fixture.calls.length, before);
  assert.equal(fixture.model.disposed, false);
  assert.ok(inputs.every(input => input.input_ids.disposed));
  assert.ok(outputs.every(output => output.sentence_embedding.disposed));
  await fixture.handler.dispose();
});

test('worker disposal during embedding releases late tensors and suppresses active and queued results', async () => {
  let release;
  let call = 0;
  const outputs = [];
  const inputs = [];
  const fixture = workerFixture({
    tokenize: () => { const input = { input_ids: tensor() }; inputs.push(input); return input; },
    inference: async () => {
      if (++call === 2) await new Promise(resolve => { release = resolve; });
      const output = { sentence_embedding: tensor() };
      outputs.push(output);
      return output;
    },
  });
  await fixture.handler.handleMessage({ type: 'load-and-test', id: 1 });
  const first = fixture.handler.handleMessage({ type: 'embed-task', id: 2, title: 'Cancelled', icon: 'home' });
  const second = fixture.handler.handleMessage({ type: 'embed-task', id: 3, title: 'Queued', icon: 'home' });
  await delay(0);
  await fixture.handler.dispose();
  const snapshot = [...fixture.states];
  release();
  await Promise.all([first, second]);
  assert.deepEqual(fixture.states, snapshot);
  assert.equal(call, 2);
  assert.equal(fixture.model.disposed, true);
  assert.ok(inputs.every(input => input.input_ids.disposed));
  assert.ok(outputs.every(output => output.sentence_embedding.disposed));
});

test('disposal during loading releases a late model and does not report ready', async () => {
  const immediate = workerFixture();
  const cancelled = immediate.handler.handleMessage({ type: 'load-and-test', id: 1 });
  await immediate.handler.dispose();
  await cancelled;
  assert.equal(immediate.calls.length, 0);
  assert.equal(immediate.states.length, 0);

  let finishLoad;
  const loading = new Promise(resolve => { finishLoad = resolve; });
  const fixture = workerFixture({ loadModel: async model => { await loading; return model; } });
  const operation = fixture.handler.handleMessage({ type: 'load-and-test', id: 1 });
  await delay(0);
  await fixture.handler.dispose();
  const snapshot = [...fixture.states];
  finishLoad();
  await operation;
  assert.deepEqual(fixture.states, snapshot);
  assert.equal(fixture.model.disposed, true);
  assert.ok(!fixture.calls.some(call => call[0] === 'inference'));
});

test('unrecognized worker messages cannot import, download, or infer', async () => {
  const fixture = workerFixture();
  for (const data of [null, {}, { type: 'embed', id: 1, text: 'task' },
    { type: 'load-and-test', id: 0 }, { type: 'load-and-test', id: '1' }]) {
    await fixture.handler.handleMessage(data);
  }
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.states.length, 0);
});

// Small DOM and local API fixtures run the deployed app orchestration offline.
// Model inference is injected, while actual app event handlers and requests run.
class AppElement {
  constructor(document, tag = 'div') {
    this.document = document;
    this.tagName = tag;
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.dataset = {};
    this.attributes = {};
    this.value = '';
    this.hidden = false;
    this.className = '';
    this.classList = {
      contains: name => this.className.split(' ').includes(name),
      toggle: (name, enabled) => {
        const names = new Set(this.className.split(' ').filter(Boolean));
        if (enabled) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
      },
    };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  async emit(type, extra = {}) {
    for (const callback of this.listeners.get(type) ?? []) {
      await callback({ target: this, preventDefault() {}, stopPropagation() {}, ...extra });
    }
  }
  append(...elements) { for (const element of elements) this.insertBefore(element, null); }
  insertBefore(element, before) {
    if (element.parent && element.contains(this.document.activeElement)) {
      // Model browsers that blur descendants when a DOM subtree moves.
      let focused = this.document.activeElement;
      this.document.activeElement = this.document.body;
      while (focused) {
        for (const callback of focused.listeners.get('focusout') ?? []) callback({ relatedTarget: null });
        focused = focused.parent;
      }
    }
    element.remove();
    element.parent = this;
    const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index, 0, element);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  focus() { this.document.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  get firstElementChild() { return this.children[0] ?? null; }
  get nextElementSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; }
  get previousElementSibling() { return this.parent?.children[this.parent.children.indexOf(this) - 1] ?? null; }
  find(className) {
    if (this.classList.contains(className)) return this;
    for (const child of this.children) { const found = child.find(className); if (found) return found; }
    return null;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}
const copy = value => JSON.parse(JSON.stringify(value));
function apiResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => copy(body) };
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; ++attempt) {
    if (predicate()) return;
    await delay(5);
  }
  assert.ok(predicate(), 'The expected app effect did not settle');
}

function appFixture({ items = [], current = [], phase = 'loading', embedTask, embedQuery, onFetch } = {}) {
  const elements = new Map();
  const document = {
    addEventListener() {},
    createElement: tag => new AppElement(document, tag),
    createTextNode: text => Object.assign(new AppElement(document, 'text'), { textContent: text }),
    querySelector: selector => {
      if (!elements.has(selector)) elements.set(selector, new AppElement(document));
      return elements.get(selector);
    },
  };
  document.body = new AppElement(document, 'body');
  document.documentElement = new AppElement(document, 'html');
  document.activeElement = document.body;
  const tasks = new Map(items.map(item => [item.id, copy(item)]));
  const embedded = new Set(current);
  const uploads = [];
  const taskCalls = [];
  const queryCalls = [];
  const requests = [];
  let subscriber;
  let counter = 0;
  const injectedRuntime = {
    subscribe(listener) { subscriber = listener; listener({ phase }); },
    embedTask: async snapshot => {
      taskCalls.push(copy(snapshot));
      return embedTask ? embedTask(copy(snapshot)) : embeddingResult(snapshot);
    },
    embedQuery: async query => {
      queryCalls.push(query);
      return embedQuery ? embedQuery(query) : embeddingResult({});
    },
  };
  const fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method, body });
    if (onFetch) {
      const custom = await onFetch({ url, method, body, tasks, embedded, uploads });
      if (custom) return custom;
    }
    if (url === '/api/todos/embeddings/pending') {
      return apiResponse([...tasks.values()].filter(item => !embedded.has(item.id)));
    }
    if (url === '/api/todos/search') {
      return apiResponse({ matches: [...tasks.values()].filter(item => embedded.has(item.id))
        .reverse().map(todo => ({ todo, score: 1 })), pending_count: tasks.size - embedded.size });
    }
    if (url === '/api/todos') {
      if (method === 'GET') return apiResponse([...tasks.values()]);
      const task = { id: `added-${++counter}`, ...body, completed: false };
      tasks.set(task.id, task);
      return apiResponse(task, 201);
    }
    const [, id, suffix] = url.match(/^\/api\/todos\/([^/]+)(\/embedding)?$/);
    const task = tasks.get(id);
    if (suffix) {
      uploads.push({ id, body });
      if (!task) return apiResponse({ detail: 'Missing' }, 404);
      if (task.title !== body.title || task.icon !== body.icon) return apiResponse({ detail: 'Changed' }, 409);
      embedded.add(id);
      return apiResponse(null, 204);
    }
    if (method === 'DELETE') { tasks.delete(id); embedded.delete(id); return apiResponse(null, 204); }
    if (!task) return apiResponse({ detail: 'Missing' }, 404);
    if (method === 'PUT') embedded.delete(id);
    const updated = { ...task, ...body };
    tasks.set(id, updated);
    return apiResponse(updated);
  };
  const source = readFileSync(new URL('../app/static/app.js', import.meta.url), 'utf8')
    .replace("import('/static/model-runtime.mjs')", 'Promise.resolve({ modelRuntime: injectedRuntime })');
  const context = { document, navigator: { maxTouchPoints: 0 }, injectedRuntime, fetch, setTimeout, clearTimeout };
  runInNewContext(`${source}\n globalThis.appTest = { rows, embeddingJobs, requestBackfill };`, context);
  return {
    element: selector => document.querySelector(selector), document, rows: context.appTest.rows,
    jobs: context.appTest.embeddingJobs, requestBackfill: context.appTest.requestBackfill,
    tasks, embedded, uploads, taskCalls, queryCalls, requests,
    ready: () => { phase = 'ready'; subscriber({ phase }); },
  };
}

const savedTask = (id, title = id) => ({ id, title, icon: 'task', completed: false });

test('backfill embeds server snapshots on readiness including additions during loading, skipping current vectors', async () => {
  const fixture = appFixture({ items: [savedTask('old', 'Saved title'), savedTask('current')], current: ['current'] });
  await until(() => fixture.rows.size === 2);
  const old = fixture.rows.get('old');
  await old.title.emit('click');
  old.editor.value = 'Unsaved draft';
  await old.editor.emit('input');
  fixture.element('#todo-title').value = 'Added while loading';
  await fixture.element('#todo-form').emit('submit');
  assert.equal(fixture.taskCalls.length, 0);
  fixture.ready();
  await until(() => fixture.uploads.length === 2);
  assert.deepEqual(fixture.taskCalls, [
    { title: 'Saved title', icon: 'task' }, { title: 'Added while loading', icon: 'task' },
  ]);
  assert.equal(old.editor.value, 'Unsaved draft');
  assert.equal(old.editing, true);
  assert.equal(fixture.document.activeElement, old.editor);
  assert.deepEqual(fixture.uploads.map(upload => upload.id), ['old', 'added-1']);
});

test('backfill deduplicates Refresh jobs and submits incrementally so searches can interleave', async () => {
  const gate = deferred();
  const fixture = appFixture({ items: [savedTask('one'), savedTask('two')],
    embedTask: async snapshot => { if (snapshot.title === 'one') await gate.promise; return embeddingResult(snapshot); } });
  await until(() => fixture.rows.size === 2);
  fixture.ready();
  await until(() => fixture.taskCalls.length === 1);
  await fixture.element('#refresh-button').emit('click');
  await fixture.requestBackfill();
  assert.equal(fixture.taskCalls.length, 1, 'Only the active background job is submitted');
  fixture.element('#todo-search').value = 'one';
  await fixture.element('#todo-search').emit('input');
  await until(() => fixture.queryCalls.length === 1);
  assert.match(fixture.element('#search-status').textContent, /2 tasks still being indexed/);
  gate.resolve();
  await until(() => fixture.uploads.length === 2);
  await fixture.element('#refresh-button').emit('click');
  await until(() => fixture.jobs.size === 0);
  assert.deepEqual(fixture.taskCalls.map(call => call.title), ['one', 'two']);
});

test('backfill upload retries reuse computed vectors and do not recreate tasks', async () => {
  for (const retry of ['row', 'refresh']) {
    let attempts = 0;
    const fixture = appFixture({ items: [savedTask('one')], onFetch: ({ url }) => {
      if (url.endsWith('/embedding') && ++attempts === 1) return apiResponse({ detail: 'Temporary upload failure' }, 503);
    } });
    await until(() => fixture.rows.size === 1);
    fixture.ready();
    await until(() => fixture.jobs.get('one')?.error);
    const computed = copy(fixture.jobs.get('one').result);
    assert.equal(fixture.taskCalls.length, 1);
    if (retry === 'row') await fixture.rows.get('one').row.find('embedding-retry').emit('click');
    else await fixture.element('#refresh-button').emit('click');
    await until(() => fixture.jobs.size === 0);
    assert.equal(attempts, 2);
    assert.equal(fixture.taskCalls.length, 1);
    assert.deepEqual(fixture.uploads[0].body, computed);
    assert.equal(fixture.requests.filter(request => request.method === 'POST' && request.url === '/api/todos').length, 0);
  }
});

test('backfill drops obsolete inference after source edits and deletion', async () => {
  for (const action of ['edit', 'delete']) {
    const gate = deferred();
    const fixture = appFixture({ items: [savedTask('one', 'Original')],
      embedTask: async snapshot => { if (snapshot.title === 'Original') await gate.promise; return embeddingResult(snapshot); } });
    await until(() => fixture.rows.size === 1);
    fixture.ready();
    await until(() => fixture.taskCalls.length === 1);
    const row = fixture.rows.get('one');
    if (action === 'edit') {
      await row.title.emit('click');
      row.editor.value = 'Confirmed edit';
      await row.editor.emit('input');
      await row.editor.emit('keydown', { key: 'Enter' });
      await until(() => row.item.title === 'Confirmed edit');
    } else {
      await row.remove.emit('click');
      await until(() => fixture.rows.size === 0);
    }
    gate.resolve();
    await until(() => fixture.jobs.size === 0);
    assert.equal(fixture.uploads.some(upload => upload.body.title === 'Original'), false);
    if (action === 'edit') {
      assert.deepEqual(fixture.taskCalls.map(call => call.title), ['Original', 'Confirmed edit']);
      assert.equal(fixture.uploads[0].body.title, 'Confirmed edit');
    } else assert.equal(fixture.uploads.length, 0);
  }
});

test('backfill reconciles source conflicts and discards deleted server snapshots', async () => {
  for (const action of ['edit', 'delete']) {
    let once = false;
    const fixture = appFixture({ items: [savedTask('one', 'Original')], onFetch: ({ url, tasks }) => {
      if (url.endsWith('/embedding') && !once) {
        once = true;
        if (action === 'edit') tasks.set('one', savedTask('one', 'Changed in another tab'));
        else tasks.delete('one');
      }
    } });
    await until(() => fixture.rows.size === 1);
    fixture.ready();
    await until(() => once && fixture.jobs.size === 0);
    if (action === 'edit') {
      await until(() => fixture.uploads.length === 2);
      assert.deepEqual(fixture.taskCalls.map(call => call.title), ['Original', 'Changed in another tab']);
      assert.equal(fixture.rows.get('one').item.title, 'Changed in another tab');
    } else {
      await until(() => fixture.rows.size === 0);
      assert.equal(fixture.uploads.length, 1);
      assert.equal(fixture.taskCalls.length, 1);
    }
  }
});

test('backfill ignores a delayed pending response captured before a successful upload', async () => {
  const inference = deferred();
  const scan = deferred();
  let holdScan = false;
  const fixture = appFixture({ items: [savedTask('one')],
    embedTask: async snapshot => { await inference.promise; return embeddingResult(snapshot); },
    onFetch: async ({ url, tasks }) => {
      if (url.endsWith('/pending') && holdScan) {
        holdScan = false;
        const stale = [...tasks.values()];
        await scan.promise;
        return apiResponse(stale);
      }
    },
  });
  await until(() => fixture.rows.size === 1);
  fixture.ready();
  await until(() => fixture.taskCalls.length === 1);
  holdScan = true;
  const refreshing = fixture.requestBackfill();
  inference.resolve();
  await until(() => fixture.uploads.length === 1);
  scan.resolve();
  await refreshing;
  assert.equal(fixture.taskCalls.length, 1);
  assert.equal(fixture.jobs.size, 0);
});

test('search ignores obsolete results, preserves drafts and focus, and clearing restores normal order', async () => {
  const oldSearch = deferred();
  let searches = 0;
  const fixture = appFixture({ items: [savedTask('one'), savedTask('two'), savedTask('three')],
    current: ['one', 'two', 'three'], onFetch: async ({ url, tasks }) => {
      if (url === '/api/todos/search') {
        if (++searches === 1) { await oldSearch.promise; return apiResponse({ matches: [{ todo: tasks.get('one'), score: 1 }], pending_count: 0 }); }
        return apiResponse({ matches: [{ todo: tasks.get('three'), score: 1 }, { todo: tasks.get('two'), score: 0.5 }], pending_count: 0 });
      }
    },
  });
  await until(() => fixture.rows.size === 3);
  fixture.ready();
  const row = fixture.rows.get('one');
  await row.title.emit('click');
  row.editor.value = 'Unsaved draft';
  row.editor.setSelectionRange(2, 5);
  await row.editor.emit('input');
  const input = fixture.element('#todo-search');
  input.value = 'old query';
  await input.emit('input');
  await until(() => searches === 1);
  input.value = 'new query';
  await input.emit('input');
  await until(() => searches === 2);
  await until(() => fixture.element('#search-status').textContent === '2 results');
  oldSearch.resolve();
  await delay(10);
  assert.equal(fixture.element('#search-status').textContent, '2 results');
  assert.equal(row.row.hidden, false, 'A draft remains visible even when it does not match');
  assert.equal(row.editor.value, 'Unsaved draft');
  assert.equal(fixture.document.activeElement, row.editor);
  assert.deepEqual([row.editor.selectionStart, row.editor.selectionEnd], [2, 5]);
  assert.deepEqual(fixture.element('#todo-list').children.map(element => element.dataset.id), ['three', 'two', 'one']);
  assert.equal(fixture.requests.some(request => request.method === 'PUT' && request.url === '/api/todos/one'), false,
    'Result reordering must not submit the focused draft');
  await fixture.element('#search-clear').emit('click');
  assert.equal(fixture.requests.some(request => request.method === 'PUT' && request.url === '/api/todos/one'), false,
    'Restoring list order must not submit the focused draft');
  assert.equal(row.editor.value, 'Unsaved draft');
  assert.deepEqual(fixture.element('#todo-list').children.map(element => element.dataset.id), ['one', 'two', 'three']);
  assert.equal(fixture.element('#search-status').hidden, true);
  assert.equal(fixture.document.activeElement, input);
});

test('search renders similarity scores with an explanation and keeps nonmatching drafts visible', async () => {
  const fixture = appFixture({ items: [savedTask('one'), savedTask('two'), savedTask('three')],
    current: ['one', 'two', 'three'], onFetch: async ({ url, tasks }) => {
      if (url === '/api/todos/search') {
        return apiResponse({ matches: [
          { todo: tasks.get('three'), score: 0.72 },
          { todo: tasks.get('two'), score: 0.5 },
        ], pending_count: 0 });
      }
    },
  });
  await until(() => fixture.rows.size === 3);
  fixture.ready();
  const draft = fixture.rows.get('one');
  await draft.title.emit('click');
  draft.editor.value = 'Unsaved draft';
  await draft.editor.emit('input');
  const input = fixture.element('#todo-search');
  input.value = 'groceries';
  await input.emit('input');
  await until(() => fixture.element('#search-status').textContent === '2 results');
  assert.equal(fixture.rows.get('three').row.find('similarity').textContent, 'Similarity 0.72');
  assert.equal(fixture.rows.get('three').row.find('similarity').hidden, false);
  assert.equal(fixture.rows.get('two').row.find('similarity').textContent, 'Similarity 0.50');
  assert.equal(fixture.rows.get('two').row.find('similarity').hidden, false);
  assert.equal(draft.row.hidden, false, 'A draft remains visible even when it does not match');
  assert.equal(draft.row.find('nonmatch').textContent, 'Not a search match');
  assert.equal(draft.row.find('nonmatch').hidden, false);
  assert.equal(draft.row.find('similarity').hidden, true, 'Nonmatches show no score');
  assert.equal(fixture.element('#search-explain').hidden, false);
  assert.deepEqual(fixture.element('#todo-list').children.map(element => element.dataset.id), ['three', 'two', 'one']);
});

test('search resyncs a source changed in another tab before scoring', async () => {
  const fixture = appFixture({ items: [savedTask('one', 'Read a novel'), savedTask('two')],
    current: ['one', 'two'], onFetch: async ({ url, tasks }) => {
      if (url === '/api/todos/search') {
        return apiResponse({ matches: [{ todo: tasks.get('one'), score: 0.94 }], pending_count: 0 });
      }
    },
  });
  await until(() => fixture.rows.size === 2);
  fixture.ready();
  // Another tab retitles the task; the local row still shows the stale source.
  fixture.tasks.set('one', { ...savedTask('one'), title: 'Buy groceries' });
  const draft = fixture.rows.get('two');
  await draft.title.emit('click');
  draft.editor.value = 'Unsaved draft';
  draft.editor.setSelectionRange(1, 4);
  await draft.editor.emit('input');
  const input = fixture.element('#todo-search');
  input.value = 'purchase food';
  await input.emit('input');
  await until(() => fixture.rows.get('one').item.title === 'Buy groceries');
  await until(() => fixture.element('#search-status').textContent === '1 results');
  assert.ok(fixture.requests.filter(request => request.url === '/api/todos/search').length >= 2,
    'The stale response triggers a rerun once sources reconcile');
  assert.equal(fixture.queryCalls.length, 1, 'The rerun reuses the cached query embedding');
  assert.equal(fixture.rows.get('one').title.textContent, 'Buy groceries');
  assert.equal(fixture.rows.get('one').row.find('similarity').textContent, 'Similarity 0.94',
    'The score labels the current source, never the stale title');
  assert.equal(draft.editor.value, 'Unsaved draft');
  assert.equal(fixture.document.activeElement, draft.editor);
  assert.deepEqual([draft.editor.selectionStart, draft.editor.selectionEnd], [1, 4]);
});

test('search retries a reconciliation refresh discarded by draft input', async () => {
  let listRequests = 0;
  const refreshGate = deferred();
  const fixture = appFixture({ items: [savedTask('one', 'Read a novel'), savedTask('two')],
    current: ['one', 'two'], onFetch: async ({ url, method, tasks }) => {
      if (url === '/api/todos' && method === 'GET' && ++listRequests === 2) {
        await refreshGate.promise; // Hold the automatic reconciliation refresh.
      }
      if (url === '/api/todos/search') {
        return apiResponse({ matches: [{ todo: tasks.get('one'), score: 0.94 }], pending_count: 0 });
      }
    },
  });
  await until(() => fixture.rows.size === 2);
  fixture.ready();
  // Another tab retitles the task; the local row still shows the stale source.
  fixture.tasks.set('one', { ...savedTask('one'), title: 'Buy groceries' });
  const draft = fixture.rows.get('two');
  await draft.title.emit('click');
  const input = fixture.element('#todo-search');
  input.value = 'purchase food';
  await input.emit('input');
  await until(() => listRequests === 2); // Reconciliation refresh is in flight.
  // Draft input bumps revision, so the held refresh must discard on release.
  draft.editor.value = 'Unsaved draft';
  draft.editor.setSelectionRange(1, 4);
  await draft.editor.emit('input');
  refreshGate.resolve();
  await until(() => fixture.rows.get('one').item.title === 'Buy groceries');
  await until(() => fixture.element('#search-status').textContent === '1 results');
  assert.ok(listRequests >= 3, 'The discarded refresh is retried while the query is current');
  assert.ok(fixture.requests.filter(request => request.url === '/api/todos/search').length >= 2,
    'The retried refresh reruns the search once sources reconcile');
  assert.equal(fixture.rows.get('one').title.textContent, 'Buy groceries');
  assert.equal(fixture.rows.get('one').row.find('similarity').textContent, 'Similarity 0.94',
    'The score labels the current source, never the stale title');
  assert.equal(fixture.requests.some(request => request.method === 'PUT' && request.url === '/api/todos/two'), false,
    'Reconciliation never submits the focused draft');
  assert.equal(draft.editor.value, 'Unsaved draft');
  assert.equal(fixture.document.activeElement, draft.editor);
  assert.deepEqual([draft.editor.selectionStart, draft.editor.selectionEnd], [1, 4]);
});

test('empty search results name no matches while indexing and errors stay distinct', async () => {
  let mode = 'empty';
  const fixture = appFixture({ items: [savedTask('one'), savedTask('two')],
    current: ['one'], onFetch: async ({ url, tasks }) => {
      if (url === '/api/todos/search') {
        if (mode === 'error') return apiResponse({ detail: 'Search failed' }, 503);
        if (mode === 'indexed') {
          return apiResponse({ matches: [{ todo: tasks.get('one'), score: 0.9 }], pending_count: 1 });
        }
        return apiResponse({ matches: [], pending_count: 1 });
      }
    },
  });
  await until(() => fixture.rows.size === 2);
  fixture.ready();
  const input = fixture.element('#todo-search');
  input.value = 'an unrelated query';
  await input.emit('input');
  await until(() => fixture.element('#search-status').textContent === 'No matching tasks · 1 tasks still being indexed');
  assert.equal(fixture.element('#search-explain').hidden, true, 'No scores means no explanation');
  assert.equal(fixture.rows.get('one').row.find('similarity').hidden, true);
  mode = 'indexed';
  input.value = 'a related query';
  await input.emit('input');
  await until(() => fixture.element('#search-status').textContent === '1 results · 1 tasks still being indexed');
  assert.equal(fixture.rows.get('one').row.find('similarity').textContent, 'Similarity 0.90');
  assert.equal(fixture.element('#search-explain').hidden, false);
  mode = 'error';
  input.value = 'a failing query';
  await input.emit('input');
  await until(() => fixture.element('#search-status').textContent === 'Search failed');
});

test('clearing or Escape removes scores and restores normal order', async () => {
  const fixture = appFixture({ items: [savedTask('one'), savedTask('two')],
    current: ['one', 'two'], onFetch: async ({ url, tasks }) => {
      if (url === '/api/todos/search') {
        return apiResponse({ matches: [{ todo: tasks.get('two'), score: 0.81 }], pending_count: 0 });
      }
    },
  });
  await until(() => fixture.rows.size === 2);
  fixture.ready();
  const input = fixture.element('#todo-search');
  for (const action of ['clear', 'escape']) {
    input.value = 'a query';
    await input.emit('input');
    await until(() => fixture.element('#search-status').textContent === '1 results');
    assert.equal(fixture.rows.get('two').row.find('similarity').textContent, 'Similarity 0.81');
    assert.equal(fixture.element('#search-explain').hidden, false);
    if (action === 'clear') await fixture.element('#search-clear').emit('click');
    else await input.emit('keydown', { key: 'Escape' });
    assert.equal(input.value, '');
    assert.equal(fixture.rows.get('two').row.find('similarity').hidden, true, 'Clearing removes obsolete scores');
    assert.equal(fixture.rows.get('one').row.find('nonmatch').hidden, true);
    assert.equal(fixture.element('#search-explain').hidden, true);
    assert.equal(fixture.element('#search-status').hidden, true);
    assert.deepEqual(fixture.element('#todo-list').children.map(element => element.dataset.id), ['one', 'two']);
  }
  assert.equal(fixture.document.activeElement, input);
});

// Opt-in real inference using authentic downloads in .venv/model-assets.
// The ordinary suite stays offline and needs only Node. This check additionally
// needs playwright@1.55.1 installed under .venv/model-browser and its Chromium.
// Run: MODEL_WEBGPU_CHECK=1 node --test --test-name-pattern='real WebGPU' tests/model_runtime.test.mjs
test('real WebGPU runs the pinned model in a module worker with valid output', {
  skip: process.env.MODEL_WEBGPU_CHECK !== '1', timeout: 25_000,
}, async () => {
  const { chromium } = await import('../.venv/model-browser/node_modules/playwright/index.mjs');
  const { createServer } = await import('node:http');
  const { createReadStream, readFileSync, statSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { fileURLToPath } = await import('node:url');
  const root = new URL('../', import.meta.url);
  const assets = new URL('.venv/model-assets/', root);
  const modelBase = `https://huggingface.co/${MODEL_ARTIFACT.id}/resolve/${MODEL_ARTIFACT.revision}/`;
  const ortBase = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/';
  const downloads = [
    ['config.json', modelBase, '8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d'],
    ['tokenizer_config.json', modelBase, '17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874'],
    ['tokenizer.json', modelBase, '4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4'],
    ['model_q4.onnx', modelBase + 'onnx/', 'f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9'],
    ['model_q4.onnx_data', modelBase + 'onnx/', 'c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49'],
    ['transformers.min.js', TRANSFORMERS_URL.replace(/[^/]+$/, ''), '8d6716d9086f57c30a4bf367dba61b887593573c770c454465e8019b2703e743'],
    ['ort-wasm-simd-threaded.asyncify.mjs', ortBase, '0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611'],
    ['ort-wasm-simd-threaded.asyncify.wasm', ortBase, '49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082'],
  ].map(([name, base, sha256]) => {
    const file = new URL(name, assets);
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), sha256,
      `The downloaded artifact changed: ${name}`);
    return { name, url: base + name, file, size: statSync(file).size };
  });
  const scripts = new Map(downloads.filter(item => /\.m?js$/.test(item.name)).map(item => [item.url, item.file]));
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Model check</title>'); return; }
    const fixture = downloads.find(item => path === `/__fixture/${item.name}`);
    const source = ['/static/model-runtime.mjs', '/static/model-worker.mjs'].includes(path)
      ? new URL(`app${path}`, root) : null;
    const file = fixture?.file ?? source;
    if (!file) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Length', fixture?.size ?? statSync(file).size);
    response.setHeader('Content-Type', source ? 'text/javascript' : 'application/octet-stream');
    createReadStream(fileURLToPath(file)).pipe(response);
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: 'chromium', headless: true,
      args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-webgpu-developer-features'] });
    const context = await browser.newContext();
    const unexpected = [];
    await context.route('https://**', async route => {
      const file = scripts.get(route.request().url());
      if (!file) { unexpected.push(route.request().url()); await route.abort(); return; }
      await route.fulfill({ path: fileURLToPath(file), contentType: 'text/javascript',
        headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${origin}/`);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1024 * 1024 * 1024 });
    // Populate the deployed worker's normal browser cache with verified bytes
    // so this reproducible check does not redownload over 200 MB each time.
    await page.evaluate(async downloads => {
      const cache = await caches.open('transformers-cache');
      await Promise.all(downloads.map(async ({ url, name, size }) => {
        const response = await fetch(`/__fixture/${name}`);
        if (!response.ok) throw Error(`Missing fixture: ${url}`);
        await cache.put(url, new Response(response.body, { headers: { 'Content-Length': String(size) } }));
      }));
    }, downloads.map(({ url, name, size }) => ({ url, name, size })));
    const result = await page.evaluate(async () => {
      const { modelRuntime } = await import('/static/model-runtime.mjs');
      const states = [];
      modelRuntime.subscribe(state => states.push(state));
      if (states.at(-1).phase !== 'idle') throw Error('Runtime activated before the test');
      const first = modelRuntime.loadAndTest();
      const shared = first === modelRuntime.loadAndTest();
      try {
        await first;
        return { shared, states };
      } finally { modelRuntime.dispose(); }
    });
    assert.equal(result.shared, true);
    assert.equal(result.states[0].phase, 'idle');
    assert.ok(result.states.some(state => state.phase === 'testing'));
    assert.ok(result.states.some(state => state.phase === 'ready' && state.progress === 1));
    assert.deepEqual(unexpected, [], 'A model asset bypassed its verified cache pin');
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
