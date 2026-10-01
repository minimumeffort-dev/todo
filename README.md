# Local To-do

A local FastAPI app with DuckDB storage. Add tasks, view your list, and remove
items when finished. Edit existing task titles inline. Tasks remain available after reloading the page or restarting
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
and choose **Add task**, or press Enter. Choose **Remove** beside a task to
delete it. Choose **Edit** to change a title, then **Save** (or press Enter) to persist
it. **Cancel** (or Escape) leaves the title unchanged. Failed saves preserve your
draft and display an error; controls are disabled while a request is pending.
**Refresh** reloads the list, including changes from other tabs, and is disabled
while editing. Starting another edit discards the previous unsaved draft.
Failed requests display an error and preserve your input or existing task.
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
editing, invalid input, missing items, and persistence across application restarts.

For a browser smoke check, start the app, add a uniquely named task, reload the
page and confirm it remains. Edit it and cancel to confirm the title stays the
same, then edit and save a new title and reload to confirm it persists. Finally,
remove it and reload again to confirm it is gone. An automated Chromium smoke
check also covers failed saves and disabled controls during pending saves.

The API is available at `GET /api/todos`, `POST /api/todos` (JSON body
`{"title": "Buy groceries"}`), `PATCH /api/todos/{id}` (the same JSON body),
and `DELETE /api/todos/{id}`. Titles are trimmed
and must contain 1–500 characters. Interactive API documentation is at
<http://127.0.0.1:8000/docs> while the app runs.
