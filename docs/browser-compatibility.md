# Browser storage compatibility gate

The browser toolchain pins Node **22.16.0**, npm **10.9.2**, Vite **7.1.3**,
DuckDB-Wasm **1.33.1-dev65.0**, Transformers.js **4.3.1** and Playwright
**1.55.1**. Dependency versions and package integrity are recorded in
`package-lock.json`. DuckDB-Wasm's npm release is a development version; this
exact pin must pass the persistence gate again before any upgrade.

## Documentation and implementation evidence

The required [DuckDB-Wasm OPFS documentation](https://duckdb.org/docs/current/clients/wasm/instantiation#persistence-with-opfs)
was retrieved successfully on 2026-10-08. The retrieved HTML SHA-256 was
`7f8d258eb1828e55045b3ecc43615b068c77d9c3d5a219f823562d58bef2a0a0`.
The persistence section explicitly gives:

```js
await db.open({
  path: 'opfs://duckdb.db',
  accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
});
await conn.query('CHECKPOINT'); // Flush changes to OPFS so they survive a reload.
```

It says that reopening the same path in a later session restores tables,
that synchronous OPFS handles are available only in workers, and that each
file can be held by only one handle at a time. It recommends `dropFile()` or
`dropFiles()` before another instance opens registered files. These calls
release file registrations; they do not delete the persistent database.

The pinned npm artifact has integrity
`sha512-qK8BQySzhixj5mY040Qs/aGJbF09B6dP5U8RyASndnk8HFdeWEQuOKeFm+7+cbVuLS78jaXLaFkdVpwVs1Ww8A==`
and package git head `448ec38a52238ad2aacde514f0ee3acfd9515b6c`.
Its distributed worker source map contains `src/parallel/worker_dispatcher.ts`,
whose `OPEN` handler detects `opfs://`, awaits `prepareDBFileHandle()` and
sets `useDirectIO=true`. In `src/bindings/runtime_browser.ts`,
`prepareDBFileHandle()` acquires handles for the database and its `.wal`.
`closeFile` flushes handles; `dropFile` flushes and closes them.

**Do not use `flushFiles()` alone as a durability acknowledgement.** This
pin's `syncFile` callback is empty. To expose native flush failures reliably,
use its blocking browser bindings inside the dedicated database worker:

```js
import { createDuckDB, BROWSER_RUNTIME, DuckDBDataProtocol,
  DuckDBAccessMode, VoidLogger } from '/vendor/duckdb/duckdb-browser-blocking.mjs';
import { DUCKDB_BUNDLES, DATABASE_PATH, flushOPFSHandles }
  from '/static/storage-contract.mjs';

// The worker must hold the origin-wide exclusive Web Lock for this lifetime.
const db = await createDuckDB(DUCKDB_BUNDLES, new VoidLogger(), BROWSER_RUNTIME);
await db.instantiate();
await db.prepareDBFileHandle(DATABASE_PATH, DuckDBDataProtocol.BROWSER_FSACCESS);
db.open({ path: DATABASE_PATH, accessMode: DuckDBAccessMode.READ_WRITE, useDirectIO: true });
const connection = db.connect();
// Run and commit each serialized transaction, then:
connection.query('CHECKPOINT');
flushOPFSHandles(BROWSER_RUNTIME); // Native FileSystemSyncAccessHandle.flush().
// Only now acknowledge the save. Any error means durability is unconfirmed.
```

The small pin-specific barrier reads the runtime's `_files` registry and
directly flushes the database and any registered WAL. It fails if the
database handle is missing and lets native exceptions propagate. This
internal registry coupling is deliberate and covered by the real-worker
gate; it must be reviewed on upgrades. The page still uses Promise-based
local RPC; synchronous SQL runs exclusively inside the owner worker.

## Repeating the gate

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci
npm run build
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}" \
  PLAYWRIGHT_BROWSERS_PATH="${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright" \
  npx playwright install chromium
npm run test:opfs
npm test
```

`tests/browser/opfs.spec.mjs` starts a loopback server on an allocated port,
serves the built `dist` assets, creates a temporary persistent Chromium
profile, and closes both browser and server itself. Browser downloads remain
under `XDG_CACHE_HOME`; no profile or private database enters the build.
The tests verify the documented async OPFS path, native worker flushing,
worker termination, page reload, full browser close/reopen with the same
profile, task IDs/completion/vector preservation, both EH and MVP Wasm,
exclusive Web Lock exclusion and flush-error propagation. They do not require
internet access or isolation headers at runtime.

## Browser requirements and limits

Task persistence requires a secure origin (HTTPS or loopback), dedicated
workers, Wasm, OPFS synchronous access handles, and Web Locks. Missing or
denied OPFS is an error; there must be no in-memory fallback. The single
threaded EH/MVP bundles need no `SharedArrayBuffer`, COOP or COEP headers.
Model inference additionally requires WebGPU and the complete pinned model
download. Ordinary task controls must remain independent of it.

The foundation gate targets Chromium 140.0.7339.186 on Debian 12 Linux arm64.
Both the documented async API and the explicit worker-native flush barrier
passed the restart proof with **1.33.1-dev65.0**. The earlier candidate
**1.33.1-dev57.0** failed: SQL succeeded but the OPFS database remained empty
because its engine normalized `opfs://` to `opfs:/` while registered handle
paths retained two slashes. Do not substitute that release or assume that
any version exposing OPFS configuration necessarily persists new databases.
Firefox, Safari, mobile browsers, private modes and embedded webviews have
not been verified here. API presence alone is insufficient to claim support.
Persistent-storage permission can be denied even where OPFS works; later
storage integration must request it, report the result, and handle quota and
flush errors without reporting a confirmed save.

The build emits only browser source and pinned runtime assets plus a
content-hashed `asset-manifest.json`. Runtime URLs are `/static/...`,
`/vendor/duckdb/...`, `/vendor/transformers/transformers.min.js` and
`/vendor/onnx/...`. A root `/service-worker.mjs`, when supplied by the offline
task, receives root scope. Vercel serves `dist` with no Python execution.
`npm run dev` serves the same URLs and source edits appear after reload;
`npm run preview` serves the built artifact. The offline task must connect
model loading to these local assets and implement the shell/model cache;
the interface/database tasks must replace the existing task API operations.

Installation sets `ONNXRUNTIME_NODE_INSTALL=skip` to avoid the Transformers.js
transitive Node runtime's unused CUDA download on Linux x64 (including
Vercel). All deployed inference code comes from the pinned browser assets;
the static build requires no native inference runtime, Python or CUDA.

