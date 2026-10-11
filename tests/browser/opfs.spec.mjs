import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';

// Downloads are reusable across checks; only the browser profile is disposable.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ms-playwright');
}
const { chromium } = await import('playwright');
const contract = await import('../../app/static/storage-contract.mjs');

// A scoped test fixture served over HTTP; never written to /static on disk.
const blockingWorkerFixture = `
import * as duckdb from '/vendor/duckdb/duckdb-browser-blocking.mjs';
import { DATABASE_PATH, DATABASE_LOCK, DUCKDB_BUNDLES, flushOPFSHandles }
  from '/static/storage-contract.mjs';
let db, connection;
let queue = Promise.resolve();
const reply = (id, value) => postMessage({ id, ok: true, value });
const fail = (id, error) => postMessage({ id, ok: false, error: { name: error.name, message: error.message } });
self.onmessage = ({ data }) => {
  if (data.method === 'open') {
    navigator.locks.request(DATABASE_LOCK, { mode: 'exclusive' }, async () => {
      const bundles = data.mvp ? { mvp: DUCKDB_BUNDLES.mvp } : DUCKDB_BUNDLES;
      db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.BROWSER_RUNTIME);
      await db.instantiate();
      await db.prepareDBFileHandle(DATABASE_PATH, duckdb.DuckDBDataProtocol.BROWSER_FSACCESS);
      db.open({ path: DATABASE_PATH, accessMode: duckdb.DuckDBAccessMode.READ_WRITE, useDirectIO: true });
      connection = db.connect();
      reply(data.id, db.getVersion());
      // Worker lifetime owns the lock. Termination releases it automatically.
      await new Promise(() => {});
    }).catch(error => fail(data.id, error));
    return;
  }
  queue = queue.then(() => {
    if (data.method === 'write') {
      connection.query('BEGIN TRANSACTION');
      connection.query('CREATE TABLE worker_tasks(id VARCHAR PRIMARY KEY,title VARCHAR,completed BOOLEAN,embedding FLOAT[])');
      connection.query("INSERT INTO worker_tasks VALUES ('worker-id','Flushed in worker',true,[0.25,0.5,0.75]::FLOAT[])");
      connection.query('COMMIT');
      connection.query('CHECKPOINT');
      flushOPFSHandles(duckdb.BROWSER_RUNTIME);
      reply(data.id, 'confirmed');
    } else if (data.method === 'read') {
      const table = connection.query('SELECT * FROM worker_tasks ORDER BY id');
      reply(data.id, table.toArray().map(row => ({ id:row.id,title:row.title,
        completed:row.completed,embedding:Array.from(row.embedding) })));
    } else if (data.method === 'failed-flush') {
      const handle = duckdb.BROWSER_RUNTIME._files.get(DATABASE_PATH);
      handle.flush = () => { throw new DOMException('Injected native quota/flush failure', 'QuotaExceededError'); };
      try { flushOPFSHandles(duckdb.BROWSER_RUNTIME); }
      finally { delete handle.flush; }
      reply(data.id, 'THIS MUST NEVER BE ACKNOWLEDGED');
    } else throw Error('Unknown worker fixture operation');
  }).catch(error => fail(data.id, error));
};
`;

async function staticServer() {
  const root = resolve('dist');
  const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/__blocking-worker.mjs') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(blockingWorkerFixture);
      return;
    }
    if (path === '/__opfs.html') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>OPFS persistence verification</title>');
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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function openDatabase(page, bundle) {
  return page.evaluate(async ({ bundle, path, lock, moduleURL }) => {
    if (!isSecureContext || !navigator.storage?.getDirectory || !navigator.locks) throw Error('Persistent OPFS and Web Locks are required');
    const duckdb = await import(moduleURL);
    let initialized, failed;
    const ready = new Promise((resolve, reject) => { initialized = resolve; failed = reject; });
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    globalThis.gateOwner = navigator.locks.request(lock, { mode: 'exclusive' }, async () => {
      const worker = new Worker(bundle.mainWorker);
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      try {
        await db.instantiate(bundle.mainModule);
        await db.open({ path, accessMode: duckdb.DuckDBAccessMode.READ_WRITE, opfs: { fileHandling: 'manual' } });
        const connection = await db.connect();
        globalThis.gate = { db, connection, worker, release };
        initialized({ version: await db.getVersion(), bundle: bundle.mainModule });
        await hold;
      } catch (error) { failed(error); throw error; }
      finally { worker.terminate(); }
    });
    // Observe initialization failures immediately, without waiting for hold.
    gateOwner.catch(() => {});
    return ready;
  }, { bundle, path: contract.DATABASE_PATH, lock: contract.DATABASE_LOCK, moduleURL: contract.DUCKDB_MODULE_URL });
}

async function readRecords(page) {
  return page.evaluate(async () => {
    const result = await gate.connection.query('SELECT id,title,completed,embedding FROM gate_tasks ORDER BY id');
    return result.toArray().map(row => ({
      id: row.id, title: row.title, completed: row.completed, embedding: Array.from(row.embedding),
    }));
  });
}

