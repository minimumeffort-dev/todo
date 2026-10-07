"""Durable task embeddings and source-checked API writes, with isolated DuckDB files."""

from concurrent.futures import ThreadPoolExecutor
import json
from threading import Barrier

import duckdb
from fastapi.testclient import TestClient
import pytest

from app.db import EMBEDDING_COLUMNS, TodoStore
from app.main import (
    create_app, EMBEDDING_MODEL, EMBEDDING_REVISION,
    EMBEDDING_DIMENSIONS, EMBEDDING_INPUT_VERSION,
)


def payload(task, **changes):
    return {
        "title": task["title"], "icon": task["icon"],
        "vector": [0.25, -0.75] + [0.0] * (EMBEDDING_DIMENSIONS - 2),
        "model": EMBEDDING_MODEL, "revision": EMBEDDING_REVISION,
        "input_version": EMBEDDING_INPUT_VERSION, "dimensions": EMBEDDING_DIMENSIONS,
        **changes,
    }


def stored(database, item_id):
    with duckdb.connect(str(database)) as connection:
        return connection.execute(
            f"SELECT {', '.join(EMBEDDING_COLUMNS)} FROM todos WHERE id = ?", [item_id]
        ).fetchone()


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / "todos.duckdb")) as test_client:
        yield test_client


def test_lifecycle_migration_and_persistence(tmp_path):
    database = tmp_path / "legacy.duckdb"
    with duckdb.connect(str(database)) as connection:
        connection.execute(
            "CREATE TABLE todos (id VARCHAR PRIMARY KEY, title VARCHAR NOT NULL, "
            "created_at TIMESTAMP DEFAULT current_timestamp, icon VARCHAR, completed BOOLEAN)"
        )
        connection.execute("INSERT INTO todos VALUES ('old', 'Saved task', '2025-01-02', 'heart', true)")
    task = {"id": "old", "title": "Saved task", "icon": "heart", "completed": True}
    with TestClient(create_app(database)) as first:
        assert first.get("/api/todos").json() == [task]
        assert stored(database, "old") == (None,) * 5
        original = payload(task)
        response = first.put("/api/todos/old/embedding", json=original)
        assert response.status_code == 204
        assert response.content == b""
        assert first.get("/api/todos").json() == [task]
    with TestClient(create_app(database)) as restarted:
        assert restarted.get("/api/todos").json() == [task]
        assert stored(database, "old") == (
            original["vector"], EMBEDDING_MODEL, EMBEDDING_REVISION, 1, EMBEDDING_DIMENSIONS,
        )
        with duckdb.connect(str(database)) as connection:
            columns = {row[1]: row[2] for row in connection.execute("PRAGMA table_info('todos')").fetchall()}
            assert columns["embedding"] == "FLOAT[]"
            assert connection.execute("SELECT created_at FROM todos WHERE id = 'old'").fetchone()[0].isoformat() == "2025-01-02T00:00:00"


def test_lifecycle_oldest_database_and_optional_creation(tmp_path):
    database = tmp_path / "oldest.duckdb"
    with duckdb.connect(str(database)) as connection:
        connection.execute("CREATE TABLE todos (id VARCHAR PRIMARY KEY, title VARCHAR NOT NULL, created_at TIMESTAMP DEFAULT current_timestamp)")
        connection.execute("INSERT INTO todos (id, title) VALUES ('old', 'Before icons')")
    with TestClient(create_app(database)) as test_client:
        task = test_client.get("/api/todos").json()[0]
        assert task == {"id": "old", "title": "Before icons", "icon": "task", "completed": False}
        new = test_client.post("/api/todos", json={"title": "No model required"}).json()
        assert stored(database, "old") == (None,) * 5
        assert stored(database, new["id"]) == (None,) * 5


@pytest.mark.parametrize("changes", [{"title": "Changed title"}, {"icon": "work"}])
def test_lifecycle_completion_noop_edit_invalidation_and_deletion(tmp_path, changes):
    database = tmp_path / "todos.duckdb"
    with TestClient(create_app(database)) as test_client:
        task = test_client.post("/api/todos", json={"title": "Buy food", "icon": "shopping"}).json()
        url = f"/api/todos/{task['id']}"
        assert test_client.put(url + "/embedding", json=payload(task)).status_code == 204
        original = stored(database, task["id"])
        for completed in (True, True, False):
            assert test_client.patch(url, json={"completed": completed}).status_code == 200
            assert stored(database, task["id"]) == original
        assert test_client.put(url, json={"title": "  Buy food  ", "icon": "shopping"}).status_code == 200
        assert stored(database, task["id"]) == original
        changed = {"title": task["title"], "icon": task["icon"], **changes}
        edited = test_client.put(url, json=changed).json()
        assert stored(database, task["id"]) == (None,) * 5
        assert test_client.put(url + "/embedding", json=payload(edited)).status_code == 204
    with TestClient(create_app(database)) as restarted:
        assert stored(database, task["id"])[0] is not None
        assert restarted.delete(url).status_code == 204
        assert stored(database, task["id"]) is None
    with TestClient(create_app(database)) as restarted_again:
        assert restarted_again.get("/api/todos").json() == []


