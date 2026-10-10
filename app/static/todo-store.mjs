// Promise-based local todo repository. Semantics mirror the server store:
// UUID ids, created_at/id ordering, trimmed 1-500 titles, six icons, strict
// booleans, FLOAT[] embeddings with pinned metadata, completion and no-op
// saves preserve embeddings, source edits invalidate them atomically.
//
// Records carry revision tokens separately from Todo:
//   Record = {todo, revision, source_revision, created_at, embedding?...}.
// Mutation preconditions use expectedRevision / expectedSourceRevision so
// stale workers and cross-tab edits cannot overwrite newer values.
// Durable operationIds make retried mutations idempotent.
//
// Persistence is injected: `persist` runs after every committed mutation and
// must confirm durability (COMMIT + CHECKPOINT + native OPFS flush in the
// production worker). If it throws, the mutation is rolled back and the
// error propagates as quota/unconfirmed so callers retain drafts and retry
// with the SAME operationId.
import {
  EMBEDDING_METADATA,
  StorageError,
} from './storage-contract.mjs';
import {
  canonicalizeTimestamp,
  compareTimestamps,
  embeddingIsUsable,
  newOperationId,
  newRevision,
  rankSearch,
  validateCompleted,
  validateEmbeddingMetadata,
  validateEmbeddingVector,
  validateIcon,
  validateSearchInput,
  validateTitle,
} from './database-schema.mjs';
import { classifyBackupImport, exportBackupDocument } from './task-backup.mjs';

function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 36).toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function cloneTodo(todo) {
  return { id: todo.id, title: todo.title, icon: todo.icon, completed: todo.completed };
}

function toPublicRecord(record) {
  return { todo: cloneTodo(record.todo), revision: record.revision, source_revision: record.source_revision };
}

function snapshotState(store) {
  return {
    rows: new Map([...store.rows].map(([id, record]) => [id, JSON.parse(JSON.stringify(record))])),
    sequence: store.sequence,
    completedOperations: new Map(store.completedOperations),
  };
}

function restoreState(store, snapshot) {
  store.rows = snapshot.rows;
  store.sequence = snapshot.sequence;
  store.completedOperations = snapshot.completedOperations;
}

export const RECEIPT_LIMIT = 1000; // Bounded durable operation log; oldest receipts expire first.

export class LocalTodoStore {
  constructor({ persist = null, now = nowIso, generateId = uuid } = {}) {
    this.rows = new Map();
    this.sequence = 0;
    this.completedOperations = new Map(); // operationId -> result
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.persist = persist;
    this.now = now;
    this.generateId = generateId;
    this.initialized = false;
  }

  // Seed rows from an existing store (legacy migration path). Each seed is
  // {id,title,icon,completed,created_at,embedding?...} with migration
  // defaults (icon 'task', completed false) applied by the caller.
  // Persisted revision tokens ride along when present; fresh tokens are
  // minted only for legacy records that lack them, so acknowledged receipts
  // stay valid across a database reopen.
  seed(seedRows) {
    for (const seed of seedRows) {
      const title = validateTitle(seed.title);
      validateIcon(seed.icon ?? 'task');
      validateCompleted(seed.completed ?? false);
      const record = {
        todo: { id: seed.id, title, icon: seed.icon ?? 'task', completed: seed.completed ?? false },
        revision: typeof seed.revision === 'string' && seed.revision.length > 0 ? seed.revision : newRevision(),
        source_revision: typeof seed.source_revision === 'string' && seed.source_revision.length > 0 ? seed.source_revision : newRevision(),
        created_at: canonicalizeTimestamp(seed.created_at ?? this.now()),
        embedding: seed.embedding !== undefined && seed.embedding !== null ? [...seed.embedding] : null,
        embedding_model: seed.embedding_model ?? null,
        embedding_revision: seed.embedding_revision ?? null,
        embedding_input_version: seed.embedding_input_version ?? null,
        embedding_dimensions: seed.embedding_dimensions ?? null,
      };
      this.rows.set(record.todo.id, record);
    }
  }

