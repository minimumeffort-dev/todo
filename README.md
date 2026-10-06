# Local To-do

A local FastAPI app with DuckDB storage. Add tasks, edit titles and icons, mark
tasks as done, and reopen them later. Completed tasks stay in the list. Saved
tasks and their completion states remain after reloading the page or restarting
the app.

## Install

Use Python 3.10 or newer. The app was verified with Python 3.12.
Run these commands from the project directory:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[test]'
```

The `test` extra installs pytest and HTTPX for the API tests. For the app alone,
use `.venv/bin/python -m pip install -e .` instead.

## Run locally

```sh
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000> in a browser with JavaScript enabled. Choose
**+ New task**, write a task, then press Enter or choose **Add**. The inline
composer stays ready for consecutive tasks. Escape or **×** closes it and
discards the new-task draft. Task is the default icon.

Use a task's checkbox to mark it as done; uncheck it to reopen it. You can also
Tab to the checkbox and press Space. Completed tasks have crossed-out titles and
remain visible, counted, and in the same order. You can still edit or remove them.
Changing completion preserves unsaved title and icon drafts without saving them.

Click a title, or Tab to it and press Enter or Space,
to open a borderless inline editor. Enter or leaving the row saves; moving to
the row's checkbox, icon, or remove control keeps the draft available for that action.
Escape in the editor restores the saved title and icon. Click a task's icon to
open its picker; selecting an icon saves it with any title draft. The composer
also has an icon picker. Use Tab or arrow keys to choose an icon, Enter or Space
to select it, and Escape to close the picker. Saving a title or icon preserves
the task's completion state.

The **×** remove control appears on hover or keyboard focus and stays visible
on touch devices. It is announced as “Remove” and the saved task title.
Removal is immediate. Focus moves to the next available task, the previous task,
or the composer. Removing an edited task does not save its draft.
Failed saves and removals leave the task and drafts available with a **Retry**
control. Failed completion changes restore the last confirmed checkbox state;
**Retry** repeats the requested completion or reopening and keeps drafts available.
Failed additions retain the composer input and icon; press Enter or
**Add** to retry. Other rows remain available while a request is pending.

**Refresh** reloads tasks, including changes from other tabs, while preserving
unsaved title and icon drafts. It also updates completion while a task is being
edited. Failed requests display an error and preserve your input or existing task.
Saved titles, icons, and completion states remain after reloading or restarting.
Stop the server with Ctrl+C.

## Storage

The default database location is `data/todos.duckdb` under the project directory.
The app creates the directory and database on startup. Run one server process
against a database file.

New tasks start incomplete. Startup upgrades older databases automatically:
missing icons default to Task, and existing tasks start incomplete when the
completion field is added. Existing titles, IDs, icons, and ordering are preserved.

To choose a different database location, set `TODO_DB_PATH` before starting:

```sh
TODO_DB_PATH=/absolute/path/to/todos.duckdb .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

## Verify

```sh
.venv/bin/python -m pytest tests/test_todos.py tests/test_health.py -q
```

The API tests use temporary databases and cover adding, listing, editing,
deleting, completing and reopening, invalid input, supported icons, missing
items, legacy database upgrades, repeated completion requests, persistence
across application restarts, and health checks without database access.

For a browser check, start the app, add consecutive tasks, edit one by mouse
and one by keyboard, and verify Enter/blur saving and Escape cancellation.
Change an icon, reload to confirm persistence, then remove tasks and check
where keyboard focus lands. Check a task, reload, restart the server, and confirm
that it is still checked, visible, and in the same position. Uncheck it and reload
again. Also check request failures and delays, refresh during an edit, and a
narrow touch layout. Automated Chromium checks verified completion with the
real API in the Linux VM, including server restarts, draft preservation, icon
changes, failed-request retries, editing other rows during pending requests,
and completed-task removal.

The API is available at `GET /api/todos`, `POST /api/todos` (JSON body
`{"title": "Buy groceries", "icon": "shopping"}`), `PUT /api/todos/{id}`
(a JSON body with both `title` and `icon`), `PATCH /api/todos/{id}`
(JSON body `{"completed": true}` to complete or `{"completed": false}` to reopen),
and `DELETE /api/todos/{id}`. Every task response includes `id`, `title`, `icon`,
and a boolean `completed`. PATCH changes only completion and returns the full
task; repeating the same state is safe. Missing or non-boolean `completed` values
return 422. Unknown task IDs return 404 with `{"detail": "To-do item not found"}`.
Title and icon updates preserve completion, and listing includes both completed
and incomplete tasks in their existing order.
Icon values are `task` (the default when adding), `star`, `home`, `work`,
`shopping`, and `heart`. Titles are trimmed and must contain 1–500 characters.
Interactive API documentation is at
<http://127.0.0.1:8000/docs> while the app runs.
