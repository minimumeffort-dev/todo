import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalTodoStore } from '../app/static/todo-store.mjs';
import { StorageError } from '../app/static/storage-contract.mjs';
import { EMBEDDING_METADATA } from '../app/static/storage-contract.mjs';

const DIMENSIONS = EMBEDDING_METADATA.dimensions;

function vector(first = 0.25, second = -0.75) {
  return [first, second, ...Array(DIMENSIONS - 2).fill(0)];
}

function makeStore(options = {}) {
  let counter = 0;
  let clock = 0;
  const store = new LocalTodoStore({
    generateId: () => `test-id-${++counter}`,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
    ...options,
  });
  return store;
}

function payload(task, changes = {}) {
  return {
    title: task.title, icon: task.icon, vector: vector(),
    model: EMBEDDING_METADATA.model, revision: EMBEDDING_METADATA.revision,
    input_version: EMBEDDING_METADATA.input_version, dimensions: DIMENSIONS,
    ...changes,
  };
}

async function assertCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof StorageError, `Expected StorageError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`Expected StorageError with code ${code}`);
}

test('add, list ordering, and remove', async () => {
  const store = makeStore();
  assert.deepEqual((await store.list()).records, []);
  const first = await store.create({ title: '  Buy groceries  ' });
  assert.equal(first.todo.title, 'Buy groceries');
  assert.equal(first.todo.icon, 'task');
  assert.equal(first.todo.completed, false);
  assert.ok(first.todo.id);
  assert.ok(first.revision);
  assert.ok(first.source_revision);
  const second = await store.create({ title: 'Buy groceries' });
  assert.notEqual(second.todo.id, first.todo.id);
  const listed = await store.list();
  assert.deepEqual(listed.records.map((record) => record.todo), [first.todo, second.todo]);
  await store.delete(first.todo.id);
  assert.deepEqual((await store.list()).records.map((record) => record.todo), [second.todo]);
  await store.delete(second.todo.id);
  assert.deepEqual((await store.list()).records, []);
});

test('invalid titles, icons and completion are rejected with validation errors', async () => {
  const store = makeStore();
  for (const title of ['', ' \t\n ', 'x'.repeat(501), null, 123, undefined]) {
    await assertCode(store.create({ title }), 'validation');
  }
  for (const icon of ['invalid', '', null, 123, []]) {
    await assertCode(store.create({ title: 'Task', icon }), 'validation');
  }
  assert.deepEqual((await store.list()).records, []);
  const valid500 = await store.create({ title: '✓'.repeat(500) });
  assert.equal(valid500.todo.title.length, 500);
  const original = await store.create({ title: 'Original', icon: 'heart' });
  for (const bad of [{}, { title: 'Valid' }, { title: '', icon: 'task' }, { title: 'x'.repeat(501), icon: 'task' },
    { title: 'Valid', icon: 'invalid' }, { title: 123, icon: 'task' }]) {
    await assertCode(store.update(original.todo.id, bad), 'validation');
  }
  assert.deepEqual((await store.list()).records.map((record) => record.todo.title).sort(),
    ['Original', '✓'.repeat(500)].sort());
  for (const bad of [{}, { completed: null }, { completed: 0 }, { completed: 1 }, { completed: 'true' }, { completed: [] }]) {
    await assertCode(store.setCompleted(original.todo.id, bad.completed), 'validation');
  }
});

test('missing and deleted items report missing errors', async () => {
  const store = makeStore();
  await assertCode(store.update('missing', { title: 'Edited', icon: 'shopping' }), 'missing');
  await assertCode(store.setCompleted('missing', true), 'missing');
  await assertCode(store.delete('missing'), 'missing');
  await assertCode(store.saveEmbedding('missing', payload({ title: 't', icon: 'task' })), 'missing');
  const item = await store.create({ title: 'Original' });
  await store.delete(item.todo.id);
  await assertCode(store.update(item.todo.id, { title: 'Edited', icon: 'shopping' }), 'missing');
  await assertCode(store.setCompleted(item.todo.id, true), 'missing');
  await assertCode(store.delete(item.todo.id), 'missing');
});

test('legacy seeds migrate with icon and completion defaults', async () => {
  const store = makeStore();
  store.seed([
    { id: 'legacy-z', title: 'Old task', created_at: '2020-01-01T00:00:00.000Z' },
    { id: 'legacy-b', title: 'Second', icon: 'heart', completed: true, created_at: '2020-01-02T00:00:00.000Z' },
    { id: 'legacy-a', title: 'First at same time', created_at: '2020-01-02T00:00:00.000Z' },
  ]);
  const listed = await store.list();
  assert.deepEqual(listed.records.map((record) => record.todo), [
    { id: 'legacy-z', title: 'Old task', icon: 'task', completed: false },
    { id: 'legacy-a', title: 'First at same time', icon: 'task', completed: false },
    { id: 'legacy-b', title: 'Second', icon: 'heart', completed: true },
  ]);
  const pending = await store.pendingEmbeddings();
  assert.equal(pending.records.length, 3);
});

test('embedding lifecycle: completion and no-op edits preserve, source edits invalidate', async () => {
  const store = makeStore();
  const created = await store.create({ title: 'Buy food', icon: 'shopping' });
  const id = created.todo.id;
  await store.saveEmbedding(id, payload(created.todo));
  const before = (await store.list()).records;
  assert.equal((await store.pendingEmbeddings()).records.length, 0);
  for (const completed of [true, true, false]) {
    await store.setCompleted(id, completed);
    assert.equal((await store.pendingEmbeddings()).records.length, 0);
  }
  await store.update(id, { title: '  Buy food  ', icon: 'shopping' });
  assert.equal((await store.pendingEmbeddings()).records.length, 0);
  const edited = await store.update(id, { title: 'Changed', icon: 'star' });
  assert.equal((await store.pendingEmbeddings()).records.length, 1);
  assert.equal((await store.pendingEmbeddings()).records[0].todo.id, id);
  await store.saveEmbedding(id, payload(edited.todo));
  assert.equal((await store.pendingEmbeddings()).records.length, 0);
  // Search finds the embedded task.
  const results = await store.search({ ...payload(edited.todo), limit: 20 });
  assert.equal(results.matches.length, 1);
  assert.equal(results.matches[0].todo.id, id);
  assert.equal(results.pending_count, 0);
  await store.delete(id);
  assert.deepEqual((await store.list()).records, []);
  void before;
});

test('embedding validation rejects bad vectors and metadata without overwriting', async () => {
  const store = makeStore();
  const created = await store.create({ title: 'Keep source' });
  await store.saveEmbedding(created.todo.id, payload(created.todo));
  const good = await store.search({ ...payload(created.todo) });
  assert.equal(good.matches.length, 1);
  const badCases = [
    { vector: [] }, { vector: Array(767).fill(1) }, { vector: Array(769).fill(1) },
    { vector: Array(768).fill(0) }, { vector: Array(768).fill(1e-100) }, { vector: Array(768).fill(1e100) },
    { vector: Array(768).fill('0.1') }, { vector: Array(768).fill(true) }, { vector: Array(768).fill(null) },
    { vector: Array(768).fill(NaN) }, { vector: Array(768).fill(Infinity) },
    { model: 'other/model' }, { revision: 'main' }, { revision: 'b'.repeat(40) },
    { input_version: 2 }, { dimensions: 2 }, { title: '' }, { icon: 'unknown' },
  ];
  for (const changes of badCases) {
    await assertCode(store.saveEmbedding(created.todo.id, payload(created.todo, changes)), 'validation');
  }
  const after = await store.search({ ...payload(created.todo) });
  assert.equal(after.matches.length, 1);
});

test('stale source snapshots and repeated uploads behave atomically', async () => {
  const store = makeStore();
  const created = await store.create({ title: 'Original', icon: 'home' });
  const id = created.todo.id;
  const body = payload(created.todo);
  for (let attempt = 0; attempt < 2; attempt++) {
    await store.saveEmbedding(id, body);
  }
  await assertCode(store.saveEmbedding(id, payload(created.todo, { title: ' Original' })), 'conflict');
  await assertCode(store.saveEmbedding(id, payload(created.todo, { icon: 'work' })), 'conflict');
  const edited = await store.update(id, { title: 'Changed', icon: 'star' });
  await assertCode(store.saveEmbedding(id, body), 'conflict');
  await store.saveEmbedding(id, payload(edited.todo));
  await store.delete(id);
  await assertCode(store.saveEmbedding(id, payload(edited.todo)), 'missing');
});

test('stale revision preconditions reject late mutations and embeddings', async () => {
  const store = makeStore();
  const created = await store.create({ title: 'Original', icon: 'home' });
  const id = created.todo.id;
  const staleRevision = created.revision;
  const staleSource = created.source_revision;
  const edited = await store.update(id, { title: 'Changed', icon: 'star' });
  assert.notEqual(edited.revision, staleRevision);
  await assertCode(store.update(id, { title: 'Late', icon: 'task' }, { expectedRevision: staleRevision }), 'conflict');
  await assertCode(store.setCompleted(id, true, { expectedRevision: staleRevision }), 'conflict');
  await assertCode(store.delete(id, { expectedRevision: staleRevision }), 'conflict');
  await assertCode(
    store.saveEmbedding(id, payload({ title: 'Original', icon: 'home' }), { expectedSourceRevision: staleSource }),
    'conflict',
  );
  // Edit-and-revert still rejects an embedding captured before the edit.
  const reverted = await store.update(id, { title: 'Original', icon: 'home' });
  assert.notEqual(reverted.source_revision, staleSource);
  await assertCode(
    store.saveEmbedding(id, payload({ title: 'Original', icon: 'home' }), { expectedSourceRevision: staleSource }),
    'conflict',
  );
  await store.saveEmbedding(id, payload(reverted.todo), { expectedSourceRevision: reverted.source_revision });
});

test('search ranking, inclusive cutoff, ties and pending counts', async () => {
  const store = makeStore();
  async function add(title, values) {
    const created = await store.create({ title, icon: 'work' });
    if (values) await store.saveEmbedding(created.todo.id, { ...payload(created.todo), vector: [...values, ...Array(768 - values.length).fill(0)] });
    return created.todo;
  }
  const query = (values, changes = {}) => ({
    vector: [...values, ...Array(768 - values.length).fill(0)],
    model: EMBEDDING_METADATA.model, revision: EMBEDDING_METADATA.revision,
    input_version: EMBEDDING_METADATA.input_version, dimensions: DIMENSIONS, ...changes,
  });
  assert.deepEqual((await store.search(query([1, 0]))).matches, []);
  await add('Opposite', [-1, 0]);
  await add('Perpendicular', [0, 9]);
  const nearScore = (0.70 + 1.0) / 2;
  const length = Math.sqrt(2);
  const near = await add('Near', [nearScore, Math.sqrt(1 - nearScore * nearScore)]);
  const exact = await add('Exact', [10, 0]);
  const pending = await add('Not yet indexed');
  await store.setCompleted(near.id, true);
  const response = await store.search(query([1, 0]));
  assert.equal(response.min_score, 0.70);
  assert.equal(response.pending_count, 1);
  assert.deepEqual(response.matches.map((match) => match.todo.id), [exact.id, near.id]);
  assert.ok(Math.abs(response.matches[0].score - 1.0) < 1e-6);
  assert.ok(Math.abs(response.matches[1].score - nearScore) < 1e-6);
  const limited = await store.search(query([1, 0], { limit: 1 }));
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.matches[0].todo.id, exact.id);
  void pending;
  void length;
});

test('search matches carry revision tokens that detect stale sources', async () => {
  const store = makeStore();
  const created = await store.create({ title: 'Buy food', icon: 'shopping' });
  await store.saveEmbedding(created.todo.id, payload(created.todo));
  const query = { ...payload(created.todo) };
  const first = await store.search(query);
  assert.equal(first.matches.length, 1);
  const listed = new Map((await store.list()).records.map((record) => [record.todo.id, record]));
  assert.equal(first.matches[0].revision, listed.get(created.todo.id).revision);
  assert.equal(first.matches[0].source_revision, listed.get(created.todo.id).source_revision);
  // A source edit mints fresh tokens, so the captured match is now stale.
  const edited = await store.update(created.todo.id, { title: 'Changed', icon: 'star' });
  assert.notEqual(first.matches[0].revision, edited.revision);
  assert.notEqual(first.matches[0].source_revision, edited.source_revision);
  // Edit-and-revert restores the title but not the source token: the old
  // match must still be rejected by comparing source_revision.
  const reverted = await store.update(created.todo.id, { title: 'Buy food', icon: 'shopping' });
  assert.equal(reverted.todo.title, 'Buy food');
  assert.notEqual(first.matches[0].source_revision, reverted.source_revision);
  await store.saveEmbedding(created.todo.id, payload(reverted.todo));
  const second = await store.search(query);
  assert.equal(second.matches[0].source_revision, (await store.list()).records[0].source_revision);
});

test('ties follow created_at then id order', async () => {
  let counter = 0;
  const ids = ['id-c', 'id-a', 'id-b'];
  const store = new LocalTodoStore({ generateId: () => ids[counter++] });
  const tasks = [];
  for (const title of ['First', 'Second', 'Third']) {
    const created = await store.create({ title });
    tasks.push(created.todo);
    await store.saveEmbedding(created.todo.id, payload(created.todo, { vector: [1, ...Array(767).fill(0)] }));
  }
  // Force created_at ties broken by id.
  const query = { vector: [1, ...Array(767).fill(0)], model: EMBEDDING_METADATA.model,
    revision: EMBEDDING_METADATA.revision, input_version: 1, dimensions: DIMENSIONS };
  const matches = (await store.search(query)).matches;
  assert.equal(matches.length, 3);
  assert.ok(matches.every((match) => match.score === 1.0));
});

test('invalid search inputs are rejected', async () => {
  const store = makeStore();
  const good = { vector: vector(), model: EMBEDDING_METADATA.model, revision: EMBEDDING_METADATA.revision,
    input_version: 1, dimensions: DIMENSIONS };
  for (const changes of [{ vector: [] }, { vector: Array(767).fill(1) }, { vector: Array(769).fill(1) },
    { vector: Array(768).fill(0) }, { model: 'other' }, { revision: 'main' }, { input_version: 2 },
    { dimensions: 767 }, { limit: 0 }, { limit: 101 }, { limit: true }, { limit: 1.5 }]) {
    await assertCode(store.search({ ...good, ...changes }), 'validation');
  }
  for (const field of ['vector', 'model', 'revision', 'input_version', 'dimensions']) {
    const body = { ...good };
    delete body[field];
    await assertCode(store.search(body), 'validation');
  }
});

test('float32 extremes produce finite cosine scores', async () => {
  for (const extreme of [1e-40, 3e38]) {
    const store = makeStore();
    const created = await store.create({ title: 'Extreme magnitude' });
    await store.saveEmbedding(created.todo.id, payload(created.todo, { vector: [extreme, extreme, ...Array(766).fill(0)] }));
    const query = { vector: [extreme, extreme, ...Array(766).fill(0)], model: EMBEDDING_METADATA.model,
      revision: EMBEDDING_METADATA.revision, input_version: 1, dimensions: DIMENSIONS };
    const results = await store.search(query);
    assert.equal(results.pending_count, 0);
    assert.equal(results.matches[0].todo.id, created.todo.id);
    assert.ok(Number.isFinite(results.matches[0].score));
    assert.ok(Math.abs(results.matches[0].score - 1.0) < 1e-6);
  }
});

test('file-backed persist hook survives a simulated restart', async () => {
  const dir = join(tmpdir(), `todo-store-restart-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'store.json');
  const persist = async (holder) => {
    writeFileSync(file, JSON.stringify(holder.store.orderedRecords()));
  };
  const holder = {};
  const first = makeStore({ persist: null });
  holder.store = first;
  first.persist = () => persist(holder);
  const kept = await first.create({ title: 'Keep me' });
  const removed = await first.create({ title: 'Remove me' });
  await first.saveEmbedding(kept.todo.id, payload(kept.todo));
  await first.delete(removed.todo.id);
  const restarted = makeStore();
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  restarted.seed(rows.map((record) => ({
    id: record.todo.id, title: record.todo.title, icon: record.todo.icon,
    completed: record.todo.completed, created_at: record.created_at,
    embedding: record.embedding, embedding_model: record.embedding_model,
    embedding_revision: record.embedding_revision,
    embedding_input_version: record.embedding_input_version,
    embedding_dimensions: record.embedding_dimensions,
  })));
  assert.deepEqual((await restarted.list()).records.map((record) => record.todo), [kept.todo]);
  assert.equal((await restarted.pendingEmbeddings()).records.length, 0);
  await restarted.delete(kept.todo.id);
  assert.deepEqual((await restarted.list()).records, []);
});

