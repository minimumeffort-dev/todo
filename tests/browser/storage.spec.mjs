import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ms-playwright');
}
const { chromium } = await import('playwright');
const contract = await import('../../app/static/storage-contract.mjs');

async function staticServer() {
  const root = resolve('dist');
  const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/__storage.html') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Storage verification</title>');
      return;
    }
    const file = resolve(root, `.${path}`);
    if (!file.startsWith(`${root}${sep}`)) { response.writeHead(404).end(); return; }
    try {
      const info = statSync(file);
      if (!info.isFile()) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
      response.setHeader('Content-Length', info.size);
      createReadStream(file).pipe(response);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// Spawn the real production database worker and return an RPC caller.
// Registers the reply wait before each request so no acknowledgement is lost.
async function spawnRepository(page) {
  return page.evaluate(async ({ workerURL, version }) => {
    const worker = new Worker(workerURL, { type: 'module' });
    const pending = new Map();
    let sequence = 0;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Database worker did not become ready')), 20000);
      worker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message)); };
      function onReply(event) {
        const message = event.data;
        const waiter = pending.get(message?.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.ok) waiter.resolve(message.value);
        else waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code, status: message.error.status }));
      }
      globalThis.repositoryWorker = worker;
      worker.onmessage = (event) => {
        if (event.data?.ready === true) {
          clearTimeout(timeout);
          worker.onmessage = onReply;
          resolve();
          return;
        }
        onReply(event);
      };
    });
    const rpc = (method, args = []) => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      worker.postMessage({ version, id, method, args });
    });
    globalThis.repositoryRpc = rpc;
    return rpc('initialize');
  }, { workerURL: '/static/database-worker.mjs', version: contract.STORAGE_PROTOCOL_VERSION });
}