  orderedRecords() {
    // Chronological order with microsecond precision: raw string comparison
    // misorders instants (`.000Z` sorts after `.000001Z` lexicographically).
    return [...this.rows.values()].sort((a, b) => {
      const byTime = compareTimestamps(a.created_at, b.created_at);
      if (byTime !== 0) return byTime;
      return a.todo.id < b.todo.id ? -1 : a.todo.id > b.todo.id ? 1 : 0;
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  publish(event) {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* A bad subscriber never breaks the store. */ }
    }
  }

  // Serialize all operations so concurrent tab calls cannot interleave.
  enqueue(operation) {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }

  // Run a mutation with operationId dedup, rollback on persist failure, and
  // a committed change notification. `mutate` applies in-memory changes and
  // returns {result, changedIds}.
  async runMutation(operationId, mutate) {
    const id = operationId ?? newOperationId();
    return this.enqueue(async () => {
      if (this.completedOperations.has(id)) return this.completedOperations.get(id);
      const snapshot = snapshotState(this);
      let outcome;
      try {
        outcome = mutate();
      } catch (error) {
        if (error instanceof StorageError && error.code === 'unconfirmed') error.operationId = id;
        throw error;
      }
      this.sequence += 1;
      const result = { ...outcome.result, sequence: this.sequence, operationId: id };
      // Record the receipt BEFORE the durability barrier so the persist hook
      // observes (and durably stores) the exact receipt being acknowledged.
      // A persist failure rolls the receipt back with the rows, so the next
      // retry with the same operationId re-executes instead of replaying.
      this.completedOperations.set(id, result);
      while (this.completedOperations.size > RECEIPT_LIMIT) {
        const oldest = this.completedOperations.keys().next();
        if (oldest.done) break;
        this.completedOperations.delete(oldest.value);
      }
      if (this.persist) {
        try {
          await this.persist();
        } catch (error) {
          restoreState(this, snapshot);
          throw toDurabilityError(error, id);
        }
      }
      this.publish({ sequence: this.sequence, operationId: id, ids: outcome.changedIds });
      return result;
    });
  }

  // Durable operation ledger: the production worker persists these receipts
  // atomically with the rows and restores them when reopening, so a retried
  // operationId after a lost acknowledgement or restart replays the stored
  // result instead of duplicating the mutation.
  exportReceipts() {
    return [...this.completedOperations].map(([operation_id, result]) => ({ operation_id, result }));
  }

  // Restore the durable operation ledger after a reopen. The change
  // sequence resumes from the persisted value (falling back to the highest
  // receipted sequence) before any request from a surviving tab is served,
  // so sequence comparisons never go backwards. Rows whose seeds lacked
  // revision tokens adopt the latest acknowledged tokens for their id, so a
  // retried operationId replays the receipt that list() already reflects.
  restoreReceipts(entries, persistedSequence) {
    if (!Array.isArray(entries)) entries = [];
    let restored = this.sequence;
    if (Number.isSafeInteger(persistedSequence)) restored = Math.max(restored, persistedSequence);
    for (const entry of entries) {
      if (!entry || typeof entry.operation_id !== 'string' || !entry.result) continue;
      this.completedOperations.set(entry.operation_id, entry.result);
      const receiptSequence = entry.result?.sequence;
      if (Number.isSafeInteger(receiptSequence)) restored = Math.max(restored, receiptSequence);
    }
    this.sequence = restored;
    while (this.completedOperations.size > RECEIPT_LIMIT) {
      const oldest = this.completedOperations.keys().next();
      if (oldest.done) break;
      this.completedOperations.delete(oldest.value);
    }
    this.reconcileTokensFromReceipts();
  }

  reconcileTokensFromReceipts() {
    const latest = new Map(); // id -> {sequence, revision, source_revision}
    for (const [, result] of this.completedOperations) {
      if (!result || typeof result !== 'object') continue;
      const id = result.todo?.id ?? result.id;
      if (typeof id !== 'string') continue;
      if (typeof result.revision !== 'string' || typeof result.source_revision !== 'string') continue;
      const receiptSequence = Number.isSafeInteger(result.sequence) ? result.sequence : -1;
      const previous = latest.get(id);
      if (!previous || receiptSequence >= previous.sequence) {
        latest.set(id, { sequence: receiptSequence, revision: result.revision, source_revision: result.source_revision });
      }
    }
    for (const [id, tokens] of latest) {
      const record = this.rows.get(id);
      if (record) {
        record.revision = tokens.revision;
        record.source_revision = tokens.source_revision;
      }
    }
  }

  async initialize() {
    return this.enqueue(async () => {
      this.initialized = true;
      let persistence = { requested: false, granted: false };
      try {
        if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
          persistence = { requested: true, granted: await navigator.storage.persist() };
        }
      } catch { persistence = { requested: true, granted: false }; }
      return { sequence: this.sequence, persistence };
    });
  }

