import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { MODEL_ARTIFACT } from '../app/static/model-worker.mjs';
import * as storageContract from '../app/static/storage-contract.mjs';
import { createCoordinator as createLocalCoordinator } from '../app/static/database-coordinator.mjs';

function embeddingResult(snapshot, changes = {}) {
  return {
    ...snapshot, vector: [0.5, -0.25, ...Array(MODEL_ARTIFACT.dimensions - 2).fill(0)],
    model: MODEL_ARTIFACT.id, revision: MODEL_ARTIFACT.revision,
    input_version: 1, dimensions: MODEL_ARTIFACT.dimensions, ...changes,
  };
}

// Small DOM and local repository fixtures run the deployed app orchestration offline.
// Model inference is injected, while actual app event handlers and repository operations run.
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

function appFixture({ items = [], current = [], phase = 'loading', embedTask, embedQuery, onCall, WorkerType = class {},
  coordinatorFactory, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const elements = new Map();
  const documentListeners = new Map();
  const document = {
    addEventListener(type, listener) { documentListeners.set(type, listener); },
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
  const uploads = [], taskCalls = [], queryCalls = [], requests = [];
  const records = new Map(), operationLog = new Map(), listeners = new Set();
  let subscriber, counter = 0, token = 0, sequence = 0;
  function record(item) {
    const previous = records.get(item.id);
    if (!previous || JSON.stringify(previous.todo) !== JSON.stringify(item)) {
      const sourceChanged = !previous || previous.todo.title !== item.title || previous.todo.icon !== item.icon;
      const next = { todo: copy(item), revision: `r${++token}`,
        source_revision: sourceChanged ? `s${token}` : previous.source_revision };
      records.set(item.id, next);
      if (previous) ++sequence;
    }
    return copy(records.get(item.id));
  }
  items.forEach(record);
  const changed = () => { ++sequence; for (const listener of listeners) listener({ sequence }); };
  const failure = (status, detail, code = ({404:'missing',409:'conflict',422:'validation'})[status] ?? 'unconfirmed') => {
    throw Object.assign(new Error(detail), { status, code });
  };
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
  const invoke = async (method, ...args) => {
    const id = ['update','setCompleted','delete','saveEmbedding'].includes(method) ? args[0] : null;
    const body = id ? args[1] : args[0];
    const options = args.at(-1) ?? {};
    requests.push({ method, args: copy(args), body: copy(body ?? null), id });
    if (onCall) {
      const custom = await onCall({ method, id, body, args, options, tasks, embedded, uploads,
        currentSequence:sequence, getRecord:record });
      if (custom) {
        if (!custom.ok) failure(custom.status, (await custom.json()).detail);
        const result = await custom.json();
        if (method === 'list' || method === 'pendingEmbeddings') {
          if (result.records) return result;
          return { records: result.map(record), sequence };
        }
        if (method === 'search') return { ...result, sequence,
          matches: result.matches.map(match => ({ ...match, ...record(match.todo), score: match.score })) };
        return result;
      }
    }
    if (method === 'initialize') return { sequence, persistence: { requested:true, granted:true } };
    if (method === 'list') {
      const result = [...tasks.values()].map(record);
      return { records: result, sequence };
    }
    if (method === 'pendingEmbeddings') return { records: [...tasks.values()]
      .filter(item => !embedded.has(item.id)).map(record), sequence };
    if (method === 'search') return { matches: [...tasks.values()]
      .filter(item => embedded.has(item.id)).reverse().map(item => ({ ...record(item), score:1 })),
      pending_count: tasks.size - embedded.size, min_score:0.7, sequence };
    if (operationLog.has(options.operationId)) return copy(operationLog.get(options.operationId));
    let result;
    if (method === 'create') {
      const task = { id: `added-${++counter}`, ...body, completed:false };
      tasks.set(task.id, task);
      result = record(task);
    } else {
      const task = tasks.get(id);
      if (method === 'saveEmbedding') uploads.push({ id, body, options: copy(options) });
      if (!task) failure(404, 'Missing');
      const saved = record(task);
      if (method === 'saveEmbedding') {
        if (saved.source_revision !== options.expectedSourceRevision || task.title !== body.title || task.icon !== body.icon) failure(409,'Changed');
        embedded.add(id); result = { id };
      } else {
        if (saved.revision !== options.expectedRevision) failure(409,'Changed');
        if (method === 'delete') { tasks.delete(id); embedded.delete(id); records.delete(id); result = { id }; }
        else {
          const updated = { ...task, ...(method === 'setCompleted' ? {completed:body} : body) };
          if (task.title !== updated.title || task.icon !== updated.icon) embedded.delete(id);
          tasks.set(id, updated); result = record(updated);
        }
      }
    }
    changed();
    result = { ...result, sequence, operationId:options.operationId };
    operationLog.set(options.operationId, copy(result));
    return copy(result);
  };
  const injectedRepository = Object.fromEntries(['initialize','list','pendingEmbeddings','search',
    'create','update','setCompleted','delete','saveEmbedding'].map(method => [method, (...args) => invoke(method,...args)]));
  injectedRepository.subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  let dependencies, panelOptions;
  const createCoordinator = options => { dependencies = options; return coordinatorFactory?.(options) ?? injectedRepository; };
  const source = readFileSync(new URL('../app/static/app.js', import.meta.url), 'utf8')
    .replace("import('/static/model-runtime.mjs')", 'Promise.resolve({ modelRuntime: injectedRuntime })')
    .replace("import('/static/database-coordinator.mjs')", 'Promise.resolve({ createCoordinator })')
    .replace("import('/static/storage-contract.mjs')", 'Promise.resolve(storageContract)')
    .replace("import('/static/storage-panel.mjs')", 'Promise.resolve({ initStoragePanel: options => { capturePanel(options); return panelStub; } })');
  const storageErrors = [];
  const panelStub = { setReady() {}, setError(error) { storageErrors.push(error); }, contains() { return false; } };
  const context = { document, isSecureContext:true,
    navigator:{maxTouchPoints:0,locks:{request() {}},storage:{getDirectory() {},persist() {}}},
    Worker:WorkerType, BroadcastChannel:class { constructor(name) { this.name = name; } close() {} }, storageContract, crypto:{randomUUID},
    injectedRuntime, injectedRepository, createCoordinator, panelStub, capturePanel: options => { panelOptions = options; },
    queueMicrotask, setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl,
    fetch() { throw new Error('Task orchestration must never fetch'); } };
  runInNewContext(`${source}\n globalThis.appTest = { rows, embeddingJobs, requestBackfill, loadItems };`, context);
  return {
    element: selector => document.querySelector(selector), document, rows:context.appTest.rows,
    jobs:context.appTest.embeddingJobs, requestBackfill:context.appTest.requestBackfill,
    loadItems:context.appTest.loadItems, tasks, embedded, uploads, taskCalls, queryCalls, requests,
    injectedRepository, storageErrors, recoverStorage: () => panelOptions.recover(),
    get dependencies() { return dependencies; }, navigator:context.navigator,
    remote(id, changes) {
      if (changes === null) { tasks.delete(id); records.delete(id); embedded.delete(id); }
      else { tasks.set(id, { ...tasks.get(id), ...changes }); record(tasks.get(id)); }
      changed();
    },
    resume() { document.visibilityState = 'visible'; documentListeners.get('visibilitychange')?.(); },
    ready: () => { phase = 'ready'; subscriber({ phase }); },
  };
}

const savedTask = (id, title = id) => ({ id, title, icon: 'task', completed: false });

test('backfill embeds saved snapshots on readiness including additions during loading, skipping current vectors', async () => {
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
    const fixture = appFixture({ items: [savedTask('one')], onCall: ({ method }) => {
      if (method === 'saveEmbedding' && ++attempts === 1) return apiResponse({ detail: 'Temporary upload failure' }, 503);
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
    assert.equal(fixture.requests.filter(request => request.method === 'create').length, 0);
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

test('backfill reconciles source conflicts and discards deleted saved snapshots', async () => {
  for (const action of ['edit', 'delete']) {
    let once = false;
    const fixture = appFixture({ items: [savedTask('one', 'Original')], onCall: ({ method, tasks }) => {
      if (method === 'saveEmbedding' && !once) {
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
    onCall: async ({ method, tasks }) => {
      if (method === 'pendingEmbeddings' && holdScan) {
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
    current: ['one', 'two', 'three'], onCall: async ({ method, tasks }) => {
      if (method === 'search') {
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
  assert.equal(fixture.requests.some(request => request.method === 'update' && request.id === 'one'), false,
    'Result reordering must not submit the focused draft');
  await fixture.element('#search-clear').emit('click');
  assert.equal(fixture.requests.some(request => request.method === 'update' && request.id === 'one'), false,
    'Restoring list order must not submit the focused draft');
  assert.equal(row.editor.value, 'Unsaved draft');
  assert.deepEqual(fixture.element('#todo-list').children.map(element => element.dataset.id), ['one', 'two', 'three']);
  assert.equal(fixture.element('#search-status').hidden, true);
  assert.equal(fixture.document.activeElement, input);
});

test('search renders similarity scores with an explanation and keeps nonmatching drafts visible', async () => {
  const fixture = appFixture({ items: [savedTask('one'), savedTask('two'), savedTask('three')],
    current: ['one', 'two', 'three'], onCall: async ({ method, tasks }) => {
      if (method === 'search') {
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
    current: ['one', 'two'], onCall: async ({ method, tasks }) => {
      if (method === 'search') {
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
  assert.ok(fixture.requests.filter(request => request.method === 'search').length >= 2,
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
    current: ['one', 'two'], onCall: async ({ method, tasks }) => {
      if (method === 'list' && ++listRequests === 2) {
        await refreshGate.promise; // Hold the automatic reconciliation refresh.
      }
      if (method === 'search') {
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
  assert.ok(fixture.requests.filter(request => request.method === 'search').length >= 2,
    'The retried refresh reruns the search once sources reconcile');
  assert.equal(fixture.rows.get('one').title.textContent, 'Buy groceries');
  assert.equal(fixture.rows.get('one').row.find('similarity').textContent, 'Similarity 0.94',
    'The score labels the current source, never the stale title');
  assert.equal(fixture.requests.some(request => request.method === 'update' && request.id === 'two'), false,
    'Reconciliation never submits the focused draft');
  assert.equal(draft.editor.value, 'Unsaved draft');
  assert.equal(fixture.document.activeElement, draft.editor);
  assert.deepEqual([draft.editor.selectionStart, draft.editor.selectionEnd], [1, 4]);
});

test('empty search results name no matches while indexing and errors stay distinct', async () => {
  let mode = 'empty';
  const fixture = appFixture({ items: [savedTask('one'), savedTask('two')],
    current: ['one'], onCall: async ({ method, tasks }) => {
      if (method === 'search') {
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
    current: ['one', 'two'], onCall: async ({ method, tasks }) => {
      if (method === 'search') {
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

test('local task lifecycle validates titles, edits icons, completes, reopens and deletes without HTTP', async () => {
  assert.doesNotMatch(readFileSync(new URL('../app/static/app.js', import.meta.url), 'utf8'), /\bfetch\s*\(|\/api\/todos/);
  const fixture = appFixture({ phase:'unsupported' });
  await until(() => fixture.requests.some(call => call.method === 'list'));
  await fixture.element('#todo-form').emit('submit');
  assert.equal(fixture.requests.some(call => call.method === 'create'), false);
  fixture.element('#todo-title').value = '  Local task  ';
  await fixture.element('#todo-form').emit('submit');
  const row = fixture.rows.get('added-1');
  assert.equal(row.item.title, 'Local task');
  await row.title.emit('click');
  row.editor.value = 'Edited task';
  await row.editor.emit('input');
  await row.editor.emit('keydown', { key:'Enter' });
  await until(() => row.item.title === 'Edited task');
  await row.icon.picker.children[1].children.find(choice => choice.dataset.icon === 'star').emit('click');
  await until(() => row.item.icon === 'star');
  row.completion.checked = true;
  await row.completion.emit('change');
  assert.equal(row.item.completed, true);
  row.completion.checked = false;
  await row.completion.emit('change');
  assert.equal(row.item.completed, false);
  await row.remove.emit('click');
  assert.equal(fixture.rows.size, 0);
  for (const call of fixture.requests.filter(call => ['create','update','setCompleted','delete'].includes(call.method))) {
    assert.ok(call.args.at(-1).operationId);
    if (call.method !== 'create') assert.ok(call.args.at(-1).expectedRevision);
  }
  assert.equal(fixture.taskCalls.length, 0, 'Task controls work without the model');
});

test('create retains its draft until durability succeeds and retries the identical operation', async () => {
  const gate = deferred();
  let attempts = 0;
  const fixture = appFixture({ onCall: async ({method}) => {
    if (method === 'create' && ++attempts === 1) { await gate.promise; return apiResponse({detail:'Save not confirmed'},503); }
  } });
  await until(() => fixture.requests.some(call => call.method === 'list'));
  fixture.element('#todo-title').value = 'Keep this draft';
  const saving = fixture.element('#todo-form').emit('submit');
  await until(() => fixture.requests.some(call => call.method === 'create'));
  assert.equal(fixture.element('#todo-title').value, 'Keep this draft');
  assert.equal(fixture.rows.size, 0);
  gate.resolve();
  await saving;
  assert.equal(fixture.element('#todo-title').value, 'Keep this draft');
  assert.equal(fixture.element('#todo-title').readOnly, true);
  assert.equal(fixture.element('#error').textContent, 'Save not confirmed');
  await fixture.element('#todo-form').emit('submit');
  const calls = fixture.requests.filter(call => call.method === 'create');
  assert.deepEqual(calls[0].args, calls[1].args);
  assert.equal(fixture.rows.size, 1);
  assert.equal(fixture.element('#todo-title').value, '');
});

test('unconfirmed edit, completion and delete keep saved state and stable retry arguments', async () => {
  for (const method of ['update','setCompleted','delete']) {
    let attempts = 0;
    const fixture = appFixture({ items:[savedTask('one')], onCall: ({method:called}) => {
      if (called === method && ++attempts === 1) return apiResponse({detail:'Durability not confirmed'},507);
    } });
    await until(() => fixture.rows.size === 1);
    const row = fixture.rows.get('one');
    if (method === 'update') {
      await row.title.emit('click'); row.editor.value = 'Kept edit';
      await row.editor.emit('input'); await row.editor.emit('keydown', {key:'Enter'});
      await until(() => row.hasError);
      await row.editor.emit('keydown', {key:'Escape'});
      assert.equal(row.draft.title, 'Kept edit', 'Escape cannot discard an unresolved save');
    } else if (method === 'setCompleted') {
      row.completion.checked = true; await row.completion.emit('change');
      assert.equal(row.completion.checked, false, 'Unconfirmed completion rolls back its visual state');
    } else await row.remove.emit('click');
    assert.equal(row.item.title, 'one');
    assert.equal(row.item.completed, false);
    assert.equal(fixture.rows.size, 1);
    await row.row.find('retry').emit('click');
    await until(() => method === 'delete' ? fixture.rows.size === 0 : !row.pending && !row.attempt);
    const calls = fixture.requests.filter(call => call.method === method);
    assert.deepEqual(calls[0].args, calls[1].args);
    if (method === 'update') assert.equal(row.item.title, 'Kept edit');
    if (method === 'setCompleted') assert.equal(row.item.completed, true);
  }
});

test('cross-tab changes preserve dirty drafts, focus and selection until an explicit conflict retry', async () => {
  const fixture = appFixture({ items:[savedTask('one')] });
  await until(() => fixture.rows.size === 1);
  const row = fixture.rows.get('one');
  await row.title.emit('click'); row.editor.value = 'My draft';
  row.editor.setSelectionRange(1,4); await row.editor.emit('input');
  const originalRevision = row.draftRevision;
  fixture.remote('one', {title:'Other tab',icon:'star'});
  await until(() => row.item.title === 'Other tab');
  assert.equal(row.editor.value, 'My draft');
  assert.equal(row.draftRevision, originalRevision);
  assert.equal(fixture.document.activeElement, row.editor);
  assert.deepEqual([row.editor.selectionStart,row.editor.selectionEnd], [1,4]);
  assert.equal(row.row.find('retry').textContent, 'Save my draft');
  await row.editor.emit('keydown', {key:'Enter'});
  assert.equal(fixture.requests.some(call => call.method === 'update'), false);
  await row.row.find('retry').emit('click');
  await until(() => row.item.title === 'My draft');
  assert.equal(row.item.icon, 'star', 'An untouched icon follows the remote change');
});

test('a stale in-flight save conflicts instead of overwriting a newer remote task', async () => {
  const gate = deferred();
  const fixture = appFixture({ items:[savedTask('one')], onCall: async ({method}) => {
    if (method === 'update') await gate.promise;
  } });
  await until(() => fixture.rows.size === 1);
  const row = fixture.rows.get('one');
  await row.title.emit('click'); row.editor.value = 'Delayed edit';
  await row.editor.emit('input'); await row.editor.emit('keydown',{key:'Enter'});
  await until(() => row.pending);
  fixture.remote('one', {title:'Newer remote task'});
  gate.resolve();
  await until(() => row.conflict && row.item.title === 'Newer remote task');
  assert.equal(row.editor.value, 'Delayed edit');
  assert.equal(fixture.tasks.get('one').title, 'Newer remote task');
});

test('remote deletion keeps a focused draft and cannot recreate the deleted ID', async () => {
  const fixture = appFixture({ items:[savedTask('one')] });
  await until(() => fixture.rows.size === 1);
  const row = fixture.rows.get('one');
  await row.title.emit('click'); row.editor.value = 'Kept after delete'; await row.editor.emit('input');
  fixture.remote('one', null);
  await until(() => row.missing);
  assert.equal(row.editor.value, 'Kept after delete');
  assert.equal(fixture.document.activeElement, row.editor);
  await row.editor.emit('keydown', {key:'Enter'});
  assert.equal(fixture.requests.some(call => call.method === 'update'), false);
  assert.equal(fixture.tasks.size, 0);
});

test('resume reconciles missed changes without erasing embedding retry state or recomputing its vector', async () => {
  let attempts = 0;
  const fixture = appFixture({ items:[savedTask('one'),savedTask('two')], current:['two'],
    onCall: ({method}) => { if (method === 'saveEmbedding' && ++attempts === 1) return apiResponse({detail:'Flush failed'},503); }
  });
  await until(() => fixture.rows.size === 2); fixture.ready();
  await until(() => fixture.jobs.get('one')?.error);
  const job = fixture.jobs.get('one');
  fixture.tasks.set('two',savedTask('two','Missed change')); fixture.resume();
  await until(() => fixture.rows.get('two').item.title === 'Missed change');
  assert.equal(fixture.jobs.get('one'), job);
  assert.equal(job.error, true);
  assert.equal(fixture.taskCalls.length, 1);
  await fixture.rows.get('one').row.find('embedding-retry').emit('click');
  await until(() => fixture.jobs.size === 0);
  const saves = fixture.requests.filter(call => call.method === 'saveEmbedding');
  assert.deepEqual(saves[0].args, saves[1].args);
});

test('edit-and-revert discards the original inference using its source token', async () => {
  const gate = deferred();
  const fixture = appFixture({items:[savedTask('one','Original')], embedTask:async snapshot => {
    if (snapshot.title === 'Original' && !gate.released) await gate.promise;
    return embeddingResult(snapshot);
  }});
  await until(() => fixture.rows.size === 1); fixture.ready();
  await until(() => fixture.taskCalls.length === 1);
  const originalJob = fixture.jobs.get('one');
  fixture.remote('one', {title:'Temporary'});
  await until(() => fixture.rows.get('one').item.title === 'Temporary');
  fixture.remote('one', {title:'Original'});
  await until(() => fixture.rows.get('one').item.title === 'Original');
  gate.released = true; gate.resolve();
  await until(() => fixture.jobs.size === 0);
  assert.ok(fixture.uploads.every(upload => upload.options.expectedSourceRevision !== originalJob.sourceRevision));
});

test('a late embedding persistence reply cannot settle the new source job', async () => {
  const gate = deferred();
  let first = true;
  const fixture = appFixture({ items:[savedTask('one','Original')], onCall:async ({method}) => {
    if (method === 'saveEmbedding' && first) { first = false; await gate.promise; return apiResponse(null,204); }
  } });
  await until(() => fixture.rows.size === 1); fixture.ready();
  await until(() => fixture.requests.some(call => call.method === 'saveEmbedding'));
  const original = fixture.jobs.get('one');
  fixture.remote('one',{title:'New source'});
  await until(() => fixture.jobs.get('one')?.sourceRevision !== original.sourceRevision);
  gate.resolve();
  await until(() => fixture.jobs.size === 0);
  assert.equal(fixture.uploads[0].body.title,'New source');
  assert.deepEqual(fixture.taskCalls.map(call => call.title),['Original','New source']);
});

test('completion conflict retains the intended completion retry across draft reconciliation', async () => {
  const gate = deferred();
  let hold = true;
  const fixture = appFixture({ items:[savedTask('one')], onCall:async ({method}) => {
    if (method === 'setCompleted' && hold) { hold = false; await gate.promise; }
  } });
  await until(() => fixture.rows.size === 1);
  const row = fixture.rows.get('one');
  await row.title.emit('click');row.editor.value = 'Unsubmitted draft';await row.editor.emit('input');
  row.completion.checked = true;
  const completion = row.completion.emit('change');
  await until(() => row.pending === 'complete');
  fixture.remote('one',{title:'Remote source'});gate.resolve();await completion;
  await until(() => row.item.title === 'Remote source');
  assert.equal(row.failedAction,'complete');
  assert.equal(row.editor.value,'Unsubmitted draft');
  await row.row.find('retry').emit('click');
  await until(() => row.item.completed);
  assert.equal(fixture.requests.some(call => call.method === 'update'),false);
  assert.equal(row.editor.value,'Unsubmitted draft');
});

test('a delayed list cannot discard a newer cross-tab notification', async () => {
  const gate = deferred();
  let lists = 0;
  const fixture = appFixture({ items:[savedTask('one')], onCall:async ({method,tasks,getRecord,currentSequence}) => {
    if (method === 'list' && ++lists === 2) {
      const stale = {records:[...tasks.values()].map(getRecord),sequence:currentSequence};
      await gate.promise;
      return apiResponse(stale);
    }
  } });
  await until(() => fixture.rows.size === 1);
  const refreshing = fixture.loadItems();
  await until(() => lists === 2);
  fixture.remote('one',{title:'Committed while reading'});
  gate.resolve();await refreshing;
  await until(() => fixture.rows.get('one').item.title === 'Committed while reading');
  assert.ok(lists >= 3,'A stale list is reconciled again after the held response');
});

test('completion stays usable with a conflicted draft without accepting its stale source revision', async () => {
  const fixture = appFixture({items:[savedTask('one')]});
  await until(() => fixture.rows.size === 1);
  const row = fixture.rows.get('one');
  await row.title.emit('click');row.editor.value = 'My draft';await row.editor.emit('input');
  const draftRevision = row.draftRevision;
  fixture.remote('one',{title:'Newer title'});
  await until(() => row.conflict);
  row.completion.checked = true;await row.completion.emit('change');
  assert.equal(row.item.completed,true);
  assert.equal(row.draftRevision,draftRevision);
  assert.equal(row.conflict,true);
  await row.editor.emit('keydown',{key:'Enter'});
  assert.equal(fixture.requests.some(call => call.method === 'update'),false);
  assert.equal(fixture.tasks.get('one').title,'Newer title');
});

test('bootstrap supplies browser dependencies and waits for worker ownership before sending RPC', async () => {
  let worker;
  class FakeWorker {
    constructor(url,options) { worker = this; this.url = url; this.options = options; this.requests = []; }
    postMessage(request) {
      this.requests.push(request);
      this.onmessage({data:{version:1,id:request.id,ok:true,value:{sequence:0}}});
    }
    terminate() { this.closed = true; }
  }
  const fixture = appFixture({WorkerType:FakeWorker});
  await until(() => fixture.dependencies);
  const dependencies = fixture.dependencies;
  assert.equal(dependencies.locks,fixture.navigator.locks);
  assert.equal(dependencies.storage,fixture.navigator.storage);
  assert.equal(dependencies.channel.name,storageContract.DATABASE_CHANNEL);
  const endpoint = dependencies.spawnOwner();
  assert.equal(typeof endpoint.then,'undefined','Owner factory returns the RPC endpoint before lock release');
  assert.equal(worker.url,'/static/database-worker.mjs');
  assert.equal(worker.options.type,'module');
  const initialization = endpoint.initialize();
  assert.equal(worker.requests.length,0,'RPC waits for the worker ownership handshake');
  worker.onmessage({data:{ready:true}});
  await initialization;
  assert.equal(worker.requests[0].method,'initialize');
  assert.equal(worker.requests[0].version,storageContract.STORAGE_PROTOCOL_VERSION);
  assert.ok(Number.isSafeInteger(worker.requests[0].id));
  // Registering the waiter before postMessage also accepts synchronous replies.
  const result = await endpoint.list();
  assert.equal(result.sequence,0);
  endpoint.close();
  assert.equal(worker.closed,true);
});

test('worker RPC preserves storage errors and rejects unconfirmed saves when transport dies', async () => {
  let worker;
  class FakeWorker {
    constructor() { worker = this; this.requests = []; }
    postMessage(request) { this.requests.push(request); }
    terminate() { this.closed = true; }
  }
  const fixture = appFixture({WorkerType:FakeWorker});
  await until(() => fixture.dependencies);
  const endpoint = fixture.dependencies.spawnOwner();
  worker.onmessage({data:{ready:true}});
  const quota = endpoint.create({title:'Keep draft'}, {operationId:'same-quota-op'});
  await until(() => worker.requests.length === 1);
  const request = worker.requests[0];
  worker.onmessage({data:{version:1,id:request.id,ok:false,
    error:{code:'quota',message:'Storage full',operationId:'same-quota-op'}}});
  await assert.rejects(quota,error => error.code === 'quota' && error.status === 507 && error.operationId === 'same-quota-op');
  const lost = endpoint.create({title:'Kept draft'}, {operationId:'same-lost-op'});
  await until(() => worker.requests.length === 2);
  worker.onerror({message:'Worker stopped',preventDefault() {}});
  await assert.rejects(lost,error => error.code === 'unconfirmed' && error.operationId === 'same-lost-op');
  assert.equal(worker.closed,true);
});

for (const failure of ['crash', 'timeout']) {
  test(`owning worker ${failure}: storage recovery re-elects, reconciles and retains save operation IDs`, async () => {
    const workers = [];
    const committed = deferred();
    const timers = new Map();
    let fixture;
    class DurableWorker {
      constructor() {
        workers.push(this);
        queueMicrotask(() => this.onmessage({data:{ready:true}}));
      }
      postMessage(request) {
        fixture.injectedRepository[request.method](...request.args).then(value => {
          if (workers[0] === this && request.method === 'create') {
            // Commit succeeds, but its reply is lost when the transport dies.
            committed.resolve(request);
            return;
          }
          this.onmessage({data:{version:1,id:request.id,ok:true,value}});
        }).catch(error => this.onmessage({data:{version:1,id:request.id,ok:false,
          error:storageContract.serializeStorageError(error)}}));
      }
      terminate() { this.closed = true; }
    }
    fixture = appFixture({items:[savedTask('existing')], WorkerType:DurableWorker,
      coordinatorFactory: options => createLocalCoordinator({...options,
        locks:{request: async (name, options, callback) => callback({name})}}),
      setTimeoutImpl: (callback, milliseconds, ...args) => {
        if (milliseconds !== 20000) return setTimeout(callback, milliseconds, ...args);
        const timer = {}; timers.set(timer, callback); return timer;
      },
      clearTimeoutImpl: timer => { if (!timers.delete(timer)) clearTimeout(timer); },
    });
    await until(() => fixture.rows.size === 1);
    fixture.element('#todo-title').value = 'Unconfirmed creation';
    const saving = fixture.element('#todo-form').emit('submit');
    const originalRequest = await committed.promise;
    if (failure === 'crash') workers[0].onerror({message:'Owner crashed',preventDefault() {}});
    else {
      assert.equal(timers.size,1,'Only the unanswered mutation watchdog remains');
      [...timers.values()][0]();
    }
    await saving;
    assert.equal(workers[0].closed,true);
    assert.equal(fixture.storageErrors.at(-1).code,'unconfirmed');
    assert.equal(fixture.storageErrors.at(-1).operationId,originalRequest.args[1].operationId);
    assert.equal(fixture.element('#todo-title').value,'Unconfirmed creation');
    assert.equal(fixture.element('#todo-title').readOnly,true);
    const row = fixture.rows.get('existing');
    await row.title.emit('click');
    row.editor.value = 'Draft retained while reconnecting';
    await row.editor.emit('input');
    row.editor.setSelectionRange(3,9);
    await fixture.recoverStorage();
    assert.equal(workers.length,2,'Recovery must spawn a replacement owner rather than reuse cached initialization');
    assert.equal(fixture.rows.size,2,'Reconciliation sees the task committed before its reply was lost');
    assert.equal(row.editor.value,'Draft retained while reconnecting');
    assert.equal(fixture.document.activeElement,row.editor);
    assert.deepEqual([row.editor.selectionStart,row.editor.selectionEnd],[3,9]);
    assert.equal(fixture.element('#todo-title').value,'Unconfirmed creation');
    // Recovery reads saved state; only an explicit retry confirms the original save.
    await fixture.element('#todo-form').emit('submit');
    const creates = fixture.requests.filter(request => request.method === 'create');
    assert.equal(creates.length,2);
    assert.deepEqual(creates[1].args,copy(originalRequest.args));
    assert.equal(fixture.tasks.size,2,'The lost-reply retry must not create a duplicate');
    assert.equal(fixture.element('#todo-title').value,'');
    assert.equal(fixture.element('#todo-title').readOnly,false);
    assert.equal(timers.size,0,'Recovery leaves no transport watchdogs behind');
    for (const worker of workers) worker.terminate();
  });
}

test('owning worker stays connected during quota recovery and keeps its pending operation ID', async () => {
  const workers = [];
  let fixture, quota = true;
  class HealthyWorker {
    constructor() { workers.push(this); queueMicrotask(() => this.onmessage({data:{ready:true}})); }
    postMessage(request) {
      fixture.injectedRepository[request.method](...request.args)
        .then(value => this.onmessage({data:{version:1,id:request.id,ok:true,value}}))
        .catch(error => this.onmessage({data:{version:1,id:request.id,ok:false,
          error:storageContract.serializeStorageError(error)}}));
    }
    terminate() { this.closed = true; }
  }
  fixture = appFixture({items:[savedTask('existing')], WorkerType:HealthyWorker,
    coordinatorFactory: options => createLocalCoordinator({...options,
      locks:{request: async (name, options, callback) => callback({name})}}),
    onCall: ({method}) => { if (method === 'create' && quota) throw new storageContract.StorageError('quota','Storage full'); },
  });
  await until(() => fixture.rows.size === 1);
  fixture.element('#todo-title').value = 'Kept quota draft';
  await fixture.element('#todo-form').emit('submit');
  const original = fixture.requests.find(request => request.method === 'create');
  await fixture.recoverStorage();
  assert.equal(workers.length,1,'Quota recovery must keep the healthy owner and its lock');
  assert.equal(workers[0].closed,undefined);
  assert.equal(fixture.element('#todo-title').value,'Kept quota draft');
  quota = false;
  await fixture.element('#todo-form').emit('submit');
  assert.deepEqual(fixture.requests.filter(request => request.method === 'create')[1].args,original.args);
  assert.equal(fixture.tasks.size,2);
  for (const worker of workers) worker.terminate();
});
