"""File-backed DuckDB storage, serialized for concurrent local requests."""

from pathlib import Path
from threading import Lock
from uuid import uuid4

import duckdb


class TodoStore:
    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser().resolve()
        self._lock = Lock()
        self._connection = None

    def open(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            connection = duckdb.connect(str(self.path))
            try:
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS todos ("
                    "id VARCHAR PRIMARY KEY, title VARCHAR NOT NULL, "
                    "created_at TIMESTAMP NOT NULL DEFAULT current_timestamp)"
                )
            except Exception:
                connection.close()
                raise
            self._connection = connection

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None

    def _db(self):
        if self._connection is None:
            raise RuntimeError("Todo storage is not open")
        return self._connection

    def list(self) -> list[dict[str, str]]:
        with self._lock:
            rows = self._db().execute(
                "SELECT id, title FROM todos ORDER BY created_at, id"
            ).fetchall()
        return [{"id": row[0], "title": row[1]} for row in rows]

    def add(self, title: str) -> dict[str, str]:
        item = {"id": str(uuid4()), "title": title}
        with self._lock:
            self._db().execute(
                "INSERT INTO todos (id, title) VALUES (?, ?)",
                [item["id"], item["title"]],
            )
        return item

    def delete(self, item_id: str) -> bool:
        with self._lock:
            row = self._db().execute(
                "DELETE FROM todos WHERE id = ? RETURNING id", [item_id]
            ).fetchone()
        return row is not None
