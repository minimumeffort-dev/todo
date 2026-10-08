import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initModelPanel, defaultMessageFor } from '../app/static/model-panel.mjs';

const readStatic = (name) => readFileSync(new URL(`../app/static/${name}`, import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeElement() {
  const listeners = new Map();
  const classes = new Set();
  const element = {
    textContent: '',
    hidden: false,
    disabled: false,
    attrs: {},
    setAttribute(key, value) { element.attrs[key] = String(value); },
    removeAttribute(key) { delete element.attrs[key]; },
    getAttribute(key) { return element.attrs[key] ?? null; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    listenerCount(type) { return listeners.get(type)?.size ?? 0; },
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); },
    },
  };
  return element;
}

function makeElements() {
  return {
    panel: makeElement(),
    loadButton: makeElement(),
    progress: makeElement(),
    statusEl: makeElement(),
    errorEl: makeElement(),
  };
}

function makeStubRuntime() {
  const listeners = new Set();
  const stub = {
    loadCalls: 0,
    subscribed: 0,
    unsubscribed: 0,
    publish(snapshot) {
      for (const listener of [...listeners]) listener(snapshot);
    },
    subscribe(listener) {
      listeners.add(listener);
      stub.subscribed += 1;
      listener({ phase: 'idle', progress: null, message: '' });
      return () => {
        listeners.delete(listener);
        stub.unsubscribed += 1;
      };
    },
    async loadAndTest() {
      stub.loadCalls += 1;
    },
  };
  return stub;
}

test('lifecycle: panel activates automatically with an injected runtime', async () => {
  const runtime = makeStubRuntime();
  const panel = initModelPanel({ runtime, ...makeElements(), root: null });
  try {
    await tick();
    assert.equal(runtime.loadCalls, 1);
    await tick();
    assert.equal(runtime.loadCalls, 1);
  } finally {
    panel.destroy();
  }
});

test('lifecycle: loading states keep the progress animation and short status', async () => {
  const runtime = makeStubRuntime();
  const elements = makeElements();
  const panel = initModelPanel({ runtime, ...elements, root: null });
  try {
    await tick();
    runtime.publish({ phase: 'loading', progress: 0.25, message: 'Downloading weights' });
    assert.equal(elements.progress.hidden, false);
    assert.equal(elements.progress.getAttribute('value'), '0.25');
    assert.match(elements.statusEl.textContent, /Loading model/);
    assert.equal(elements.loadButton.hidden, true);
    assert.equal(elements.panel.classList.contains('is-busy'), true);
    runtime.publish({ phase: 'testing', progress: null, message: '' });
    assert.equal(elements.statusEl.textContent, defaultMessageFor('testing'));
    assert.equal(elements.progress.hidden, false);
    assert.equal(elements.progress.getAttribute('value'), null);
  } finally {
    panel.destroy();
  }
});

test('lifecycle: readiness is a compact indicator with no retry button', async () => {
  const runtime = makeStubRuntime();
  const elements = makeElements();
  const panel = initModelPanel({ runtime, ...elements, root: null });
  try {
    await tick();
    runtime.publish({ phase: 'ready', progress: 1, message: 'Sample inference succeeded.' });
    assert.equal(elements.statusEl.textContent, 'Model ready.');
    assert.equal(elements.progress.hidden, true);
    assert.equal(elements.errorEl.hidden, true);
    assert.equal(elements.loadButton.hidden, true);
    assert.equal(elements.panel.classList.contains('is-ready'), true);
    assert.equal(elements.panel.classList.contains('is-busy'), false);
  } finally {
    panel.destroy();
  }
});

test('lifecycle: failure shows retry feedback and teardown stops work', async () => {
  const runtime = makeStubRuntime();
  const elements = makeElements();
  const panel = initModelPanel({ runtime, ...elements, root: null });
  try {
    await tick();
    const callsAfterAutoStart = runtime.loadCalls;
    assert.equal(callsAfterAutoStart, 1);
    runtime.publish({ phase: 'error', progress: null, message: 'Check your connection, then retry.' });
    assert.equal(elements.loadButton.hidden, false);
    assert.equal(elements.loadButton.disabled, false);
    assert.equal(elements.loadButton.textContent, 'Retry');
    assert.equal(elements.errorEl.hidden, false);
    assert.equal(elements.errorEl.textContent, 'Check your connection, then retry.');
    elements.loadButton.dispatch('click');
    await tick();
    assert.equal(runtime.loadCalls, callsAfterAutoStart + 1);
    runtime.publish({ phase: 'ready', progress: 1, message: '' });
    assert.equal(elements.loadButton.hidden, true);
    assert.equal(elements.errorEl.hidden, true);
    panel.destroy();
    assert.equal(runtime.unsubscribed, 1);
    elements.loadButton.dispatch('click');
    await panel.activate();
    await tick();
    assert.equal(runtime.loadCalls, callsAfterAutoStart + 1);
  } finally {
    panel.destroy();
  }
});