test('quota and flush failures are truthful, roll back, and retry with the same operationId', async () => {
  let failuresLeft = 1;
  const quotaError = new DOMException('Quota exceeded', 'QuotaExceededError');
  const store = makeStore({
    persist: async () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw quotaError;
      }
    },
  });
  const operationId = 'op-quota-1';
  const failure = await assertCode(store.create({ title: 'Draft kept' }, { operationId }), 'quota');
  assert.equal(failure.operationId, operationId);
  assert.deepEqual((await store.list()).records, []);
  const retry = await store.create({ title: 'Draft kept' }, { operationId });
  assert.equal(retry.operationId, operationId);
  assert.equal((await store.list()).records.length, 1);
  // Duplicate successful operationIds are idempotent.
  const again = await store.create({ title: 'Draft kept' }, { operationId });
  assert.deepEqual(again, retry);
  assert.equal((await store.list()).records.length, 1);

  const generic = makeStore({ persist: async () => { throw new Error('flush failed'); } });
  const unconfirmed = await assertCode(generic.create({ title: 'Never confirmed' }, { operationId: 'op-x' }), 'unconfirmed');
  assert.equal(unconfirmed.code, 'unconfirmed');
  assert.equal(unconfirmed.operationId, 'op-x');
  assert.deepEqual((await generic.list()).records, []);
});