test('pinned DuckDB OPFS writes survive flush, worker termination, reload and browser-profile restart', { timeout: 25_000 }, async () => {
  const packageInfo = JSON.parse(readFileSync('node_modules/@duckdb/duckdb-wasm/package.json', 'utf8'));
  assert.equal(packageInfo.version, contract.DUCKDB_VERSION);
  const documentation = readFileSync('docs/browser-compatibility.md', 'utf8');
  assert.ok(documentation.includes(contract.DUCKDB_VERSION));
  assert.ok(documentation.includes('https://duckdb.org/docs/current/clients/wasm/instantiation#persistence-with-opfs'));
  assert.match(documentation, /CHECKPOINT/);
  const profile = await mkdtemp(join(tmpdir(), 'todo-opfs-profile-'));
  const { server, origin } = await staticServer();
  let context;
  const externalRequests = [];
  const launch = async () => {
    context = await chromium.launchPersistentContext(profile, { headless: true });
    context.on('request', request => {
      if (!request.url().startsWith(`${origin}/`)) externalRequests.push(request.url());
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${origin}/__opfs.html`);
    return page;
  };
  try {
    let page = await launch();
    const info = await openDatabase(page, contract.DUCKDB_BUNDLES.eh);
    assert.match(info.version, /^v?1\./);
    // This document deliberately has no isolation headers; OPFS must work
    // with the single-threaded bundle without requiring SharedArrayBuffer.
    assert.equal(await page.evaluate(() => crossOriginIsolated), false);
    const second = await context.newPage();
    await second.goto(`${origin}/__opfs.html`);
    assert.equal(await second.evaluate(lock => navigator.locks.request(lock,
      { mode: 'exclusive', ifAvailable: true }, acquired => acquired !== null), contract.DATABASE_LOCK), false);
    await second.close();
    await page.evaluate(async () => {
      await gate.connection.query('BEGIN TRANSACTION');
      await gate.connection.query('CREATE TABLE gate_tasks(id VARCHAR PRIMARY KEY,title VARCHAR,completed BOOLEAN,embedding FLOAT[])');
      await gate.connection.query("INSERT INTO gate_tasks VALUES ('saved-id','Persistent task',true,[0.5,-0.25,0.75]::FLOAT[])");
      await gate.connection.query('COMMIT');
      await gate.connection.query('CHECKPOINT');
      // Exercise the documented async API. A separate proof below verifies
      // an explicit native flush barrier rather than trusting flushFiles.
      await gate.db.flushFiles();
    });
    const expected = [{ id: 'saved-id', title: 'Persistent task', completed: true, embedding: [0.5, -0.25, 0.75] }];
    assert.deepEqual(await readRecords(page), expected);
    const fileSize = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle('local-todo.duckdb');
      return (await file.getFile()).size;
    });
    assert.ok(fileSize > 0, 'A real OPFS database file must exist');
    // Abrupt termination: no connection close/reset/last-minute checkpoint.
    await page.evaluate(() => { gate.worker.terminate(); gate.release(); });
    await page.reload();
    await openDatabase(page, contract.DUCKDB_BUNDLES.eh);
    assert.deepEqual(await readRecords(page), expected);
    await page.evaluate(() => { gate.worker.terminate(); gate.release(); });
    await context.close();
    context = null;
    page = await launch();
    // Also exercise the portable MVP fallback against the same durable file.
    await openDatabase(page, contract.DUCKDB_BUNDLES.mvp);
    assert.deepEqual(await readRecords(page), expected);
    assert.deepEqual(externalRequests, [], 'The persistence proof must use only self-hosted runtime assets');
    await page.evaluate(() => { gate.worker.terminate(); gate.release(); });
  } finally {
    await context?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
});

async function startBlockingWorker(page, mvp = false) {
  return page.evaluate(async mvp => {
    const worker = new Worker('/__blocking-worker.mjs', { type: 'module' });
    const pending = new Map();
    let sequence = 0;
    const rpc = (method, values = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, ...values });
    });
    worker.onmessage = ({ data }) => {
      const waiter = pending.get(data.id);
      if (!waiter) return;
      pending.delete(data.id);
      if (data.ok) waiter.resolve(data.value);
      else waiter.reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
    };
    worker.onerror = event => {
      for (const waiter of pending.values()) waiter.reject(new Error(event.message));
      pending.clear();
    };
    globalThis.blocking = { worker, rpc };
    return rpc('open', { mvp });
  }, mvp);
}

test('owning worker explicitly flushes native OPFS handles and propagates failures before acknowledging', { timeout: 25_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'todo-native-opfs-profile-'));
  const { server, origin } = await staticServer();
  let context;
  const launch = async () => {
    context = await chromium.launchPersistentContext(profile, { headless: true });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${origin}/__opfs.html`);
    return page;
  };
  try {
    let page = await launch();
    await startBlockingWorker(page);
    assert.equal(await page.evaluate(lock => navigator.locks.request(lock,
      { ifAvailable: true }, acquired => acquired !== null), contract.DATABASE_LOCK), false);
    assert.equal(await page.evaluate(() => blocking.rpc('write')), 'confirmed');
    const expected = [{ id: 'worker-id', title: 'Flushed in worker', completed: true, embedding: [0.25, 0.5, 0.75] }];
    assert.deepEqual(await page.evaluate(() => blocking.rpc('read')), expected);
    const failure = await page.evaluate(async () => {
      try { return { acknowledged: await blocking.rpc('failed-flush') }; }
      catch (error) { return { name: error.name, message: error.message }; }
    });
    assert.equal(failure.name, 'QuotaExceededError');
    assert.match(failure.message, /Injected native quota\/flush failure/);
    assert.equal('acknowledged' in failure, false);
    await page.evaluate(() => blocking.worker.terminate());
    await page.reload();
    await startBlockingWorker(page);
    assert.deepEqual(await page.evaluate(() => blocking.rpc('read')), expected);
    await page.evaluate(() => blocking.worker.terminate());
    await context.close();
    context = null;
    page = await launch();
    await startBlockingWorker(page, true);
    assert.deepEqual(await page.evaluate(() => blocking.rpc('read')), expected);
    await page.evaluate(() => blocking.worker.terminate());
  } finally {
    await context?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
});
