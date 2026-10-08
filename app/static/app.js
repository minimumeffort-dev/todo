const form = document.querySelector('#todo-form');
const input = document.querySelector('#todo-title');
const addButton = document.querySelector('#add-button');
const newTask = document.querySelector('#new-task');
const cancelAdd = document.querySelector('#cancel-add');
const refreshButton = document.querySelector('#refresh-button');
const list = document.querySelector('#todo-list');
const count = document.querySelector('#count');
const status = document.querySelector('#status');
const error = document.querySelector('#error');
const searchInput = document.querySelector('#todo-search');
const searchClear = document.querySelector('#search-clear');
const searchStatus = document.querySelector('#search-status');
const searchExplain = document.querySelector('#search-explain');
// Keep controls available on touch devices even when a keyboard or mouse is used.
document.documentElement.classList.toggle('touch-device', navigator.maxTouchPoints > 0);
const icons = {
  task: ['✓', 'Task'], star: ['★', 'Star'], home: ['⌂', 'Home'],
  work: ['▣', 'Work'], shopping: ['🛒', 'Shopping'], heart: ['♥', 'Heart'],
};
const rows = new Map();
let adding = false;
let loading = false;
let revision = 0;
let composerIcon = 'task';
let composerComposing = false;
let openPicker = null;
let pickerSequence = 0;
let modelReady = false;
let modelRuntime = null;
let modelPhase = 'idle';
let sourceEpoch = 0;
let normalOrder = [];
const embeddingJobs = new Map();
let backfillRequested = false;
let scanningBackfill = false;
let pumpingBackfill = false;
let searchSequence = 0;
let searchTimer = null;
let searchMatches = null;
const searchScores = new Map();
let queryEmbedding = null;
let arrangingRows = false;
// The page-level model panel owns activation; share its resident runtime.
import('/static/model-runtime.mjs').then(module => {
  modelRuntime = module.modelRuntime;
  modelRuntime.subscribe(snapshot => {
    const wasReady = modelReady;
    modelPhase = snapshot.phase;
    modelReady = snapshot.phase === 'ready';
    if (modelReady && !wasReady) requestBackfill();
    scheduleSearch(0);
  });
}).catch(() => {
  modelPhase = 'error';
  scheduleSearch(0);
});

function button(className, label) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  return element;
}
function showError(message = '') {
  error.textContent = message;
  error.hidden = !message;
}
async function request(url, options = {}) {
  let response;
  try { response = await fetch(url, options); }
  catch { throw new Error('Could not reach the local app. Try again.'); }
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).detail; } catch { /* Fall back to status. */ }
    const exception = new Error(typeof detail === 'string' ? detail : `Request failed (${response.status}). Please try again.`);
    exception.status = response.status;
    throw exception;
  }
  return response.status === 204 ? null : response.json();
}
function updateRefresh() {
  refreshButton.disabled = loading || adding || [...rows.values()].some(state => state.pending);
}
function updateCount() {
  count.textContent = rows.size;
  status.textContent = 'Your list is clear. Add a task to get started.';
  status.hidden = rows.size > 0;
}