  async list() {
    return this.enqueue(async () => ({
      records: this.orderedRecords().map(toPublicRecord),
      sequence: this.sequence,
    }));
  }

  async create(input, { operationId } = {}) {
    const title = validateTitle(input?.title);
    const icon = validateIcon(input?.icon === undefined ? 'task' : input.icon);
    return this.runMutation(operationId, () => {
      const record = {
        todo: { id: this.generateId(), title, icon, completed: false },
        revision: newRevision(),
        source_revision: newRevision(),
        created_at: canonicalizeTimestamp(this.now()),
        embedding: null,
        embedding_model: null,
        embedding_revision: null,
        embedding_input_version: null,
        embedding_dimensions: null,
      };
      this.rows.set(record.todo.id, record);
      return { result: { ...toPublicRecord(record) }, changedIds: [record.todo.id] };
    });
  }

  async update(id, input, { expectedRevision, operationId } = {}) {
    const title = validateTitle(input?.title);
    const icon = validateIcon(input?.icon);
    return this.runMutation(operationId, () => {
      const record = this.rows.get(id);
      if (!record) throw new StorageError('missing', 'To-do item not found.');
      if (expectedRevision !== undefined && expectedRevision !== record.revision) {
        throw new StorageError('conflict', 'This task changed elsewhere. Reload and retry.');
      }
      const unchanged = record.todo.title === title && record.todo.icon === icon;
      record.todo = { ...record.todo, title, icon };
      record.revision = newRevision();
      if (!unchanged) {
        record.source_revision = newRevision();
        record.embedding = null;
        record.embedding_model = null;
        record.embedding_revision = null;
        record.embedding_input_version = null;
        record.embedding_dimensions = null;
      }
      return { result: { ...toPublicRecord(record) }, changedIds: [id] };
    });
  }

  async setCompleted(id, completed, { expectedRevision, operationId } = {}) {
    validateCompleted(completed);
    return this.runMutation(operationId, () => {
      const record = this.rows.get(id);
      if (!record) throw new StorageError('missing', 'To-do item not found.');
      if (expectedRevision !== undefined && expectedRevision !== record.revision) {
        throw new StorageError('conflict', 'This task changed elsewhere. Reload and retry.');
      }
      record.todo = { ...record.todo, completed };
      record.revision = newRevision();
      return { result: { ...toPublicRecord(record) }, changedIds: [id] };
    });
  }

  async delete(id, { expectedRevision, operationId } = {}) {
    return this.runMutation(operationId, () => {
      const record = this.rows.get(id);
      if (!record) throw new StorageError('missing', 'To-do item not found.');
      if (expectedRevision !== undefined && expectedRevision !== record.revision) {
        throw new StorageError('conflict', 'This task changed elsewhere. Reload and retry.');
      }
      this.rows.delete(id);
      return { result: { id }, changedIds: [id] };
    });
  }

  async saveEmbedding(id, input, { expectedSourceRevision, operationId } = {}) {
    if (!input || typeof input !== 'object') throw new StorageError('validation', 'Embedding is invalid.');
    const vector = validateEmbeddingVector(input.vector, EMBEDDING_METADATA.dimensions);
    validateEmbeddingMetadata(input);
    // Source snapshot must match confirmed saved values exactly (no trim).
    if (typeof input.title !== 'string' || input.title.length < 1 || input.title.length > 500) {
      throw new StorageError('validation', 'Embedding source title is invalid.');
    }
    validateIcon(input.icon);
    return this.runMutation(operationId, () => {
      const record = this.rows.get(id);
      if (!record) throw new StorageError('missing', 'To-do item not found.');
      if (expectedSourceRevision !== undefined && expectedSourceRevision !== record.source_revision) {
        throw new StorageError('conflict', 'This task changed elsewhere. Reload and retry.');
      }
      // Atomic source check: the write only applies when the saved source
      // still matches the embedded snapshot (edit-and-revert races included,
      // because every source edit mints a fresh source_revision).
      if (record.todo.title !== input.title || record.todo.icon !== input.icon) {
        throw new StorageError('conflict', 'To-do title or icon changed.');
      }
      record.embedding = vector;
      record.embedding_model = EMBEDDING_METADATA.model;
      record.embedding_revision = EMBEDDING_METADATA.revision;
      record.embedding_input_version = EMBEDDING_METADATA.input_version;
      record.embedding_dimensions = EMBEDDING_METADATA.dimensions;
      // Embedding-only writes preserve the task revision: background indexing
      // must never invalidate UI drafts or edits keyed on expectedRevision.
      // Subscribers still learn of the write through the mutation sequence.
      return { result: { id, revision: record.revision, source_revision: record.source_revision }, changedIds: [id] };
    });
  }

