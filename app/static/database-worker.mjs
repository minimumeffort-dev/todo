// Dedicated owning database worker. Exactly one worker per origin holds the
// exclusive Web Lock for its entire open lifetime and opens the OPFS-backed
// DuckDB file with the pinned blocking bindings. All SQL runs here;
// pages and other tabs talk to it through versioned request/reply RPC.
//
// Durability: every mutation runs COMMIT + CHECKPOINT + flushOPFSHandles()
// and is acknowledged ONLY after the native flush succeeds. Any flush error
// rolls the mutation back and is reported as quota/unconfirmed (never as
// success), so callers retain drafts and retry with the SAME operationId.
// The durable operations table makes retried operationIds idempotent.
//
// Message protocol (same as storage-contract.mjs):
//   request: {version:1, id, method, args:Array}
//   reply:   {version:1, id, ok:true, value} | {version:1, id, ok:false, error}
import {
  DATABASE_LOCK,
  DATABASE_PATH,
  DUCKDB_BLOCKING_MODULE_URL,
  DUCKDB_BUNDLES,
  EMBEDDING_METADATA,
  MIN_SEARCH_SCORE,
  REPOSITORY_METHODS,
  STORAGE_PROTOCOL_VERSION,
  StorageError,
  restoreStorageError,
  serializeStorageError,
} from './storage-contract.mjs';
import { MIGRATION_STATEMENTS } from './database-schema.mjs';
import { LocalTodoStore, toDurabilityError } from './todo-store.mjs';

export const WORKER_URL = '/static/database-worker.mjs';

function replyOk(id, value) {
  return { version: STORAGE_PROTOCOL_VERSION, id, ok: true, value };
}

function replyFail(id, error) {
  const serialized = error instanceof StorageError
    ? serializeStorageError(error)
    : serializeStorageError(toDurabilityError(error, undefined));
  return { version: STORAGE_PROTOCOL_VERSION, id, ok: false, error: serialized };
}