test('real worker persists tasks and embeddings across reload and browser restart', { timeout: 120_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'todo-storage-profile-'));
  const { server, origin } = await staticServer();
  let context;
  const externalRequests = [];
  const launch = async () => {
    context = await chromium.launchPersistentContext(profile, { headless: true });
    context.on('request', request => {
      if (!request.url().startsWith(`${origin}/`)) externalRequests.push(request.url());
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${origin}/__storage.html`);
    return page;
  };
  try {
    let page = await launch();
    await spawnRepository(page);
    const firstId = await page.evaluate(async () => {
      const created = await globalThis.repositoryRpc('create', [{ title: 'Persistent task', icon: 'star' }, { operationId: 'op-create-first' }]);
      const second = await globalThis.repositoryRpc('create', [{ title: 'Second task', icon: 'heart' }, { operationId: 'op-create-second' }]);
      if (created.todo.id === second.todo.id) throw new Error('Task ids must differ');
      const listed = await globalThis.repositoryRpc('list', []);
      if (listed.records.length !== 2) throw new Error('Expected two tasks');
      // Same operationId is idempotent: no duplicate task.
      const repeated = await globalThis.repositoryRpc('create', [{ title: 'Persistent task', icon: 'star' }, { operationId: 'op-create-first' }]);
      if (repeated.todo.id !== created.todo.id) throw new Error('Retried operationId must return the same task');
      if ((await globalThis.repositoryRpc('list', [])).records.length !== 2) throw new Error('Retry must not duplicate');
      const updated = await globalThis.repositoryRpc('update', [created.todo.id, { title: 'Edited task', icon: 'work' },
        { expectedRevision: created.revision, operationId: 'op-edit' }]);
      try {
        await globalThis.repositoryRpc('update', [created.todo.id, { title: 'Stale edit', icon: 'task' },
          { expectedRevision: created.revision, operationId: 'op-stale' }]);
        throw new Error('Stale revision must conflict');
      } catch (error) {
        if (error.code !== 'conflict') throw error;
      }
      await globalThis.repositoryRpc('setCompleted', [second.todo.id, true, { operationId: 'op-complete' }]);
      const vector = [0.25, -0.75, ...Array(766).fill(0)];
      const meta = { model: 'onnx-community/embeddinggemma-2-ONNX', revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0', input_version: 1, dimensions: 768 };
      await globalThis.repositoryRpc('saveEmbedding', [created.todo.id,
        { title: 'Edited task', icon: 'work', vector, ...meta }, { operationId: 'op-embed' }]);
      try {
        await globalThis.repositoryRpc('saveEmbedding', [created.todo.id,
          { title: 'Persistent task', icon: 'star', vector, ...meta }, { operationId: 'op-stale-embed' }]);
        throw new Error('Stale embedding source must conflict');
      } catch (error) {
        if (error.code !== 'conflict') throw error;
      }
      const pending = await globalThis.repositoryRpc('pendingEmbeddings', []);
      if (pending.records.length !== 1 || pending.records[0].todo.id !== second.todo.id) {
        throw new Error(`Expected one pending embedding, got ${JSON.stringify(pending.records.map(r => r.todo.id))}`);
      }
      const found = await globalThis.repositoryRpc('search', [{ vector, ...meta, limit: 20 }]);
      if (found.matches.length !== 1 || found.matches[0].todo.id !== created.todo.id) {
        throw new Error(`Expected one search match, got ${JSON.stringify(found)}`);
      }
      const currentList = await globalThis.repositoryRpc('list', []);
      const byId = new Map(currentList.records.map(record => [record.todo.id, record]));
      const current = byId.get(found.matches[0].todo.id);
      if (found.matches[0].revision !== current.revision || found.matches[0].source_revision !== current.source_revision) {
        throw new Error('Search matches must carry the current revision tokens');
      }
      if (found.min_score !== 0.70) throw new Error('Search cutoff must be 0.70');
      const backup = await globalThis.repositoryRpc('exportBackup', []);
      if (backup.format !== 'local-todo' || backup.version !== 1 || backup.todos.length !== 2) {
        throw new Error('Backup must contain both tasks');
      }
      try {
        await globalThis.repositoryRpc('importBackup', [{ format: 'other', version: 1, todos: [] }, {}]);
        throw new Error('Invalid backup must be rejected');
      } catch (error) {
        if (error.code !== 'validation') throw error;
      }
      const conflicting = JSON.parse(JSON.stringify(backup));
      conflicting.todos[0].title = 'Conflicting title';
      conflicting.todos.push({ id: 'new-id', title: 'New', icon: 'work', completed: false, created_at: new Date().toISOString() });
      try {
        await globalThis.repositoryRpc('importBackup', [conflicting, { operationId: 'op-conflict' }]);
        throw new Error('Conflicting backup must be rejected');
      } catch (error) {
        if (error.code !== 'conflict') throw error;
      }
      if ((await globalThis.repositoryRpc('list', [])).records.length !== 2) throw new Error('Conflict must change nothing');
      return created.todo.id;
    });
    assert.ok(firstId);
    // A second tab cannot take ownership while the first holds the lock.
    const second = await context.newPage();
    await second.goto(`${origin}/__storage.html`);
    assert.equal(await second.evaluate(lock => navigator.locks.request(lock,
      { mode: 'exclusive', ifAvailable: true }, acquired => acquired !== null), contract.DATABASE_LOCK), false);
    await second.close();
    // Abrupt owner loss: terminate without closing. The lock must release.
    await page.evaluate(() => { globalThis.repositoryWorker.terminate(); });
    await page.reload();
    await spawnRepository(page);
    const afterReload = await page.evaluate(async (expectedId) => {
      const listed = await globalThis.repositoryRpc('list', []);
      if (listed.records.length !== 2) throw new Error(`Expected two tasks after reload, got ${listed.records.length}`);
      const edited = listed.records.find(record => record.todo.id === expectedId);
      if (!edited || edited.todo.title !== 'Edited task' || edited.todo.icon !== 'work') {
        throw new Error('Edited task must survive reload');
      }
      const completed = listed.records.find(record => record.todo.id !== expectedId);
      if (!completed || completed.todo.completed !== true) throw new Error('Completion must survive reload');
      const pending = await globalThis.repositoryRpc('pendingEmbeddings', []);
      if (pending.records.length !== 1) throw new Error('Pending embeddings must survive reload');
      const vector = [0.25, -0.75, ...Array(766).fill(0)];
      const meta = { model: 'onnx-community/embeddinggemma-2-ONNX', revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0', input_version: 1, dimensions: 768 };
      const found = await globalThis.repositoryRpc('search', [{ vector, ...meta }]);
      if (found.matches.length !== 1 || found.matches[0].todo.id !== expectedId) {
        throw new Error('Search must work after reload');
      }
      return true;
    }, firstId);
    assert.equal(afterReload, true);
    await page.evaluate(() => { globalThis.repositoryWorker.terminate(); });
    await context.close();
    context = null;
    // Full browser restart with the same persistent profile.
    page = await launch();
    await spawnRepository(page);
    const afterRestart = await page.evaluate(async (expectedId) => {
      const listed = await globalThis.repositoryRpc('list', []);
      if (listed.records.length !== 2) throw new Error(`Expected two tasks after restart, got ${listed.records.length}`);
      const vector = [0.25, -0.75, ...Array(766).fill(0)];
      const meta = { model: 'onnx-community/embeddinggemma-2-ONNX', revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0', input_version: 1, dimensions: 768 };
      const found = await globalThis.repositoryRpc('search', [{ vector, ...meta }]);
      if (found.matches.length !== 1 || found.matches[0].todo.id !== expectedId) {
        throw new Error('Embeddings must survive a browser restart');
      }
      // Backup round-trip still works after restart.
      const backup = await globalThis.repositoryRpc('exportBackup', []);
      const merged = await globalThis.repositoryRpc('importBackup', [JSON.parse(JSON.stringify(backup)), { operationId: 'op-reimport' }]);
      if (merged.imported !== 0 || merged.skipped !== 2) throw new Error('Reimport must skip identical records');
      return true;
    }, firstId);
    assert.equal(afterRestart, true);
    assert.deepEqual(externalRequests, [], 'The repository must use only self-hosted assets');
    await page.evaluate(() => { globalThis.repositoryWorker.terminate(); });
  } finally {
    await context?.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    await rm(profile, { recursive: true, force: true });
  }
});

test('proxying, stale guards and uncertain-reply recovery without a backend', { timeout: 60_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'todo-coordinator-profile-'));
  const { server, origin } = await staticServer();
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: true });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${origin}/__storage.html`);
    const result = await page.evaluate(async () => {
      const { LocalTodoStore } = await import('/static/todo-store.mjs');
      const { createWorkerHost } = await import('/static/database-worker.mjs');
      const { createCoordinator, createMemoryChannel } = await import('/static/database-coordinator.mjs');
      const { StorageError } = await import('/static/storage-contract.mjs');
      const outcomes = [];
      const check = (name, condition) => outcomes.push([name, Boolean(condition)]);

      // Fault injection: quota and flush failures are truthful and roll back.
      const failingStore = new LocalTodoStore({ persist: async () => { throw new DOMException('No space', 'QuotaExceededError'); } });
      const failingHost = createWorkerHost({
        lock: { request: async (name, options, callback) => callback() },
        openDatabase: async () => ({}),
        store: failingStore,
      });
      await failingHost.handleRequest({ version: 1, id: 1, method: 'initialize', args: [] });
      const quotaReply = await failingHost.handleRequest({ version: 1, id: 2, method: 'create',
        args: [{ title: 'Draft kept' }, { operationId: 'op-quota' }] });
      check('quota is reported as a quota error', quotaReply.ok === false && quotaReply.error.code === 'quota');
      check('quota error carries the operationId', quotaReply.error.operationId === 'op-quota');
      const rolledBack = await failingHost.handleRequest({ version: 1, id: 3, method: 'list', args: [] });
      check('failed save leaves no rows', rolledBack.ok === true && rolledBack.value.records.length === 0);
      // Recovery with the same operationId succeeds after the failure clears.
      failingStore.persist = async () => {};
      const recovered = await failingHost.handleRequest({ version: 1, id: 4, method: 'create',
        args: [{ title: 'Draft kept' }, { operationId: 'op-quota' }] });
      check('same operationId recovers', recovered.ok === true);
      const duplicate = await failingHost.handleRequest({ version: 1, id: 5, method: 'create',
        args: [{ title: 'Draft kept' }, { operationId: 'op-quota' }] });
      check('duplicate operationId is idempotent',
        duplicate.ok === true && duplicate.value.todo.id === recovered.value.todo.id);

      // Missing storage support never falls back to memory.
      const noLockHost = createWorkerHost({
        lock: null,
        openDatabase: async () => ({}),
        store: new LocalTodoStore(),
      });
      const unavailable = await noLockHost.handleRequest({ version: 1, id: 6, method: 'initialize', args: [] });
      check('missing locks report unavailable', unavailable.ok === false && unavailable.error.code === 'unavailable');

      // Two tabs: one owner, one proxy client.
      let held = false;
      const locks = {
        request: async (name, options, callback) => {
          if (options?.ifAvailable && held) return null;
          held = true;
          try { return await callback(); } finally { /* Owner holds until worker ends. */ }
        },
        release() { held = false; },
      };
      const shared = new LocalTodoStore();
      const pair = createMemoryChannel();
      const owner = createCoordinator({ locks, spawnOwner: async () => shared, channel: pair.owner });
      const client = createCoordinator({ locks, spawnOwner: async () => { throw new Error('Client must never open the database'); }, channel: pair.client });
      const ownerState = await owner.initialize();
      check('first tab becomes owner', ownerState.owner === true);
      const clientEvents = [];
      client.subscribe((event) => clientEvents.push(event));
      const clientState = await client.initialize();
      check('second tab is a client', clientState.owner === false);
      const created = await client.create({ title: 'From another tab' });
      check('client write is proxied', typeof created.todo.id === 'string');
      await new Promise(done => setTimeout(done, 50));
      check('client receives commit notifications', clientEvents.length >= 1);
      const ownerList = await owner.list();
      check('owner sees the client write', ownerList.records.some(record => record.todo.id === created.todo.id));
      // Stale revision from the client is rejected, not overwritten.
      let staleRejected = false;
      try {
        await client.update(created.todo.id, { title: 'Stale', icon: 'task' }, { expectedRevision: 'outdated' });
      } catch (error) {
        staleRejected = error.code === 'conflict';
      }
      check('stale client edit conflicts', staleRejected);
      // Uncertain reply: the owner commits but the reply is lost; the retry
      // with the same operationId returns the committed result once.
      const flakyTarget = new LocalTodoStore();
      let attempts = 0;
      const flaky = new Proxy(flakyTarget, {
        get(target, property) {
          const value = target[property];
          if (property === 'create' && typeof value === 'function') {
            return async (...args) => {
              attempts += 1;
              const result = await value.apply(target, args);
              if (attempts === 1) throw new StorageError('unconfirmed', 'Transport lost', { operationId: args[1]?.operationId });
              return result;
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const pair2 = createMemoryChannel();
      let held2 = false;
      const locks2 = { request: async (name, options, callback) => {
        if (options?.ifAvailable && held2) return null;
        held2 = true;
        try { return await callback(); } finally {}
      } };
      const solo = createCoordinator({ locks: locks2, spawnOwner: async () => flaky, channel: pair2.owner });
      await solo.initialize();
      const uncertain = await solo.create({ title: 'Uncertain' }, { operationId: 'op-uncertain' });
      check('uncertain reply recovers the committed save', typeof uncertain.todo.id === 'string');
      check('uncertain retry does not duplicate', (await flakyTarget.list()).records.length === 1
        && attempts === 2);
      // Owner loss: releasing the lock lets another tab take ownership.
      locks.release();
      let ownerOpened = false;
      const replacement = createCoordinator({ locks,
        spawnOwner: async () => { ownerOpened = true; return new LocalTodoStore(); }, channel: pair.owner });
      // Fresh channel links are required for a new pair; reuse is enough for election here.
      await replacement.initialize();
      check('ownership transfers after owner loss', ownerOpened === true && replacement.owner === true);
      return outcomes;
    });
    for (const [name, passed] of result) {
      assert.equal(passed, true, name);
    }
    assert.ok(result.length >= 14, `Expected broad coverage, got ${result.length} checks`);
  } finally {
    await context?.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    await rm(profile, { recursive: true, force: true });
  }
});
