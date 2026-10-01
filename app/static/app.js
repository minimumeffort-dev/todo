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
  refreshButton.disabled = value;
  list.querySelectorAll('button').forEach(button => { button.disabled = value; });
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
    row.append(title, button);
    list.append(row);
  }
}

async function loadItems() {
  if (busy) return;
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
