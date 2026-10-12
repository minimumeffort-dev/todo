"""HTTP contracts for the Vite distribution served by the real FastAPI app."""

import hashlib
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

from fastapi.testclient import TestClient
import httpx
import pytest

from app.main import (
    create_app, EMBEDDING_MODEL, EMBEDDING_REVISION,
    EMBEDDING_DIMENSIONS, EMBEDDING_INPUT_VERSION,
)

ROOT = Path(__file__).resolve().parents[1]
CONTENT_TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
}


@pytest.fixture(scope="module")
def built_dist(tmp_path_factory):
    output = tmp_path_factory.mktemp("serving-build") / "dist"
    # Build real pinned assets without rewriting the repository's distribution.
    subprocess.run(
        [shutil.which("node") or "node", str(ROOT / "node_modules/vite/bin/vite.js"),
         "build", "--outDir", str(output)],
        cwd=ROOT, check=True, capture_output=True, text=True, timeout=30,
    )
    return output


@pytest.fixture
def client(built_dist, tmp_path):
    with TestClient(create_app(tmp_path / "todos.duckdb", dist_path=built_dist)) as client:
        yield client


def assert_manifest_assets(client, distribution):
    response = client.get("/asset-manifest.json")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.headers["cache-control"] == "no-cache"
    assert response.content == (distribution / "asset-manifest.json").read_bytes()
    manifest = response.json()
    assert len(manifest["version"]) == len(manifest["shellVersion"]) == 64
    entries = {entry["url"]: entry for entry in manifest["assets"]}
    assert {"/index.html", "/service-worker.mjs", "/static/app.js",
            "/vendor/transformers/transformers.min.js", "/vendor/duckdb/duckdb-browser.mjs",
            "/vendor/duckdb/duckdb-mvp.wasm", "/vendor/onnx/ort-wasm-simd-threaded.asyncify.mjs",
            "/vendor/onnx/ort-wasm-simd-threaded.asyncify.wasm"} <= entries.keys()
    for url, entry in entries.items():
        response = client.get(url)
        assert response.status_code == 200, url
        assert response.headers["content-type"].split(";")[0] == CONTENT_TYPES[Path(url).suffix], url
        assert response.content == (distribution / url.lstrip("/")).read_bytes(), url
        assert len(response.content) == entry["size"], url
        assert hashlib.sha256(response.content).hexdigest() == entry["sha256"], url
    worker = client.get("/service-worker.mjs")
    assert manifest["shellVersion"] in worker.text
    assert "__SHELL_VERSION__" not in worker.text
    root = client.get("/")
    assert root.status_code == 200
    assert root.content == (distribution / "index.html").read_bytes()


def test_every_built_asset_is_served_unchanged(client, built_dist):
    assert_manifest_assets(client, built_dist)


@pytest.mark.parametrize("url", ["/service-worker.mjs", "/asset-manifest.json"])
def test_worker_and_manifest_revalidate(client, url):
    response = client.get(url)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"
    head = client.head(url)
    assert head.status_code == 200
    assert head.content == b""
    assert head.headers["content-length"] == response.headers["content-length"]
    assert head.headers["content-type"] == response.headers["content-type"]
    revalidated = client.get(url, headers={"If-None-Match": response.headers["etag"]})
    assert revalidated.status_code == 304
    assert revalidated.content == b""
    assert revalidated.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize("url", ["/static/missing.mjs", "/vendor/onnx/missing.wasm", "/missing",
                                 "/static/", "/vendor/", "/api/missing"])
def test_missing_assets_never_return_the_shell(client, url):
    response = client.get(url)
    assert response.status_code == 404
    assert response.json() == {"detail": "Not Found"}


@pytest.mark.parametrize("missing", ["directory", "index.html", "service-worker.mjs",
                                     "asset-manifest.json", "static/app.js",
                                     "vendor/transformers/transformers.min.js"])
