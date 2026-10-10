// Compact page-level indicator for the on-device embedding model.
//
// The panel lives outside the task card and loads the model automatically
// once during page initialization: importing this module never starts a
// download, but initializing the panel does (a single loadAndTest call).
// It subscribes to modelRuntime snapshots of the shape
// { phase, progress, message } where phase is one of "idle", "loading",
// "testing", "ready", "unsupported" or "error", and progress is null
// (indeterminate) or a 0..1 fraction. Individual embedding operations
// report through their own promises and never publish loading snapshots,
// so this indicator only reflects the shared model lifecycle. All model
// feedback stays inside #model-panel; task controls and the task
// status/error elements (#status, #error) are never touched. Search and
// embedding backfill orchestration live in app.js, which subscribes to the
// same runtime independently.

export const MODEL_LOAD_LABEL = 'Load and test model';

const BUSY_PHASES = new Set(['loading', 'testing']);

export function defaultMessageFor(phase) {
  switch (phase) {
    case 'loading':
      return 'Loading model\u2026';
    case 'testing':
      return 'Testing model\u2026';
    case 'ready':
      return 'Model ready.';
    case 'unsupported':
      return 'Model not supported in this browser.';
    case 'error':
      return 'Model failed to load.';
    case 'idle':
    default:
      return 'Model not loaded.';
  }
}

