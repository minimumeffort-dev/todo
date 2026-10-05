const form = document.querySelector('#todo-form');
const input = document.querySelector('#todo-title');
const iconInput = document.querySelector('#todo-icon');
const icons = { task: '✓ Task', star: '★ Star', home: '⌂ Home', work: '▣ Work', shopping: '🛒 Shopping', heart: '♥ Heart' };
function fillIcons(select, selected = 'task') {
  for (const [value, label] of Object.entries(icons)) {
    select.add(new Option(label, value, false, value === selected));
  }
}
fillIcons(iconInput);
const addButton = document.querySelector('#add-button');
const refreshButton = document.querySelector('#refresh-button');
const list = document.querySelector('#todo-list');
const count = document.querySelector('#count');
const status = document.querySelector('#status');
const error = document.querySelector('#error');
let items = [];
let busy = false;
let editingId = null;

function showError(message = '') {
  error.textContent = message;
  error.hidden = !message;
}

function setBusy(value) {
  busy = value;
  form.setAttribute('aria-busy', String(value));
  list.setAttribute('aria-busy', String(value));
  input.disabled = value || editingId !== null;
  iconInput.disabled = input.disabled;
  addButton.disabled = input.disabled;
  refreshButton.disabled = input.disabled;
  list.querySelectorAll('button, input, select').forEach(control => {
    control.disabled = value || (editingId !== null && !control.closest('.edit-form'));
  });
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
    if (editingId === item.id) {
      const editForm = document.createElement('form');
      editForm.className = 'edit-form';
      const titleLabel = document.createElement('label');
      titleLabel.htmlFor = 'edit-title';
      titleLabel.textContent = 'Task title';
      const editTitle = document.createElement('input');
      editTitle.id = 'edit-title';
      editTitle.value = item.title;
      editTitle.required = true;
      editTitle.maxLength = 500;
      editTitle.setAttribute('aria-describedby', 'error');
      const iconLabel = document.createElement('label');
      iconLabel.htmlFor = 'edit-icon';
      iconLabel.textContent = 'Icon';
      const editIcon = document.createElement('select');
      editIcon.id = 'edit-icon';
      fillIcons(editIcon, item.icon);
      const actions = document.createElement('div');
      actions.className = 'task-actions';
      const save = document.createElement('button');
      save.type = 'submit';
      save.textContent = 'Save';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'secondary';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        editingId = null;
        showError();
        render();
        setBusy(false);
        focusEdit(item.id);
      });
      editForm.addEventListener('submit', event => {
        event.preventDefault();
        saveItem(item.id, editTitle, editIcon);
      });
      actions.append(save, cancel);
      editForm.append(titleLabel, editTitle, iconLabel, editIcon, actions);
      row.append(editForm);
      list.append(row);
      continue;
    }
    const icon = document.createElement('span');
    icon.className = 'task-icon';
    icon.textContent = (icons[item.icon] || icons.task).split(' ')[0];
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', `${(icons[item.icon] || icons.task).split(' ')[1]} icon`);
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
    edit.className = 'secondary edit';
    edit.dataset.id = item.id;
    edit.textContent = 'Edit';
    edit.setAttribute('aria-label', `Edit ${item.title}`);
    edit.addEventListener('click', () => {
      if (busy || editingId !== null) return;
      editingId = item.id;
      showError();
      render();
      setBusy(false);
      document.querySelector('#edit-title').focus();
    });
    const actions = document.createElement('div');
    actions.className = 'task-actions';
    actions.append(edit, button);
    row.append(icon, title, actions);
    list.append(row);
  }
}

function focusEdit(id) {
  [...list.querySelectorAll('.edit')].find(button => button.dataset.id === id)?.focus();
}

async function saveItem(id, editTitle, editIcon) {
  if (busy) return;
  const title = editTitle.value.trim();
  if (!title) {
    showError('Enter a task title before saving it.');
    editTitle.focus();
    return;
  }
  setBusy(true);
  showError();
  try {
    const updated = await request(`/api/todos/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, icon: editIcon.value }),
    });
    items = items.map(item => item.id === id ? updated : item);
    editingId = null;
    render();
  } catch (exception) { showError(exception.message); }
  finally {
    setBusy(false);
    if (editingId !== null) editTitle.focus();
    else focusEdit(id);
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
  if (busy || editingId !== null) return;
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
      body: JSON.stringify({ title, icon: iconInput.value }),
    });
    items.push(item);
    input.value = '';
    iconInput.value = 'task';
    render();
  } catch (exception) { showError(exception.message); }
  finally {
    setBusy(false);
    input.focus();
  }
});

async function removeItem(id) {
  if (busy || editingId !== null) return;
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