function sameSource(first, second) {
  return first.title === second.title && first.icon === second.icon;
}
function embeddingIsCurrent(job) {
  return embeddingJobs.get(job.id) === job;
}
function renderJob(job) {
  const state = rows.get(job.id);
  if (state) {
    state.embedding = embeddingJobs.get(job.id) ?? null;
    state.renderEmbedding();
    // Embedding protection (a pending retry or a new failure) changes search
    // visibility: surface newly protected rows and hide settled ones without
    // waiting for the next keystroke. Retained rows stay unscored nonmatches.
    if (searchMatches !== null) applySearchView();
  }
}
function invalidateEmbedding(state, confirmed) {
  const job = embeddingJobs.get(state.item.id);
  if (job && (!confirmed || !sameSource(job.snapshot, confirmed))) {
    embeddingJobs.delete(job.id);
    state.embedding = null;
    state.renderEmbedding();
  }
}
async function processTask(job) {
  if (!embeddingIsCurrent(job) || job.pending) return;
  job.pending = true;
  job.error = false;
  renderJob(job);
  try {
    // A persistence retry reuses the successful vector; it never recreates the task.
    if (!job.result) job.result = await modelRuntime.embedTask(job.snapshot);
    if (!embeddingIsCurrent(job)) return;
    await request(`/api/todos/${encodeURIComponent(job.id)}/embedding`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job.result),
    });
    if (embeddingIsCurrent(job)) {
      ++sourceEpoch;
      embeddingJobs.delete(job.id);
      scheduleSearch();
    }
  } catch (exception) {
    if (!embeddingIsCurrent(job)) return;
    // A source changed in another tab or a deletion is final for this snapshot.
    if (exception.status === 404 || exception.status === 409 || exception.name === 'AbortError') {
      embeddingJobs.delete(job.id);
      if (exception.status === 404 || exception.status === 409) {
        void loadItems();
        requestBackfill();
      }
    } else job.error = true;
  } finally {
    job.pending = false;
    renderJob(job);
  }
}
async function pumpBackfill() {
  if (pumpingBackfill || !modelReady) return;
  pumpingBackfill = true;
  try {
    // Submit one background inference at a time, allowing query requests to
    // interleave instead of filling the worker's queue with the entire list.
    while (modelReady) {
      const job = [...embeddingJobs.values()].find(candidate => !candidate.pending && !candidate.error);
      if (!job) break;
      await processTask(job);
    }
  } finally { pumpingBackfill = false; }
}
async function requestBackfill() {
  if (!modelReady || !modelRuntime) return;
  backfillRequested = true;
  if (scanningBackfill) return;
  scanningBackfill = true;
  try {
    while (backfillRequested && modelReady) {
      backfillRequested = false;
      const epoch = sourceEpoch;
      const pending = await request('/api/todos/embeddings/pending');
      if (epoch !== sourceEpoch) { backfillRequested = true; continue; }
      const byId = new Map(pending.map(item => [item.id, item]));
      for (const [id, job] of embeddingJobs) {
        if (!byId.has(id) || !sameSource(job.snapshot, byId.get(id))) {
          embeddingJobs.delete(id);
          renderJob(job);
        }
      }
      for (const item of pending) {
        let job = embeddingJobs.get(item.id);
        if (!job) {
          job = { id: item.id, snapshot: { title: item.title, icon: item.icon },
            result: null, pending: false, error: false };
          embeddingJobs.set(item.id, job);
        } else job.error = false;
        renderJob(job);
      }
      void pumpBackfill();
    }
  } catch {
    if (searchInput?.value.trim()) setSearchStatus('Could not check search indexing. Try Refresh.');
  } finally { scanningBackfill = false; }
}

