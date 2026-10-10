import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { createModelCache, MODEL_ASSETS, MODEL_CACHE_NAME } from '../app/static/model-cache.mjs';
import { createModelWorker } from '../app/static/model-worker.mjs';
import { createModelRuntime } from '../app/static/model-runtime.mjs';
import { createOfflineRuntime } from '../app/static/offline.mjs';

function fixture() {
  const bodies = ['configuration', 'tokenizer', 'weights'].map(text => Buffer.from(text));
  const assets = bodies.map((body, i) => ({ path: `file${i}`, url: `https://example.invalid/file${i}`,
    size: body.length, sha256: createHash('sha256').update(body).digest('hex') }));
  const stores = new Map();
  let tail = Promise.resolve();
  const locks = { request(_name, action) { const result = tail.then(action); tail = result.catch(() => {}); return result; } };
  const storage = { keys: async () => [...stores.keys()], delete: async name => stores.delete(name),
    open: async name => {
      if (!stores.has(name)) stores.set(name, new Map());
      const data = stores.get(name);
      return { match: async url => data.get(url)?.clone(),
        put: async (url, response) => data.set(url, response.clone()), delete: async url => data.delete(url) };
    } };
  const calls = [];
  let fetchMode = null, putMode = null;
  const wrapped = { ...storage, open: async name => {
    const cache = await storage.open(name);
    return { ...cache, put: async (...args) => {
      if (putMode === 'quota') throw new DOMException('Full', 'QuotaExceededError');
      if (putMode !== 'noop') await cache.put(...args);
    } };
  } };
  const options = { assets, name: 'managed-model', storage: wrapped, locks, crypto: webcrypto,
    fetchAsset: async url => {
      calls.push(url);
      const index = assets.findIndex(asset => asset.url === url);
      if (fetchMode === 'interrupted' && index === 1) return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(Error('Disconnected')); },
      }));
      if (fetchMode === 'corrupt') return new Response(Buffer.alloc(bodies[index].length));
      return new Response(bodies[index]);
    } };
  return { cache: createModelCache(options), create: () => createModelCache(options), calls, storage, assets,
    setFetch: mode => { fetchMode = mode; }, setPut: mode => { putMode = mode; } };
}

// Each read is released by the test. Waiting for the next pull confirms that
// the preceding chunk reached the consumer, without wall-clock sleeps.
function controlledDownload() {
  let next = Promise.withResolvers();
  let controller;
  let resume;
  const body = new ReadableStream({
    start(value) { controller = value; },
    pull() {
      const pending = Promise.withResolvers();
      resume = pending.resolve;
      next.resolve();
      return pending.promise;
    },
  }, { highWaterMark: 0 });
  return {
    response: new Response(body),
    async waiting() { await next.promise; next = Promise.withResolvers(); },
    send(bytes) { controller.enqueue(bytes); resume(); },
    close() { controller.close(); resume(); },
    abort() { controller.error(Error('Test download cancelled')); resume?.(); },
  };
}

function downloadFixture(body) {
  const f = fixture();
  const asset = { path: 'weights', url: 'https://example.invalid/weights', size: body.length,
    sha256: createHash('sha256').update(body).digest('hex') };
  const download = controlledDownload();
  const cache = createModelCache({ assets: [asset], name: 'managed-model',
    storage: f.storage, crypto: webcrypto,
    locks: { request: (_name, action) => action() }, fetchAsset: async () => download.response });
  return { ...f, asset, download, cache };
}

function downloadingRuntime(cache) {
  const sample = Promise.withResolvers();
  const testing = Promise.withResolvers();
  const states = [];
  let configurationCalls = 0;
  let work;
  const worker = { terminated: false,
    postMessage(message) { work = handler.handleMessage(message); },
    terminate() { this.terminated = true; void handler.dispose(); } };
  const handler = createModelWorker({ cache,
    postMessage: message => worker.onmessage?.({ data: message }),
    gpu: { requestAdapter: async () => ({ features: new Set() }) },
    importRuntime: async () => ({ env: { version: '4.3.1', backends: { onnx: { wasm: {} } } },
      AutoConfig: { from_pretrained: async () => {
        ++configurationCalls;
        return { model_type: 'embedding_gemma2', text_config: { embedding_dim: 768 } };
      } },
      AutoTokenizer: { from_pretrained: async () => () => ({}) },
      AutoModel: { from_pretrained: async () => async () => {
        await sample.promise;
        return { sentence_embedding: { type: 'float32', data: new Float32Array(768).fill(1), dims: [1, 768] } };
      } },
    }),
  });
  const runtime = createModelRuntime({ supportsWebGPU: () => true, createWorker: () => worker });
  runtime.subscribe(state => {
    states.push(state);
    if (state.phase === 'testing') testing.resolve();
  });
  return { runtime, worker, states, sample, testing,
    configurationCalls: () => configurationCalls, work: () => work };
}

