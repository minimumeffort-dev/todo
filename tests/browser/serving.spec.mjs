// Browser verification for the FastAPI distribution host.
//
// The static-app specs serve `dist/` from an inline Node fixture and cannot
// detect a host that omits those files. These tests drive the production
// host instead: an owned Uvicorn process running `app.main:app` over loopback
// on an allocated port (production serves port 8000 the same way after
// `npm run build`). They reproduce the original port-8000 report — `/` loaded
// while `/service-worker.mjs`, `/asset-manifest.json` and every `/vendor/`
// runtime returned 404 — and prove the repaired host: each manifest asset
// loads with the correct MIME type and hash, the root service worker
// activates, a dedicated model worker starts from the served bytes while the
// served Transformers.js build reports 4.3.1, and saved tasks survive an
// offline reload with zero task API traffic.
//
// Full model readiness (WebGPU inference, cache seeding) stays covered by
// `tests/browser/offline.spec.mjs`; this spec stops at runtime loading.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(
    process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ms-playwright');
}
const { chromium } = await import('playwright');

// Resolved through PATH so the pinned interpreter applies under `mise exec`.
const PYTHON = process.env.SERVING_PYTHON || 'python';
const CONTENT_TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
};
// Assets whose absence caused the original port-8000 failure report. The
// manifest cannot list its own SHA-256 (entries are hashed before it is
// written), so it is verified by direct fetch, not by membership.
const ESSENTIAL = ['/service-worker.mjs',
  '/vendor/transformers/transformers.min.js',
  '/vendor/duckdb/duckdb-browser.mjs',
  '/vendor/duckdb/duckdb-browser-blocking.mjs',
  '/vendor/duckdb/duckdb-mvp.wasm', '/vendor/duckdb/duckdb-eh.wasm',
  '/vendor/onnx/ort-wasm-simd-threaded.mjs',
  '/vendor/onnx/ort-wasm-simd-threaded.wasm'];
const TASK_TITLE = 'Survives the offline serving reload';

let host = null;

async function allocatePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startHost() {
  const scratch = await mkdtemp(join(tmpdir(), 'todo-serving-host-'));
  const port = await allocatePort();
  const child = execFile(PYTHON,
    ['-B', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)],
    { cwd: PROJECT_ROOT, stdio: 'ignore', env: { ...process.env,
      PYTHONDONTWRITEBYTECODE: '1', TODO_DB_PATH: join(scratch, 'todos.duckdb') } });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(`${origin}/health`)).ok) break;
    } catch { /* Still starting. */ }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`Owned Uvicorn did not become ready on ${port}`);
    }
    await delay(200);
  }
  return { origin, scratch, child };
}

async function readManifest(origin) {
  const response = await fetch(`${origin}/asset-manifest.json`);
  assert.equal(response.status, 200, '/asset-manifest.json status');
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const manifest = await response.json();
  assert.ok(typeof manifest.version === 'string' && typeof manifest.shellVersion === 'string');
  assert.ok(Array.isArray(manifest.assets) && manifest.assets.length > 0);
  for (const entry of manifest.assets) {
    assert.match(entry.url, /^\//);
    assert.equal(typeof entry.size, 'number');
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  }
  return manifest;
}

async function openApp(context, origin) {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#storage-status')
    ?.textContent.includes('Local storage ready'), null, { timeout: 25000 });
  return page;
}

before(async () => { host = await startHost(); });

after(async () => {
  if (host) {
    host.child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => host.child.once('exit', resolve)), delay(10000)]);
    if (host.child.exitCode === null) host.child.kill('SIGKILL');
    await rm(host.scratch, { recursive: true, force: true });
    host = null;
  }
});