def test_incomplete_build_is_actionable_and_api_still_works(built_dist, tmp_path, missing):
    distribution = tmp_path / "dist"
    # Isolate the incomplete build; never alter the real generated assets.
    if missing != "directory":
        for source in built_dist.rglob("*"):
            relative = source.relative_to(built_dist)
            if source.is_file() and str(relative) != missing:
                target = distribution / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                # Only file availability is relevant to this incomplete build.
                target.write_bytes(source.read_bytes() if source.suffix not in (".wasm",) else b"wasm fixture")
    with TestClient(create_app(tmp_path / "todos.duckdb", dist_path=distribution)) as client:
        response = client.get("/")
        assert response.status_code == 503
        assert "npm run build" in response.json()["detail"]
        assert "restart" in response.json()["detail"].lower()
        assert client.get("/health").json() == {"status": "ok"}
        created = client.post("/api/todos", json={"title": "Kept without a build", "icon": "star"})
        assert created.status_code == 201
        assert client.get("/api/todos").json() == [created.json()]
        assert client.delete(f"/api/todos/{created.json()['id']}").status_code == 204
        assert client.get("/api/todos").json() == []
        missing_url = "/service-worker.mjs" if missing == "directory" else "/" + missing
        assert client.get(missing_url).status_code == (503 if missing_url == "/index.html" else 404)
        assert client.get("/static/missing.mjs").status_code == 404


@pytest.mark.parametrize("manifest", ["{", "null", "{}", '{"assets": []}',
                                      '{"assets": [{"url": 42}]}',
                                      '{"assets": [{"url": "/../private.txt"}]}'])
def test_unusable_manifest_is_actionable(tmp_path, manifest):
    distribution = tmp_path / "dist"
    distribution.mkdir()
    (distribution / "index.html").write_text("shell")
    (distribution / "service-worker.mjs").write_text("worker")
    (distribution / "asset-manifest.json").write_text(manifest)
    (tmp_path / "private.txt").write_text("private data")
    with TestClient(create_app(tmp_path / "todos.duckdb", dist_path=distribution)) as client:
        response = client.get("/")
        assert response.status_code == 503
        assert response.headers["cache-control"] == "no-cache"
        assert "npm run build" in response.json()["detail"]
        assert client.get("/health").json() == {"status": "ok"}


@pytest.mark.parametrize("url", ["/%2e%2e/private.txt", "/static/%2e%2e/%2e%2e/private.txt",
                                 "/vendor/%2e%2e/%2e%2e/private.txt", "/%2e%2e%2fprivate.txt",
                                 "/static/%2e%2e%2f%2e%2e%2fprivate.txt", "/private.txt",
                                 "/static/outside.mjs", "/vendor/outside/private.txt"])
def test_traversal_and_symlinks_cannot_leave_dist(tmp_path, url):
    distribution = tmp_path / "dist"
    (distribution / "static").mkdir(parents=True)
    (tmp_path / "private.txt").write_text("private data")
    (distribution / "static/outside.mjs").symlink_to(tmp_path / "private.txt")
    (distribution / "vendor").mkdir()
    (distribution / "vendor/outside").symlink_to(tmp_path, target_is_directory=True)
    (distribution / "static/inside.mjs").write_text("export const inside = true;")
    with TestClient(create_app(tmp_path / "todos.duckdb", dist_path=distribution)) as client:
        assert client.get("/static/inside.mjs").text == "export const inside = true;"
        response = client.get(url)
        assert response.status_code == 404
        assert "private data" not in response.text


def test_symlinked_shell_cannot_leave_dist(built_dist, tmp_path):
    distribution = tmp_path / "dist"
    distribution.mkdir()
    for name in ("index.html", "service-worker.mjs", "asset-manifest.json"):
        (distribution / name).symlink_to(built_dist / name)
    with TestClient(create_app(tmp_path / "todos.duckdb", dist_path=distribution)) as client:
        assert client.get("/").status_code == 503
        assert client.get("/index.html").status_code == 503


def test_build_directory_is_a_file(tmp_path):
    distribution = tmp_path / "dist"
    distribution.write_text("incomplete build")
    with TestClient(create_app(tmp_path / "todos.duckdb", dist_path=distribution)) as client:
        assert client.get("/").status_code == 503
        assert client.get("/service-worker.mjs").status_code == 404
        assert client.get("/health").json() == {"status": "ok"}


