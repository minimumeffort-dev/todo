// Offline restart with real inference and a zero-backend audit. A persistent
// Chromium profile visits the built app once online (caching the app shell
// and the pinned model files) and creates tasks through the real database
// worker, then the HTTP server is shut down and the same profile reopens
// fully offline: the app shell loads from cache, the persisted tasks are
// visible, the app auto-loads the model and backfills embeddings into the
// reopened local database, and a UI semantic search ranks the paraphrase
// first. A second test-owned database worker is never spawned: the app page
// owns the exclusive database lock, so all offline database access goes
// through the app's own owner. No task data, embedding or search request
// reaches a backend or remote service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, extname, sep, basename } from 'node:path';
import { chromium } from 'playwright';
import { ensureDist, makeProfile, dropProfile, CONTENT_TYPES } from './model-fixtures.mjs';
import { MODEL_ASSETS, MODEL_CACHE_NAME } from '../../app/static/model-cache.mjs';
import { STORAGE_PROTOCOL_VERSION } from '../../app/static/storage-contract.mjs';

const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
const ASSET_DIR = join(cacheRoot, 'local-todo/model-assets');
const PROBE_HTML = '<!doctype html><meta charset="utf-8"><title>Offline verification</title><h1>probe</h1>';

async function fixture() {
  const dist = await ensureDist();
  const folder = await makeProfile('todo-verify-offline-');
  const served = [];
  const requests = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    served.push(path);
    requests.push({ path, method: request.method });
    if (path === '/__verify.html') {
      response.setHeader('Content-Type', 'text/html'); response.end(PROBE_HTML); return;
    }
    let file;
    if (path.startsWith('/__fixture/')) file = join(ASSET_DIR, basename(path));
    else file = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
    if (!path.startsWith('/__fixture/') && !file.startsWith(dist + sep)) { response.writeHead(404).end(); return; }
    try {
      const info = statSync(file);
      if (!info.isFile()) throw new Error('Not file');
      response.setHeader('Content-Type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Length', info.size);
      createReadStream(file).pipe(response);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, served, requests,
    async stopServer() { server.closeAllConnections(); await new Promise(done => server.close(done)); },
    async close() { await dropProfile(folder); },
    profile: join(folder, 'profile'),
  };
}

async function seedModel(page) {
  for (const asset of MODEL_ASSETS) {
    const bytes = await readFile(join(ASSET_DIR, asset.path.split('/').pop()));
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.path);
  }
  await page.evaluate(async () => {
    const { createModelCache } = await import('/static/model-cache.mjs');
    await createModelCache({ fetchAsset: url => fetch(`/__fixture/${url.split('/').pop()}`) }).prepare();
  });
}

