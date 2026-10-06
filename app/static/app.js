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
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${response.status}). Please try again.`);
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
  editor.setAttribute('aria-describedby', `edit-help ${message.id}`);
  title.setAttribute('aria-describedby', 'edit-help');
  completion.setAttribute('aria-describedby', message.id);
  const state = { row, title, editor, completion, remove, item, draft: { title: item.title, icon: item.icon },
    editing: false, composing: false, pending: false, removingIntent: false,
    failedAction: 'save', failedCompletion: null };
  rows.set(item.id, state);
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
    rowError();
    try {
      const updated = await request(`/api/todos/${encodeURIComponent(item.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
      });
      state.item = updated;
      state.draft = { title: updated.title, icon: updated.icon };
      state.sync();
      // Restore focus only if the user has stayed in this editor.
      const restoreFocus = document.activeElement === editor;
      pending(false);
      finishEditing(restoreFocus);
    } catch (exception) { rowError(exception.message); }
    finally {
      pending(false);
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
    rowError();
    completion.checked = desired;
    try {
      state.item = await request(`/api/todos/${encodeURIComponent(item.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: desired }),
      });
      // Completion changes the saved item without submitting or discarding drafts.
      labels();
    } catch (exception) {
      state.failedCompletion = desired;
      rowError(exception.message, 'complete');
    } finally {
      pending(false);
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
    rowError();
    try {
      await request(`/api/todos/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      const adjacent = [row.nextElementSibling, row.previousElementSibling]
        .map(element => element && rows.get(element.dataset.id))
        .find(candidate => candidate && (!candidate.pending || (candidate.editing && candidate.pending === 'save')));
      const restoreFocus = hadFocus && (row.contains(document.activeElement) || document.activeElement === document.body);
      rows.delete(item.id);
      row.remove();
      updateCount();
      if (restoreFocus) {
        if (adjacent) (adjacent.editing ? adjacent.editor : adjacent.title).focus();
        else openComposer();
      }
    } catch (exception) {
      rowError(exception.message, 'remove');
      pending(false);
      if (hadFocus && document.activeElement === document.body) remove.focus();
    }
    finally { state.removingIntent = false; state.removingHadFocus = false; pending(false); }
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
    if (!state.editing || state.pending || state.removingIntent || row.contains(event.relatedTarget)
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
  feedback.append(message, retry);
  content.append(title, editor);
  row.append(completionControl, iconContainer, content, remove, rowStatus, feedback);
  list.append(row);
}

async function loadItems() {
  if (loading || adding || [...rows.values()].some(state => state.pending)) return;
  const snapshot = revision;
  loading = true;
  updateRefresh();
  showError();
  try {
    const items = await request('/api/todos');
    if (snapshot !== revision) return;
    const byId = new Map(items.map(item => [item.id, item]));
    for (const [id, state] of rows) {
      const dirty = state.draft.title !== state.item.title || state.draft.icon !== state.item.icon;
      const preserveDraft = state.editing || dirty || state.row.contains(document.activeElement);
      if (state.pending) continue;
      if (!byId.has(id)) {
        if (preserveDraft) continue;
        state.icon.close(); state.row.remove(); rows.delete(id);
      }
      else {
        const updated = byId.get(id);
        if (preserveDraft) state.item = { ...state.item, completed: updated.completed };
        else {
          state.item = updated;
          state.draft = { title: updated.title, icon: updated.icon };
        }
        state.sync();
      }
    }
    for (const item of items) if (!rows.has(item.id)) makeRow(item);
    updateCount();
  } catch (exception) {
    showError(exception.message);
    if (!rows.size) { status.textContent = 'Could not load your tasks. Try Refresh.'; status.hidden = false; }
  }
  finally { loading = false; updateRefresh(); }
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
    // Keep consecutive entry convenient without stealing focus from another row.
    if (form.contains(document.activeElement) || document.activeElement === document.body) input.focus();
  }
});
refreshButton.addEventListener('click', loadItems);
loadItems();
