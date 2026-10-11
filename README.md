# Local To-do

A to-do app that runs entirely in the browser. Add tasks, edit titles and
icons, mark tasks as done, and reopen them later. Completed tasks stay in the
list. Saved tasks, their completion states and their search embeddings are
stored locally in your browser and remain after reloading the page,
restarting the browser, or going offline. There is no server, no account,
and no cross-device sync.

## Quick start

You need Node 22 and npm 10 (see `package.json` engines). No Python is
required to run or deploy the app.

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci
npm run dev
```

Open the printed loopback URL (for example <http://127.0.0.1:5173>) in a
browser with JavaScript enabled. `npm run dev` serves the same local asset
URLs as production; source edits appear after reload.

```sh
npm run build    # reproducible static output in dist/
npm run preview  # serve the built app locally
```

Choose **+ New task**, write a task, then press Enter or choose **Add**. The
inline composer stays ready for consecutive tasks. Escape or **×** closes it
and discards the new-task draft. Task is the default icon.

Use a task's checkbox to mark it as done; uncheck it to reopen it. You can
also Tab to the checkbox and press Space. Completed tasks have crossed-out
titles and remain visible, counted, and in the same order. You can still edit
or remove them. Changing completion preserves unsaved title and icon drafts
without saving them.

Click a title, or Tab to it and press Enter or Space, to open a borderless
inline editor. Enter or leaving the row saves; moving to the row's checkbox,
icon, or remove control keeps the draft available for that action. Escape in
the editor restores the saved title and icon. Click a task's icon to open its
picker; selecting an icon saves it with any title draft. The composer also
has an icon picker. Use Tab or arrow keys to choose an icon, Enter or Space
to select it, and Escape to close the picker. Saving a title or icon
preserves the task's completion state.

The **×** remove control appears on hover or keyboard focus and stays visible
on touch devices. It is announced as “Remove” and the saved task title.
Removal is immediate. Focus moves to the next visible available task, the
previous visible task, or the composer. Removing an edited task does not save
its draft. Failed saves and removals leave the task and drafts available with
a **Retry** control. Failed completion changes restore the last confirmed
checkbox state; **Retry** repeats the requested completion or reopening and
keeps drafts available. Failed additions retain the composer input and icon;
press Enter or **Add** to retry. Other rows remain available while a request
is pending. A save only counts as successful after the database confirms
durability; anything else keeps your draft and says so.

**Refresh** reloads tasks, including changes from other tabs, while preserving
unsaved title and icon drafts. It also updates completion while a task is
being edited. Failed requests display an error and preserve your input or
existing task. Saved titles, icons, and completion states remain after
reloading or restarting. Drafts are never written to backups or submitted
implicitly.

## Storage architecture

Tasks and embeddings live in a DuckDB database that runs inside a dedicated
browser worker (DuckDB-Wasm **1.33.1-dev65.0**) and persists to the browser's
Origin Private File System (OPFS). Every mutation is acknowledged only after
commit, checkpoint and a native OPFS flush succeed; a save that cannot be
confirmed keeps your draft and reports an unconfirmed save instead of
pretending it succeeded. If OPFS or Web Locks are unavailable, the app shows
a clear error — it never silently falls back to temporary storage.

The repository preserves the original semantics: UUID ids, creation-time/ID
ordering, six icon values (`task`, `star`, `home`, `work`, `shopping`,
`heart`), trimmed 1–500-character titles, strict booleans, and automatic
migration defaults for older data (missing icons become Task, existing tasks
start incomplete when the completion field is added). Vectors are stored
directly as `FLOAT[]` alongside the pinned model id, immutable revision,
input-format version and dimension count. Completion changes and
unchanged-source saves preserve embeddings; source edits invalidate them
atomically and schedule re-indexing.

Multiple tabs share one database safely: exactly one tab's worker holds the
origin-wide exclusive Web Lock and serves the OPFS file, while other tabs
proxy repository calls to the owner over local message channels and
reconcile by sequence after sleep or resume. Stale edits and late embedding
results carry revision tokens and are rejected with a conflict instead of
overwriting newer values; uncertain replies are recovered by retrying with
the same operation id rather than duplicating the write.

Request persistent browser storage when the app starts; denial is reported
in the storage panel (export a backup) rather than blocking task use. Quota
and flush failures roll the mutation back and surface as explicit errors
with **Retry**, reusing the same operation id.

## Model loading and search

EmbeddingGemma 2 inference stays in a browser module worker using WebGPU and
the pinned, SHA-256-verified model files. Task controls remain usable while
the model loads or if loading fails; the compact model indicator sits above
the page heading, separate from task rows. **Model ready** means a built-in
sample produced valid output. Failure details and **Retry** appear in the
indicator. Retry starts a fresh worker after a failure or timeout.

Use **Search tasks** to find saved tasks by meaning, including completed
tasks. For example, “purchase food” can find a grocery task. Queries accept
1–500 characters and wait for model readiness. Results include only tasks
meeting the minimum cosine similarity, ranked from closest meaning to least,
up to 20 tasks. Search may return **No matching tasks** even when all tasks
are indexed. Each match shows its raw score, such as **Similarity 0.72**.
Higher cosine similarity means closer meaning; it is not a confidence or
probability score. The status reports when some tasks still lack embeddings,
so an incomplete index is distinguishable from an empty one. Results update
as indexing finishes. Search guidance uses the minimum score returned by the
local repository. **Clear search**, or Escape in the search field, restores
normal list order and removes search scores. The field has one **Clear
search** control. Search updates preserve row drafts, retry controls, and
keyboard focus. A nonmatching row retained for a draft, pending action or
background processing, retry, or focus says **Not a search match**, has no
score, and does not contribute to the result count. It disappears once its
draft, pending action, error, or focus no longer needs protection. Changing
a query or saved task source removes obsolete scores.

The local repository uses an inclusive minimum cosine score of **0.70**,
defined by `MIN_SEARCH_SCORE` in `app/static/database-schema.mjs`. The
pinned q4 model produced these scores with the saved task input format and
icons below:

| Query | Buy groceries (Shopping) | Read a novel (Star) |
| --- | --- | --- |
| purchase food | 0.739 | 0.616 |
| read a story | 0.612 | 0.759 |
| repair the spacecraft engine | 0.598 | 0.639 |

This heuristic cutoff retains both paraphrases, excludes the unrelated task,
and allows the spacecraft query to return no matches. These fixtures
calibrate a useful default for this model; reassess the cutoff if the model
or input format changes.

When the model becomes ready, the app finds saved tasks with missing or
incompatible embeddings and processes them in the background. This includes
older tasks and tasks added during loading. **Refresh**, successful
additions, and saved title or icon edits also check for missing embeddings.
One background inference is submitted at a time so searches can interleave.
Completion changes preserve embeddings; source edits invalidate them and
trigger new processing.

If inference or a vector save fails, the task stays saved and gets a
separate processing **Retry**. Retrying never creates another task. A failed
save reuses its computed vector; an inference retry computes a new one.
**Refresh** also retries pending indexing. Changed or deleted snapshots are
discarded, and conflicts from another tab are reconciled with the current
saved source.

Inference stays in a browser module worker. Task embeddings use confirmed
saved values, never unsaved drafts. Their input is exactly
`Icon: <icon>\nTask: <title>` (input version 1), with the icon's text key
such as `shopping`. Search embeds the trimmed query text with the same
resident model. The resulting 768-value vectors and metadata go to the local
database for storage and ranking; inference never sends task or query text
to a remote model service, and the deployed app makes no task API requests.

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

## Downloads and offline use

The first online visit downloads approximately **207 MB of model files**
(about 174 MB of weights, 32 MB of tokenizer data, plus small configs) from
`huggingface.co` and its CDN, verified by SHA-256 before use. The app shell
(JavaScript, workers, Wasm, styles) is cached separately with a
content-versioned service worker; the large model files live in exactly one
managed cache and are never duplicated. Interrupted downloads and cache
failures never report readiness: model readiness still requires successful
inference, and cache recovery repairs only failed assets without touching
the task database.

After one successful online visit and a complete model download, the app
reopens fully offline: task operations and semantic search work with no
internet connection, reusing the downloaded assets. Ordinary task operations
never depend on model availability. Cache cleanup and app updates preserve
the OPFS task database.

## Browser requirements

Task persistence requires a secure origin (HTTPS or loopback), dedicated
workers, Wasm, OPFS synchronous access handles, and Web Locks. Missing or
denied persistent storage is an explicit error, not a silent fallback.
Semantic search additionally requires WebGPU and the completed model
download from the first online visit.

Verified here: Chromium 140 on Debian Linux (headless, including SwiftShader
software WebGPU), covering OPFS write/flush/worker-termination/reload,
persistent-profile browser restart, multi-tab locking, offline restart with
real inference, and backup round-trips. Firefox, Safari, mobile browsers,
private modes and embedded webviews have not been verified; API presence
alone is not claimed as support. See
[docs/browser-compatibility.md](docs/browser-compatibility.md) for the
repeatable gate and the current support statement.

## Backups

**Export** downloads a versioned JSON backup
(`{format: 'local-todo', version: 1, todos: [...]}`, at most 32 MB)
preserving ids, titles, icons, completion, ordering timestamps and any saved
vectors with metadata. **Import** validates the whole document before
changing anything: bad JSON, wrong format/version, duplicate ids and invalid
values are rejected with no changes, and imports that conflict with existing
tasks are rejected atomically. Re-importing an identical backup skips
unchanged records.

Each browser profile and origin has its own data: there is no cross-device
sync. Clearing site data removes local tasks, embeddings and cached assets
(including the downloaded model). Keep an exported backup somewhere safe.

## Deployment

The deployment is static: `dist/` contains only browser sources and pinned
runtime assets plus a content-hashed `asset-manifest.json`. No Python,
FastAPI, server-side database or task API is involved, and no existing
database or backup is bundled into the assets.

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci
npm run build
```