function isFiniteProgress(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function progressPercent(progress) {
  const clamped = Math.min(1, Math.max(0, progress));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * Render a runtime snapshot into the panel elements. Pure (no imports,
 * no network): suitable for exercising every phase with a stub runtime.
 * The retry button is only shown when it can do something (failure states);
 * automatic loading covers every other phase, keeping the indicator to a
 * short status line plus the progress animation while busy.
 */
export function renderModelState(elements, snapshot) {
  const { panel, loadButton, progress, statusEl, errorEl } = elements;
  const phase = snapshot && typeof snapshot.phase === 'string' ? snapshot.phase : 'idle';
  const detail = snapshot && typeof snapshot.message === 'string' && snapshot.message
    ? snapshot.message
    : defaultMessageFor(phase);
  const busy = BUSY_PHASES.has(phase);

  if (panel && panel.classList) {
    panel.classList.toggle('is-busy', busy);
    panel.classList.toggle('is-ready', phase === 'ready');
  }

  if (statusEl) {
    if (phase === 'error' || phase === 'unsupported') {
      statusEl.textContent = defaultMessageFor(phase);
    } else if (busy && isFiniteProgress(snapshot && snapshot.progress)) {
      statusEl.textContent = `Loading model\u2026 ${progressPercent(snapshot.progress)}`;
    } else {
      statusEl.textContent = defaultMessageFor(phase);
    }
  }

  if (progress) {
    progress.hidden = !busy;
    if (busy) {
      if (isFiniteProgress(snapshot && snapshot.progress)) {
        progress.setAttribute('value', String(Math.min(1, Math.max(0, snapshot.progress))));
      } else {
        progress.removeAttribute('value');
      }
    } else {
      progress.removeAttribute('value');
    }
  }

  if (errorEl) {
    const showError = phase === 'error' || phase === 'unsupported';
    errorEl.textContent = showError ? detail : '';
    errorEl.hidden = !showError;
  }

  if (loadButton) {
    if (phase === 'error') {
      loadButton.hidden = false;
      loadButton.disabled = false;
      loadButton.setAttribute('aria-busy', 'false');
      loadButton.textContent = 'Retry';
    } else if (phase === 'unsupported') {
      loadButton.hidden = false;
      loadButton.disabled = true;
      loadButton.setAttribute('aria-busy', 'false');
      loadButton.textContent = 'Not supported';
    } else if (busy) {
      loadButton.hidden = true;
      loadButton.disabled = true;
      loadButton.setAttribute('aria-busy', 'true');
      loadButton.textContent = phase === 'testing' ? 'Testing\u2026' : 'Loading\u2026';
    } else if (phase === 'ready') {
      loadButton.hidden = true;
      loadButton.disabled = true;
      loadButton.setAttribute('aria-busy', 'false');
      loadButton.textContent = 'Model ready';
    } else {
      loadButton.hidden = true;
      loadButton.disabled = false;
      loadButton.setAttribute('aria-busy', 'false');
      loadButton.textContent = MODEL_LOAD_LABEL;
    }
  }
}

function resolveElements(options, root) {
  const byId = (id) => root && root.getElementById ? root.getElementById(id) : null;
  const panel = options.panel || byId('model-panel');
  const scoped = (id) => {
    if (panel && panel.querySelector) {
      const found = panel.querySelector(`#${id}`);
      if (found) return found;
    }
    return byId(id);
  };
  return {
    panel,
    loadButton: options.loadButton || scoped('model-load'),
    progress: options.progress || scoped('model-progress'),
    statusEl: options.statusEl || scoped('model-status'),
    errorEl: options.errorEl || scoped('model-error'),
    cacheButton: options.cacheButton || scoped('model-cache-clear'),
    offlineStatus: options.offlineStatus || scoped('offline-status'),
    offlineError: options.offlineError || scoped('offline-error'),
    offlineRetry: options.offlineRetry || scoped('offline-retry'),
  };
}

/**
 * Wire the panel to a runtime. Accepts an injected runtime (used by
 * checks with a stub); otherwise lazily imports ./model-runtime.mjs.
 * Initialization starts one automatic loadAndTest; the button only
 * reappears to retry after a failure. subscribe/loadAndTest behavior of
 * the runtime is unchanged.
 */
export function initModelPanel(options = {}) {
  const root = options.root || (typeof document !== 'undefined' ? document : null);
  const elements = resolveElements(options, root);
  const { loadButton } = elements;
  let runtime = options.runtime || null;
  let unsubscribe = null;
  let attached = false;
  let destroyed = false;
  let autoStarted = false;
  let offlineRuntime = options.offlineRuntime || null;
  let offlineUnsubscribe = null;

  let snapshot = { phase: 'idle', progress: null, message: '' };

  function handleSnapshot(next) {
    snapshot = next;
    renderModelState(elements, next);
    if (elements.cacheButton) elements.cacheButton.hidden = next.phase !== 'error' || typeof runtime?.clearCache !== 'function';
  }

  async function ensureRuntime() {
    if (runtime) return runtime;
    const module = await import('./model-runtime.mjs');
    runtime = module.modelRuntime;
    return runtime;
  }

  async function ensureSubscribed() {
    if (unsubscribe) return true;
    if (destroyed) return false;
    let resolved = null;
    try {
      resolved = await ensureRuntime();
    } catch {
      resolved = null;
    }
    if (destroyed) return false;
    if (!resolved || typeof resolved.subscribe !== 'function') {
      handleSnapshot({ phase: 'error', progress: null, message: 'Model runtime unavailable.' });
      return false;
    }
    unsubscribe = resolved.subscribe(handleSnapshot);
    return true;
  }

  async function activate() {
    if (destroyed) return;
    const ok = await ensureSubscribed();
    if (!ok || destroyed) return;
    try {
      await runtime.loadAndTest();
    } catch {
      // Failures are surfaced through the subscription snapshot.
    }
  }

  async function clearModelCache() {
    if (destroyed || !runtime?.clearCache) return;
    if (elements.cacheButton) elements.cacheButton.disabled = true;
    try { await runtime.clearCache(); await activate(); }
    catch (error) { handleSnapshot({ phase:'error', message:error.message }); }
    finally { if (elements.cacheButton) elements.cacheButton.disabled = false; }
  }

  function renderOffline(next) {
    if (destroyed) return;
    if (elements.offlineStatus) elements.offlineStatus.textContent = next.phase === 'ready' ? 'App cached.'
      : next.phase === 'caching' ? 'Caching app…' : '';
    const failed = next.phase === 'error' || next.phase === 'unsupported';
    if (elements.offlineError) {
      elements.offlineError.hidden = !failed;
      elements.offlineError.textContent = failed ? next.message || 'App cache unavailable.' : '';
    }
    if (elements.offlineRetry) {
      elements.offlineRetry.hidden = !failed;
      elements.offlineRetry.disabled = next.phase === 'unsupported';
    }
  }

  async function initializeOffline() {
    try {
      if (!offlineRuntime) offlineRuntime = (await import('./offline.mjs')).offlineRuntime;
      if (destroyed) return;
      offlineUnsubscribe = offlineRuntime.subscribe(renderOffline);
      await offlineRuntime.initialize();
    } catch (error) { renderOffline({ phase:'error', message:error.message || 'App cache unavailable.' }); }
  }

  async function retryOffline() {
    if (destroyed) return;
    try {
      if (offlineRuntime) await offlineRuntime.recover();
      else await initializeOffline();
    } catch (error) { renderOffline({ phase:'error', message:error.message }); }
  }

  function autoStart() {
    if (autoStarted) return;
    autoStarted = true;
    void activate();
  }

  function destroy() {
    destroyed = true;
    if (loadButton && attached) loadButton.removeEventListener('click', activate);
    attached = false;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    offlineUnsubscribe?.();
    elements.offlineRetry?.removeEventListener('click', retryOffline);
    elements.cacheButton?.removeEventListener('click', clearModelCache);
  }

  // Eagerly subscribe when a runtime was injected so the panel reflects
  // its current snapshot without waiting for activation.
  if (runtime && typeof runtime.subscribe === 'function') {
    unsubscribe = runtime.subscribe(handleSnapshot);
  } else if (root && loadButton) {
    renderModelState(elements, snapshot);
  }

  if (loadButton) {
    loadButton.addEventListener('click', activate);
    attached = true;
  }

  // Load automatically once during page initialization; the retry button
  // remains for failures.
  autoStart();
  elements.cacheButton?.addEventListener('click', clearModelCache);
  elements.offlineRetry?.addEventListener('click', retryOffline);
  if (offlineRuntime || elements.offlineStatus) void initializeOffline();

  return { activate, destroy, elements, clearModelCache, retryOffline };
}

// Self-initialize in the browser only; Node-based checks import the
// functions above without touching the DOM.
if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
  try {
    if (document.getElementById('model-panel')) initModelPanel();
  } catch {
    // Panel errors must never break task controls.
  }
}
