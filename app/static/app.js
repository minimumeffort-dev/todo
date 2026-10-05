const form = document.querySelector('#todo-form');
const input = document.querySelector('#todo-title');
const iconInput = document.querySelector('#todo-icon');
const addButton = document.querySelector('#add-button');
const refreshButton = document.querySelector('#refresh-button');
const list = document.querySelector('#todo-list');
const count = document.querySelector('#count');
const status = document.querySelector('#status');
const error = document.querySelector('#error');
const icons = { task: '✓ Task', star: '★ Star', home: '⌂ Home', work: '▣ Work', shopping: '🛒 Shopping', heart: '♥ Heart' };
const rows = new Map();
let adding = false;
let loading = false;
let revision = 0;
function fillIcons(select, selected = 'task') {
  for (const [value, label] of Object.entries(icons)) {
    select.add(new Option(label, value, false, value === selected));
  }
}
fillIcons(iconInput);
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
function updateCount() {
  count.textContent = rows.size;
  status.textContent = 'Your list is clear. Add a task to get started.';
  status.hidden = rows.size > 0;
}
function makeRow(item) {
  const row = document.createElement('li');
  const title = document.createElement('input');
  title.className = 'task-title';
  title.value = item.title;
  title.maxLength = 500;
  title.required = true;
  title.setAttribute('aria-label', 'Task title');
  title.setAttribute('aria-describedby', 'edit-help error');
  const icon = document.createElement('select');
  icon.className = 'task-icon';
  icon.setAttribute('aria-label', `Icon for ${item.title}`);
  fillIcons(icon, item.icon);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', `Remove ${item.title}`);
  const state = { row, title, icon, remove, item, pending: false };
  rows.set(item.id, state);
  function pending(value) {
    state.pending = value;
    row.setAttribute('aria-busy', String(value));
    title.readOnly = value;
    icon.disabled = value;
    remove.disabled = value;
  }
  async function save() {
    if (state.pending) return;
    const draft = title.value.trim();
    if (draft === state.item.title && icon.value === state.item.icon) return;
    if (!draft) { showError('Enter a task title before saving it.'); return; }
    pending(true);
    revision++;
    showError();
    try {
      const updated = await request(`/api/todos/${encodeURIComponent(item.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: draft, icon: icon.value }),
      });
      state.item = updated;
      title.value = updated.title;
      remove.setAttribute('aria-label', `Remove ${updated.title}`);
      icon.setAttribute('aria-label', `Icon for ${updated.title}`);
    } catch (exception) { showError(exception.message); }
    finally { pending(false); }
  }
  title.addEventListener('blur', event => {
    // Removing this row should not issue a competing save request.
    if (event.relatedTarget !== remove) save();
  });
  title.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); save(); }
    if (event.key === 'Escape' && !state.pending) {
      title.value = state.item.title;
      icon.value = state.item.icon;
      showError();
    }
  });
  icon.addEventListener('change', save);
  remove.addEventListener('click', async () => {
    if (state.pending) return;
    const hadFocus = row.contains(document.activeElement);
    pending(true);
    revision++;
    showError();
    try {
      await request(`/api/todos/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      const next = row.nextElementSibling || row.previousElementSibling;
      const restoreFocus = hadFocus && (row.contains(document.activeElement) || document.activeElement === document.body);
      rows.delete(item.id);
      row.remove();
      updateCount();
      if (restoreFocus) (next?.querySelector('.task-title') || input).focus();
    } catch (exception) {
      showError(exception.message);
      pending(false);
      if (hadFocus && document.activeElement === document.body) remove.focus();
    }
    finally { pending(false); }
  });
  row.append(icon, title, remove);
  list.append(row);
}
async function loadItems() {
  if (loading || adding || [...rows.values()].some(state => state.pending)) return;
  const snapshot = revision;
  loading = true;
  refreshButton.disabled = true;
  showError();
  try {
    const items = await request('/api/todos');
    if (snapshot !== revision) return;
    const ids = new Set(items.map(item => item.id));
    for (const [id, state] of rows) {
      const dirty = state.title.value !== state.item.title || state.icon.value !== state.item.icon;
      if (state.pending || dirty) continue;
      if (!ids.has(id)) { state.row.remove(); rows.delete(id); }
      else {
        const updated = items.find(item => item.id === id);
        state.item = updated;
        state.title.value = updated.title;
        state.icon.value = updated.icon;
        state.remove.setAttribute('aria-label', `Remove ${updated.title}`);
        state.icon.setAttribute('aria-label', `Icon for ${updated.title}`);
      }
    }
    for (const item of items) if (!rows.has(item.id)) makeRow(item);
    updateCount();
  } catch (exception) {
    showError(exception.message);
    if (!rows.size) { status.textContent = 'Could not load your tasks. Try Refresh.'; status.hidden = false; }
  }
  finally { loading = false; refreshButton.disabled = false; }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (adding) return;
  const title = input.value.trim();
  if (!title) { showError('Enter a task before adding it.'); input.focus(); return; }
  adding = true;
  revision++;
  input.readOnly = true;
  iconInput.disabled = true;
  addButton.disabled = true;
  form.setAttribute('aria-busy', 'true');
  showError();
  try {
    const item = await request('/api/todos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, icon: iconInput.value }),
    });
    if (!rows.has(item.id)) makeRow(item);
    input.value = '';
    iconInput.value = 'task';
    updateCount();
  } catch (exception) { showError(exception.message); }
  finally {
    adding = false;
    input.readOnly = false;
    iconInput.disabled = false;
    addButton.disabled = false;
    form.setAttribute('aria-busy', 'false');
    input.focus();
  }
});
refreshButton.addEventListener('click', loadItems);
loadItems();