test('port-8000 reproduction: every manifest asset loads from the FastAPI host',
  { timeout: 120_000 }, async () => {
    const manifest = await readManifest(host.origin);
    for (const url of ESSENTIAL) {
      assert.ok(manifest.assets.some((entry) => entry.url === url), `${url} is manifested`);
    }
    for (const entry of manifest.assets) {
      const response = await fetch(`${host.origin}${entry.url}`);
      assert.equal(response.status, 200, entry.url);
      const extension = entry.url.slice(entry.url.lastIndexOf('.'));
      assert.ok((response.headers.get('content-type') ?? '')
        .startsWith(CONTENT_TYPES[extension] ?? 'application/octet-stream'), entry.url);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, entry.size, entry.url);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.url);
    }
    for (const url of ['/service-worker.mjs', '/asset-manifest.json']) {
      const response = await fetch(`${host.origin}${url}`);
      assert.ok((response.headers.get('cache-control') ?? '').includes('no-cache'), url);
    }
    assert.equal((await fetch(`${host.origin}/vendor/duckdb/does-not-exist.mjs`)).status, 404);
    const root = await fetch(`${host.origin}/`);
    assert.equal(root.status, 200);
    assert.ok((root.headers.get('content-type') ?? '').startsWith('text/html'));
    assert.equal((await fetch(`${host.origin}/health`)).status, 200);
    const todos = await fetch(`${host.origin}/api/todos`);
    assert.equal(todos.status, 200);
    assert.deepEqual(await todos.json(), []);
    console.log(`FastAPI serving gate: ${manifest.assets.length} manifest assets verified`);
  });

test('root service worker activates and the dedicated worker serves Transformers.js 4.3.1',
  { timeout: 120_000 }, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'todo-serving-profile-'));
    // Software WebGPU lets the production worker reach its runtime import
    // without model weights; full readiness stays with offline.spec.mjs.
    const context = await chromium.launchPersistentContext(profile, { headless: true });
    try {
    console.log(`Chromium serving gate: ${context.browser().version()}`);
    const page = await openApp(context, host.origin);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
    const registration = await page.evaluate(async () => {
      const value = await navigator.serviceWorker.getRegistration();
      return { scope: value?.scope ?? null, scriptURL: value?.active?.scriptURL ?? null };
    });
    assert.equal(registration.scope, `${host.origin}/`);
    assert.ok((registration.scriptURL ?? '').endsWith('/service-worker.mjs'));
    // A dedicated worker imports the served Transformers.js build and
    // reports its version: an import failure (missing, corrupt or wrong-MIME
    // runtime) posts an error instead of a version, without needing model
    // weights or WebGPU. Full model readiness stays with offline.spec.mjs.
    const runtime = await page.evaluate((base) => new Promise((resolve, reject) => {
      const source = `import(${JSON.stringify(`${base}/vendor/transformers/transformers.min.js`)})`
        + `.then((module) => postMessage({ version: module.env?.version ?? null }))`
        + `.catch((error) => postMessage({ error: String(error?.message ?? error) }));`;
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const worker = new Worker(url, { type: 'module' });
      const timer = setTimeout(() => reject(new Error('Dedicated worker did not import the served runtime')), 30000);
      worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)); };
      worker.onmessage = (event) => {
        clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); resolve(event.data);
      };
    }), host.origin);
    if (runtime.error) throw new Error(`Dedicated worker could not import the served runtime: ${runtime.error}`);
    assert.equal(runtime.version, '4.3.1');
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  });

test('saved tasks survive offline reload without task API traffic',
  { timeout: 120_000 }, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'todo-serving-offline-'));
    const context = await chromium.launchPersistentContext(profile, { headless: true });
    const api = [];
    const external = [];
    context.on('request', (request) => {
      if (!request.url().startsWith(`${host.origin}/`)) external.push(request.url());
      if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url());
    });
    try {
      const page = await openApp(context, host.origin);
      // The production offline runtime reports ready only after the root
      // worker activates and precaches the shell, so the offline reload below
      // is served from cache instead of racing installation.
      const cache = await page.evaluate(
        async () => (await import('/static/offline.mjs')).offlineRuntime.initialize());
      assert.equal(cache.phase, 'ready');
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
      if (await page.locator('#todo-form').isHidden()) await page.locator('#new-task').click();
      await page.locator('#todo-title').fill(TASK_TITLE);
      await page.locator('#todo-title').press('Enter');
      await page.locator('.task-row', { hasText: TASK_TITLE }).first().waitFor({ timeout: 10000 });
      await context.setOffline(true);
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#storage-status')
        ?.textContent.includes('Local storage ready'), null, { timeout: 25000 });
      await page.locator('.task-row', { hasText: TASK_TITLE }).first().waitFor({ timeout: 10000 });
      assert.equal(await page.locator('.task-row').count(), 1);
      assert.deepEqual(api, []);
      assert.deepEqual(external, []);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
