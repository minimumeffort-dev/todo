// Backup and recovery controls never clear the database or submit task drafts.
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;

export function storageMessage(error) {
  if (error?.code === 'quota') return 'Storage is full. Free space, then retry. Your change is not confirmed.';
  if (error?.code === 'unconfirmed') return 'Save not confirmed. Retry the same change to check it. Your draft is kept.';
  return error?.message || 'Persistent local storage is unavailable. Retry storage.';
}

export function initStoragePanel(options = {}) {
  const root = options.root ?? globalThis.document;
  const byId = id => root?.querySelector?.(`#${id}`);
  const panel = options.panel ?? byId('storage-panel');
  const status = options.status ?? byId('storage-status');
  const error = options.error ?? byId('storage-error');
  const exportButton = options.exportButton ?? byId('backup-export');
  const importButton = options.importButton ?? byId('backup-import');
  const fileInput = options.fileInput ?? byId('backup-file');
  const retryButton = options.retryButton ?? byId('storage-retry');
  const getRepository = options.getRepository;
  let busy = false;
  let destroyed = false;
  let importAttempt = null;
  const listeners = [];
  function on(element, event, handler) {
    element?.addEventListener(event, handler);
    listeners.push(() => element?.removeEventListener(event, handler));
  }
  function setBusy(next) {
    busy = next;
    panel?.setAttribute('aria-busy', String(next));
    for (const control of [exportButton, importButton, retryButton]) if (control) control.disabled = next;
  }
  function setError(exception) {
    if (destroyed) return;
    if (error) { error.textContent = storageMessage(exception); error.hidden = false; }
    if (retryButton) retryButton.hidden = false;
  }
  function clearError() {
    if (error) { error.textContent = ''; error.hidden = true; }
    if (retryButton) retryButton.hidden = true;
  }
  function setReady(result = {}) {
    if (destroyed) return;
    clearError();
    if (status) status.textContent = result.persistence?.granted === false
      ? 'Local storage ready. Storage protection was not granted; export a backup.'
      : 'Local storage ready.';
  }
  function taskBusy() {
    if (!options.isBusy?.()) return false;
    setError(new Error('Finish or retry the current task change before using backups.'));
    return true;
  }
  async function exportTasks() {
    if (busy || destroyed || taskBusy()) return;
    setBusy(true);
    clearError();
    try {
      const store = await getRepository();
      const backup = await store.exportBackup();
      const text = JSON.stringify(backup, null, 2);
      if (options.download) await options.download(text);
      else {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = root.createElement('a');
        link.href = url;
        link.download = 'local-todo-backup.json';
        try { link.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
      }
      if (status) status.textContent = 'Backup exported.';
    } catch (exception) { setError(exception); }
    finally { setBusy(false); }
  }
  async function importFile(file) {
    if (busy || destroyed || taskBusy() || (!file && !importAttempt)) return;
    setBusy(true);
    clearError();
    try {
      if (!importAttempt) {
        if (file.size > MAX_BACKUP_BYTES) throw new Error('Backup is too large (maximum 32 MB).');
        let document;
        try { document = JSON.parse(await file.text()); }
        catch { throw new Error('Choose a valid JSON task backup.'); }
        importAttempt = { document, options: { operationId: crypto.randomUUID() } };
      }
      const store = await getRepository();
      const result = await store.importBackup(importAttempt.document, importAttempt.options);
      importAttempt = null;
      if (fileInput) fileInput.value = '';
      if (importButton) importButton.textContent = 'Import';
      if (status) status.textContent = `Imported ${result.imported} tasks · ${result.skipped} unchanged.`;
      options.onImported?.(result);
    } catch (exception) {
      if (['validation', 'conflict', 'missing'].includes(exception.code) || !importAttempt) {
        importAttempt = null;
        if (fileInput) fileInput.value = '';
      }
      if (importButton) importButton.textContent = importAttempt ? 'Retry import' : 'Import';
      setError(exception);
    } finally { setBusy(false); }
  }
  async function recover() {
    if (busy || destroyed) return;
    setBusy(true);
    try { await options.recover(); clearError(); }
    catch (exception) { setError(exception); }
    finally { setBusy(false); }
  }
  on(exportButton, 'click', exportTasks);
  on(importButton, 'click', () => importAttempt ? importFile() : fileInput?.click());
  on(fileInput, 'change', () => importFile(fileInput.files?.[0]));
  on(retryButton, 'click', recover);
  return {
    setReady, setError, exportTasks, importFile, recover,
    contains: element => panel?.contains(element) ?? false,
    destroy() { destroyed = true; for (const remove of listeners) remove(); },
  };
}
