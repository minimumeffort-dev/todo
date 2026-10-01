"""API behavior checks: each test uses an isolated, file-backed database."""

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / "todos.duckdb")) as test_client:
        yield test_client


def test_add_list_and_remove(client):
    assert client.get("/api/todos").json() == []
    response = client.post("/api/todos", json={"title": "  Buy groceries  "})
    assert response.status_code == 201
    first = response.json()
    assert first["id"]
    assert first["title"] == "Buy groceries"
    second_response = client.post("/api/todos", json={"title": "Buy groceries"})
    assert second_response.status_code == 201
    second = second_response.json()
    assert second["id"] != first["id"]
    response = client.get("/api/todos")
    assert response.status_code == 200
    assert response.json() == [first, second]
    response = client.delete(f"/api/todos/{first['id']}")
    assert response.status_code == 204
    assert response.content == b""
    assert client.get("/api/todos").json() == [second]
    assert client.delete(f"/api/todos/{second['id']}").status_code == 204
    assert client.get("/api/todos").json() == []


@pytest.mark.parametrize("payload", [
    {}, {"title": ""}, {"title": " \t\n "}, {"title": "x" * 501},
    {"title": None}, {"title": 123}, {"title": []},
])
def test_invalid_items_are_rejected(client, payload):
    response = client.post("/api/todos", json=payload)
    assert response.status_code == 422
    assert response.json()["detail"]
    assert client.get("/api/todos").json() == []


def test_title_length_boundary_and_unicode(client):
    title = "✓" * 500
    response = client.post("/api/todos", json={"title": title})
    assert response.status_code == 201
    assert client.get("/api/todos").json() == [response.json()]


def test_delete_unknown_or_already_removed_item(client):
    response = client.delete("/api/todos/unknown")
    assert response.status_code == 404
    assert response.json() == {"detail": "To-do item not found"}
    item = client.post("/api/todos", json={"title": "One task"}).json()
    assert client.delete(f"/api/todos/{item['id']}").status_code == 204
    assert client.delete(f"/api/todos/{item['id']}").status_code == 404


def test_items_and_deletions_persist_after_restart(tmp_path):
    database = tmp_path / "nested" / "todos.duckdb"
    with TestClient(create_app(database)) as client:
        assert database.is_file()
        kept = client.post("/api/todos", json={"title": "Keep me"}).json()
        removed = client.post("/api/todos", json={"title": "Remove me"}).json()
        assert client.delete(f"/api/todos/{removed['id']}").status_code == 204
    with TestClient(create_app(database)) as restarted:
        assert restarted.get("/api/todos").json() == [kept]
        assert restarted.delete(f"/api/todos/{removed['id']}").status_code == 404
        assert restarted.delete(f"/api/todos/{kept['id']}").status_code == 204
    with TestClient(create_app(database)) as restarted_again:
        assert restarted_again.get("/api/todos").json() == []


def test_environment_database_path(tmp_path, monkeypatch):
    database = tmp_path / "custom.duckdb"
    monkeypatch.setenv("TODO_DB_PATH", str(database))
    with TestClient(create_app()) as client:
        assert database.is_file()
        assert client.get("/api/todos").json() == []


def test_update_preserves_id_and_list_order(client):
    items = [
        client.post("/api/todos", json={"title": title}).json()
        for title in ["First", "Second", "Third"]
    ]
    for index in [0, 1, 2, 0]:
        response = client.patch(
            f"/api/todos/{items[index]['id']}", json={"title": "  Edited ✓  "}
        )
        assert response.status_code == 200
        items[index] = {"id": items[index]["id"], "title": "Edited ✓"}
        assert response.json() == items[index]
        assert client.get("/api/todos").json() == items
    response = client.patch(
        f"/api/todos/{items[1]['id']}", json={"title": "✓" * 500}
    )
    assert response.status_code == 200
    items[1]["title"] = "✓" * 500
    assert response.json() == items[1]
    assert client.get("/api/todos").json() == items


@pytest.mark.parametrize("payload", [
    {}, {"title": ""}, {"title": " \t\n "}, {"title": "x" * 501},
    {"title": None}, {"title": 123}, {"title": []},
])
def test_invalid_updates_are_rejected(client, payload):
    item = client.post("/api/todos", json={"title": "Original"}).json()
    response = client.patch(f"/api/todos/{item['id']}", json=payload)
    assert response.status_code == 422
    assert response.json()["detail"]
    assert client.get("/api/todos").json() == [item]


def test_update_unknown_or_removed_item(client):
    item = client.post("/api/todos", json={"title": "Original"}).json()
    response = client.patch("/api/todos/unknown", json={"title": "Edited"})
    assert response.status_code == 404
    assert response.json() == {"detail": "To-do item not found"}
    assert client.get("/api/todos").json() == [item]
    assert client.delete(f"/api/todos/{item['id']}").status_code == 204
    response = client.patch(f"/api/todos/{item['id']}", json={"title": "Edited"})
    assert response.status_code == 404
    assert response.json() == {"detail": "To-do item not found"}
    assert client.get("/api/todos").json() == []


def test_edits_persist_after_restart(tmp_path):
    database = tmp_path / "todos.duckdb"
    with TestClient(create_app(database)) as client:
        first = client.post("/api/todos", json={"title": "Original"}).json()
        second = client.post("/api/todos", json={"title": "Unchanged"}).json()
        edited = {"id": first["id"], "title": "Persisted edit"}
        response = client.patch(f"/api/todos/{first['id']}", json={"title": edited["title"]})
        assert response.status_code == 200
        assert response.json() == edited
    with TestClient(create_app(database)) as restarted:
        assert restarted.get("/api/todos").json() == [edited, second]
