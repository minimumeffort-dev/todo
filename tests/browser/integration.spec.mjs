// Verification against the built static app using the real browser repository
// (OPFS-backed DuckDB worker). No backend, no /api traffic, no stubs: task
// operations run through the production database worker and coordinator.
//
// Covers: persistence across reload and full browser restart, completion
// states, safe multi-tab use, stale edit/embedding rejection, quota
// truthfulness with idempotent recovery, backup round-trips with
// invalid/conflicting import rejection, keyboard use, 375px touch layout
// and reduced motion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serveDist, makeProfile, dropProfile } from './model-fixtures.mjs';
import { STORAGE_PROTOCOL_VERSION } from '../../app/static/storage-contract.mjs';

const PROBE_HTML = '<!doctype html><meta charset="utf-8"><title>Repository verification</title>';

async function launch(chromiumApi, profile, options = {}) {
  return chromiumApi.launchPersistentContext(profile, {
    headless: true, viewport: options.viewport ?? { width: 1280, height: 900 },
    hasTouch: options.hasTouch ?? false, reducedMotion: options.reducedMotion ?? 'no-preference',
    acceptDownloads: true, ...options.extra,
  });
}

function watchRequests(context, origin) {
  const external = [];
  const api = [];
  context.on('request', request => {
    if (!request.url().startsWith(`${origin}/`)) external.push(request.url());
    if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url());
  });
  return { external, api };
}

async function openApp(context, origin) {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#storage-status')
    ?.textContent.includes('Local storage ready'), null, { timeout: 25000 });
  return page;
}

async function createTask(page, title) {
  if (await page.locator('#todo-form').isHidden()) await page.locator('#new-task').click();
  await page.locator('#todo-title').fill(title);
  await page.locator('#todo-title').press('Enter');
  await page.locator('.task-row', { hasText: title }).first().waitFor({ timeout: 10000 });
}

// Spawn the real production database worker inside a blank probe page (the
// app page owns its worker already; a second worker would queue on the
// exclusive lock). The reply wait is registered before each request is sent.
async function spawnRealWorker(page) {
  await page.evaluate(async (version) => {
    const worker = new Worker('/static/database-worker.mjs', { type: 'module' });
    const pending = new Map();
    let sequence = 0;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Database worker did not become ready')), 25000);
      worker.onmessage = (event) => {
        if (event.data?.ready === true) { clearTimeout(timeout); resolve(); return; }
        const waiter = pending.get(event.data?.id);
        if (!waiter) return;
        pending.delete(event.data.id);
        if (event.data.ok) waiter.resolve(event.data.value);
        else waiter.reject(Object.assign(new Error(event.data.error.message),
          { code: event.data.error.code, status: event.data.error.status,
            operationId: event.data.error.operationId }));
      };
      worker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message)); };
    });
    globalThis.verifyWorker = worker;
    // Resolve with an envelope (never reject): Playwright drops custom error
    // properties on thrown values, which would lose the error code.
    globalThis.verifyRpc = (method, args = []) => new Promise((resolve) => {
      const id = ++sequence;
      pending.set(id, {
        resolve: value => resolve({ ok: true, value }),
        reject: error => resolve({ ok: false,
          error: { message: error.message, code: error.code,
            status: error.status, operationId: error.operationId } }),
      });
      worker.postMessage({ version, id, method, args });
    });
    const initialized = await globalThis.verifyRpc('initialize');
    if (!initialized.ok) throw new Error(initialized.error.message);
  }, STORAGE_PROTOCOL_VERSION);
  return async (method, args) => {
    const reply = await page.evaluate(([m, a]) => globalThis.verifyRpc(m, a), [method, args]);
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), reply.error);
    return reply.value;
  };
}

