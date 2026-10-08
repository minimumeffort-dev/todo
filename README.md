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

## Model loading and search

EmbeddingGemma 2 loads automatically when the page opens. A compact indicator
above the task card animates during setup and download; **Model ready** means a
built-in sample produced valid output on WebGPU. Task controls remain usable
while the model loads or if loading fails. Failure details and **Retry** appear
in the indicator. Retry starts a fresh worker after a failure or timeout.

Use **Search tasks** to find saved tasks by meaning, including completed tasks.
For example, “purchase food” can find a grocery task. Queries accept 1–500
characters and wait for model readiness. Results rank by cosine similarity to
the query vector and show up to 20 tasks. The status reports when some tasks
still lack embeddings, so an incomplete index is distinguishable from an empty
one. Results update as indexing finishes. **Clear search**, or Escape in the
search field, restores normal list order. Search updates preserve row drafts,
retry controls, and keyboard focus.

When the model becomes ready, the app fetches saved tasks with missing or
incompatible embeddings and processes them in the background. This includes
older tasks and tasks added during loading. **Refresh**, successful additions,
and saved title or icon edits also check for missing embeddings. One background
inference is submitted at a time so searches can interleave. Completion changes
preserve embeddings; source edits invalidate them and trigger new processing.

If inference or a vector upload fails, the task stays saved and gets a separate
processing **Retry**. Retrying never creates another task. A failed upload reuses
its computed vector; an inference retry computes a new one. **Refresh** also
retries pending indexing. Changed or deleted snapshots are discarded, and
conflicts from another tab are reconciled with the current saved source.

Inference stays in a browser module worker. Task embeddings use confirmed saved
values, never unsaved drafts. Their input is exactly
`Icon: <icon>\nTask: <title>` (input version 1), with the icon's text key such as
`shopping`. Search embeds the trimmed query text with the same resident model.
The resulting 768-value vectors and metadata go to the local FastAPI app for
storage or ranking; inference does not send task or query text to a remote model
service.

Use a current WebGPU-capable browser with WebGPU in module workers, hardware
acceleration, and enough GPU memory. Serve the app on **HTTPS or localhost**.
If WebGPU is unavailable, ordinary task controls still work and the model panel
explains why semantic search is unavailable.

The verified pins are:

| Component | Pin |
| --- | --- |
| Model | [onnx-community/embeddinggemma-2-ONNX](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/tree/daa72c51243991dfcaf9f9137d2c573d8f7790c0) |
| Immutable revision | `daa72c51243991dfcaf9f9137d2c573d8f7790c0` |
| Browser weights | `q4`: `onnx/model_q4.onnx` and `onnx/model_q4.onnx_data` |
| Transformers.js | `4.3.1` |
| ONNX Runtime Web dependency | `1.31.0-dev.20260914-8d85527a0` |

The model loads only the text encoder and tokenizer. Model and tokenizer
requests, including metadata probes, use the pinned revision.

The first page load fetches approximately **234 MB of uncompressed assets**:
about 175 MB of model graph/weights, 32 MB of tokenizer data, and 27 MB of runtime
files. Network transfer varies with compression and caching. Downloads use
`huggingface.co`, its CDN `us.aws.cdn.hf.co`, and `cdn.jsdelivr.net`.
Network access starts automatically during page initialization.

Assets use the browser's origin-scoped cache when available. Reloading releases
the resident worker and automatically loads again, reusing cached assets and
current saved task vectors. Browser storage quotas, private browsing, cache
eviction, or clearing site data may require another download.

## Storage

The default database location is `data/todos.duckdb` under the project directory.
The app creates the directory and database on startup. Run one server process
against a database file.

New tasks start incomplete. Startup upgrades older databases automatically:
missing icons default to Task, and existing tasks start incomplete when the
completion field is added. Existing titles, IDs, icons, and ordering are preserved.
Startup also adds nullable embedding columns without changing saved tasks.
DuckDB stores vectors directly as `FLOAT[]`, alongside the pinned model ID,
immutable revision, input-format version, and dimension count. No separate vector
database is needed. Vectors survive application restarts.

To choose a different database location, set `TODO_DB_PATH` before starting:

