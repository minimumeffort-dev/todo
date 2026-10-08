"""File-backed DuckDB storage, serialized for concurrent local requests."""

from __future__ import annotations

from pathlib import Path
import math
from threading import Lock
from uuid import uuid4

import duckdb

DEFAULT_ICON = "task"
# Heuristic calibrated with the pinned q4 model and task input format v1:
# "purchase food" / "read a story" score relevant tasks at 0.739 / 0.759;
# unrelated tasks and "repair the spacecraft engine" score 0.598-0.639
# (tests/test_model_assets.py). Keep a gap; cosine scores are not probabilities.
MIN_SEARCH_COSINE_SIMILARITY = 0.70
EMBEDDING_COLUMNS = (
    "embedding", "embedding_model", "embedding_revision",
    "embedding_input_version", "embedding_dimensions",
)


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
                connection.execute(
                    "ALTER TABLE todos ADD COLUMN IF NOT EXISTS completed "
                    "BOOLEAN DEFAULT false"
                )
                for column, data_type in zip(
                    EMBEDDING_COLUMNS, ("FLOAT[]", "VARCHAR", "VARCHAR", "INTEGER", "INTEGER")
                ):
                    connection.execute(
                        f"ALTER TABLE todos ADD COLUMN IF NOT EXISTS {column} {data_type}"
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

    def list(self) -> list[dict[str, str | bool]]:
        with self._lock:
            rows = self._db().execute(
                "SELECT id, title, icon, completed FROM todos ORDER BY created_at, id"
            ).fetchall()
        return [
            {"id": row[0], "title": row[1], "icon": row[2], "completed": row[3]}
            for row in rows
        ]

    def add(self, title: str, icon: str = DEFAULT_ICON) -> dict[str, str | bool]:
        item = {"id": str(uuid4()), "title": title, "icon": icon, "completed": False}
        with self._lock:
            self._db().execute(
                "INSERT INTO todos (id, title, icon) VALUES (?, ?, ?)",
                [item["id"], item["title"], item["icon"]],
            )
        return item

    def _embedding_rows(self):
        return self._db().execute(
            f"SELECT id, title, icon, completed, {', '.join(EMBEDDING_COLUMNS)} "
            "FROM todos ORDER BY created_at, id"
        ).fetchall()

    @staticmethod
    def _compatible(row, model, revision, input_version, dimensions):
        vector = row[4]
        return (
            row[5:] == (model, revision, input_version, dimensions)
            and vector is not None and len(vector) == dimensions
            and all(value is not None and math.isfinite(value) for value in vector)
            and any(vector)
        )

    @staticmethod
    def _todo(row):
        return {"id": row[0], "title": row[1], "icon": row[2], "completed": row[3]}

    def pending_embeddings(self, model, revision, input_version, dimensions):
        with self._lock:
            rows = self._embedding_rows()
        return [self._todo(row) for row in rows if not self._compatible(
            row, model, revision, input_version, dimensions
        )]

    def search(self, *, vector, model, revision, input_version, dimensions, limit):
        # Snapshot vectors and task fields under the same lock as writes. Compute
        # cosine in float64 so float32 extremes cannot overflow or underflow.
        with self._lock:
            rows = self._embedding_rows()
        matches = []
        pending_count = 0
        query_norm = math.sqrt(math.fsum(value * value for value in vector))
        for row in rows:
            if not self._compatible(row, model, revision, input_version, dimensions):
                pending_count += 1
                continue
            stored = row[4]
            norm = math.sqrt(math.fsum(value * value for value in stored))
            score = math.fsum(a * b for a, b in zip(vector, stored)) / (query_norm * norm)
            score = max(-1.0, min(1.0, score))
            if score >= MIN_SEARCH_COSINE_SIMILARITY:
                matches.append({"todo": self._todo(row), "score": score})
        # Python's stable sort retains created_at/id order for equal scores.
        matches.sort(key=lambda match: match["score"], reverse=True)
        return {
            "matches": matches[:limit], "pending_count": pending_count,
            "min_score": MIN_SEARCH_COSINE_SIMILARITY,
        }

    def update(self, item_id: str, title: str, icon: str) -> dict[str, str | bool] | None:
        # Compare against the old source in the same UPDATE. No-op saves and
        # completion changes keep embeddings; a changed source clears metadata too.
        embedding_assignments = ", ".join(
            f"{column} = CASE WHEN title = ? AND icon = ? THEN {column} ELSE NULL END"
            for column in EMBEDDING_COLUMNS
        )
        with self._lock:
            row = self._db().execute(
                f"UPDATE todos SET {embedding_assignments}, title = ?, icon = ? WHERE id = ? "
                "RETURNING id, title, icon, completed",
                [title, icon] * len(EMBEDDING_COLUMNS) + [title, icon, item_id],
            ).fetchone()
        return (
            {"id": row[0], "title": row[1], "icon": row[2], "completed": row[3]}
            if row else None
        )

    def set_embedding(
        self, item_id: str, *, title: str, icon: str, vector: list[float],
        model: str, revision: str, input_version: int, dimensions: int,
    ) -> str:
        with self._lock:
            # The source predicate makes the write atomic with source comparison.
            # Hold the store lock through the existence check to distinguish stale
            # snapshots from missing rows without a local edit/delete race.
            connection = self._db()
            row = connection.execute(
                "UPDATE todos SET embedding = ?, embedding_model = ?, "
                "embedding_revision = ?, embedding_input_version = ?, embedding_dimensions = ? "
                "WHERE id = ? AND title = ? AND icon = ? RETURNING id",
                [vector, model, revision, input_version, dimensions, item_id, title, icon],
            ).fetchone()
            if row is not None:
                return "saved"
            exists = connection.execute("SELECT id FROM todos WHERE id = ?", [item_id]).fetchone()
            return "stale" if exists else "missing"

    def set_completed(self, item_id: str, completed: bool) -> dict[str, str | bool] | None:
        with self._lock:
            row = self._db().execute(
                "UPDATE todos SET completed = ? WHERE id = ? "
                "RETURNING id, title, icon, completed", [completed, item_id]
            ).fetchone()
        return (
            {"id": row[0], "title": row[1], "icon": row[2], "completed": row[3]}
            if row else None
        )

    def delete(self, item_id: str) -> bool:
        with self._lock:
            row = self._db().execute(
                "DELETE FROM todos WHERE id = ? RETURNING id", [item_id]
            ).fetchone()
        return row is not None