test('uncertain replies recover by reissuing the same operationId without duplication', async () => {
  const store = makeStore();
  const operationId = 'op-uncertain-9';
  const first = await store.create({ title: 'Uncertain save' }, { operationId });
  // Simulate a lost acknowledgement: the caller retries the identical operation.
  const recovered = await store.create({ title: 'Uncertain save' }, { operationId });
  assert.deepEqual(recovered, first);
  assert.equal((await store.list()).records.length, 1);
});

test('operations serialize so concurrent writes cannot interleave', async () => {
  const store = makeStore();
  const creations = await Promise.all([
    store.create({ title: 'One' }), store.create({ title: 'Two' }), store.create({ title: 'Three' }),
  ]);
  assert.equal(new Set(creations.map((record) => record.todo.id)).size, 3);
  assert.deepEqual((await store.list()).records.map((record) => record.todo.title), ['One', 'Two', 'Three']);
  const sequences = creations.map((record) => record.sequence).sort((a, b) => a - b);
  assert.deepEqual(sequences, [1, 2, 3]);
});

test('subscribe receives committed change notifications', async () => {
  const store = makeStore();
  const events = [];
  const unsubscribe = store.subscribe((event) => events.push(event));
  const created = await store.create({ title: 'Notify me' }, { operationId: 'op-notify' });
  assert.equal(events.length, 1);
  assert.equal(events[0].sequence, created.sequence);
  assert.equal(events[0].operationId, 'op-notify');
  assert.deepEqual(events[0].ids, [created.todo.id]);
  unsubscribe();
  await store.create({ title: 'Silent' });
  assert.equal(events.length, 1);
});