function setSearchStatus(message = '') {
  if (!searchStatus) return;
  searchStatus.textContent = message;
  searchStatus.hidden = !message;
}
function formatSimilarity(score) {
  return `Similarity ${Number(score).toFixed(2)}`;
}
// The static #search-explain copy is the fallback. Each successful response
// may carry the server-owned cutoff (min_score); render it verbatim so the
// guidance always explains the cutoff that actually filtered these results
// instead of a value hard-coded in the page.
const defaultSearchGuidance = searchExplain?.textContent ?? '';
function renderSearchGuidance(minScore) {
  if (!searchExplain) return;
  searchExplain.textContent = Number.isFinite(minScore)
    ? `Only tasks scoring at least ${Number(minScore).toFixed(2)} are shown. ${defaultSearchGuidance}`
    : defaultSearchGuidance;
}
function clearSearchScores() {
  searchScores.clear();
  if (searchExplain) {
    searchExplain.textContent = defaultSearchGuidance;
    searchExplain.hidden = true;
  }
}
function applySearchView() {
  const active = Boolean(searchInput?.value.trim()) && searchMatches !== null;
  const matches = new Set(searchMatches ?? []);
  const pinned = state => state.editing || state.pending || state.hasError || state.embedding?.error
    || state.embedding?.pending
    || !sameSource(state.draft, state.item) || state.row.contains(document.activeElement);
  for (const [id, state] of rows) {
    const matched = matches.has(id);
    state.row.hidden = active && !matched && !pinned(state);
    if (state.renderSearch) state.renderSearch({ active, matched, score: searchScores.get(id) });
  }
  const order = active ? [...searchMatches, ...normalOrder.filter(id => !matches.has(id))] : normalOrder;
  const focused = document.activeElement;
  const selection = focused?.classList?.contains('task-editor')
    ? [focused.selectionStart, focused.selectionEnd] : null;
  // Moving a focused row can dispatch focusout. Keep that internal DOM move
  // from submitting its draft, and restore the editor's selection afterwards.
  arrangingRows = true;
  try {
    let previous = null;
    for (const id of order) {
      const row = rows.get(id)?.row;
      if (!row) continue;
      const expected = previous ? previous.nextElementSibling : list.firstElementChild;
      if (row !== expected) list.insertBefore(row, expected);
      previous = row;
    }
    if (focused && document.activeElement !== focused && list.contains(focused)) {
      focused.focus();
      if (selection) focused.setSelectionRange(...selection);
    }
  } finally { arrangingRows = false; }
}
function scheduleSearch(delay = 250) {
  const sequence = ++searchSequence;
  clearTimeout(searchTimer);
  const query = searchInput?.value.trim() ?? '';
  if (searchClear) searchClear.hidden = !searchInput.value;
  if (!query) {
    searchMatches = null;
    queryEmbedding = null;
    clearSearchScores();
    setSearchStatus();
    applySearchView();
    return;
  }
  if ([...query].length > 500) { setSearchStatus('Use a search query with 1–500 characters.'); return; }
  if (!modelReady) {
    setSearchStatus(['error', 'unsupported'].includes(modelPhase)
      ? 'Search unavailable. Retry the model.' : 'Waiting for the model…');
    return;
  }
  setSearchStatus('Searching…');
  searchTimer = setTimeout(() => { void runSearch(query, sequence); }, delay);
}
async function runSearch(query, sequence) {
  try {
    let result = queryEmbedding?.query === query ? queryEmbedding.result : null;
    if (!result) result = await modelRuntime.embedQuery(query);
    if (sequence !== searchSequence) return;
    queryEmbedding = { query, result };
    const response = await request('/api/todos/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result),
    });
    if (sequence !== searchSequence) return;
    const resync = response.matches.some(match => {
      const state = rows.get(match.todo.id);
      return state && !sameSource(state.item, match.todo);
    });
    if (resync) {
      // A saved source changed elsewhere (for example in another tab). Never
      // label the stale title with the new score: drop obsolete scores,
      // refresh the list while preserving drafts and focus, then rerun this
      // query once the list is current.
      searchMatches = null;
      searchScores.clear();
      if (searchExplain) searchExplain.hidden = true;
      applySearchView();
      setSearchStatus('Searching…');
      void resyncSources(query, sequence);
      return;
    }
    searchMatches = response.matches.map(match => match.todo.id).filter(id => rows.has(id));
    searchScores.clear();
    for (const match of response.matches) {
      if (rows.has(match.todo.id) && Number.isFinite(match.score)) searchScores.set(match.todo.id, match.score);
    }
    applySearchView();
    renderSearchGuidance(response.min_score);
    if (searchExplain) searchExplain.hidden = searchMatches.length === 0;
    const found = searchMatches.length;
    const summary = found ? `${found} results` : 'No matching tasks';
    setSearchStatus(response.pending_count > 0 ? `${summary} · ${response.pending_count} tasks still being indexed` : summary);
  } catch (exception) {
    if (sequence === searchSequence) setSearchStatus(exception.message);
  }
}
// Reconcile cross-tab source changes for a search whose response no longer
// matches the displayed rows. A refresh discarded by concurrent edits (or
// skipped while busy) schedules no rerun itself, so retry while this query is
// still current. Refreshing preserves drafts and focus inside loadItems, and
// the rerun goes through scheduleSearch, keeping stale-response guards.
async function resyncSources(query, sequence) {
  for (;;) {
    if (sequence !== searchSequence) return;
    if ((searchInput?.value.trim() ?? '') !== query) return;
    if (await loadItems()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}
function tasksChanging() {
  ++sourceEpoch;
  ++searchSequence;
  clearTimeout(searchTimer);
}
function tasksChanged({ backfill = false } = {}) {
  ++sourceEpoch;
  searchMatches = null;
  clearSearchScores();
  applySearchView();
  scheduleSearch();
  if (backfill) requestBackfill();
}

// A small, keyboard-accessible picker shared by rows and the composer.
function makeIconControl(container, selected, label, onSelect) {
  const trigger = button('icon-button', '');
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  const picker = document.createElement('div');
  picker.className = 'icon-picker';
  picker.id = `icon-picker-${++pickerSequence}`;
  picker.hidden = true;
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', 'Choose an icon');
  trigger.setAttribute('aria-controls', picker.id);
  const heading = document.createElement('p');
  heading.className = 'picker-label';
  heading.textContent = 'Choose an icon';
  const options = document.createElement('div');
  options.className = 'picker-options';
  const choices = [];
  let value = selected;
  function close(restoreFocus = false) {
    picker.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (openPicker === control) openPicker = null;
    if (restoreFocus) trigger.focus();
  }
  function update(next, accessibleLabel = label) {
    value = next;
    trigger.textContent = icons[next][0];
    trigger.setAttribute('aria-label', `${accessibleLabel}, ${icons[next][1]} icon`);
    for (const choice of choices) choice.setAttribute('aria-pressed', String(choice.dataset.icon === next));
  }
  for (const [key, [symbol, name]] of Object.entries(icons)) {
    const choice = button('icon-option', '');
    choice.dataset.icon = key;
    choice.setAttribute('aria-label', name);
    const glyph = document.createElement('span');
    glyph.className = 'option-symbol';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = symbol;
    choice.append(glyph, document.createTextNode(name));
    choice.addEventListener('click', () => {
      close(true);
      update(key);
      onSelect(key);
    });
    choices.push(choice);
    options.append(choice);
  }
  const control = { trigger, picker, close, update, container };
  update(value);
  trigger.addEventListener('click', () => {
    if (!picker.hidden) { close(true); return; }
    openPicker?.close();
    openPicker = control;
    picker.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    choices.find(choice => choice.dataset.icon === value).focus();
  });
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    const directions = { ArrowRight: 1, ArrowDown: 2, ArrowLeft: -1, ArrowUp: -2 };
    const index = choices.indexOf(document.activeElement);
    if (index < 0) return;
    if (event.key in directions || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
        : (index + directions[event.key] + choices.length) % choices.length;
      choices[next].focus();
    }
  });
  container.addEventListener('focusout', event => {
    if (!container.contains(event.relatedTarget)) close();
  });
  picker.append(heading, options);
  container.append(trigger, picker);
  return control;
}
document.addEventListener('pointerdown', event => {
  if (openPicker && !openPicker.container.contains(event.target)) openPicker.close();
});

