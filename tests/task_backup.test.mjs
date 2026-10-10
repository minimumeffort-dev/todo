import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalTodoStore } from '../app/static/todo-store.mjs';
import { StorageError } from '../app/static/storage-contract.mjs';
import { EMBEDDING_METADATA } from '../app/static/storage-contract.mjs';

const DIMENSIONS = EMBEDDING_METADATA.dimensions;

function vector(first = 0.25, second = -0.75) {
  return [first, second, ...Array(DIMENSIONS - 2).fill(0)];
}

function makeStore() {
  let counter = 0;
  return new LocalTodoStore({ generateId: () => `backup-id-${++counter}` });
}

async function seededStore() {
  const store = makeStore();
  const first = await store.create({ title: 'First', icon: 'star' });
  const second = await store.create({ title: 'Second', icon: 'heart' });
  await store.setCompleted(second.todo.id, true);
  await store.saveEmbedding(first.todo.id, {
    title: first.todo.title, icon: first.todo.icon, vector: vector(),
    model: EMBEDDING_METADATA.model, revision: EMBEDDING_METADATA.revision,
    input_version: EMBEDDING_METADATA.input_version, dimensions: DIMENSIONS,
  });
  return store;
}

test('export/import round-trips tasks, completion, ordering, timestamps and embeddings', async () => {
  const store = await seededStore();
  const backup = await store.exportBackup();
  assert.equal(backup.format, 'local-todo');
  assert.equal(backup.version, 1);
  assert.equal(backup.todos.length, 2);
  const [first, second] = backup.todos;
  assert.equal(first.title, 'First');
  assert.equal(first.icon, 'star');
  assert.equal(first.completed, false);
  assert.equal(typeof first.created_at, 'string');
  assert.deepEqual(first.embedding.slice(0, 2), [Math.fround(0.25), Math.fround(-0.75)]);
  assert.equal(first.embedding.length, DIMENSIONS);
  assert.equal(first.embedding_model, EMBEDDING_METADATA.model);
  assert.equal(first.embedding_revision, EMBEDDING_METADATA.revision);
  assert.equal(first.embedding_input_version, 1);
  assert.equal(first.embedding_dimensions, DIMENSIONS);
  assert.equal(second.completed, true);
  assert.equal(second.embedding, undefined);

  const fresh = makeStore();
  const result = await fresh.importBackup(JSON.parse(JSON.stringify(backup)));
  assert.equal(result.imported, 2);
  assert.equal(result.skipped, 0);
  const relisted = await fresh.list();
  assert.deepEqual(relisted.records.map((record) => record.todo),
    (await store.list()).records.map((record) => record.todo));
  const reexported = await fresh.exportBackup();
  assert.deepEqual(reexported, backup);
  // Search works on the imported vectors.
  const query = { vector: vector(), model: EMBEDDING_METADATA.model, revision: EMBEDDING_METADATA.revision,
    input_version: 1, dimensions: DIMENSIONS };
  const results = await fresh.search(query);
  assert.equal(results.matches.length, 1);
  assert.equal(results.matches[0].todo.title, 'First');
});

test('import merges missing ids and skips identical records', async () => {
  const store = await seededStore();
  const backup = await store.exportBackup();
  const again = await store.importBackup(JSON.parse(JSON.stringify(backup)));
  assert.equal(again.imported, 0);
  assert.equal(again.skipped, 2);
  assert.equal((await store.list()).records.length, 2);

  const extra = {
    format: 'local-todo', version: 1,
    todos: [...backup.todos, {
      id: 'brand-new', title: 'New', icon: 'work', completed: false,
      created_at: new Date(Date.UTC(2026, 5, 1)).toISOString(),
    }],
  };
  const merged = await store.importBackup(extra);
  assert.equal(merged.imported, 1);
  assert.equal(merged.skipped, 2);
  assert.equal((await store.list()).records.length, 3);
});

