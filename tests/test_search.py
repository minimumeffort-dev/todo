"""Semantic ranking and eligibility with deterministic vectors and isolated storage."""

import json

import duckdb
from fastapi.testclient import TestClient
import pytest

from app.main import (
    create_app, EMBEDDING_MODEL, EMBEDDING_REVISION, EMBEDDING_DIMENSIONS,
    EMBEDDING_INPUT_VERSION,
)


def query(values=(1.0, 0.0), **changes):
    return {
        "vector": list(values) + [0.0] * (EMBEDDING_DIMENSIONS - len(values)),
        "model": EMBEDDING_MODEL, "revision": EMBEDDING_REVISION,
        "input_version": EMBEDDING_INPUT_VERSION, "dimensions": EMBEDDING_DIMENSIONS,
        **changes,
    }


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / "search.duckdb")) as test_client:
        yield test_client


def add(client, title, vector=None):
    task = client.post("/api/todos", json={"title": title, "icon": "work"}).json()
    if vector is not None:
        assert client.put(f"/api/todos/{task['id']}/embedding", json={
            "title": task["title"], "icon": task["icon"], **query(vector),
        }).status_code == 204
    return task


def test_empty_index_and_pending_order(client):
    assert client.post("/api/todos/search", json=query()).json() == {"matches": [], "pending_count": 0}
    first = add(client, "Not indexed")
    second = add(client, "Also pending")
    assert client.get("/api/todos/embeddings/pending").json() == [first, second]
    assert client.post("/api/todos/search", json=query()).json() == {"matches": [], "pending_count": 2}


def test_known_cosine_ranking_limit_and_completed_tasks(client):
    negative = add(client, "Opposite", (-1.0, 0.0))
    perpendicular = add(client, "Perpendicular", (0.0, 9.0))
    near = add(client, "Near", (3.0, 4.0))
    exact = add(client, "Exact", (10.0, 0.0))
    add(client, "Not yet indexed")
    url = f"/api/todos/{near['id']}"
    near = client.patch(url, json={"completed": True}).json()
    response = client.post("/api/todos/search", json=query()).json()
    assert response["pending_count"] == 1
    assert [match["todo"] for match in response["matches"]] == [exact, near, perpendicular, negative]
    assert [match["score"] for match in response["matches"]] == pytest.approx([1.0, 0.6, 0.0, -1.0])
    assert client.post("/api/todos/search", json=query(limit=2)).json()["matches"] == response["matches"][:2]
    assert client.get("/api/todos").json()[2] == near
    assert set(response["matches"][0]["todo"]) == {"id", "title", "icon", "completed"}


def test_ties_follow_created_at_then_id(client):
    tasks = [add(client, title, (1.0, 0.0)) for title in ["First", "Second", "Third"]]
    with duckdb.connect(str(client.app.state.store.path)) as connection:
        connection.execute("UPDATE todos SET created_at = '2026-01-02'")
        connection.execute("UPDATE todos SET created_at = '2026-01-01' WHERE id = ?", [tasks[2]["id"]])
    expected = [tasks[2], *sorted(tasks[:2], key=lambda task: task["id"])]
    for _ in range(3):
        matches = client.post("/api/todos/search", json=query()).json()["matches"]
        assert [match["todo"] for match in matches] == expected
        assert all(match["score"] == 1.0 for match in matches)


@pytest.mark.parametrize("column,value", [
    ("embedding_model", "other"), ("embedding_revision", "main"),
    ("embedding_input_version", 2), ("embedding_dimensions", 2),
    ("embedding", None), ("embedding", [1.0, 0.0]),
    ("embedding", [0.0] * 768), ("embedding", [float("nan")] * 768),
    ("embedding", [float("inf")] * 768), ("embedding", [None] * 768),
])
def test_incompatible_or_unusable_embeddings_are_pending(client, column, value):
    old = add(client, "Old embedding", (1.0, 0.0))
    current = add(client, "Current embedding", (0.0, 1.0))
    with duckdb.connect(str(client.app.state.store.path)) as connection:
        connection.execute(f"UPDATE todos SET {column} = ? WHERE id = ?", [value, old["id"]])
    assert client.get("/api/todos/embeddings/pending").json() == [old]
    results = client.post("/api/todos/search", json=query()).json()
    assert results == {"matches": [{"todo": current, "score": 0.0}], "pending_count": 1}