test('model watchdog survives active downloads longer than its inactivity limit', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const body = Buffer.alloc(7_000, 42);
  const f = downloadFixture(body);
  const pipeline = downloadingRuntime(f.cache);
  const loaded = pipeline.runtime.loadAndTest();
  const outcome = loaded.then(() => null, error => error);
  try {
    await f.download.waiting();
    for (let offset = 0; offset < body.length; offset += 1_000) {
      t.mock.timers.tick(40_000);
      f.download.send(body.subarray(offset, offset + 1_000));
      await f.download.waiting();
      assert.equal(pipeline.worker.terminated, false, 'Continuous incoming bytes must keep the worker alive');
      assert.equal(pipeline.states.at(-1).phase, 'loading');
    }
    assert.equal(Date.now(), 280_000);
    assert.equal(pipeline.configurationCalls(), 0, 'No configuration or inference before complete verification');
    assert.equal(await (await f.storage.open('managed-model')).match(f.asset.url), undefined);
    f.download.close();
    await pipeline.testing.promise;
    assert.equal((await f.cache.inspect()).complete, true);
    assert.equal(pipeline.states.at(-1).phase, 'testing', 'Cached bytes alone do not establish readiness');
    pipeline.sample.resolve();
    assert.equal(await outcome, null);
    assert.equal(pipeline.states.at(-1).phase, 'ready');
  } finally {
    f.download.abort(); pipeline.sample.resolve(); pipeline.runtime.dispose();
    await outcome; await pipeline.work();
  }
});

test('model watchdog still rejects a stalled download without caching partial bytes', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const f = downloadFixture(Buffer.from('unfinished weights'));
  const pipeline = downloadingRuntime(f.cache);
  const loaded = pipeline.runtime.loadAndTest();
  const rejected = assert.rejects(loaded, /stopped responding/);
  try {
    await f.download.waiting();
    t.mock.timers.tick(40_000);
    f.download.send(Buffer.from('un'));
    await f.download.waiting();
    t.mock.timers.tick(179_999);
    assert.equal(pipeline.worker.terminated, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(pipeline.worker.terminated, true);
    assert.equal(pipeline.configurationCalls(), 0);
    assert.ok(!pipeline.states.some(state => ['testing', 'ready'].includes(state.phase)));
    assert.equal(await (await f.storage.open('managed-model')).match(f.asset.url), undefined);
  } finally {
    f.download.abort(); pipeline.runtime.dispose(); await pipeline.work();
  }
});

test('model watchdog download updates are bounded while reporting received bytes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const f = downloadFixture(Buffer.alloc(1_000, 42));
  const updates = [];
  const preparing = f.cache.prepare(info => updates.push({ ...info, at: Date.now() }));
  try {
    await f.download.waiting();
    for (let i = 0; i < 1_000; ++i) {
      t.mock.timers.tick(1);
      f.download.send(new Uint8Array([42]));
      await f.download.waiting();
    }
    const streaming = updates.filter(info => info.progress > 0 && info.message.startsWith('Downloading'));
    assert.ok(streaming.length > 0, 'Progress must arrive before EOF');
    assert.ok(streaming.length <= 10, 'At most ten streaming updates per second');
    assert.ok(streaming.every((info, i) => Number.isFinite(info.progress) && info.progress <= 1
      && info.progress === info.at / 1_000 && (!i || info.at - streaming[i - 1].at >= 100)));
    assert.equal(await (await f.storage.open('managed-model')).match(f.asset.url), undefined);
    f.download.close();
    assert.equal((await preparing).complete, true);
  } finally {
    f.download.abort(); await preparing.catch(() => {});
  }
});

test('streaming downloads reject size mismatches before committing cache entries', async () => {
  for (const oversized of [false, true]) {
    const f = fixture();
    const body = Buffer.alloc(oversized ? f.assets[0].size + 1 : f.assets[0].size - 1);
    let cancelled = false;
    const cache = createModelCache({ assets: [f.assets[0]], name: 'managed-model',
      storage: f.storage, crypto: webcrypto, locks: { request: (_name, action) => action() },
      fetchAsset: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(body); if (!oversized) controller.close(); },
        cancel() { cancelled = true; },
      })),
    });
    await assert.rejects(cache.prepare(), error => error.name === 'ModelCacheError'
      && /model file/.test(error.cause?.message));
    assert.equal((await cache.inspect()).files, 0);
    if (oversized) assert.equal(cancelled, true, 'Oversized downloads must stop reading');
  }
});

test('immutable cache manifest pins every required model file exactly once', () => {
  assert.equal(MODEL_ASSETS.length, 5);
  assert.equal(new Set(MODEL_ASSETS.map(asset => asset.url)).size, 5);
  assert.ok(MODEL_ASSETS.every(asset => /^[a-f0-9]{64}$/.test(asset.sha256)
    && asset.url.includes('daa72c51243991dfcaf9f9137d2c573d8f7790c0')));
  assert.match(MODEL_CACHE_NAME, /^local-todo-model-v1-/);
});

