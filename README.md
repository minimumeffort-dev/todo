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

## Run EmbeddingGemma 2

Choose **Load and test model** in the **On-device model** panel. This loads the
model on demand in a module worker and runs a built-in sample sentence on
WebGPU. **Model ready** means inference succeeded with finite, nonzero output.
The sample output is validated and discarded. Task titles and drafts are never
sent to the model. Uploads, task embeddings, vector storage, and search are
reserved for future work.

The model panel shows indeterminate progress during setup and a percentage
when the download total is available. **Retry** starts a fresh worker after a
loading or inference failure. Tasks remain usable during model loading, testing,
and errors.

Use a current WebGPU-capable browser with WebGPU available in module workers,
hardware acceleration, and enough GPU memory. Serve the app on **HTTPS or
localhost**. The panel explains when WebGPU or a GPU adapter is unavailable.
The test uses the WebGPU backend; support depends on the browser, OS, and GPU.

The verified pins are:

| Component | Pin |
| --- | --- |
| Model | [onnx-community/embeddinggemma-2-ONNX](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/tree/daa72c51243991dfcaf9f9137d2c573d8f7790c0) |
| Immutable revision | `daa72c51243991dfcaf9f9137d2c573d8f7790c0` |
| Browser weights | `q4`: `onnx/model_q4.onnx` and `onnx/model_q4.onnx_data` |
| Transformers.js | `4.3.1` |
| ONNX Runtime Web dependency | `1.31.0-dev.20260914-8d85527a0` |

This fixed text test loads the text encoder and tokenizer. Vision and audio
encoder configs are disabled. All model and tokenizer requests, including
metadata probes, use the pinned revision.

The first activation fetches approximately **234 MB of uncompressed assets**:
about 175 MB of model graph/weights, 32 MB of tokenizer data, and 27 MB of runtime
files. Network transfer varies with compression and caching. Downloads use
`huggingface.co`, its weight CDN `us.aws.cdn.hf.co`, and `cdn.jsdelivr.net`.
Network access starts only after activation.

Model assets use the browser's origin-scoped cache when available. Reloading
releases the resident worker and returns the panel to its initial state;
activation can reuse cached assets. Browser storage quotas, private browsing,
cache eviction, or clearing site data may require another download.

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
.venv/bin/python -m pip install 'setuptools>=68' wheel
.venv/bin/python -m pytest tests/test_todos.py tests/test_health.py tests/test_model_assets.py -q
mise exec node@22.20.0 -- node --test tests/model_runtime.test.mjs
```

The API tests use temporary databases and cover adding, listing, editing,
deleting, completing and reopening, invalid input, supported icons, missing
items, legacy database upgrades, repeated completion requests, persistence
across application restarts, and health checks without database access.
Model asset checks also verify JavaScript serving, the panel's separate status
elements, wheel packaging, and the offline worker lifecycle suite. These checks
need Node 22. Install it with `mise install node@22.20.0` if needed. Browser
integration checks are opt-in.

To prepare reproducible browser checks, install Playwright and download the
pinned fixtures (approximately 234 MB, stored under the ignored `.venv` folder):

```sh
mise install node@22.20.0
mise exec node@22.20.0 -- npm install --prefix .venv/model-browser --no-audit --no-fund playwright@1.55.1
mise exec node@22.20.0 -- node .venv/model-browser/node_modules/playwright/cli.js install chromium
mise exec node@22.20.0 -- .venv/bin/python tests/test_model_assets.py --download-fixtures
```

Playwright reports any missing native Chromium libraries on Linux. The fixture
preparation command verifies SHA-256 hashes before making downloads available
to tests and reuses matching files on later runs.

Run these checks separately; each starts and stops its own FastAPI server and
browser using temporary databases and dynamically allocated loopback ports:

```sh
MODEL_BROWSER_CHECK=1 mise exec node@22.20.0 -- .venv/bin/python -m pytest tests/test_model_assets.py -k real_model -q
MODEL_BROWSER_CHECK=1 mise exec node@22.20.0 -- .venv/bin/python -m pytest tests/test_model_assets.py -k failures_retry -q
MODEL_BROWSER_CHECK=1 mise exec node@22.20.0 -- .venv/bin/python -m pytest tests/test_model_assets.py -k external_weight -q
MODEL_BROWSER_CHECK=1 mise exec node@22.20.0 -- .venv/bin/python -m pytest tests/test_model_assets.py -k task_flows -q
```

The first two run the actual model in the production worker with authentic
cached bytes. The tests raise the temporary browser cache quota to fit the
fixtures and use Chromium's SwiftShader software WebGPU adapter in the Linux VM.
They verify task interactions during loading and inference, draft preservation,
blocked runtime/model-graph/external-weight downloads, unsupported WebGPU,
retry, and cache reuse after reload. Fault tests reject downloads through browser
routing and the SDK's fetch hook; they do not replace inference or its output.
The third specifically checks that a failed external-weight download offers
**Retry**, then verifies real inference succeeds after retry. The fourth checks
task add/edit/complete/reopen/remove flows, completion failure/retry, and a
narrow layout alongside the model panel.

For a cold download check, set `MODEL_COLD_DOWNLOAD=1` on the `real_model` command;
this uses the actual CDN requests and can take several minutes. In the managed
VM, the check uses the provided network proxy for HTTPS and bypasses it for
localhost. The cold run and cached inference checks were verified with
Chromium 140 on the software WebGPU adapter. Physical GPU and browser performance
will vary.

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
