"""API behavior checks: each test uses an isolated, file-backed database."""

import duckdb
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
    assert first["icon"] == "task"
    assert first["completed"] is False
    second_response = client.post("/api/todos", json={"title": "Buy groceries"})
    assert second_response.status_code == 201
    second = second_response.json()
    assert second["id"] != first["id"]
    assert second["completed"] is False
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


@pytest.mark.parametrize("with_icons", [False, True], ids=["without-icons", "with-icons"])
def test_legacy_database_upgrade(tmp_path, with_icons):
    database = tmp_path / "legacy.duckdb"
    with duckdb.connect(str(database)) as connection:
        icon_column = ", icon VARCHAR DEFAULT 'task'" if with_icons else ""
        connection.execute(
            "CREATE TABLE todos (id VARCHAR PRIMARY KEY, title VARCHAR NOT NULL, "
            f"created_at TIMESTAMP NOT NULL DEFAULT current_timestamp{icon_column})"
        )
        connection.execute(
            "INSERT INTO todos (id, title, created_at) VALUES "
            "('legacy-z', '  Old task ✓  ', '2020-01-01'), "
            "('legacy-b', 'Second', '2020-01-02'), "
            "('legacy-a', 'First at same time', '2020-01-02')"
        )
        if with_icons:
            connection.execute("UPDATE todos SET icon = 'star' WHERE id = 'legacy-z'")
            connection.execute("UPDATE todos SET icon = 'heart' WHERE id = 'legacy-b'")
        original_rows = connection.execute(
            "SELECT id, title, created_at FROM todos ORDER BY created_at, id"
        ).fetchall()
    expected = [
        {"id": "legacy-z", "title": "  Old task ✓  ",
         "icon": "star" if with_icons else "task", "completed": False},
        {"id": "legacy-a", "title": "First at same time", "icon": "task", "completed": False},
        {"id": "legacy-b", "title": "Second",
         "icon": "heart" if with_icons else "task", "completed": False},
    ]
    for _ in range(2):
        with TestClient(create_app(database)) as client:
            assert client.get("/api/todos").json() == expected
    with duckdb.connect(str(database)) as connection:
        assert connection.execute(
            "SELECT id, title, created_at FROM todos ORDER BY created_at, id"
        ).fetchall() == original_rows
        connection.execute("INSERT INTO todos (id, title) VALUES ('new', 'Default state')")
        assert connection.execute("SELECT completed FROM todos WHERE id = 'new'").fetchone() == (False,)
    with TestClient(create_app(database)) as restarted:
        assert restarted.get("/api/todos").json() == expected + [
            {"id": "new", "title": "Default state", "icon": "task", "completed": False}
        ]


def test_edit_preserves_identity_order_and_persists(tmp_path):
    database = tmp_path / "edit.duckdb"
    with TestClient(create_app(database)) as client:
        first = client.post("/api/todos", json={"title": "First", "icon": "star"}).json()
        second = client.post("/api/todos", json={"title": "Second"}).json()
        assert first["icon"] == "star"
        assert second["icon"] == "task"
        response = client.put(f"/api/todos/{first['id']}", json={"title": "  Edited  ", "icon": "home"})
        assert response.status_code == 200
        edited = {"id": first["id"], "title": "Edited", "icon": "home", "completed": False}
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
    assert response.json() == {"id": original["id"], "title": "✓" * 500, "icon": icon, "completed": False}