test('lifecycle: unsupported browsers explain without a working retry', async () => {
  const runtime = makeStubRuntime();
  const elements = makeElements();
  const panel = initModelPanel({ runtime, ...elements, root: null });
  try {
    await tick();
    runtime.publish({ phase: 'unsupported', progress: null, message: 'WebGPU unavailable.' });
    assert.equal(elements.statusEl.textContent, 'Model not supported in this browser.');
    assert.equal(elements.loadButton.hidden, false);
    assert.equal(elements.loadButton.disabled, true);
  } finally {
    panel.destroy();
  }
});

test('markup: model status bar precedes the page heading with accessible search controls', () => {
  const html = readStatic('index.html');
  assert.ok(html.includes('id="model-panel"'), 'model panel exists');
  assert.ok(html.includes('id="model-status" role="status"'), 'model status is announced');
  assert.ok(html.includes('id="model-error" class="error" role="alert"'), 'model errors are announced');
  assert.ok(html.includes('id="model-progress"'), 'loading animation exists');
  const panelAt = html.indexOf('id="model-panel"');
  const mainAt = html.indexOf('<main');
  const headingAt = html.indexOf('<h1>');
  const sectionAt = html.indexOf('<section');
  const sectionEnd = html.indexOf('</section>');
  assert.ok(panelAt !== -1 && mainAt !== -1 && panelAt < mainAt, 'status bar sits above the page content');
  assert.ok(headingAt !== -1 && panelAt < headingAt, 'status bar precedes the heading');
  assert.ok(panelAt !== -1 && sectionAt !== -1 && panelAt < sectionAt, 'indicator is outside the task card');
  assert.ok(sectionEnd > sectionAt && !(panelAt > sectionAt && panelAt < sectionEnd), 'indicator is not nested in the card');
  assert.ok(html.includes('model-statusbar'), 'status bar spans the top of the page');
  assert.ok(html.includes('<label class="sr-only" for="todo-search">Search tasks</label>'), 'search has an accessible label');
  assert.ok(html.includes('id="todo-search" type="search"'), 'search input exists');
  assert.ok(html.includes('id="search-clear"'), 'search clear control exists');
  assert.equal(html.split('id="search-clear"').length - 1, 1, 'the custom clear button is the sole clear control');
  assert.ok(html.includes('aria-label="Clear search"'), 'clear control is labelled');
  assert.ok(html.includes('id="search-status" role="status"'), 'search status is announced');
  assert.ok(html.includes('id="search-explain"'), 'score explanation exists');
  assert.match(html, /higher.*closer meaning.*not confidence/i, 'explanation names meaning, not confidence');
});

test('markup: local-storage footer and model setup copy are removed', () => {
  const html = readStatic('index.html');
  assert.ok(!html.includes('<footer'), 'footer element is removed');
  assert.ok(!html.includes('Stored locally on this computer.'), 'local-storage copy is removed');
  assert.ok(!html.includes('Load and test model'), 'manual load copy is removed');
  assert.ok(!html.includes('Sample inference'), 'setup explanation copy is removed');
});

test('styling: indicator animation, narrow layout, and reduced motion are covered', () => {
  const css = readStatic('styles.css');
  assert.ok(css.includes('.model-indicator'), 'page-level indicator is styled');
  assert.ok(css.includes('.model-statusbar'), 'top status bar is styled');
  assert.match(css, /\.model-statusbar[^}]*position:\s*sticky/, 'status bar stays at the top');
  assert.ok(css.includes('::-webkit-search-cancel-button'), 'native search cancel is suppressed');
  assert.ok(css.includes('::-ms-clear'), 'legacy native clear is suppressed');
  assert.ok(css.includes('.similarity'), 'match scores are styled');
  assert.ok(css.includes('.nonmatch'), 'retained nonmatches are styled');
  assert.ok(css.includes('#search-explain'), 'score explanation is styled');
  assert.ok(css.includes('@keyframes model-pulse'), 'loading animation is defined');
  assert.ok(css.includes('.model-indicator.is-busy'), 'busy state drives the animation');
  assert.ok(css.includes('@media (max-width: 480px)'), 'narrow layout is covered');
  const narrowAt = css.indexOf('@media (max-width: 480px)');
  const narrowBlock = css.slice(narrowAt);
  assert.ok(narrowBlock.includes('.search-row') || narrowBlock.includes('#model-progress'), 'search and indicator adapt to narrow layouts');
  assert.ok(css.includes('prefers-reduced-motion'), 'reduced motion is respected');
  assert.ok(/prefers-reduced-motion[^}]*animation:\s*none/.test(css), 'animation is disabled for reduced motion');
  assert.ok(!/\.model-toolbar/.test(css), 'card toolbar styles are removed');
  assert.ok(!/footer\s*\{/.test(css), 'footer styles are removed');
  assert.ok(css.includes('.search-row') && css.includes('#todo-search'), 'search controls are styled');
});
