// Compact model-toolbar wiring for the on-device embedding model.
//
// The toolbar lives inside the task card heading and subscribes to
// modelRuntime snapshots of the shape { phase, progress, message } where
// phase is one of "idle", "loading", "testing", "ready", "unsupported" or
// "error", and progress is null (indeterminate) or a 0..1 fraction.
// Individual embedding operations report through their own promises and
// never publish loading snapshots, so this toolbar only reflects the
// shared model lifecycle. All model feedback stays inside #model-panel;
// task controls and the task status/error elements (#status, #error)
// are never touched.

export const MODEL_LOAD_LABEL = 'Load and test model';

const BUSY_PHASES = new Set(['loading', 'testing']);

export function defaultMessageFor(phase) {
  switch (phase) {
    case 'loading':
      return 'Loading model\u2026';
    case 'testing':
      return 'Testing model\u2026';
    case 'ready':
      return 'Model ready. Sample inference succeeded.';
    case 'unsupported':
      return 'This browser does not support the on-device model (WebGPU unavailable).';
    case 'error':
      return 'Model failed to load.';
    case 'idle':
    default:
      return 'Model not loaded.';
  }
}

function shortLabelFor(phase) {
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
 */
export function renderModelState(elements, snapshot) {
  const { loadButton, progress, statusEl, errorEl } = elements;
  const phase = snapshot && typeof snapshot.phase === 'string' ? snapshot.phase : 'idle';
  const detail = snapshot && typeof snapshot.message === 'string' && snapshot.message
    ? snapshot.message
    : defaultMessageFor(phase);
  const busy = BUSY_PHASES.has(phase);

  if (statusEl) {
    if (phase === 'error' || phase === 'unsupported') {
      statusEl.textContent = shortLabelFor(phase);
    } else if (busy && isFiniteProgress(snapshot && snapshot.progress)) {
      statusEl.textContent = `${detail} ${progressPercent(snapshot.progress)}`;
    } else {
      statusEl.textContent = detail;
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
    if (busy) {
      loadButton.disabled = true;
      loadButton.setAttribute('aria-busy', 'true');
      loadButton.textContent = phase === 'testing' ? 'Testing\u2026' : 'Loading\u2026';
    } else if (phase === 'ready') {
      loadButton.disabled = true;
      loadButton.setAttribute('aria-busy', 'false');
      loadButton.textContent = 'Model ready';
    } else if (phase === 'unsupported') {
      loadButton.disabled = true;
      loadButton.setAttribute('aria-busy', 'false');
      loadButton.textContent = 'Not supported';
    } else if (phase === 'error') {
      loadButton.disabled = false;
      loadButton.setAttribute('aria-busy', 'false');
      loadButton.textContent = 'Retry';
    } else {
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
  };
}

/**
 * Wire the panel to a runtime. Accepts an injected runtime (used by
 * checks with a stub); otherwise lazily imports ./model-runtime.mjs.
 * Importing never starts a download; network activity begins only inside
 * runtime.loadAndTest(), called from the button (explicit activation).
 */
export function initModelPanel(options = {}) {
  const root = options.root || (typeof document !== 'undefined' ? document : null);
  const elements = resolveElements(options, root);
  const { loadButton } = elements;
  let runtime = options.runtime || null;
  let unsubscribe = null;
  let attached = false;

  let snapshot = { phase: 'idle', progress: null, message: '' };

  function handleSnapshot(next) {
    snapshot = next;
    renderModelState(elements, next);
  }

  async function ensureRuntime() {
    if (runtime) return runtime;
    const module = await import('./model-runtime.mjs');
    runtime = module.modelRuntime;
    return runtime;
  }

  async function ensureSubscribed() {
    if (unsubscribe) return true;
    let resolved = null;
    try {
      resolved = await ensureRuntime();
    } catch {
      resolved = null;
    }
    if (!resolved || typeof resolved.subscribe !== 'function') {
      handleSnapshot({ phase: 'error', progress: null, message: 'Model runtime unavailable.' });
      return false;
    }
    unsubscribe = resolved.subscribe(handleSnapshot);
    return true;
  }

  async function activate() {
    const ok = await ensureSubscribed();
    if (!ok) return;
    try {
      await runtime.loadAndTest();
    } catch {
      // Failures are surfaced through the subscription snapshot.
    }
  }

  function destroy() {
    if (loadButton && attached) loadButton.removeEventListener('click', activate);
    attached = false;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  // Eagerly subscribe when a runtime was injected so the panel reflects
  // its current snapshot without waiting for activation. Deferred-import
  // runtimes subscribe on first activation instead, keeping module load
  // free of side effects.
  if (runtime && typeof runtime.subscribe === 'function') {
    unsubscribe = runtime.subscribe(handleSnapshot);
  } else if (root && loadButton) {
    renderModelState(elements, snapshot);
  }

  if (loadButton) {
    loadButton.addEventListener('click', activate);
    attached = true;
  }

  return { activate, destroy, elements };
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