test('imported records receive fresh internal revision tokens', async () => {
  const store = await seededStore();
  const backup = await store.exportBackup();
  const before = new Map((await store.list()).records.map((record) => [record.todo.id, record.revision]));
  const fresh = makeStore();
  await fresh.importBackup(JSON.parse(JSON.stringify(backup)));
  const after = await fresh.list();
  for (const record of after.records) {
    assert.ok(record.revision);
    assert.ok(record.source_revision);
  }
  // Tokens are opaque and freshly minted, so a second import target differs.
  const other = makeStore();
  await other.importBackup(JSON.parse(JSON.stringify(backup)));
  const otherRecords = await other.list();
  assert.notDeepEqual(
    otherRecords.records.map((record) => record.revision),
    after.records.map((record) => record.revision),
  );
  void before;
});

test('invalid backups are rejected without changes', async () => {
  const store = await seededStore();
  const backup = await store.exportBackup();
  const before = await store.exportBackup();
  const invalid = [
    null, [], { format: 'other', version: 1, todos: [] },
    { format: 'local-todo', version: 2, todos: [] },
    { format: 'local-todo', version: 1 },
    { format: 'local-todo', version: 1, todos: {} },
    { format: 'local-todo', version: 1, todos: [{ id: '', title: 'x', icon: 'task', completed: false, created_at: new Date().toISOString() }] },
    { format: 'local-todo', version: 1, todos: [{ id: 'a', title: '', icon: 'task', completed: false, created_at: new Date().toISOString() }] },
    { format: 'local-todo', version: 1, todos: [{ id: 'a', title: 'x'.repeat(501), icon: 'task', completed: false, created_at: new Date().toISOString() }] },
    { format: 'local-todo', version: 1, todos: [{ id: 'a', title: 'ok', icon: 'nope', completed: false, created_at: new Date().toISOString() }] },
    { format: 'local-todo', version: 1, todos: [{ id: 'a', title: 'ok', icon: 'task', completed: 'yes', created_at: new Date().toISOString() }] },
    { format: 'local-todo', version: 1, todos: [{ id: 'a', title: 'ok', icon: 'task', completed: false, created_at: 'not-a-date' }] },
    { format: 'local-todo', version: 1, todos: [
      { id: 'dup', title: 'one', icon: 'task', completed: false, created_at: new Date().toISOString() },
      { id: 'dup', title: 'two', icon: 'task', completed: false, created_at: new Date().toISOString() },
    ] },
    { format: 'local-todo', version: 1, todos: [{ id: 'a', title: 'ok', icon: 'task', completed: false,
      created_at: new Date().toISOString(), embedding: [1, 2], embedding_model: EMBEDDING_METADATA.model,
      embedding_revision: EMBEDDING_METADATA.revision, embedding_input_version: 1, embedding_dimensions: DIMENSIONS }] },
    { format: 'local-todo', version: 1, todos: [{ id: 'a', title: 'ok', icon: 'task', completed: false,
      created_at: new Date().toISOString(), embedding: vector(), embedding_model: 'other',
      embedding_revision: EMBEDDING_METADATA.revision, embedding_input_version: 1, embedding_dimensions: DIMENSIONS }] },
  ];
  for (const document of invalid) {
    try {
      await store.importBackup(document);
      assert.fail(`Expected rejection for ${JSON.stringify(document)?.slice(0, 80)}`);
    } catch (error) {
      assert.ok(error instanceof StorageError, `Expected StorageError, got ${error}`);
      assert.equal(error.code, 'validation');
    }
  }
  assert.deepEqual(await store.exportBackup(), before);
  assert.deepEqual(backup, before);
});

test('conflicting imports are rejected atomically with no partial changes', async () => {
  const store = await seededStore();
  const backup = await store.exportBackup();
  const before = await store.exportBackup();
  // Same id but a different title is a conflict, even alongside a new id.
  const conflicting = {
    format: 'local-todo', version: 1,
    todos: [
      ...backup.todos.map((entry) => entry.id === backup.todos[0].id
        ? { ...entry, title: 'Changed title' } : entry),
      { id: 'brand-new', title: 'New', icon: 'work', completed: false, created_at: new Date().toISOString() },
    ],
  };
  try {
    await store.importBackup(conflicting);
    assert.fail('Expected conflict');
  } catch (error) {
    assert.ok(error instanceof StorageError);
    assert.equal(error.code, 'conflict');
  }
  assert.deepEqual(await store.exportBackup(), before);
  assert.equal((await store.list()).records.length, 2);
});