test('persistent profile reopens offline with real inference and zero backend traffic', { timeout: 120000 }, async () => {
  const f = await fixture();
  let context;
  const external = [];
  try {
    context = await chromium.launchPersistentContext(f.profile, { channel: 'chromium', headless: true,
      args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-webgpu-developer-features'] });
    context.on('request', request => {
      if (!request.url().startsWith(`${f.origin}/`)) external.push({ url: request.url(), body: request.postData() });
    });
    let page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${f.origin}/__verify.html`);
    // Cache the app shell and the pinned model files while online.
    const shell = await page.evaluate(async () => {
      const { createOfflineRuntime } = await import('/static/offline.mjs');
      return (await createOfflineRuntime({ timeoutMs: 15000 }).initialize()).phase;
    });
    assert.equal(shell, 'ready');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
    await seedModel(page);
    // Create tasks in the real local database while online.
    await page.evaluate(async (version) => {
      const worker = new Worker('/static/database-worker.mjs', { type: 'module' });
      const pending = new Map();
      let sequence = 0;
      await new Promise((resolveOuter, rejectOuter) => {
        const timeout = setTimeout(() => rejectOuter(new Error('Database worker did not become ready')), 25000);
        worker.onmessage = (event) => {
          if (event.data?.ready === true) { clearTimeout(timeout); resolveOuter(); return; }
          const waiter = pending.get(event.data?.id);
          if (!waiter) return;
          pending.delete(event.data.id);
          waiter(event.data.ok ? { ok: true, value: event.data.value }
            : { ok: false, error: event.data.error });
        };
        worker.onerror = (event) => { clearTimeout(timeout); rejectOuter(new Error(event.message)); };
      });
      globalThis.verifyWorker = worker;
      globalThis.verifyRpc = (method, args = []) => new Promise((resolve) => {
        const id = ++sequence;
        pending.set(id, resolve);
        worker.postMessage({ version, id, method, args });
      });
      const initialized = await globalThis.verifyRpc('initialize');
      if (!initialized.ok) throw new Error(initialized.error.message);
      for (const [title, icon, operationId] of
        [['Buy fresh groceries', 'shopping', 'net-groceries'], ['Read a science fiction novel', 'star', 'net-book']]) {
        const created = await globalThis.verifyRpc('create', [{ title, icon }, { operationId }]);
        if (!created.ok) throw new Error(created.error.message);
      }
      const listed = await globalThis.verifyRpc('list', []);
      if (!listed.ok) throw new Error(listed.error.message);
      if (listed.value.records.length !== 2) throw new Error('Expected two online tasks');
      worker.terminate();
    }, STORAGE_PROTOCOL_VERSION);
    const servedOnline = f.served.length;
    // Go fully offline: shut down HTTP and restart the same profile.
    await context.close();
    context = null;
    await f.stopServer();
    context = await chromium.launchPersistentContext(f.profile, { channel: 'chromium', headless: true,
      args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-webgpu-developer-features'] });
    await context.setOffline(true);
    context.on('request', request => {
      if (!request.url().startsWith('http://127.0.0.1')) external.push({ url: request.url(), body: request.postData() });
    });
    page = context.pages()[0] ?? await context.newPage();
    // The app shell must load with no server: index comes from the app cache.
    await page.goto(`${f.origin}/`);
    await page.locator('h1').first().waitFor({ timeout: 15000 });
    // The app shell loads from cache with no server, and the tasks created
    // online are visible from the reopened local database.
    await page.locator('.task-row', { hasText: 'Buy fresh groceries' }).waitFor({ timeout: 15000 });
    await page.locator('.task-row', { hasText: 'Read a science fiction novel' }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.task-row').count(), 2);
    // The app loads the model automatically; background backfill embeds the
    // tasks into the reopened database, and each completed save re-runs the
    // current query. One fill is enough: the view live-updates to the end
    // state where everything is indexed and the paraphrase ranks first.
    await page.waitForFunction(() => document.querySelector('#model-status')
      ?.textContent.includes('Model ready.'), null, { timeout: 20000 });
    await page.locator('#todo-search').fill('buy food');
    await page.waitForFunction(() => {
      const status = document.querySelector('#search-status')?.textContent ?? '';
      const visible = [...document.querySelectorAll('.task-row')].filter(row => !row.hidden);
      return status === '1 results'
        && visible.length === 1
        && visible[0].textContent.includes('Buy fresh groceries');
    }, null, { timeout: 25000 });
    // The rendered score is the real cosine similarity of offline embeddings
    // stored in the reopened database; it must clear the 0.70 calibration.
    const rowText = await page.locator('.task-row:not([hidden])').first().innerText();
    const score = parseFloat(/Similarity ([0-9.]+)/.exec(rowText)?.[1] ?? 'NaN');
    assert.ok(score >= 0.70, `Real paraphrase similarity must clear calibration, got ${rowText}`);
    // The guidance carries the repository cutoff verbatim.
    assert.match(await page.locator('#search-explain').innerText(), /at least 0\.70/);
    // Audit: no task API, no remote inference, no task/query text leaves the origin.
    assert.deepEqual(f.requests.filter(entry => entry.path.startsWith('/api/')), []);
    assert.deepEqual(f.served.slice(servedOnline).filter(path => !path.startsWith('/__fixture/')), [],
      'Offline restart must not reach the (now closed) HTTP server');
    const remote = external.filter(entry => !entry.url.startsWith('http://127.0.0.1'));
    assert.deepEqual(remote, [], 'No request may leave loopback');
    for (const entry of external) {
      for (const secret of ['groceries', 'groceries'.slice(0, 5), 'science fiction', 'buy food']) {
        assert.equal((entry.body ?? '').includes(secret), false, `Task text leaked to ${entry.url}`);
      }
    }
    const inventory = await page.evaluate(async () => {
      const result = {};
      for (const name of await caches.keys()) {
        result[name] = (await (await caches.open(name)).keys()).map(request => request.url);
      }
      return result;
    });
    assert.equal(inventory[MODEL_CACHE_NAME].length, 5);
    assert.equal(Object.values(inventory).flat().filter(url => url.includes('huggingface.co')).length, 5);
  } finally {
    await context?.close().catch(() => {});
    await f.stopServer().catch(() => {});
    await f.close();
  }
});