def test_default_distribution_is_independent_of_working_directory(tmp_path, monkeypatch):
    shadow = tmp_path / "dist"
    shadow.mkdir()
    (shadow / "index.html").write_text("wrong origin's shell")
    (shadow / "service-worker.mjs").write_text("wrong worker")
    monkeypatch.chdir(tmp_path)
    with TestClient(create_app(tmp_path / "todos.duckdb")) as client:
        worker = ROOT / "dist/service-worker.mjs"
        response = client.get("/service-worker.mjs")
        if worker.is_file():
            assert response.status_code == 200
            assert response.content == worker.read_bytes()
        else:
            assert response.status_code == 404
            assert client.get("/").status_code == 503


def follow_api_slash_redirect(client, method, canonical_path, **kwargs):
    url = canonical_path + "/?attempt=1"
    response = client.request(method, url, follow_redirects=False, **kwargs)
    assert response.status_code == 307
    assert response.headers["location"] == "http://testserver" + canonical_path + "?attempt=1"
    followed = client.request(method, url, follow_redirects=True, **kwargs)
    assert [response.status_code for response in followed.history] == [307]
    return followed


@pytest.mark.parametrize("with_build", [False, True])
def test_trailing_slash_api_redirects_preserve_crud_and_embeddings(built_dist, tmp_path, with_build):
    distribution = built_dist if with_build else tmp_path / "absent-dist"
    with TestClient(create_app(tmp_path / "todos.duckdb", dist_path=distribution)) as client:
        assert follow_api_slash_redirect(client, "GET", "/health").json() == {"status": "ok"}
        created = follow_api_slash_redirect(client, "POST", "/api/todos",
                                            json={"title": "  Redirected task  ", "icon": "star"})
        assert created.status_code == 201
        original = created.json()
        assert original == {"id": original["id"], "title": "Redirected task",
                            "icon": "star", "completed": False}
        assert follow_api_slash_redirect(client, "GET", "/api/todos").json() == [original]

        path = f"/api/todos/{original['id']}"
        updated = follow_api_slash_redirect(client, "PUT", path,
                                            json={"title": "Edited through redirect", "icon": "home"})
        assert updated.status_code == 200
        edited = {**original, "title": "Edited through redirect", "icon": "home"}
        assert updated.json() == edited
        completed = follow_api_slash_redirect(client, "PATCH", path, json={"completed": True})
        assert completed.status_code == 200
        saved = {**edited, "completed": True}
        assert completed.json() == saved
        assert follow_api_slash_redirect(client, "GET", "/api/todos/embeddings/pending").json() == [saved]

        query = {"model": EMBEDDING_MODEL, "revision": EMBEDDING_REVISION,
                 "dimensions": EMBEDDING_DIMENSIONS, "input_version": EMBEDDING_INPUT_VERSION,
                 "vector": [1.0] + [0.0] * (EMBEDDING_DIMENSIONS - 1)}
        uploaded = follow_api_slash_redirect(client, "PUT", path + "/embedding",
                                             json={**query, "title": saved["title"], "icon": saved["icon"]})
        assert uploaded.status_code == 204
        assert uploaded.content == b""
        assert follow_api_slash_redirect(client, "GET", "/api/todos/embeddings/pending").json() == []
        searched = follow_api_slash_redirect(client, "POST", "/api/todos/search", json=query)
        assert searched.status_code == 200
        assert searched.json()["matches"] == [{"todo": saved, "score": 1.0}]
        assert searched.json()["pending_count"] == 0

        deleted = follow_api_slash_redirect(client, "DELETE", path)
        assert deleted.status_code == 204
        assert deleted.content == b""
        assert follow_api_slash_redirect(client, "GET", "/api/todos").json() == []


@pytest.mark.parametrize("method, path, payload, expected_status", [
    ("POST", "/api/todos", {"title": ""}, 422),
    ("PUT", "/api/todos/missing", {"title": "Missing", "icon": "task"}, 404),
    ("PATCH", "/api/todos/missing", {"completed": True}, 404),
    ("DELETE", "/api/todos/missing", None, 404),
    ("PUT", "/api/todos/missing/embedding", {}, 422),
    ("POST", "/api/todos/search", {}, 422),
    ("HEAD", "/api/todos", None, 405),
])
def test_trailing_slash_api_redirects_preserve_errors(tmp_path, method, path, payload, expected_status):
    with TestClient(create_app(tmp_path / "todos.duckdb", dist_path=tmp_path / "absent-dist")) as client:
        response = follow_api_slash_redirect(client, method, path, json=payload)
        assert response.status_code == expected_status
        if expected_status == 404:
            assert response.json() == {"detail": "To-do item not found"}
        elif expected_status == 422:
            assert response.json()["detail"][0]["loc"][0] == "body"
        else:
            assert response.content == b""
        assert client.get("/api/todos").json() == []


