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


def test_legacy_database_upgrade(tmp_path):
    import duckdb

    database = tmp_path / "legacy.duckdb"
    with duckdb.connect(str(database)) as connection:
        connection.execute(
            "CREATE TABLE todos (id VARCHAR PRIMARY KEY, title VARCHAR NOT NULL, "
            "created_at TIMESTAMP NOT NULL DEFAULT current_timestamp)"
        )
        connection.execute("INSERT INTO todos (id, title) VALUES ('legacy', 'Old task')")
    expected = {"id": "legacy", "title": "Old task", "icon": "task"}
    for _ in range(2):
        with TestClient(create_app(database)) as client:
            assert client.get("/api/todos").json() == [expected]


def test_edit_preserves_identity_order_and_persists(tmp_path):
    database = tmp_path / "edit.duckdb"
    with TestClient(create_app(database)) as client:
        first = client.post("/api/todos", json={"title": "First", "icon": "star"}).json()
        second = client.post("/api/todos", json={"title": "Second"}).json()
        assert first["icon"] == "star"
        assert second["icon"] == "task"
        response = client.put(f"/api/todos/{first['id']}", json={"title": "  Edited  ", "icon": "home"})
        assert response.status_code == 200
        edited = {"id": first["id"], "title": "Edited", "icon": "home"}
        assert response.json() == edited
        assert client.get("/api/todos").json() == [edited, second]
    with TestClient(create_app(database)) as restarted:
        assert restarted.get("/api/todos").json() == [edited, second]


@pytest.mark.parametrize("payload", [
    {}, {"title": "Valid"}, {"title": "", "icon": "task"},
    {"title": " \t\n", "icon": "task"}, {"title": "x" * 501, "icon": "task"},
    {"title": None, "icon": "task"}, {"title": 123, "icon": "task"},
    {"title": "Valid", "icon": "invalid"}, {"title": "Valid", "icon": None},
    {"title": "Valid", "icon": 123}, {"title": "Valid", "icon": []},
])
def test_invalid_updates_leave_item_unchanged(client, payload):
    original = client.post("/api/todos", json={"title": "Original", "icon": "heart"}).json()
    response = client.put(f"/api/todos/{original['id']}", json=payload)
    assert response.status_code == 422
    assert response.json()["detail"]
    assert client.get("/api/todos").json() == [original]


@pytest.mark.parametrize("icon", ["invalid", "", None, 123, []])
def test_invalid_create_icons(client, icon):
    assert client.post("/api/todos", json={"title": "Task", "icon": icon}).status_code == 422
    assert client.get("/api/todos").json() == []


def test_update_missing_or_deleted_item(client):
    payload = {"title": "Edited", "icon": "shopping"}
    response = client.put("/api/todos/missing", json=payload)
    assert response.status_code == 404
    assert response.json() == {"detail": "To-do item not found"}
    original = client.post("/api/todos", json={"title": "Original"}).json()
    assert client.delete(f"/api/todos/{original['id']}").status_code == 204
    assert client.put(f"/api/todos/{original['id']}", json=payload).status_code == 404
    assert client.get("/api/todos").json() == []


@pytest.mark.parametrize("icon", ["task", "star", "home", "work", "shopping", "heart"])
def test_supported_icons_and_update_title_boundary(client, icon):
    original = client.post("/api/todos", json={"title": "Original", "icon": icon}).json()
    response = client.put(f"/api/todos/{original['id']}", json={"title": "✓" * 500, "icon": icon})
    assert response.status_code == 200
    assert response.json() == {"id": original["id"], "title": "✓" * 500, "icon": icon}
