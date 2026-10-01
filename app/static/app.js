const form = document.querySelector('#todo-form');
const input = document.querySelector('#todo-title');
const addButton = document.querySelector('#add-button');
const refreshButton = document.querySelector('#refresh-button');
const list = document.querySelector('#todo-list');
const count = document.querySelector('#count');
const status = document.querySelector('#status');
const error = document.querySelector('#error');
let items = [];
let busy = false;
let editingId = null;
let draft = '';

function showError(message = '') {
  error.textContent = message;
  error.hidden = !message;
}

function setBusy(value) {
  busy = value;
  form.setAttribute('aria-busy', String(value));
  list.setAttribute('aria-busy', String(value));
  input.disabled = value;
  addButton.disabled = value;
  refreshButton.disabled = value || editingId !== null;
  list.querySelectorAll('button, input').forEach(control => { control.disabled = value; });
}

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error('Could not reach the local app. Check that it is running and try again.');
  }
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).detail; } catch { /* Use the status below. */ }
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${response.status}). Please try again.`);
  }
  return response.status === 204 ? null : response.json();
}

function render() {
  list.replaceChildren();
  count.textContent = items.length;
  status.textContent = items.length ? '' : 'Your list is clear. Add a task to get started.';
  status.hidden = items.length > 0;
  for (const item of items) {
    const row = document.createElement('li');
    if (item.id === editingId) {
      const editor = document.createElement('form');
      editor.className = 'edit-form';
      editor.setAttribute('aria-busy', String(busy));
      const field = document.createElement('input');
      field.value = draft;
      field.maxLength = 500;
      field.required = true;
      field.setAttribute('aria-label', `Edit ${item.title}`);
      field.setAttribute('aria-describedby', 'error');
      field.addEventListener('input', () => { draft = field.value; });
      const save = document.createElement('button');
      save.type = 'submit';
      save.textContent = 'Save';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'secondary';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => finishEditing(item.id));
      field.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !busy) finishEditing(item.id);
      });
      editor.addEventListener('submit', event => {
        event.preventDefault();
        saveItem(item.id);
      });
      editor.append(field, save, cancel);
      editor.querySelectorAll('input, button').forEach(control => { control.disabled = busy; });
      row.append(editor);
      list.append(row);
      continue;
    }
    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = item.title;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'remove';
    button.textContent = 'Remove';
    button.disabled = busy;
    button.setAttribute('aria-label', `Remove ${item.title}`);
    button.addEventListener('click', () => removeItem(item.id));
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'secondary';
    edit.textContent = 'Edit';
    edit.disabled = busy;
    edit.setAttribute('aria-label', `Edit ${item.title}`);
    edit.addEventListener('click', () => {
      if (busy) return;
      editingId = item.id;
      draft = item.title;
      showError();
      render();
      setBusy(false);
      list.querySelector('input').focus();
    });
    const actions = document.createElement('div');
    actions.className = 'task-actions';
    actions.append(edit, button);
    row.append(title, actions);
    list.append(row);
  }
}

function finishEditing(id) {
  if (busy) return;
  editingId = null;
  draft = '';
  showError();
  render();
  setBusy(false);
  const index = items.findIndex(item => item.id === id);
  list.children[index]?.querySelector('button').focus();
}

async function saveItem(id) {
  if (busy) return;
  const title = draft.trim();
  if (!title) {
    showError('Enter a task before saving it.');
    list.querySelector('input').focus();
    return;
  }
  setBusy(true);
  list.querySelector('.edit-form').setAttribute('aria-busy', 'true');
  showError();
  try {
    const updated = await request(`/api/todos/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    items = items.map(item => item.id === id ? updated : item);
    setBusy(false);
    finishEditing(id);
  } catch (exception) {
    showError(exception.message);
  } finally {
    setBusy(false);
    const editor = list.querySelector('.edit-form');
    if (editor) {
      editor.setAttribute('aria-busy', 'false');
      editor.querySelector('input').focus();
    }
  }
}

async function loadItems() {
  if (busy || editingId !== null) return;
  setBusy(true);
  showError();
  try {
    items = await request('/api/todos');
    render();
  } catch (exception) {
    status.textContent = 'Could not refresh your tasks.';
    status.hidden = false;
    showError(exception.message);
  } finally { setBusy(false); }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const title = input.value.trim();
  if (!title) {
    showError('Enter a task before adding it.');
    input.focus();
    return;
  }
  setBusy(true);
  showError();
  try {
    const item = await request('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    items.push(item);
    input.value = '';
    render();
  } catch (exception) { showError(exception.message); }
  finally {
    setBusy(false);
    input.focus();
  }
});

async function removeItem(id) {
  if (busy) return;
  setBusy(true);
  showError();
  try {
    await request(`/api/todos/${encodeURIComponent(id)}`, { method: 'DELETE' });
    items = items.filter(item => item.id !== id);
    render();
  } catch (exception) { showError(exception.message); }
  finally { setBusy(false); }
}

refreshButton.addEventListener('click', loadItems);
loadItems();