@pytest.mark.parametrize("changes", [
    {"vector": []}, {"vector": [1.0] * 767}, {"vector": [1.0] * 769},
    {"vector": [0.0] * 768}, {"vector": [1e-100] * 768}, {"vector": [1e100] * 768},
    {"vector": ["0.1"] * 768}, {"vector": [True] * 768}, {"vector": [None] * 768},
    {"model": "other/model"}, {"revision": "main"}, {"revision": "b" * 40},
    {"input_version": 2}, {"input_version": True}, {"input_version": "1"},
    {"dimensions": 2}, {"dimensions": 768.0}, {"dimensions": "768"},
    {"title": ""}, {"title": "x" * 501}, {"title": 12}, {"icon": "unknown"},
    {"extra": "not part of the contract"},
])
def test_validation_rejects_vectors_and_metadata_without_overwriting(client, changes):
    task = client.post("/api/todos", json={"title": "Keep source"}).json()
    url = f"/api/todos/{task['id']}/embedding"
    assert client.put(url, json=payload(task)).status_code == 204
    before = stored(client.app.state.store.path, task["id"])
    response = client.put(url, json=payload(task, **changes))
    assert response.status_code == 422
    assert response.json()["detail"]
    assert stored(client.app.state.store.path, task["id"]) == before
    assert client.get("/api/todos").json() == [task]


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_validation_nonfinite_json_is_422(client, value):
    task = client.post("/api/todos", json={"title": "Finite only"}).json()
    body = payload(task)
    body["vector"][0] = value
    response = client.put(f"/api/todos/{task['id']}/embedding", content=json.dumps(body), headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert stored(client.app.state.store.path, task["id"]) == (None,) * 5


@pytest.mark.parametrize("field", ["title", "icon", "vector", "model", "revision", "input_version", "dimensions"])
def test_validation_all_fields_are_required(client, field):
    task = client.post("/api/todos", json={"title": "Required fields"}).json()
    body = payload(task)
    del body[field]
    assert client.put(f"/api/todos/{task['id']}/embedding", json=body).status_code == 422


def test_validation_missing_stale_and_repeated_uploads(client):
    task = client.post("/api/todos", json={"title": "Original", "icon": "home"}).json()
    url = f"/api/todos/{task['id']}"
    body = payload(task)
    for _ in range(2):
        assert client.put(url + "/embedding", json=body).status_code == 204
    assert client.put(url + "/embedding", json=payload(task, title=" Original")).status_code == 409
    assert client.put(url + "/embedding", json=payload(task, icon="work")).status_code == 409
    assert stored(client.app.state.store.path, task["id"])[0] == body["vector"]
    edited = client.put(url, json={"title": "Changed", "icon": "star"}).json()
    assert client.put(url + "/embedding", json=body).status_code == 409
    assert stored(client.app.state.store.path, task["id"]) == (None,) * 5
    assert client.put(url + "/embedding", json=payload(edited)).status_code == 204
    assert client.delete(url).status_code == 204
    assert client.put(url + "/embedding", json=payload(edited)).status_code == 404
    assert client.put("/api/todos/unknown/embedding", json=body).status_code == 404


def test_validation_atomic_edit_and_upload_race(tmp_path):
    store = TodoStore(tmp_path / "race.duckdb")
    store.open()
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            for index in range(10):
                task = store.add(f"Task {index}", "home")
                barrier = Barrier(2)

                def upload():
                    barrier.wait()
                    return store.set_embedding(task["id"], **payload(task))

                def edit():
                    barrier.wait()
                    return store.update(task["id"], "Changed", "work")

                uploading = pool.submit(upload)
                editing = pool.submit(edit)
                assert uploading.result() in ("saved", "stale")
                assert editing.result()["title"] == "Changed"
                assert stored(store.path, task["id"]) == (None,) * 5
    finally:
        store.close()