// Create the RPC handler. Dependencies are injectable for Node tests:
// - lock: {request(name, options, callback)} Web-Locks-like.
// - openDatabase(): resolves {query(sql, params?), checkpoint(), persist(), close()}.
// - store: LocalTodoStore instance (owns semantics, revisions, operation log).
export function createWorkerHost({ lock = globalThis.navigator?.locks ?? null, openDatabase = null, store = null } = {}) {
  const repository = store ?? new LocalTodoStore();
  let database = null;
  let initialized = false;

  async function ensureStorageAvailable() {
    if (typeof isSecureContext !== 'undefined' && isSecureContext === false) {
      throw new StorageError('unavailable', 'Persistent storage requires a secure origin (HTTPS or loopback).');
    }
    if (!lock) {
      throw new StorageError('unavailable', 'Persistent storage requires Web Locks in this browser.');
    }
    if (typeof FileSystemSyncAccessHandle === 'undefined' && typeof navigator !== 'undefined' && !navigator?.storage?.getDirectory) {
      throw new StorageError('unavailable', 'Persistent OPFS storage is unavailable in this browser.');
    }
  }

  async function defaultOpenDatabase() {
    const duckdb = await import(DUCKDB_BLOCKING_MODULE_URL);
    const db = await duckdb.createDuckDB(DUCKDB_BUNDLES, new duckdb.VoidLogger(), duckdb.BROWSER_RUNTIME);
    await db.instantiate();
    const { flushOPFSHandles } = await import('./storage-contract.mjs');
    await db.prepareDBFileHandle(DATABASE_PATH, duckdb.DuckDBDataProtocol.BROWSER_FSACCESS);
    db.open({ path: DATABASE_PATH, accessMode: duckdb.DuckDBAccessMode.READ_WRITE, useDirectIO: true });
    const connection = db.connect();
    const { MIGRATION_STATEMENTS: migrations, toEmbeddingArray, toIsoTimestamp } = await import('./database-schema.mjs');
    return {
      runtime: duckdb.BROWSER_RUNTIME,
      async migrate() {
        connection.query('BEGIN TRANSACTION');
        try {
          for (const statement of migrations) connection.query(statement);
          connection.query('COMMIT');
        } catch (error) {
          try { connection.query('ROLLBACK'); } catch { /* Keep the original error. */ }
          throw error;
        }
        connection.query('CHECKPOINT');
        flushOPFSHandles(duckdb.BROWSER_RUNTIME);
      },
      async checkpointAndFlush() {
        connection.query('BEGIN TRANSACTION');
        connection.query('COMMIT');
        connection.query('CHECKPOINT');
        flushOPFSHandles(duckdb.BROWSER_RUNTIME);
      },
      async readAll() {
        const table = connection.query(
          'SELECT id, title, icon, completed, created_at, embedding, embedding_model, embedding_revision, embedding_input_version, embedding_dimensions, revision, source_revision FROM todos ORDER BY created_at, id',
        );
        const seeds = table.toArray().map((row) => ({
          id: row.id,
          title: row.title,
          icon: row.icon ?? 'task',
          completed: row.completed ?? false,
          created_at: toIsoTimestamp(row.created_at),
          embedding: toEmbeddingArray(row.embedding),
          embedding_model: row.embedding_model ?? null,
          embedding_revision: row.embedding_revision ?? null,
          embedding_input_version: row.embedding_input_version ?? null,
          embedding_dimensions: row.embedding_dimensions ?? null,
          revision: typeof row.revision === 'string' ? row.revision : null,
          source_revision: typeof row.source_revision === 'string' ? row.source_revision : null,
        }));
        let receipts = [];
        try {
          const operations = connection.query('SELECT operation_id, result FROM operations');
          receipts = operations.toArray().map((row) => {
            let result = null;
            try {
              result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
            } catch { result = null; }
            return { operation_id: row.operation_id, result };
          }).filter((entry) => typeof entry.operation_id === 'string' && entry.result);
        } catch { receipts = []; }
        let sequence;
        try {
          const meta = connection.query("SELECT value FROM meta WHERE key = 'sequence'");
          const rows = meta.toArray();
          const parsed = rows.length > 0 ? Number(rows[0].value) : NaN;
          if (Number.isSafeInteger(parsed)) sequence = parsed;
        } catch { sequence = undefined; }
        return { seeds, receipts, sequence };
      },
      async writeThrough(records, receipts = [], sequence) {
        const { sqlLiteral: literal } = await import('./database-schema.mjs');
        connection.query('BEGIN TRANSACTION');
        try {
          connection.query('DELETE FROM todos');
          for (const record of records) {
            connection.query(
              `INSERT INTO todos (id, title, icon, completed, created_at, embedding, embedding_model, embedding_revision, embedding_input_version, embedding_dimensions, revision, source_revision) VALUES (${literal(record.todo.id)}, ${literal(record.todo.title)}, ${literal(record.todo.icon)}, ${literal(record.todo.completed)}, ${literal(record.created_at)}, ${literal(record.embedding)}, ${literal(record.embedding_model)}, ${literal(record.embedding_revision)}, ${literal(record.embedding_input_version)}, ${literal(record.embedding_dimensions)}, ${literal(record.revision ?? null)}, ${literal(record.source_revision ?? null)})`,
            );
          }
          // The operation ledger shares the mutation transaction: receipts
          // are durable exactly when the rows they describe are durable.
          connection.query('DELETE FROM operations');
          for (const entry of receipts ?? []) {
            if (!entry || typeof entry.operation_id !== 'string' || !entry.result) continue;
            connection.query(
              `INSERT INTO operations (operation_id, result) VALUES (${literal(entry.operation_id)}, ${literal(JSON.stringify(entry.result))})`,
            );
          }
          // The change sequence shares the mutation transaction: a reopened
          // owner resumes exactly where the acknowledged writes left off.
          if (Number.isSafeInteger(sequence)) {
            connection.query("DELETE FROM meta WHERE key = 'sequence'");
            connection.query(
              `INSERT INTO meta (key, value) VALUES ('sequence', ${literal(String(sequence))})`,
            );
          }
          connection.query('COMMIT');
          connection.query('CHECKPOINT');
          flushOPFSHandles(duckdb.BROWSER_RUNTIME);
        } catch (error) {
          try { connection.query('ROLLBACK'); } catch { /* Keep the original error. */ }
          throw error;
        }
      },
    };
  }

  async function initialize() {
    // Idempotent for the ownership lifetime: proxied initialize calls from
    // newly opened tabs must not reopen the database or reseed records
    // (reseeding would mint fresh revisions and invalidate saved tokens).
    if (initialized) return repository.initialize();
    await ensureStorageAvailable();
    if (!lock) throw new StorageError('unavailable', 'Web Locks are required for safe database access.');
    // Exclusive ownership is proven by the caller: the worker entry point
    // holds DATABASE_LOCK for its entire lifetime before serving RPC, and
    // client tabs proxy through the coordinator instead of opening the
    // database. No probe here: Web Locks are not reentrant, so probing the
    // lock we already hold could never succeed.
    const open = openDatabase ?? defaultOpenDatabase;
    database = await open();
    if (database.migrate) await database.migrate();
    if (database.readAll) {
      const data = await database.readAll();
      // readAll resolves {seeds, receipts, sequence}; legacy doubles
      // returning a bare seed array are still accepted.
      const seeds = Array.isArray(data) ? data : (data?.seeds ?? []);
      const receipts = Array.isArray(data) ? [] : (data?.receipts ?? []);
      const persistedSequence = Array.isArray(data) ? undefined : data?.sequence;
      if (seeds.length > 0) repository.seed(seeds);
      if (typeof repository.restoreReceipts === 'function') {
        repository.restoreReceipts(receipts, persistedSequence);
      }
    }
    // Persist hook: write the full committed state through DuckDB and flush.
    // Todos and operation receipts share one transaction, so an acknowledged
    // save always replays its stored receipt after a restart. Injected stores
    // in tests may carry their own persist hook already.
    if (!repository.persist && database.writeThrough) {
      repository.persist = () => database.writeThrough(
        repository.orderedRecords(), repository.exportReceipts(), repository.sequence,
      );
    } else if (database.checkpointAndFlush) {
      const inner = repository.persist;
      repository.persist = async () => {
        if (inner) await inner();
        await database.checkpointAndFlush();
      };
    } else if (database.writeThrough) {
      const inner = repository.persist;
      repository.persist = async () => {
        if (inner) await inner();
        await database.writeThrough(repository.orderedRecords(), repository.exportReceipts(), repository.sequence);
      };
    }
    initialized = true;
    return repository.initialize();
  }

  function requireInitialized() {
    if (!initialized) throw new StorageError('unavailable', 'The task database is not initialized.');
  }

  async function dispatch(method, args) {
    if (method === 'initialize') return initialize();
    requireInitialized();
    switch (method) {
      case 'list': return repository.list();
      case 'create': return repository.create(args[0], args[1]);
      case 'update': return repository.update(args[0], args[1], args[2]);
      case 'setCompleted': return repository.setCompleted(args[0], args[1], args[2]);
      case 'delete': return repository.delete(args[0], args[1]);
      case 'saveEmbedding': return repository.saveEmbedding(args[0], args[1], args[2]);
      case 'pendingEmbeddings': return repository.pendingEmbeddings();
      case 'search': return repository.search(args[0]);
      case 'exportBackup': return repository.exportBackup();
      case 'importBackup': return repository.importBackup(args[0], args[1]);
      default: throw new StorageError('validation', `Unknown repository method: ${method}.`);
    }
  }

  async function handleRequest(message) {
    if (!message || message.version !== STORAGE_PROTOCOL_VERSION
      || !REPOSITORY_METHODS.includes(message.method) && message.method !== 'initialize'
      || !Number.isSafeInteger(message.id)) {
      return replyFail(message?.id ?? 0, new StorageError('validation', 'Invalid repository request.'));
    }
    try {
      const value = await dispatch(message.method, message.args ?? []);
      return replyOk(message.id, value);
    } catch (error) {
      return replyFail(message.id, error);
    }
  }

  return { repository, initialize, dispatch, handleRequest, get database() { return database; } };
}

