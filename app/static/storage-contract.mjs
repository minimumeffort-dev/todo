// Shared browser repository contract. This module has no side effects and is
// safe to import in a page, a worker or an offline Node test.
export const STORAGE_PROTOCOL_VERSION = 1;
export const DUCKDB_VERSION = '1.33.1-dev65.0';
export const DATABASE_PATH = 'opfs://local-todo.duckdb';
export const DATABASE_LOCK = 'local-todo:database:v1';
export const DATABASE_CHANNEL = 'local-todo:database:v1';
export const BACKUP_FORMAT = 'local-todo';
export const BACKUP_VERSION = 1;
export const TASK_ICONS = Object.freeze(['task', 'star', 'home', 'work', 'shopping', 'heart']);
export const MAX_TITLE_LENGTH = 500;
export const MIN_SEARCH_SCORE = 0.70;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;
export const EMBEDDING_METADATA = Object.freeze({
  model: 'onnx-community/embeddinggemma-2-ONNX',
  revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0',
  input_version: 1,
  dimensions: 768,
});
export const DUCKDB_BUNDLES = Object.freeze({
  mvp: Object.freeze({
    mainModule: '/vendor/duckdb/duckdb-mvp.wasm',
    mainWorker: '/vendor/duckdb/duckdb-browser-mvp.worker.js',
  }),
  eh: Object.freeze({
    mainModule: '/vendor/duckdb/duckdb-eh.wasm',
    mainWorker: '/vendor/duckdb/duckdb-browser-eh.worker.js',
  }),
});
export const DUCKDB_MODULE_URL = '/vendor/duckdb/duckdb-browser.mjs';
export const DUCKDB_BLOCKING_MODULE_URL = '/vendor/duckdb/duckdb-browser-blocking.mjs';
export const REPOSITORY_METHODS = Object.freeze([
  'initialize', 'list', 'create', 'update', 'setCompleted', 'delete',
  'saveEmbedding', 'pendingEmbeddings', 'search', 'exportBackup', 'importBackup',
]);
export const STORAGE_ERROR_STATUS = Object.freeze({
  validation: 422, missing: 404, conflict: 409,
  unavailable: 503, quota: 507, unconfirmed: 503,
});

export class StorageError extends Error {
  constructor(code, message, { operationId, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StorageError';
    this.code = code;
    this.status = STORAGE_ERROR_STATUS[code] ?? 503;
    if (operationId !== undefined) this.operationId = operationId;
  }
}

export function serializeStorageError(error) {
  return {
    code: error.code ?? 'unavailable',
    status: error.status ?? STORAGE_ERROR_STATUS[error.code] ?? 503,
    message: error.message ?? 'Local storage is unavailable.',
    ...(error.operationId === undefined ? {} : { operationId: error.operationId }),
  };
}

export function restoreStorageError(value) {
  return new StorageError(value.code, value.message, { operationId: value.operationId });
}

// Pin-specific durability barrier for the blocking bindings INSIDE the owning
// worker. CHECKPOINT must finish first. The pin's syncFile is empty, so calling
// db.flushFiles() alone does not prove a native OPFS flush succeeded. Keeping
// this explicit also prevents the runtime's catch/failWith wrappers from
// hiding quota/flush exceptions. Never use this on the page's main thread.
export function flushOPFSHandles(runtime, path = DATABASE_PATH) {
  const database = runtime?._files?.get(path);
  if (typeof database?.flush !== 'function') {
    throw new StorageError('unconfirmed', 'The persistent database flush could not be confirmed.');
  }
  database.flush();
  const wal = runtime._files.get(`${path}.wal`);
  if (wal && wal !== database) wal.flush();
}

/**
 * Todo = {id:string, title:string, icon:one of TASK_ICONS, completed:boolean}.
 * Record = {todo:Todo, revision:string, source_revision:string}.
 * Tokens are opaque and never part of Todo or user backups. Source edits and
 * imports receive fresh source tokens even if a title is later reverted.
 *
 * Promise-based repository signatures:
 * initialize() -> {sequence, persistence:{requested, granted}}.
 * list() -> {records:Record[], sequence}; ordered by created_at then id.
 * create({title,icon}, {operationId}) -> Record + {sequence,operationId}.
 * update(id, {title,icon}, {expectedRevision,operationId}) -> same result.
 * setCompleted(id, completed, {expectedRevision,operationId}) -> same result.
 * delete(id, {expectedRevision,operationId}) -> {id,sequence,operationId}.
 * saveEmbedding(id, embedding, {expectedSourceRevision,operationId})
 *   -> {id,sequence,operationId}. Embedding includes source title/icon, vector
 *      and EMBEDDING_METADATA. It cannot alter the task or its revision.
 * pendingEmbeddings() -> {records:Record[],sequence}.
 * search(queryEmbedding, {limit=20})
 *   -> {matches:[{todo,score,revision,source_revision}],pending_count,
 *       min_score:0.70,sequence}. Query metadata must match the model pin.
 * exportBackup() -> {format:'local-todo',version:1,todos:[...]}; entries contain
 *   id,title,icon,completed,created_at and optional embedding + its metadata.
 *   Preserve microsecond timestamps as strings, without JS Date truncation.
 * importBackup(document, {operationId}) -> {imported,skipped,sequence,operationId}.
 *   Validate the entire backup first; merge missing IDs, skip exact records,
 *   reject conflicting IDs atomically; assign fresh internal revision tokens.
 * subscribe(listener) -> unsubscribe; listener receives committed events
 *   {sequence,operationId?,ids?}. Resume reconciles sequence using list().
 *
 * Mutations require a caller-generated stable operationId and appropriate
 * revision precondition. Success means COMMIT, CHECKPOINT and native OPFS
 * handle flushes all succeeded. Use the pin's blocking bindings inside the
 * dedicated owner worker and flushOPFSHandles(BROWSER_RUNTIME) after writes;
 * initialize via instantiate(), prepareDBFileHandle(path,BROWSER_FSACCESS),
 * then open({path,accessMode:READ_WRITE,useDirectIO:true}).
 * On unconfirmed durability retain the operationId; reissue the identical
 * operation after recovery so the durable operation log can reconcile it.
 * Never report success from COMMIT alone or retry with a new operationId.
 * Completion and unchanged-source updates preserve existing embeddings.
 *
 * Worker/local RPC request:
 * {version:1,id:string,method:REPOSITORY_METHODS member,args:Array}.
 * Replies: {version:1,id,ok:true,value} or {version:1,id,ok:false,error:
 * {code,status,message,operationId?}}. Request IDs only match RPC replies;
 * durable operation IDs are separately passed in mutation options.
 *
 * One worker owns DATABASE_LOCK exclusively for its entire open lifetime.
 * Other tabs use DATABASE_CHANNEL local RPC; they never open the same OPFS
 * files while that lock remains held. RPC handlers serialize operations.
 * No timeout can grant ownership. Only acquisition of the Web Lock can.
 * Initialization checks secure-context OPFS, Worker and Web Locks support,
 * requests navigator.storage.persist(), and never falls back to memory.
 */
