"""File-backed DuckDB storage, serialized for concurrent local requests."""

from pathlib import Path
from threading import Lock
from uuid import uuid4

import duckdb

DEFAULT_ICON = "task"


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
                connection.execute(
                    "ALTER TABLE todos ADD COLUMN IF NOT EXISTS icon "
                    "VARCHAR DEFAULT 'task'"
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
                "SELECT id, title, icon FROM todos ORDER BY created_at, id"
            ).fetchall()
        return [{"id": row[0], "title": row[1], "icon": row[2]} for row in rows]

    def add(self, title: str, icon: str = DEFAULT_ICON) -> dict[str, str]:
        item = {"id": str(uuid4()), "title": title, "icon": icon}
        with self._lock:
            self._db().execute(
                "INSERT INTO todos (id, title, icon) VALUES (?, ?, ?)",
                [item["id"], item["title"], item["icon"]],
            )
        return item

    def update(self, item_id: str, title: str, icon: str) -> dict[str, str] | None:
        with self._lock:
            row = self._db().execute(
                "UPDATE todos SET title = ?, icon = ? WHERE id = ? "
                "RETURNING id, title, icon", [title, icon, item_id]
            ).fetchone()
        return {"id": row[0], "title": row[1], "icon": row[2]} if row else None

    def delete(self, item_id: str) -> bool:
        with self._lock:
            row = self._db().execute(
                "DELETE FROM todos WHERE id = ? RETURNING id", [item_id]
            ).fetchone()
        return row is not None
