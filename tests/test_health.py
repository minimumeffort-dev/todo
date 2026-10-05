"""Health checks remain available without database access."""

from unittest.mock import Mock

from fastapi.testclient import TestClient

from app.main import create_app


def test_health_response(tmp_path):
    client = TestClient(create_app(tmp_path / "todos.duckdb"))
    try:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/json"
        assert response.json() == {"status": "ok"}
    finally:
        client.close()


def test_health_without_database_access(tmp_path, monkeypatch):
    database = tmp_path / "todos.duckdb"
    application = create_app(database)
    blocked_calls = []
    for method in ("open", "close", "_db", "list", "add", "update", "delete"):
        blocked = Mock(side_effect=AssertionError("Health must not access storage"))
        monkeypatch.setattr(application.state.store, method, blocked)
        blocked_calls.append(blocked)

    # Do not enter TestClient's context: that would start the database lifespan.
    client = TestClient(application)
    try:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
    finally:
        client.close()

    for blocked in blocked_calls:
        blocked.assert_not_called()
    assert not database.exists()
