"""Static distribution checks for the browser-only build (standard library only).

The app no longer has a Python backend: there is no FastAPI server, no
``/api/todos`` traffic and no server-side database. These checks run against
the built static ``dist/`` output and the pinned browser sources, plus the
retained Node unit suites. Run with ``python3 tests/test_model_assets.py``;
any failure exits nonzero. Browser scenarios live in ``tests/browser/`` and
are invoked per-file so each fits its own time budget.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
STATIC = ROOT / "app" / "static"

MODEL_ID = "onnx-community/embeddinggemma-2-ONNX"
MODEL_REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0"
TRANSFORMERS_PIN = '"@huggingface/transformers": "4.3.1"'
DUCKDB_PIN = '"@duckdb/duckdb-wasm": "1.33.1-dev65.0"'

NODE_SUITES = [
    "tests/todo_store.test.mjs",
    "tests/task_backup.test.mjs",
    "tests/model_cache.test.mjs",
    "tests/model_runtime.test.mjs",
    "tests/app.test.mjs",
    "tests/model_panel.test.mjs",
    "tests/storage_panel.test.mjs",
]

FAILURES = []


def check(name, condition, detail=""):
    print(("PASS " if condition else "FAIL ") + name + (f" ({detail})" if detail and not condition else ""))
    if not condition:
        FAILURES.append(name + (f": {detail}" if detail else ""))


def node_executable():
    configured = os.environ.get("MODEL_TEST_NODE")
    installed = shutil.which("node")
    home = Path.home()
    managed = sorted((home / ".local/share/mise/installs/node").glob("22*/bin/node"))
    result = configured or installed or (str(managed[-1]) if managed else "")
    return result if result and Path(result).is_file() else ""


def main():
    # Reproducible static build exists and is self-contained.
    check("dist asset manifest exists", (DIST / "asset-manifest.json").is_file())
    check("dist index exists", (DIST / "index.html").is_file())
    for asset in ("static/app.js", "static/database-worker.mjs",
                  "static/model-worker.mjs", "static/model-runtime.mjs",
                  "vendor/duckdb/duckdb-mvp.wasm", "vendor/duckdb/duckdb-eh.wasm",
                  "vendor/transformers/transformers.min.js",
                  "vendor/onnx/ort-wasm-simd-threaded.asyncify.mjs",
                  "vendor/onnx/ort-wasm-simd-threaded.asyncify.wasm"):
        check(f"dist contains {asset}", (DIST / asset).is_file())
    check("dist contains no database", not list(DIST.rglob("*.duckdb")))
    check("dist contains no backups", not list(DIST.rglob("local-todo-backup*"))
          and not list(DIST.rglob("*.duckdb-wal")))

    # No task API traffic or remote inference in shipped browser code.
    shipped = ""
    for path in ("app.js", "todo-store.mjs", "database-worker.mjs",
                 "database-coordinator.mjs", "model-worker.mjs",
                 "model-runtime.mjs", "model-cache.mjs", "offline.mjs",
                 "service-worker.mjs", "task-backup.mjs", "storage-panel.mjs",
                 "model-panel.mjs"):
        shipped += (STATIC / path).read_text()
    check("no task API paths in shipped code", "/api/" not in shipped)
    # The pinned download host appears only in the model download manager and
    # a worker error string; nothing else may reference remote hosts, and no
    # shipped module posts task or query text anywhere (only same-origin GET
    # asset caching and OPFS-local writes exist).
    remote_holders = [path.name for path in STATIC.glob("*.mjs")
                      if "huggingface.co" in (STATIC / path.name).read_text()]
    check("download host confined to model cache", sorted(remote_holders) == ["model-cache.mjs", "model-worker.mjs"],
          str(remote_holders))
    check("no jsdelivr/cdn hosts in shipped code",
          not any(host in shipped for host in ("jsdelivr", "cdn.hf.co", "us.aws.cdn")))
    check("no remote posts in shipped code", "method: 'POST'" not in shipped and "XMLHttpRequest" not in shipped)
    pins = ((STATIC / "storage-contract.mjs").read_text()
            + (STATIC / "model-worker.mjs").read_text()
            + (STATIC / "model-cache.mjs").read_text())
    check("model id pin retained", MODEL_ID in pins)
    check("model revision pin retained", MODEL_REVISION in pins)
    expected_hashes = ("8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d",
                       "17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874",
                       "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4",
                       "f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9",
                       "c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49")
    check("model cache holds five immutable files",
          all(digest in pins for digest in expected_hashes))

    # Pinned toolchain and deployment configuration.
    lock = (ROOT / "package-lock.json").read_text()
    package = json.loads((ROOT / "package.json").read_text())
    check("duckdb-wasm pin retained", DUCKDB_PIN in (ROOT / "package.json").read_text()
          and "1.33.1-dev65.0" in lock)
    check("transformers pin retained", TRANSFORMERS_PIN in (ROOT / "package.json").read_text()
          and "4.3.1" in lock)
    vercel = json.loads((ROOT / "vercel.json").read_text())
    check("vercel serves dist", vercel.get("outputDirectory") == "dist")
    check("vercel build is static", vercel.get("buildCommand") == "npm run build"
          and "uvicorn" not in json.dumps(vercel) and "python" not in json.dumps(vercel).lower())
    check("vercel keeps service worker uncached",
          "service-worker.mjs" in json.dumps(vercel))
    check("no python server dependency in scripts",
          all("uvicorn" not in script and "pytest" not in script
              for script in package.get("scripts", {}).values()))
    manifest = json.loads((DIST / "asset-manifest.json").read_text())
    check("manifest has content version", bool(manifest.get("version")) and bool(manifest.get("shellVersion")))
    # The ONNX *runtime* (/vendor/onnx/*.wasm) is a local dependency; model
    # weights/tokenizer data and databases must never be bundled.
    check("manifest excludes model and database assets",
          all(not any(token in entry["url"] for token in ("model_q4", "tokenizer", ".onnx", ".duckdb"))
              for entry in manifest.get("assets", [])))

    # README documents the browser-only architecture, downloads, browser
    # requirements, backup controls and static deployment steps.
    readme = (ROOT / "README.md").read_text()
    for token in ("Origin Private File System", "1.33.1-dev65.0", "huggingface.co",
                  "Web Locks", "local-todo", "vercel --prod", "no cross-device",
                  "Clearing site data", "Model ready"):
        check(f"readme documents {token[:24]}", token in readme, token)
    compat = (ROOT / "docs" / "browser-compatibility.md").read_text()
    check("compatibility states tested browser", "Chromium 140" in compat)
    check("compatibility claims no other browser", "No other browser is claimed" in compat)
    check("compatibility reports no open blocker", "Known blocker" not in compat)

    # Retained Node unit suites still pass (model pins, store, backup, panels).
    node = node_executable()
    check("node 22 available", bool(node), "install node@22 or set MODEL_TEST_NODE")
    if node:
        for suite in NODE_SUITES:
            try:
                subprocess.run([node, "--test", str(ROOT / suite)], check=True,
                               capture_output=True, text=True, timeout=25, cwd=str(ROOT))
                check(f"node suite {Path(suite).name}", True)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
                detail = ""
                if isinstance(error, subprocess.CalledProcessError):
                    detail = (error.stderr or error.stdout or "")[-500:]
                check(f"node suite {Path(suite).name}", False, detail or "timeout")

    if FAILURES:
        print(f"\n{len(FAILURES)} static check(s) failed.")
        sys.exit(1)
    print("\nStatic distribution checks passed.")


if __name__ == "__main__":
    main()