test('built app persists tasks across reload and restart with safe multi-tab use', { timeout: 29000 }, async () => {
  const profile = await makeProfile('todo-verify-profile-');
  const { origin, requests, close } = await serveDist();
  let context;
  try {
    context = await launch(chromium, profile);
    const seen = watchRequests(context, origin);
    const page = await openApp(context, origin);
    // Task controls work without WebGPU or a downloaded model.
    assert.doesNotMatch(await page.locator('#model-status').innerText(), /Model ready\./);
    await createTask(page, 'Verify persistence alpha');
    await createTask(page, 'Verify persistence beta');
    assert.equal(await page.locator('.task-row').count(), 2);
    await page.locator('.task-row', { hasText: 'Verify persistence alpha' }).locator('.task-completion').check();
    await page.waitForFunction(() => [...document.querySelectorAll('.task-row')]
      .some(row => row.textContent.includes('Verify persistence alpha') && row.classList.contains('is-completed')));
    // Reload: tasks and completion survive.
    await page.reload();
    const reloaded = await openApp(context, origin);
    await reloaded.locator('.task-row', { hasText: 'Verify persistence beta' }).waitFor({ timeout: 10000 });
    assert.equal(await reloaded.locator('.task-row').count(), 2);
    assert.equal(await reloaded.locator('.task-row.is-completed').count(), 1);
    // Second tab sees the same rows and can write; refresh reconciles.
    const second = await context.newPage();
    await second.goto(origin);
    await second.waitForFunction(() => document.querySelector('#storage-status')
      ?.textContent.includes('Local storage ready'), null, { timeout: 25000 });
    await second.locator('.task-row', { hasText: 'Verify persistence alpha' }).first().waitFor({ timeout: 10000 });
    await createTask(second, 'Written from the second tab');
    await reloaded.locator('#refresh-button').click();
    await reloaded.locator('.task-row', { hasText: 'Written from the second tab' }).waitFor({ timeout: 10000 });
    assert.equal(await reloaded.locator('.task-row').count(), 3);
    await second.close();
    // Full browser restart with the same profile.
    await context.close();
    context = await launch(chromium, profile);
    const restartedSeen = watchRequests(context, origin);
    const restarted = await openApp(context, origin);
    await restarted.locator('.task-row', { hasText: 'Written from the second tab' }).waitFor({ timeout: 10000 });
    assert.equal(await restarted.locator('.task-row').count(), 3);
    assert.equal(await restarted.locator('.task-row.is-completed').count(), 1);
    assert.deepEqual(requests.filter(entry => entry.path.startsWith('/api/')), []);
    assert.deepEqual(seen.api, []);
    assert.deepEqual(seen.external, []);
    assert.deepEqual(restartedSeen.api, []);
    assert.deepEqual(restartedSeen.external, []);
  } finally {
    await context?.close();
    await close();
    await dropProfile(profile);
  }
});

