// Pure validation, ranking and SQL migration helpers for the local todo
// repository. No side effects; safe in page, worker and Node tests.
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  DEFAULT_SEARCH_LIMIT,
  EMBEDDING_METADATA,
  MAX_SEARCH_LIMIT,
  MAX_TITLE_LENGTH,
  MIN_SEARCH_SCORE,
  STORAGE_ERROR_STATUS,
  StorageError,
  TASK_ICONS,
} from './storage-contract.mjs';

export { StorageError };
export const ERROR_STATUS = STORAGE_ERROR_STATUS;

export function normalizeTitle(title) {
  return typeof title === 'string' ? title.trim() : title;
}

export function validateTitle(title) {
  const normalized = normalizeTitle(title);
  if (typeof normalized !== 'string' || normalized.length < 1 || normalized.length > MAX_TITLE_LENGTH) {
    throw new StorageError('validation', 'Task title must be 1-500 characters after trimming.');
  }
  return normalized;
}

export function validateIcon(icon) {
  if (!TASK_ICONS.includes(icon)) {
    throw new StorageError('validation', 'Task icon is not supported.');
  }
  return icon;
}

export function validateCompleted(completed) {
  if (typeof completed !== 'boolean') {
    throw new StorageError('validation', 'Task completion must be a boolean.');
  }
  return completed;
}

export function validateTodoShape(todo) {
  if (!todo || typeof todo !== 'object') throw new StorageError('validation', 'Task is invalid.');
  validateTitle(todo.title);
  validateIcon(todo.icon);
  validateCompleted(todo.completed);
  if (typeof todo.id !== 'string' || todo.id.length === 0) {
    throw new StorageError('validation', 'Task id is invalid.');
  }
  return todo;
}

function toFloat32(value) {
  return Math.fround(Number(value));
}

// Mirror the server contract: values must fit float32 and the converted
// vector must be finite and nonzero.
export function validateEmbeddingVector(vector, dimensions = EMBEDDING_METADATA.dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions) {
    throw new StorageError('validation', 'Embedding must have 768 values.');
  }
  const converted = vector.map((value) => {
    if (typeof value === 'boolean' || value === null || value === undefined) {
      throw new StorageError('validation', 'Embedding values must fit float32.');
    }
    if (typeof value === 'string') {
      throw new StorageError('validation', 'Embedding values must fit float32.');
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new StorageError('validation', 'Embedding must have finite, nonzero float32 output.');
    }
    const asFloat32 = toFloat32(value);
    if (!Number.isFinite(asFloat32)) {
      throw new StorageError('validation', 'Embedding must have finite, nonzero float32 output.');
    }
    return asFloat32;
  });
  if (!converted.some((value) => value !== 0)) {
    throw new StorageError('validation', 'Embedding must have finite, nonzero float32 output.');
  }
  return converted;
}

export function validateEmbeddingMetadata(meta) {
  if (!meta || meta.model !== EMBEDDING_METADATA.model
    || meta.revision !== EMBEDDING_METADATA.revision
    || meta.input_version !== EMBEDDING_METADATA.input_version
    || meta.dimensions !== EMBEDDING_METADATA.dimensions) {
    throw new StorageError('validation', 'Embedding model metadata does not match the pinned model.');
  }
}

export function validateSearchInput(input) {
  if (!input || typeof input !== 'object') throw new StorageError('validation', 'Search input is invalid.');
  const vector = validateEmbeddingVector(input.vector, EMBEDDING_METADATA.dimensions);
  validateEmbeddingMetadata(input);
  const limit = input.limit === undefined ? DEFAULT_SEARCH_LIMIT : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new StorageError('validation', 'Search limit must be an integer 1-100.');
  }
  return { ...input, vector, limit };
}

export function embeddingIsUsable(record) {
  const vector = record?.embedding;
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_METADATA.dimensions) return false;
  if (record.embedding_model !== EMBEDDING_METADATA.model
    || record.embedding_revision !== EMBEDDING_METADATA.revision
    || record.embedding_input_version !== EMBEDDING_METADATA.input_version
    || record.embedding_dimensions !== EMBEDDING_METADATA.dimensions) return false;
  let nonzero = false;
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (value !== 0) nonzero = true;
  }
  return nonzero;
}

// Cosine similarity in float64 so float32 extremes cannot overflow.
export function cosineScore(first, second) {
  let dot = 0;
  let firstNorm = 0;
  let secondNorm = 0;
  for (let index = 0; index < first.length; index++) {
    dot += first[index] * second[index];
    firstNorm += first[index] * first[index];
    secondNorm += second[index] * second[index];
  }
  firstNorm = Math.sqrt(firstNorm);
  secondNorm = Math.sqrt(secondNorm);
  if (!(firstNorm > 0) || !(secondNorm > 0)) return 0;
  const score = dot / (firstNorm * secondNorm);
  return Math.max(-1, Math.min(1, score));
}