```sh
TODO_DB_PATH=/absolute/path/to/todos.duckdb .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

## Verify

Use Python 3.12 and Node 22 for the verified test setup:

```sh
.venv/bin/python -m pip install -e '.[test]' 'setuptools>=68' wheel
mise install node@22
.venv/bin/python tests/test_model_assets.py --check-suites
```

The full Python suite uses temporary databases and includes both offline Node
suites. It covers task lifecycle and persistence, legacy database upgrades,
embedding validation and atomic uploads, pending eligibility, cosine ranking
and stable ties, and query/task inference serialization, failures, timeouts,
and disposal. Static checks verify JavaScript serving and wheel packaging;
panel tests verify automatic startup and accessible state changes.
Set `MODEL_TEST_NODE` to an absolute Node executable path if it is outside PATH
and the usual mise installation directory.

Install the optional browser setup and prepare the pinned fixtures:

```sh
mise exec node@22 -- npm install --prefix .venv/model-browser --no-audit --no-fund playwright@1.55.1
mise exec node@22 -- node .venv/model-browser/node_modules/playwright/cli.js install chromium
.venv/bin/python tests/test_model_assets.py --download-fixtures
```

Playwright reports missing native Chromium libraries on Linux. Fixture downloads
are approximately 234 MB under the ignored `.venv/model-assets` directory and
are verified against SHA-256 hashes; matching files are reused on later runs.

Run each browser check separately:

```sh
.venv/bin/python tests/test_model_assets.py --check-flows
.venv/bin/python tests/test_model_assets.py --check-real
```

Each command starts and stops its own FastAPI server and Chromium in the same
process, with temporary databases and dynamically allocated loopback ports.
The flow check injects model inference while exercising the real DOM, API, and
DuckDB: additions during loading, saved-snapshot backfill, current-vector reuse,
source edits/deletions during inference, 404/409 reconciliation, inference and
upload retries, rapid searches, clearing, and draft/focus preservation.
Browser actions await matching responses registered before the action and then
assert the rendered state. Controlled request gates cover pending creation and
saves; held search responses arrive after a newer query, clearing, or a source
save to verify that obsolete results cannot overwrite the current view.

The real-model check uses the deployed worker and authentic pinned bytes in
Chromium's browser cache. It verifies automatic activation, loading failure and
retry, missing-item backfill, semantic ranking, cache reuse after reload, and
persisted vectors after a server restart. Both browser checks include a narrow
layout and reduced motion. Chromium uses SwiftShader software WebGPU in the
Linux VM; physical GPU and browser performance varies. The real check also
verifies that unsupported WebGPU leaves task controls available.
On reload, reaching the sample-test phase confirms that the fresh worker loaded
the cached tokenizer and weights. The check then stops Chromium before waiting
for a second software-GPU sample; the first sample and real inference already
passed.

Browser tests are opt-in under ordinary pytest runs. Set `MODEL_BROWSER_CHECK=1`
to include them, or use the two commands above.

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

`PUT /api/todos/{id}/embedding` accepts
`{title, icon, vector, model, revision, input_version, dimensions}`. Use the pinned
model and revision above, input version `1`, and exactly `768` finite
float32-compatible values forming a nonzero vector. Success returns 204;
incompatible metadata or an invalid vector returns 422, a missing task returns
404, and a changed title/icon snapshot returns 409. Source comparison and the
vector write are atomic.
Ordinary task responses still contain only `id`, `title`, `icon`, and `completed`.

`GET /api/todos/embeddings/pending` returns ordinary task objects in list order
for missing or incompatible embeddings. Compatibility requires the current
model, revision, input version, dimensions, and a usable finite nonzero vector.

`POST /api/todos/search` accepts
`{vector, model, revision, input_version, dimensions, limit?}` with the same
vector validation as uploads. `limit` defaults to 20 and must be an integer from
1 to 100. The response is `{matches: [{todo, score}], pending_count}`. Only
compatible vectors are ranked by descending cosine similarity, with ties in
creation-time/ID order; `pending_count` reports tasks still missing compatible
vectors. Invalid input returns a sanitized 422 response. An empty index returns
an empty `matches` list.