The exported repository shapes, revision preconditions, operation IDs,
error codes, model metadata and backup policy are documented in
`app/static/storage-contract.mjs`. Data belongs to a browser profile and
origin; there is no cross-device sync. Clearing site data removes both local
tasks and cached assets. Neither existing DuckDB files nor backups are
copied into deployed assets.

## Static-app verification (2026-10-08)

The verification specs run the built `dist/` app with no backend:

- `tests/browser/integration.spec.mjs` drives the real OPFS-backed worker
  through UI persistence across reload and full persistent-profile browser
  restart, second-tab writes with refresh reconciliation, stale
  edit/embedding rejection, truthful quota errors with same-operationId
  recovery, backup export/import round-trips with invalid/conflicting import
  rejection, keyboard-only creation, a 375px touch layout and reduced motion,
  while auditing zero `/api/` and zero non-origin requests.
- `tests/browser/network.spec.mjs` creates tasks through the real database
  worker while online, caches the app shell and the five pinned model files,
  shuts the HTTP server down, and restarts the same profile offline: the app
  shell loads from cache, the persisted tasks are visible, the app
  auto-loads the model and backfills embeddings into the reopened local
  database, and a UI search ranks the paraphrase first with a real score at
  or above the 0.70 cutoff — with no task API request, no
  loopback-external request, and no task/query text in any remote payload.
  No second test-owned database worker is spawned offline: the app page
  owns the exclusive database lock, so offline database access goes through
  the app's own owner.
- `tests/test_model_assets.py` (stdlib only) checks the static `dist/`
  contents, the absence of `/api/` and remote-inference hosts in shipped
  code, the retained pins, the Vercel configuration, and the retained Node
  unit suites.

Tested browser support: Chromium 140 headless on Debian 12 Linux arm64,
including SwiftShader software WebGPU for the real-inference restart proof.
No other browser is claimed. The page entry (`app/static/app.js`) wires the
coordinator to `navigator.locks`, `navigator.storage`, a database-channel
BroadcastChannel, and a real worker owner factory; the coordinator treats a
null `ifAvailable` grant as a refusal and takes the proxy path instead of
spawning a competing owner. Persistence across reload, full-profile restart,
and second-tab writes with refresh reconciliation pass against the built
app. Firefox, Safari, mobile browsers, private modes and embedded webviews
remain unverified, and API presence alone is still insufficient to claim
support.