// Rank stored records against a query vector. Returns
// {matches:[{todo,score,revision,source_revision}],pending_count,min_score}.
// Ordering: descending score; ties keep created_at/id order (stable sort
// over ordered input). The per-match tokens let callers reject scores
// computed for a stale source (including edit-and-revert, where the title
// matches again but source_revision does not).
export function rankSearch(records, queryVector, { limit = DEFAULT_SEARCH_LIMIT } = {}) {
  const matches = [];
  let pendingCount = 0;
  for (const record of records) {
    if (!embeddingIsUsable(record)) {
      pendingCount += 1;
      continue;
    }
    const score = cosineScore(queryVector, record.embedding);
    if (score >= MIN_SEARCH_SCORE) {
      matches.push({ todo: { ...record.todo }, score, revision: record.revision, source_revision: record.source_revision });
    }
  }
  matches.sort((a, b) => b.score - a.score); // Stable: ties keep input order.
  return { matches: matches.slice(0, limit), pending_count: pendingCount, min_score: MIN_SEARCH_SCORE };
}

// Escape a value as a DuckDB SQL literal. The blocking Wasm bindings used
// by the owning worker do not support bound parameters, so the worker
// inlines values into single statements. Strings double their quotes,
// timestamps travel as ISO strings, and vectors become FLOAT[] literals.
export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StorageError('validation', 'Embedding values must fit float32.');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(sqlLiteral).join(',')}]::FLOAT[]`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

// One UTC timestamp representation with exact microsecond precision.
// Whole milliseconds keep the familiar `.SSS` form; sub-millisecond values
// keep up to six digits with trailing zeros stripped (`.123000Z` and
// `.123Z` are the same instant and must compare, order and reimport
// identically). Raw string comparison cannot order these correctly
// (`.000Z` sorts after `.000001Z` lexicographically), so ordering always
// goes through compareTimestamps and equality through canonicalization.
const ISO_Z_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

// Parse an ISO UTC string into epoch microseconds (bigint), or null when it
// is not a UTC instant we can represent exactly.
export function timestampToMicroseconds(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_Z_PATTERN.exec(value);
  if (!match) return null;
  const epochMs = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
  );
  if (!Number.isFinite(epochMs)) return null;
  const fraction = ((match[7] ?? '') + '000000').slice(0, 6);
  if (!/^\d{6}$/.test(fraction)) return null;
  return BigInt(epochMs) * 1000n + BigInt(fraction);
}

// Render six fraction digits with trailing zeros stripped, keeping at least
// millisecond precision so whole milliseconds stay in `.SSS` form.
function formatFraction(microseconds6) {
  let end = 6;
  while (end > 3 && microseconds6[end - 1] === '0') end -= 1;
  return microseconds6.slice(0, end);
}

export function canonicalizeTimestamp(value) {
  if (typeof value !== 'string') return toIsoTimestamp(value);
  const micros = timestampToMicroseconds(value);
  if (micros === null) {
    // Non-UTC or unusual spellings: fall back to millisecond precision.
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return value;
    return new Date(parsed).toISOString();
  }
  return isoFromMicroseconds(micros);
}

// Chronological ordering for created_at values. Falls back to plain string
// comparison only when a value is not a parseable instant.
export function compareTimestamps(first, second) {
  const firstMicros = timestampToMicroseconds(first);
  const secondMicros = timestampToMicroseconds(second);
  if (firstMicros !== null && secondMicros !== null) {
    if (firstMicros < secondMicros) return -1;
    if (firstMicros > secondMicros) return 1;
    return 0;
  }
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}

// Decode DuckDB-Wasm driver values into repository shapes. TIMESTAMP
// columns arrive as fractional epoch milliseconds (number), microsecond
// epochs (bigint), Dates, or canonical strings; FLOAT[] columns arrive as
// Arrow vectors exposing length/get (or arrays in some builds).
//
// Timestamps are preserved as canonical microsecond strings WITHOUT passing
// through JavaScript Date (which truncates to whole milliseconds): two tasks
// created microseconds apart must keep distinct, correctly ordered
// created_at values across reopen, and their backups must reimport cleanly.
export function toIsoTimestamp(value) {
  if (typeof value === 'string') return canonicalizeTimestamp(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return isoFromMicroseconds(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    const wholeMs = Math.trunc(value);
    const base = new Date(wholeMs).toISOString(); // YYYY-MM-DDTHH:mm:ss.SSSZ
    const subMsMicros = Math.round((value - wholeMs) * 1000);
    let fraction = base.slice(20, 23);
    if (subMsMicros > 0 && subMsMicros < 1000) {
      fraction += String(subMsMicros).padStart(3, '0');
    }
    return `${base.slice(0, 20)}${formatFraction(`${fraction}000000`.slice(0, 6))}Z`;
  }
  return String(value);
}

// Format a microsecond epoch as an ISO string with exact microsecond digits,
// using only integer arithmetic so no precision is lost.
export function isoFromMicroseconds(microseconds) {
  const perSecond = 1000000n;
  let seconds = microseconds / perSecond;
  let remainder = microseconds % perSecond;
  if (remainder < 0n) {
    remainder += perSecond;
    seconds -= 1n;
  }
  const base = new Date(Number(seconds) * 1000).toISOString();
  const ms = remainder / 1000n;
  const sub = remainder % 1000n;
  const fraction = `${String(ms).padStart(3, '0')}${String(sub).padStart(3, '0')}`;
  return `${base.slice(0, 20)}${formatFraction(fraction)}Z`;
}

export function toEmbeddingArray(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return [...value];
  if (typeof value.length === 'number') {
    const out = new Array(value.length);
    for (let index = 0; index < value.length; index++) {
      out[index] = typeof value.get === 'function' ? value.get(index) : value[index];
    }
    return out;
  }
  return Array.from(value);
}

export const MIGRATION_STATEMENTS = Object.freeze([
  'CREATE TABLE IF NOT EXISTS todos (id VARCHAR PRIMARY KEY, title VARCHAR NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT current_timestamp)',
  "ALTER TABLE todos ADD COLUMN IF NOT EXISTS icon VARCHAR DEFAULT 'task'",
  'ALTER TABLE todos ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT false',
  'ALTER TABLE todos ADD COLUMN IF NOT EXISTS embedding FLOAT[]',
  'ALTER TABLE todos ADD COLUMN IF NOT EXISTS embedding_model VARCHAR',
  'ALTER TABLE todos ADD COLUMN IF NOT EXISTS embedding_revision VARCHAR',
  'ALTER TABLE todos ADD COLUMN IF NOT EXISTS embedding_input_version INTEGER',
  'ALTER TABLE todos ADD COLUMN IF NOT EXISTS embedding_dimensions INTEGER',
  'ALTER TABLE todos ADD COLUMN IF NOT EXISTS source_revision VARCHAR',
  'ALTER TABLE todos ADD COLUMN IF NOT EXISTS revision VARCHAR',
  'ALTER TABLE todos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP',
  'CREATE TABLE IF NOT EXISTS operations (operation_id VARCHAR PRIMARY KEY, created_at TIMESTAMP NOT NULL DEFAULT current_timestamp)',
  'ALTER TABLE operations ADD COLUMN IF NOT EXISTS result VARCHAR',
  'CREATE TABLE IF NOT EXISTS meta (key VARCHAR PRIMARY KEY, value VARCHAR)',
]);

// Validate a versioned backup document without mutating anything.
export function validateBackupDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new StorageError('validation', 'Backup is invalid.');
  }
  if (document.format !== BACKUP_FORMAT || document.version !== BACKUP_VERSION) {
    throw new StorageError('validation', 'Backup version is not supported.');
  }
  if (!Array.isArray(document.todos)) throw new StorageError('validation', 'Backup tasks are invalid.');
  const seen = new Set();
  for (const entry of document.todos) {
    if (!entry || typeof entry !== 'object') throw new StorageError('validation', 'Backup task is invalid.');
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new StorageError('validation', 'Backup task id is invalid.');
    }
    if (seen.has(entry.id)) throw new StorageError('validation', 'Backup contains a duplicate task id.');
    seen.add(entry.id);
    // The stored title is the validated value: backups must already carry
    // the canonical trimmed form. Storing entry.title verbatim while
    // validating only its trimmed form would admit over-long raw titles that
    // cannot be indexed and that change on the next seed/migration.
    const canonicalTitle = validateTitle(entry.title);
    if (entry.title !== canonicalTitle) {
      throw new StorageError('validation', 'Backup task title is not in canonical form.');
    }
    validateIcon(entry.icon);
    validateCompleted(entry.completed);
    if (typeof entry.created_at !== 'string' || Number.isNaN(Date.parse(entry.created_at))) {
      throw new StorageError('validation', 'Backup timestamp is invalid.');
    }
    if (entry.embedding !== undefined && entry.embedding !== null) {
      validateEmbeddingVector(entry.embedding, EMBEDDING_METADATA.dimensions);
      validateEmbeddingMetadata({
        model: entry.embedding_model,
        revision: entry.embedding_revision,
        input_version: entry.embedding_input_version,
        dimensions: entry.embedding_dimensions,
      });
    }
  }
  return document;
}

export function newRevision() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `rev-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(36)}`;
}

export function newOperationId() {
  return newRevision();
}