test('interrupted streaming never completes; retry reuses the verified prior file', async () => {
  const f = fixture(); f.setFetch('interrupted');
  await assert.rejects(f.cache.prepare(), /download or cache verification failed/);
  assert.deepEqual((await f.cache.inspect()).files, 1);
  f.setFetch(null); await f.cache.prepare();
  assert.equal((await f.cache.inspect()).complete, true);
  assert.deepEqual(f.calls, [f.assets[0].url, f.assets[1].url, f.assets[1].url, f.assets[2].url]);
});

test('quota and unconfirmed cache writes fail truthfully and can retry', async () => {
  for (const mode of ['quota', 'noop']) {
    const f = fixture(); f.setPut(mode);
    await assert.rejects(f.cache.prepare(), mode === 'quota' ? /storage is full/ : /verification failed/);
    assert.equal((await f.cache.inspect()).complete, false);
    f.setPut(null); await f.cache.prepare();
    assert.equal((await f.cache.inspect()).complete, true);
  }
});

test('same-length corruption is repaired while complete files are reused', async () => {
  const f = fixture(); const saved = await f.cache.prepare();
  const data = await f.storage.open('managed-model');
  await data.put(f.assets[1].url, new Response(Buffer.alloc(f.assets[1].size)));
  assert.equal((await f.cache.inspect()).complete, false);
  await assert.rejects(saved.customCache.match(f.assets[1].url), /failed verification/);
  await f.cache.prepare();
  assert.deepEqual(f.calls.slice(3), [f.assets[1].url]);
  f.setFetch('corrupt'); await data.delete(f.assets[2].url);
  await assert.rejects(f.cache.prepare(), /verification failed/);
  assert.equal((await f.cache.inspect()).complete, false);
});

test('parallel owners share completed assets under the origin lock, without duplicate copies', async () => {
  const f = fixture();
  const first = f.cache.prepare(); assert.equal(first, f.cache.prepare());
  await Promise.all([first, f.create().prepare()]);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(await f.storage.keys(), ['managed-model']);
});

test('legacy migration, read-only probes and clear preserve unrelated caches', async () => {
  const f = fixture();
  const legacy = await f.storage.open('transformers-cache');
  await legacy.put(f.assets[0].url, new Response('configuration'));
  await legacy.put('https://elsewhere.invalid/other', new Response('keep'));
  await f.storage.open('local-todo-shell-v1-current');
  const saved = await f.cache.prepare();
  assert.equal(f.calls.length, 2);
  assert.equal(await legacy.match(f.assets[0].url), undefined);
  assert.equal((await saved.customCache.match('https://example.invalid/optional.json')).status, 404);
  await assert.rejects(saved.customCache.put(), /managed cache/);
  await f.cache.clear();
  assert.equal((await legacy.match('https://elsewhere.invalid/other')).status, 200);
  assert.deepEqual(await f.storage.keys(), ['transformers-cache', 'local-todo-shell-v1-current']);
});

test('cache failure prevents configuration, sample testing and ready in the actual worker lifecycle', async () => {
  const states = []; let configuration = false;
  const handler = createModelWorker({ postMessage: state => states.push(state),
    gpu: { requestAdapter: async () => ({ features: new Set() }) },
    cache: { prepare: async () => { throw Error('Cache write failed'); } },
    importRuntime: async () => ({ env: { version: '4.3.1' },
      AutoConfig: { from_pretrained() { configuration = true; } } }) });
  await handler.handleMessage({ type: 'load-and-test', id: 1 });
  assert.equal(configuration, false);
  assert.equal(states.at(-1).phase, 'error');
  assert.ok(!states.some(state => ['testing', 'ready'].includes(state.phase)));
});

test('missing persistent caching cannot silently fall back', async () => {
  await assert.rejects(createModelCache({ storage: null }).prepare(), /unavailable/);
});

test('model cache recovery cancels work before clearing files', async () => {
  const sequence = []; let worker;
  const runtime = createModelRuntime({ supportsWebGPU: () => true,
    createWorker: () => worker = { postMessage() {}, terminate() { sequence.push('terminate'); } },
    clearModelCache: async () => sequence.push('clear') });
  const loading = runtime.loadAndTest();
  const cancelled = assert.rejects(loading, { name: 'AbortError' });
  await runtime.clearCache(); await cancelled;
  assert.deepEqual(sequence, ['terminate', 'clear']);
  let state; runtime.subscribe(value => { state = value; });
  assert.equal(state.phase, 'idle');
});

test('unsupported shell caching remains separate and does not activate a model', async () => {
  const runtime = createOfflineRuntime({ navigator: {}, secure: false });
  assert.equal((await runtime.initialize()).phase, 'unsupported');
});