def test_completion_and_reopening_persist_after_restart(tmp_path):
    database = tmp_path / "completion.duckdb"
    with TestClient(create_app(database)) as client:
        first = client.post("/api/todos", json={"title": "First", "icon": "star"}).json()
        second = client.post("/api/todos", json={"title": "Second", "icon": "home"}).json()
        third = client.post("/api/todos", json={"title": "Third", "icon": "heart"}).json()
        assert client.get("/api/todos").json() == [first, second, third]
    with duckdb.connect(str(database)) as connection:
        original_rows = connection.execute(
            "SELECT id, title, icon, created_at FROM todos ORDER BY created_at, id"
        ).fetchall()
    completed = {**second, "completed": True}
    with TestClient(create_app(database)) as client:
        for _ in range(2):
            response = client.patch(f"/api/todos/{second['id']}", json={"completed": True})
            assert response.status_code == 200
            assert response.json() == completed
            assert client.get("/api/todos").json() == [first, completed, third]
    with TestClient(create_app(database)) as restarted:
        assert restarted.get("/api/todos").json() == [first, completed, third]
        for _ in range(2):
            response = restarted.patch(f"/api/todos/{second['id']}", json={"completed": False})
            assert response.status_code == 200
            assert response.json() == second
            assert restarted.get("/api/todos").json() == [first, second, third]
    with TestClient(create_app(database)) as restarted_again:
        assert restarted_again.get("/api/todos").json() == [first, second, third]
    with duckdb.connect(str(database)) as connection:
        assert connection.execute(
            "SELECT id, title, icon, created_at FROM todos ORDER BY created_at, id"
        ).fetchall() == original_rows


@pytest.mark.parametrize("completed", [False, True])
def test_title_and_icon_edits_preserve_completion(client, completed):
    original = client.post("/api/todos", json={"title": "Original", "icon": "heart"}).json()
    response = client.patch(
        f"/api/todos/{original['id']}",
        json={"completed": completed, "title": "Ignored title", "icon": "shopping"},
    )
    assert response.status_code == 200
    assert response.json() == {**original, "completed": completed}
    response = client.put(
        f"/api/todos/{original['id']}", json={"title": "  Edited  ", "icon": "work"}
    )
    expected = {**original, "title": "Edited", "icon": "work", "completed": completed}
    assert response.status_code == 200
    assert response.json() == expected
    assert client.get("/api/todos").json() == [expected]


@pytest.mark.parametrize("payload", [
    {}, {"title": "Valid", "icon": "task"}, {"completed": None},
    {"completed": 0}, {"completed": 1}, {"completed": 0.0}, {"completed": 1.0},
    {"completed": "true"}, {"completed": "false"}, {"completed": "0"},
    {"completed": "1"}, {"completed": "yes"}, {"completed": ""},
    {"completed": []}, {"completed": {}}, [], True, "true", None,
])
def test_invalid_completion_leaves_item_unchanged(client, payload):
    original = client.post("/api/todos", json={"title": "Original", "icon": "star"}).json()
    completed = {**original, "completed": True}
    assert client.patch(f"/api/todos/{original['id']}", json={"completed": True}).json() == completed
    response = client.patch(f"/api/todos/{original['id']}", json=payload)
    assert response.status_code == 422
    assert response.json()["detail"]
    assert client.get("/api/todos").json() == [completed]


@pytest.mark.parametrize("completed", [False, True])
def test_completion_missing_or_deleted_item(client, completed):
    payload = {"completed": completed}
    response = client.patch("/api/todos/missing", json=payload)
    assert response.status_code == 404
    assert response.json() == {"detail": "To-do item not found"}
    original = client.post("/api/todos", json={"title": "Original"}).json()
    assert client.delete(f"/api/todos/{original['id']}").status_code == 204
    response = client.patch(f"/api/todos/{original['id']}", json=payload)
    assert response.status_code == 404
    assert response.json() == {"detail": "To-do item not found"}
    assert client.get("/api/todos").json() == []


def test_completed_item_can_be_removed(client):
    item = client.post("/api/todos", json={"title": "Finished"}).json()
    completed = client.patch(f"/api/todos/{item['id']}", json={"completed": True})
    assert completed.status_code == 200
    assert client.get("/api/todos").json() == [{**item, "completed": True}]
    assert client.delete(f"/api/todos/{item['id']}").status_code == 204
    assert client.get("/api/todos").json() == []