def test_completion_noop_source_edit_and_restart(tmp_path):
    database = tmp_path / "restart.duckdb"
    with TestClient(create_app(database)) as client:
        task = add(client, "Saved", (1.0, 0.0))
        url = f"/api/todos/{task['id']}"
        task = client.patch(url, json={"completed": True}).json()
        assert client.get("/api/todos/embeddings/pending").json() == []
        client.put(url, json={"title": " Saved ", "icon": "work"})
        assert client.post("/api/todos/search", json=query()).json()["matches"][0]["todo"] == task
    with TestClient(create_app(database)) as client:
        assert client.get("/api/todos/embeddings/pending").json() == []
        assert client.post("/api/todos/search", json=query()).json()["matches"][0]["todo"] == task
        edited = client.put(url, json={"title": "Changed source", "icon": "heart"}).json()
        assert client.get("/api/todos/embeddings/pending").json() == [edited]
        assert client.post("/api/todos/search", json=query()).json() == {"matches": [], "pending_count": 1}
        assert client.put(url + "/embedding", json={"title": edited["title"], "icon": edited["icon"], **query()}).status_code == 204
    with TestClient(create_app(database)) as client:
        assert client.post("/api/todos/search", json=query()).json()["matches"][0]["todo"] == edited
        client.delete(url)
        assert client.get("/api/todos/embeddings/pending").json() == []
        assert client.post("/api/todos/search", json=query()).json() == {"matches": [], "pending_count": 0}


@pytest.mark.parametrize("changes", [
    {"vector": []}, {"vector": [1.0] * 767}, {"vector": [1.0] * 769},
    {"vector": [0.0] * 768}, {"vector": [1e-100] * 768}, {"vector": [1e100] * 768},
    {"vector": ["0.1"] * 768}, {"vector": [True] * 768}, {"vector": [None] * 768},
    {"model": "other"}, {"revision": "main"}, {"input_version": True},
    {"input_version": 2}, {"input_version": "1"}, {"dimensions": 767},
    {"dimensions": "768"}, {"dimensions": 768.0}, {"limit": 0}, {"limit": 101},
    {"limit": True}, {"limit": 1.0}, {"limit": "20"}, {"extra": "rejected"},
])
def test_invalid_search_vectors_metadata_and_limits_are_sanitized(client, changes):
    response = client.post("/api/todos/search", json=query(**changes))
    assert response.status_code == 422
    assert response.json()["detail"]
    assert all(set(issue) == {"loc", "msg", "type"} for issue in response.json()["detail"])


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_nonfinite_query_values_return_json_errors(client, value):
    body = query()
    body["vector"][0] = value
    response = client.post("/api/todos/search", content=json.dumps(body), headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert response.json()["detail"]
    assert "input" not in response.json()["detail"][0]


@pytest.mark.parametrize("field", ["vector", "model", "revision", "input_version", "dimensions"])
def test_search_metadata_is_required(client, field):
    body = query()
    del body[field]
    assert client.post("/api/todos/search", json=body).status_code == 422


@pytest.mark.parametrize("value", [1e-40, 3e38])
def test_float32_extremes_have_finite_cosine_scores(client, value):
    task = add(client, "Extreme magnitude", (value, value))
    results = client.post("/api/todos/search", json=query((value, value), limit=100)).json()
    assert results["pending_count"] == 0
    assert results["matches"][0]["todo"] == task
    assert results["matches"][0]["score"] == pytest.approx(1.0)