@pytest.mark.parametrize("path", ["/api/not-a-route", "/health/private", "/not-shipped.txt"])
def test_distribution_cannot_shadow_non_asset_paths(tmp_path, path):
    distribution = tmp_path / "dist"
    hidden = distribution / path.lstrip("/")
    hidden.parent.mkdir(parents=True, exist_ok=True)
    hidden.write_text("not a browser asset")
    with TestClient(create_app(tmp_path / "todos.duckdb", dist_path=distribution)) as client:
        response = client.get(path, follow_redirects=False)
        assert response.status_code == 404
        assert response.json() == {"detail": "Not Found"}


def test_uvicorn_serves_the_manifest_on_a_real_loopback_socket(built_dist, tmp_path):
    # The factory selects only an isolated dist. The host is actual Uvicorn,
    # rather than the hand-written static server used by retained browser tests.
    (tmp_path / "serving_host.py").write_text(
        "from app.main import create_app\n"
        f"def app():\n    return create_app({str(tmp_path / 'todos.duckdb')!r}, dist_path={str(built_dist)!r})\n"
    )
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1",
               PYTHONPATH=os.pathsep.join([str(ROOT), str(tmp_path)]))
    with socket.socket() as listener, (tmp_path / "uvicorn.log").open("w+") as log:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        command = [sys.executable, "-B", "-m", "uvicorn", "serving_host:app", "--factory",
                   "--fd", str(listener.fileno()), "--log-level", "warning"]
        process = subprocess.Popen(command, cwd=tmp_path, env=env,
                                   pass_fds=(listener.fileno(),), stdout=log, stderr=log)
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=3, trust_env=False) as client:
                deadline = time.monotonic() + 10
                while True:
                    try:
                        assert client.get("/health").json() == {"status": "ok"}
                        break
                    except httpx.TransportError:
                        if process.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            pytest.fail("Uvicorn did not start: " + log.read())
                        time.sleep(0.05)
                assert_manifest_assets(client, built_dist)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


@pytest.mark.parametrize("entry", ["/", "/index.html"])
@pytest.mark.parametrize("method", ["GET", "HEAD"])
@pytest.mark.parametrize("build", ["complete", "missing_directory", "missing_manifest", "invalid_manifest", "missing_worker", "missing_payload"])
def test_html_entry_points_share_completeness_guard(tmp_path, entry, method, build):
    distribution = tmp_path / "dist"
    if build != "missing_directory":
        (distribution / "static").mkdir(parents=True)
        (distribution / "index.html").write_text("shell")
        (distribution / "service-worker.mjs").write_text("worker")
        (distribution / "static/app.js").write_text("payload")
        (distribution / "asset-manifest.json").write_text('{"assets": [{"url": "/static/app.js"}]}')
        if build == "missing_manifest":
            (distribution / "asset-manifest.json").unlink()
        elif build == "invalid_manifest":
            (distribution / "asset-manifest.json").write_text("null")
        elif build == "missing_worker":
            (distribution / "service-worker.mjs").unlink()
        elif build == "missing_payload":
            (distribution / "static/app.js").unlink()
    with TestClient(create_app(tmp_path / "todos.duckdb", dist_path=distribution)) as client:
        response = client.request(method, entry)
        assert response.status_code == (200 if build == "complete" else 503)
        assert response.headers["cache-control"] == "no-cache"
        if method == "HEAD":
            assert response.content == b""
        elif build == "complete":
            assert response.content == b"shell"
        else:
            assert "npm run build" in response.json()["detail"]
            assert "restart" in response.json()["detail"].lower()
        assert client.get("/health").json() == {"status": "ok"}
        assert client.get("/static/absent.js").status_code == 404