function makeRow(item) {
  const row = document.createElement('li');
  row.className = 'task-row';
  row.dataset.id = item.id;
  const completionControl = document.createElement('label');
  completionControl.className = 'completion-control';
  const completion = document.createElement('input');
  completion.type = 'checkbox';
  completion.className = 'task-completion';
  const completionLabel = document.createElement('span');
  completionLabel.className = 'sr-only';
  completionControl.append(completion, completionLabel);
  const iconContainer = document.createElement('div');
  iconContainer.className = 'icon-control';
  const content = document.createElement('div');
  content.className = 'title-content';
  const title = button('task-title', item.title);
  const editor = document.createElement('input');
  editor.className = 'inline-editor task-editor';
  editor.maxLength = 500;
  editor.autocomplete = 'off';
  editor.hidden = true;
  editor.setAttribute('aria-label', 'Task title');
  const remove = button('quiet-button remove', '×');
  const feedback = document.createElement('div');
  feedback.className = 'row-feedback';
  feedback.hidden = true;
  const message = document.createElement('p');
  message.className = 'error';
  message.id = `row-error-${item.id}`;
  message.setAttribute('role', 'alert');
  const retry = button('retry', 'Retry');
  const rowStatus = document.createElement('p');
  rowStatus.className = 'row-status';
  rowStatus.setAttribute('role', 'status');
  rowStatus.hidden = true;
  const embeddingStatus = document.createElement('p');
  embeddingStatus.className = 'row-status embedding-status';
  embeddingStatus.setAttribute('role', 'status');
  embeddingStatus.hidden = true;
  const embeddingFeedback = document.createElement('div');
  embeddingFeedback.className = 'row-feedback embedding-feedback';
  embeddingFeedback.hidden = true;
  const embeddingMessage = document.createElement('p');
  embeddingMessage.className = 'error';
  embeddingMessage.setAttribute('role', 'alert');
  const embeddingRetry = button('retry embedding-retry', 'Retry');
  const similarity = document.createElement('p');
  similarity.className = 'row-status similarity';
  similarity.setAttribute('role', 'status');
  similarity.hidden = true;
  const nonmatch = document.createElement('p');
  nonmatch.className = 'row-status nonmatch';
  nonmatch.textContent = 'Not a search match';
  nonmatch.hidden = true;
  editor.setAttribute('aria-describedby', `edit-help ${message.id}`);
  title.setAttribute('aria-describedby', 'edit-help');
  completion.setAttribute('aria-describedby', message.id);
  const state = { row, title, editor, completion, remove, item, draft: { title: item.title, icon: item.icon },
    editing: false, composing: false, pending: false, removingIntent: false,
    failedAction: 'save', failedCompletion: null, embedding: embeddingJobs.get(item.id) ?? null,
    hasError: false };
  rows.set(item.id, state);
  normalOrder.push(item.id);
  state.renderEmbedding = () => {
    const job = state.embedding;
    const retryFocused = document.activeElement === embeddingRetry;
    embeddingStatus.textContent = job?.pending ? 'Processing…' : '';
    embeddingStatus.hidden = !job?.pending;
    embeddingFeedback.hidden = !job?.error;
    embeddingMessage.textContent = job?.error ? 'Task saved. Processing failed.' : '';
    embeddingRetry.disabled = Boolean(job?.pending);
    embeddingRetry.setAttribute('aria-label', `Retry processing ${state.item.title}`);
    if (retryFocused && embeddingFeedback.hidden) {
      (state.editing ? editor : title).focus();
    }
  };
  state.renderSearch = ({ active, matched, score }) => {
    const showScore = Boolean(active && matched) && Number.isFinite(score);
    similarity.textContent = showScore ? formatSimilarity(score) : '';
    similarity.hidden = !showScore;
    nonmatch.hidden = !(active && !matched);
  };
  embeddingRetry.addEventListener('click', () => {
    const job = embeddingJobs.get(item.id);
    if (!job || job.pending) return;
    job.error = false;
    if (job.result) void processTask(job);
    else if (modelReady) void pumpBackfill();
    else { job.error = true; state.renderEmbedding(); }
  });
  const icon = makeIconControl(iconContainer, item.icon, `Icon for ${item.title}`, value => {
    state.draft.icon = value;
    revision++;
    save();
  });
  state.icon = icon;
  function labels() {
    completion.checked = state.item.completed;
    completionLabel.textContent = `Completed: ${state.item.title}`;
    row.classList.toggle('is-completed', state.item.completed);
    title.textContent = state.item.title;
    title.setAttribute('aria-label', `Edit ${state.item.title}`);
    remove.setAttribute('aria-label', `Remove ${state.item.title}`);
    const retryAction = state.failedAction === 'remove' ? 'removing'
      : state.failedAction === 'complete' ? (state.failedCompletion ? 'completing' : 'reopening') : 'saving';
    retry.setAttribute('aria-label', `Retry ${retryAction} ${state.item.title}`);
    icon.update(state.draft.icon, `Icon for ${state.item.title}`);
  }
  state.sync = () => {
    if (editor.value !== state.draft.title) editor.value = state.draft.title;
    labels();
  };
  function rowError(text = '', action = 'save') {
    state.hasError = Boolean(text);
    state.failedAction = action;
    message.textContent = text;
    feedback.hidden = !text;
    editor.setAttribute('aria-invalid', String(Boolean(text) && action === 'save'));
    labels();
  }
  function pending(action, completed) {
    state.pending = action;
    row.setAttribute('aria-busy', String(Boolean(action)));
    editor.readOnly = Boolean(action);
    title.disabled = Boolean(action);
    completion.disabled = Boolean(action);
    icon.trigger.disabled = Boolean(action);
    remove.disabled = Boolean(action);
    retry.disabled = Boolean(action);
    rowStatus.textContent = action === 'remove' ? 'Removing…'
      : action === 'complete' ? (completed ? 'Marking done…' : 'Reopening…') : 'Saving…';
    rowStatus.hidden = !action;
    updateRefresh();
  }
  function finishEditing(restoreFocus = false) {
    state.editing = false;
    editor.hidden = true;
    title.hidden = false;
    if (restoreFocus) title.focus();
  }
  function startEditing() {
    if (state.pending) return;
    editor.value = state.draft.title;
    title.hidden = true;
    editor.hidden = false;
    editor.focus();
    // Hiding the focused title can fire focusout before the editor receives focus.
    state.editing = true;
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }
  async function save() {
    if (state.pending || state.composing) return;
    const draft = { title: state.draft.title.trim(), icon: state.draft.icon };
    if (!draft.title || draft.title.length > 500) {
      rowError('Use a title with 1–500 characters.');
      return;
    }
    if (draft.title === state.item.title && draft.icon === state.item.icon) {
      state.draft = { title: state.item.title, icon: state.item.icon };
      rowError();
      finishEditing(document.activeElement === editor);
      return;
    }
    const focusedControl = document.activeElement;
    pending('save');
    icon.close();
    revision++;
    tasksChanging();
    rowError();
    try {
      const updated = await request(`/api/todos/${encodeURIComponent(item.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
      });
      invalidateEmbedding(state, updated);
      state.item = updated;
      state.draft = { title: updated.title, icon: updated.icon };
      state.sync();
      // Restore focus only if the user has stayed in this editor.
      const restoreFocus = document.activeElement === editor;
      pending(false);
      finishEditing(restoreFocus);
      tasksChanged({ backfill: true });
    } catch (exception) { rowError(exception.message); }
    finally {
      pending(false);
      scheduleSearch();
      if (document.activeElement === document.body && [icon.trigger, retry].includes(focusedControl)) {
        (focusedControl === retry && feedback.hidden ? title : focusedControl).focus();
      }
    }
  }
  async function setCompleted(desired) {
    if (state.pending) return;
    const focusedControl = document.activeElement;
    pending('complete', desired);
    icon.close();
    revision++;
    tasksChanging();
    rowError();
    completion.checked = desired;
    try {
      const updated = await request(`/api/todos/${encodeURIComponent(item.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: desired }),
      });
      invalidateEmbedding(state, updated);
      state.item = updated;
      // Completion changes the saved item without submitting or discarding drafts.
      labels();
      tasksChanged();
    } catch (exception) {
      state.failedCompletion = desired;
      rowError(exception.message, 'complete');
    } finally {
      pending(false);
      scheduleSearch();
      if (document.activeElement === document.body && [completion, retry].includes(focusedControl)) {
        (focusedControl === retry && feedback.hidden ? completion : focusedControl).focus();
      }
    }
  }
  async function removeItem() {
    if (state.pending) return;
    const hadFocus = row.contains(document.activeElement) || state.removingHadFocus;
    pending('remove');
    icon.close();
    revision++;
    tasksChanging();
    rowError();
    try {
      await request(`/api/todos/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      // Focus must land on a visible row: filtered-out matches are hidden and
      // cannot receive focus. Scan outward from the removed row instead of
      // only checking its immediate neighbours.
      const eligible = candidate => Boolean(candidate) && !candidate.row.hidden
        && (!candidate.pending || (candidate.editing && candidate.pending === 'save'));
      let adjacent = null;
      for (let element = row.nextElementSibling; element && !adjacent; element = element.nextElementSibling) {
        const candidate = rows.get(element.dataset.id);
        if (eligible(candidate)) adjacent = candidate;
      }
      for (let element = row.previousElementSibling; element && !adjacent; element = element.previousElementSibling) {
        const candidate = rows.get(element.dataset.id);
        if (eligible(candidate)) adjacent = candidate;
      }
      const restoreFocus = hadFocus && (row.contains(document.activeElement) || document.activeElement === document.body);
      invalidateEmbedding(state, null);
      rows.delete(item.id);
      normalOrder = normalOrder.filter(id => id !== item.id);
      row.remove();
      updateCount();
      if (restoreFocus) {
        if (adjacent) (adjacent.editing ? adjacent.editor : adjacent.title).focus();
        else openComposer();
      }
      tasksChanged();
    } catch (exception) {
      rowError(exception.message, 'remove');
      pending(false);
      if (hadFocus && document.activeElement === document.body) remove.focus();
    }
    finally {
      state.removingIntent = false; state.removingHadFocus = false; pending(false);
      scheduleSearch();
    }
  }
  title.addEventListener('click', startEditing);
  completion.addEventListener('change', () => setCompleted(completion.checked));
  editor.addEventListener('input', () => { state.draft.title = editor.value; revision++; });
  editor.addEventListener('compositionstart', () => { state.composing = true; });
  editor.addEventListener('compositionend', () => { state.composing = false; state.draft.title = editor.value; revision++; });
  editor.addEventListener('keydown', event => {
    if (event.isComposing || state.composing || event.keyCode === 229) return;
    if (event.key === 'Enter') { event.preventDefault(); save(); }
    if (event.key === 'Escape' && !state.pending) {
      event.preventDefault();
      state.draft = { title: state.item.title, icon: state.item.icon };
      revision++;
      rowError();
      state.sync();
      finishEditing(true);
    }
  });
  row.addEventListener('focusout', event => {
    // Moving to this row's controls must not start a competing save.
    if (arrangingRows || !state.editing || state.pending || state.removingIntent || row.contains(event.relatedTarget)
      || event.relatedTarget === refreshButton) return;
    save();
  });
  remove.addEventListener('pointerdown', () => {
    state.removingIntent = true;
    state.removingHadFocus = row.contains(document.activeElement) || document.activeElement === document.body;
  });
  for (const eventName of ['pointerup', 'pointercancel']) {
    remove.addEventListener(eventName, () => {
      setTimeout(() => { state.removingIntent = false; state.removingHadFocus = false; }, 0);
    });
  }
  remove.addEventListener('click', removeItem);
  retry.addEventListener('click', () => {
    if (state.failedAction === 'remove') removeItem();
    else if (state.failedAction === 'complete') setCompleted(state.failedCompletion);
    else save();
  });
  state.sync();
  state.renderEmbedding();
  feedback.append(message, retry);
  embeddingFeedback.append(embeddingMessage, embeddingRetry);
  content.append(title, editor);
  row.append(completionControl, iconContainer, content, remove, rowStatus, feedback, embeddingStatus, embeddingFeedback, similarity, nonmatch);
  list.append(row);
}

async function loadItems() {
  // Reports whether the refresh applied: only then has tasksChanged()
  // rescheduled dependent work such as an awaiting search reconciliation.
  if (loading || adding || [...rows.values()].some(state => state.pending)) return false;
  const snapshot = revision;
  loading = true;
  updateRefresh();
  showError();
  try {
    const items = await request('/api/todos');
    if (snapshot !== revision) return false;
    const byId = new Map(items.map(item => [item.id, item]));
    for (const [id, state] of rows) {
      const dirty = state.draft.title !== state.item.title || state.draft.icon !== state.item.icon;
      const preserveDraft = state.editing || dirty || state.row.contains(document.activeElement);
      if (state.pending) continue;
      if (!byId.has(id)) {
        invalidateEmbedding(state, null);
        if (preserveDraft) continue;
        state.icon.close(); state.row.remove(); rows.delete(id);
      }
      else {
        const updated = byId.get(id);
        invalidateEmbedding(state, updated);
        const oldItem = state.item;
        // Focus alone protects the row from removal, not its draft: rebase
        // untouched fields onto the refreshed source while preserving actual
        // edits, so leaving the editor without typing never PUTs stale text.
        const userEdited = state.editing
          || state.draft.title !== oldItem.title
          || state.draft.icon !== oldItem.icon;
        state.item = updated;
        if (userEdited) {
          if (state.draft.title === oldItem.title) state.draft.title = updated.title;
          if (state.draft.icon === oldItem.icon) state.draft.icon = updated.icon;
        } else {
          state.draft = { title: updated.title, icon: updated.icon };
        }
        const editorFocused = state.editing && document.activeElement === state.editor;
        const selection = editorFocused ? [state.editor.selectionStart, state.editor.selectionEnd] : null;
        state.sync();
        if (selection) state.editor.setSelectionRange(...selection);
      }
    }
    for (const item of items) if (!rows.has(item.id)) makeRow(item);
    normalOrder = [...items.map(item => item.id), ...normalOrder.filter(id => rows.has(id) && !byId.has(id))];
    updateCount();
    tasksChanged();
    return true;
  } catch (exception) {
    showError(exception.message);
    if (!rows.size) { status.textContent = 'Could not load your tasks. Try Refresh.'; status.hidden = false; }
  }
  finally { loading = false; updateRefresh(); requestBackfill(); }
}
const composerPicker = makeIconControl(document.querySelector('#composer-icon'), 'task', 'New task icon', value => {
  composerIcon = value;
  input.focus();
});
function openComposer() {
  form.hidden = false;
  newTask.hidden = true;
  newTask.setAttribute('aria-expanded', 'true');
  input.focus();
}
function closeComposer() {
  if (adding) return;
  composerPicker.close();
  input.value = '';
  composerIcon = 'task';
  composerPicker.update('task');
  showError();
  input.setAttribute('aria-invalid', 'false');
  form.hidden = true;
  newTask.hidden = false;
  newTask.setAttribute('aria-expanded', 'false');
  newTask.focus();
}
newTask.addEventListener('click', openComposer);
cancelAdd.addEventListener('click', closeComposer);
input.addEventListener('compositionstart', () => { composerComposing = true; });
input.addEventListener('compositionend', () => { composerComposing = false; });
input.addEventListener('keydown', event => {
  if (event.isComposing || composerComposing || event.keyCode === 229) {
    if (event.key === 'Enter') event.preventDefault();
    return;
  }
  if (event.key === 'Escape') { event.preventDefault(); closeComposer(); }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (adding || composerComposing) return;
  const title = input.value.trim();
  if (!title || title.length > 500) {
    showError('Use a title with 1–500 characters.');
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  adding = true;
  revision++;
  tasksChanging();
  input.readOnly = true;
  composerPicker.trigger.disabled = true;
  composerPicker.close();
  addButton.disabled = true;
  cancelAdd.disabled = true;
  form.setAttribute('aria-busy', 'true');
  input.setAttribute('aria-invalid', 'false');
  updateRefresh();
  showError();
  try {
    const item = await request('/api/todos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, icon: composerIcon }),
    });
    if (!rows.has(item.id)) makeRow(item);
    tasksChanged({ backfill: true });
    input.value = '';
    composerIcon = 'task';
    composerPicker.update('task');
    updateCount();
  } catch (exception) { showError(exception.message); }
  finally {
    adding = false;
    input.readOnly = false;
    composerPicker.trigger.disabled = false;
    addButton.disabled = false;
    cancelAdd.disabled = false;
    form.setAttribute('aria-busy', 'false');
    updateRefresh();
    scheduleSearch();
    // Keep consecutive entry convenient without stealing focus from another row.
    if (form.contains(document.activeElement) || document.activeElement === document.body) input.focus();
  }
});
refreshButton.addEventListener('click', loadItems);
searchInput?.addEventListener('input', () => {
  searchMatches = null;
  clearSearchScores();
  applySearchView();
  scheduleSearch();
});
searchClear?.addEventListener('click', () => {
  searchInput.value = '';
  scheduleSearch(0);
  searchInput.focus();
});
searchInput?.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    searchInput.value = '';
    scheduleSearch(0);
  }
});
// A retained nonmatch stays visible only while it is protected (draft,
// pending work, an error, or focus). Re-evaluate once focus settles
// elsewhere so unprotected rows hide promptly instead of lingering until
// the next keystroke. The arrangingRows guard avoids re-entering from the
// focus restore inside applySearchView.
document.addEventListener('focusin', () => {
  if (arrangingRows || searchMatches === null) return;
  applySearchView();
});
// Blurring to a non-focusable target (heading, background, or body) fires no
// focusin, so a focus-only retained row would linger. Reevaluate once focus
// settles instead; the guard skips internal DOM moves like focusin does.
document.addEventListener('focusout', () => {
  if (arrangingRows || searchMatches === null) return;
  setTimeout(() => {
    if (arrangingRows || searchMatches === null) return;
    applySearchView();
  }, 0);
});
loadItems();