// Worker entry point: hold the origin-wide exclusive lock for life, then
// serve serialized RPC. Non-owner tabs never reach this code; they proxy
// through the coordinator's BroadcastChannel instead.
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  const host = createWorkerHost();
  let queue = Promise.resolve();
  const locks = globalThis.navigator?.locks;
  if (!locks) {
    globalThis.onmessage = (event) => {
      const message = event.data;
      globalThis.postMessage(replyFail(message?.id ?? 0, new StorageError('unavailable', 'Web Locks are required.')));
    };
  } else {
    locks.request(DATABASE_LOCK, { mode: 'exclusive' }, async () => {
      globalThis.onmessage = (event) => {
        const message = event.data;
        queue = queue.then(() => host.handleRequest(message)).then((reply) => {
          globalThis.postMessage(reply);
          if (message.method !== 'list' && message.method !== 'search'
            && message.method !== 'pendingEmbeddings' && message.method !== 'exportBackup' && reply.ok) {
            broadcastCommit(reply.value);
          }
        }).catch((error) => {
          globalThis.postMessage(replyFail(message?.id ?? 0, error));
        });
      };
      globalThis.postMessage({ ready: true });
      // Hold the lock for the worker lifetime.
      await new Promise(() => {});
    });
  }

  function broadcastCommit(value) {
    try {
      const channel = new BroadcastChannel(DATABASE_PATH_LOCK_CHANNEL());
      channel.postMessage({ sequence: value?.sequence ?? null, operationId: value?.operationId ?? null, ids: null });
      channel.close();
    } catch { /* Commit notification is best-effort; tabs reconcile via sequence. */ }
  }

  function DATABASE_PATH_LOCK_CHANNEL() {
    return 'local-todo:database:v1';
  }

  void EMBEDDING_METADATA;
  void MIN_SEARCH_SCORE;
  void restoreStorageError;
  void MIGRATION_STATEMENTS;
}