  async pendingEmbeddings() {
    return this.enqueue(async () => ({
      records: this.orderedRecords().filter((record) => !embeddingIsUsable(record)).map(toPublicRecord),
      sequence: this.sequence,
    }));
  }

  async search(input) {
    const validated = validateSearchInput({ ...input });
    return this.enqueue(async () => {
      const ranked = rankSearch(this.orderedRecords(), validated.vector, { limit: validated.limit });
      return { ...ranked, sequence: this.sequence };
    });
  }

  async exportBackup() {
    return this.enqueue(async () => exportBackupDocument(this.orderedRecords()));
  }

  // Atomic validated import: merge missing ids, skip identical records,
  // reject conflicting existing ids without changing anything. The whole
  // operation (receipt lookup, classification, mutation and durability
  // barrier) runs inside one serialized step: a retried operationId replays
  // the stored receipt even when later writes (such as background indexing)
  // made the live rows differ from the retried backup. Imports that change
  // nothing record a receipt as well, so their acknowledgement reconciles
  // exactly like any other committed mutation.
  async importBackup(document, { operationId } = {}) {
    const id = operationId ?? newOperationId();
    return this.enqueue(async () => {
      if (operationId !== undefined && this.completedOperations.has(operationId)) {
        return this.completedOperations.get(operationId);
      }
      const snapshot = snapshotState(this);
      let result;
      let changedIds = null;
      try {
        const currentById = new Map([...this.rows].map(([rowId, record]) => [rowId, {
          todo: cloneTodo(record.todo),
          created_at: record.created_at,
          embedding: record.embedding ? [...record.embedding] : record.embedding,
          embedding_model: record.embedding_model,
          embedding_revision: record.embedding_revision,
          embedding_input_version: record.embedding_input_version,
          embedding_dimensions: record.embedding_dimensions,
        }]));
        const { missing, skipped } = classifyBackupImport(document, currentById);
        if (missing.length === 0) {
          result = { imported: 0, skipped: skipped.length, sequence: this.sequence, operationId: id };
        } else {
          for (const entry of missing) {
            const record = {
              todo: { id: entry.id, title: entry.title, icon: entry.icon, completed: entry.completed },
              revision: newRevision(),
              source_revision: newRevision(),
              created_at: canonicalizeTimestamp(entry.created_at),
              embedding: entry.embedding !== undefined && entry.embedding !== null ? [...entry.embedding] : null,
              embedding_model: entry.embedding_model ?? null,
              embedding_revision: entry.embedding_revision ?? null,
              embedding_input_version: entry.embedding_input_version ?? null,
              embedding_dimensions: entry.embedding_dimensions ?? null,
            };
            this.rows.set(record.todo.id, record);
          }
          this.sequence += 1;
          result = { imported: missing.length, skipped: skipped.length, sequence: this.sequence, operationId: id };
          changedIds = missing.map((entry) => entry.id);
        }
      } catch (error) {
        // Validation and conflict failures change neither rows nor receipts,
        // so a corrected retry with the same operationId runs fresh.
        throw error;
      }
      this.completedOperations.set(id, result);
      while (this.completedOperations.size > RECEIPT_LIMIT) {
        const oldest = this.completedOperations.keys().next();
        if (oldest.done) break;
        this.completedOperations.delete(oldest.value);
      }
      if (this.persist) {
        try {
          await this.persist();
        } catch (error) {
          restoreState(this, snapshot);
          throw toDurabilityError(error, id);
        }
      }
      if (changedIds) {
        this.publish({ sequence: this.sequence, operationId: id, ids: changedIds });
      }
      return result;
    });
  }
}

export function toDurabilityError(error, operationId) {
  if (error instanceof StorageError) {
    if (error.operationId === undefined) error.operationId = operationId;
    return error;
  }
  const name = error?.name ?? '';
  const message = String(error?.message ?? error);
  if (name === 'QuotaExceededError' || /quota/i.test(message)) {
    return new StorageError('quota', 'Browser storage quota was exceeded. The save was not confirmed.', { operationId });
  }
  return new StorageError('unconfirmed', 'The save could not be confirmed. It may not survive a reload.', { operationId });
}
