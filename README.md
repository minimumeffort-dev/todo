# Local To-do

A local FastAPI app with DuckDB storage. Add tasks, edit titles and icons, and remove
items when finished. Tasks remain available after reloading the page or restarting
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

Open <http://127.0.0.1:8000> in a browser with JavaScript enabled. Type a task
and press Enter or choose **Add**. An icon is optional; Task is the default.
The quick-add field stays ready for the next task.

Click or Tab to a task title to edit it directly. Press Enter or leave the field
to save; Escape discards the unsaved title and icon changes. Choose an icon in
the row to save it immediately. Failed saves keep your draft: press Enter or
leave the title field again to retry. Other rows and quick-add remain available.
Choose the **×** button (announced as “Remove” and the task title) to remove a
task in one step. Keyboard focus moves to the next task, the previous task, or
the quick-add field when the list is empty. Removal is immediate.

**Refresh** reloads tasks, including changes from other tabs, while preserving
unsaved row drafts. Failed requests display an error and preserve your input
or existing task. Saved titles and icons remain after reloading or restarting.
Stop the server with Ctrl+C.

## Storage

The default database location is `data/todos.duckdb` under the project directory.
The app creates the directory and database on startup. Run one server process
against a database file.

To choose a different database location, set `TODO_DB_PATH` before starting:

```sh
TODO_DB_PATH=/absolute/path/to/todos.duckdb .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

## Verify

```sh
.venv/bin/python -m pytest tests/test_todos.py -q
```

The API tests use temporary databases and cover adding, listing, deleting,
invalid input, missing items, and persistence across application restarts.

For a browser smoke check, start the app, add a uniquely named task, reload the
page and confirm it remains, then remove it and reload again to confirm it is
gone. An automated Chromium smoke check also verified this sequence in the
Linux VM.

The API is available at `GET /api/todos`, `POST /api/todos` (JSON body
`{"title": "Buy groceries", "icon": "shopping"}`), `PUT /api/todos/{id}`
(a JSON body with both `title` and `icon`), and `DELETE /api/todos/{id}`.
Icon values are `task` (the default when adding), `star`, `home`, `work`,
`shopping`, and `heart`. Existing databases upgrade with the default Task icon.
Titles are trimmed
and must contain 1–500 characters. Interactive API documentation is at
<http://127.0.0.1:8000/docs> while the app runs.