Deploy `dist/` to Vercel (see `vercel.json`: `npm run build`, output
`dist/`, uncached service worker, no Python install). Exact steps:

1. `npm run build` and confirm `dist/asset-manifest.json` exists.
2. `vercel --prod` from the project directory (or connect the repository in
   the Vercel dashboard; the checked-in `vercel.json` supplies the build).
3. Open the deployed HTTPS origin, create a task, reload, and confirm it
   persists; then export a backup.

Actual deployment is a separate request; this repository only prepares the
static configuration.

## Verify

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci
npm run build
python3 tests/test_model_assets.py   # static dist, pins, retained unit suites
npm test                             # repository, backup, runtime and panel suites
npm run test:opfs                     # OPFS persistence gate (persistent profile)
npm run test:integration              # persistence/restart, tabs, guards, backups, usability
npm run test:network                 # offline restart, real inference, zero-backend audit
```

`tests/test_model_assets.py` needs only the system Python 3 standard library
plus Node 22 (`MODEL_TEST_NODE` overrides discovery). Browser specs start
their own ephemeral loopback servers and persistent profiles, close
everything themselves, and keep reusable model downloads under
`XDG_CACHE_HOME`; no profile or private database enters the build. The
offline inference check needs the five pinned model files cached locally
(about 207 MB, SHA-256 verified on use) and a WebGPU-capable Chromium;
without them it reports the missing cache instead of passing.