test('real repository rejects stale writes and quota failures without false saves', { timeout: 29000 }, async () => {
  const profile = await makeProfile('todo-verify-guards-');
  const { origin, close } = await serveDist({ '/__verify.html': PROBE_HTML });
  let context;
  try {
    context = await launch(chromium, profile);
    const seen = watchRequests(context, origin);
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${origin}/__verify.html`);
    const rpc = await spawnRealWorker(page);
    const created = await rpc('create', [{ title: 'Guarded task', icon: 'star' }, { operationId: 'verify-create' }]);
    // Stale revision edits cannot overwrite newer values.
    await rpc('update', [created.todo.id, { title: 'Newer title', icon: 'work' },
      { expectedRevision: created.revision, operationId: 'verify-edit' }]);
    await assert.rejects(
      rpc('update', [created.todo.id, { title: 'Stale overwrite', icon: 'task' },
        { expectedRevision: created.revision, operationId: 'verify-stale' }]),
      error => error.code === 'conflict');
    const listed = await rpc('list', []);
    assert.equal(listed.records.find(record => record.todo.id === created.todo.id).todo.title, 'Newer title');
    // Old embedding results cannot overwrite edited tasks (or deleted ones).
    const vector = [0.5, -0.25, ...Array(766).fill(0)];
    const meta = { model: 'onnx-community/embeddinggemma-2-ONNX',
      revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0', input_version: 1, dimensions: 768 };
    const current = listed.records.find(record => record.todo.id === created.todo.id);
    await assert.rejects(
      rpc('saveEmbedding', [created.todo.id,
        { title: current.todo.title, icon: current.todo.icon, vector, ...meta },
        { expectedSourceRevision: 'outdated-source', operationId: 'verify-stale-embed' }]),
      error => error.code === 'conflict' || error.code === 'missing');
    // Quota/flush failures are truthful: no confirmed save, no rows, and the
    // same operationId recovers without duplicating once storage works.
    const quota = await page.evaluate(async () => {
      const { LocalTodoStore } = await import('/static/todo-store.mjs');
      const { createWorkerHost } = await import('/static/database-worker.mjs');
      const store = new LocalTodoStore({
        persist: async () => { throw new DOMException('Storage is full', 'QuotaExceededError'); },
      });
      const host = createWorkerHost({
        lock: { request: (name, options, callback) => callback() },
        openDatabase: async () => ({}),
        store,
      });
      await host.handleRequest({ version: 1, id: 1, method: 'initialize', args: [] });
      const failed = await host.handleRequest({ version: 1, id: 2, method: 'create',
        args: [{ title: 'Unconfirmed draft' }, { operationId: 'verify-quota' }] });
      const after = await host.handleRequest({ version: 1, id: 3, method: 'list', args: [] });
      store.persist = async () => {};
      const recovered = await host.handleRequest({ version: 1, id: 4, method: 'create',
        args: [{ title: 'Unconfirmed draft' }, { operationId: 'verify-quota' }] });
      const duplicate = await host.handleRequest({ version: 1, id: 5, method: 'create',
        args: [{ title: 'Unconfirmed draft' }, { operationId: 'verify-quota' }] });
      return {
        failed, listed: after,
        recoveredId: recovered.ok ? recovered.value.todo.id : null,
        duplicateId: duplicate.ok ? duplicate.value.todo.id : null,
      };
    });
    assert.equal(quota.failed.ok, false);
    assert.ok(['quota', 'unconfirmed'].includes(quota.failed.error.code),
      `Storage failure must be quota/unconfirmed, got ${quota.failed.error.code}`);
    assert.equal(quota.failed.error.operationId, 'verify-quota');
    assert.equal(quota.listed.value.records.length, 0);
    assert.ok(quota.recoveredId);
    assert.equal(quota.duplicateId, quota.recoveredId);
    // Backup round-trip preserves data; invalid and conflicting imports change nothing.
    const backup = await rpc('exportBackup', []);
    assert.equal(backup.format, 'local-todo');
    assert.equal(backup.version, 1);
    await assert.rejects(rpc('importBackup', [{ format: 'other', version: 1, todos: [] }, {}]),
      error => error.code === 'validation');
    const conflicting = JSON.parse(JSON.stringify(backup));
    conflicting.todos[0].title = 'Conflicting title';
    await assert.rejects(rpc('importBackup', [conflicting, { operationId: 'verify-conflict' }]),
      error => error.code === 'conflict');
    assert.equal((await rpc('list', [])).records.length, 1);
    const reimport = await rpc('importBackup', [JSON.parse(JSON.stringify(backup)), { operationId: 'verify-reimport' }]);
    assert.equal(reimport.imported, 0);
    assert.deepEqual(seen.api, []);
    assert.deepEqual(seen.external, []);
    await page.evaluate(() => globalThis.verifyWorker?.terminate());
  } finally {
    await context?.close();
    await close();
    await dropProfile(profile);
  }
});

test('backups, keyboard, narrow layout and reduced motion stay usable', { timeout: 29000 }, async () => {
  const profile = await makeProfile('todo-verify-usable-');
  const { origin, close } = await serveDist();
  let context;
  try {
    context = await launch(chromium, profile, {
      viewport: { width: 375, height: 820 }, hasTouch: true, reducedMotion: 'reduce',
    });
    const seen = watchRequests(context, origin);
    const page = await openApp(context, origin);
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    // Keyboard-only task creation on the 375px touch layout.
    await page.locator('#new-task').focus();
    await page.keyboard.press('Enter');
    await page.locator('#todo-title').fill('Keyboard created task');
    await page.keyboard.press('Enter');
    await page.locator('.task-row', { hasText: 'Keyboard created task' }).waitFor({ timeout: 10000 });
    // The visible checkbox is 18px, but its interactive target is the
    // wrapping label, which must meet the 24px minimum touch size.
    assert.ok(await page.locator('.task-row .completion-control').first()
      .evaluate(element => element.getBoundingClientRect().height >= 24
        && element.getBoundingClientRect().width >= 24));
    // Backup export downloads versioned JSON; invalid and conflicting
    // imports are rejected with visible errors and change nothing.
    const download = page.waitForEvent('download', { timeout: 10000 });
    await page.locator('#backup-export').click();
    const backupPath = join(profile, 'backup.json');
    await (await download).saveAs(backupPath);
    const { readFile } = await import('node:fs/promises');
    const document = JSON.parse(await readFile(backupPath, 'utf8'));
    assert.equal(document.format, 'local-todo');
    assert.equal(document.version, 1);
    assert.ok(document.todos.some(todo => todo.title === 'Keyboard created task'));
    const invalidPath = join(profile, 'invalid.json');
    await writeFile(invalidPath, JSON.stringify({ format: 'other', version: 1, todos: [] }));
    await page.locator('#backup-file').setInputFiles(invalidPath);
    await page.locator('#storage-error:not([hidden])').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.task-row').count(), 1);
    const conflicting = JSON.parse(JSON.stringify(document));
    conflicting.todos[0].title = 'Conflicting title';
    const conflictPath = join(profile, 'conflict.json');
    await writeFile(conflictPath, JSON.stringify(conflicting));
    await page.locator('#backup-file').setInputFiles(conflictPath);
    await page.locator('#storage-error:not([hidden])').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.task-row').count(), 1);
    assert.deepEqual(seen.api, []);
    assert.deepEqual(seen.external, []);
  } finally {
    await context?.close();
    await close();
    await dropProfile(profile);
  }
});
