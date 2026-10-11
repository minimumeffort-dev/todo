// Versioned JSON backup export/import helpers. Pure logic over repository
// records; the store owns atomicity and revision assignment.
import { BACKUP_FORMAT, BACKUP_VERSION, StorageError } from './storage-contract.mjs';
import { canonicalizeTimestamp, validateBackupDocument } from './database-schema.mjs';

export function exportBackupDocument(records) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    todos: records.map((record) => {
      const entry = {
        id: record.todo.id,
        title: record.todo.title,
        icon: record.todo.icon,
        completed: record.todo.completed,
        created_at: record.created_at,
      };
      if (record.embedding !== undefined && record.embedding !== null) {
        entry.embedding = [...record.embedding];
        entry.embedding_model = record.embedding_model;
        entry.embedding_revision = record.embedding_revision;
        entry.embedding_input_version = record.embedding_input_version;
        entry.embedding_dimensions = record.embedding_dimensions;
      }
      return entry;
    }),
  };
}

// Classify a validated backup against current records. Pure: no mutation.
// Returns {missing:[entries], skipped:[ids]} or throws conflict StorageError
// naming the first conflicting id. Identical = same saved fields and same
// embedding payload; anything else on an existing id is a conflict.
export function classifyBackupImport(document, currentById) {
  validateBackupDocument(document);
  const missing = [];
  const skipped = [];
  for (const entry of document.todos) {
    const current = currentById.get(entry.id);
    if (!current) {
      missing.push(entry);
      continue;
    }
    if (backupEntryMatchesRecord(entry, current)) {
      skipped.push(entry.id);
      continue;
    }
    throw new StorageError('conflict', `Backup conflicts with an existing task: ${entry.id}.`);
  }
  return { missing, skipped };
}

function vectorsEqual(first, second) {
  if (first === undefined || first === null) return second === undefined || second === null;
  if (second === undefined || second === null) return false;
  if (first.length !== second.length) return false;
  return first.every((value, index) => Object.is(value, second[index]) || value === second[index]);
}

export function backupEntryMatchesRecord(entry, record) {
  // Timestamps compare in canonical form: `.123000Z` and `.123Z` name the
  // same instant and must round-trip cleanly across database reopens.
  if (entry.title !== record.todo.title || entry.icon !== record.todo.icon
    || entry.completed !== record.todo.completed
    || canonicalizeTimestamp(entry.created_at) !== canonicalizeTimestamp(record.created_at)) {
    return false;
  }
  const entryHas = entry.embedding !== undefined && entry.embedding !== null;
  const recordHas = record.embedding !== undefined && record.embedding !== null;
  if (entryHas !== recordHas) return false;
  if (!entryHas) return true;
  return vectorsEqual(entry.embedding, record.embedding)
    && entry.embedding_model === record.embedding_model
    && entry.embedding_revision === record.embedding_revision
    && entry.embedding_input_version === record.embedding_input_version
    && entry.embedding_dimensions === record.embedding_dimensions;
}
