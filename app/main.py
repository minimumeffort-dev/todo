"""Run locally with: uvicorn app.main:app --host 127.0.0.1 --port 8000."""

from contextlib import asynccontextmanager
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from app.db import TodoStore


class TodoInput(BaseModel):
    title: str = Field(min_length=1, max_length=500)

    @field_validator("title", mode="before")
    @classmethod
    def trim_title(cls, value):
        return value.strip() if isinstance(value, str) else value


class Todo(BaseModel):
    id: str
    title: str


def create_app(db_path: str | Path | None = None) -> FastAPI:
    default_path = Path(__file__).resolve().parent.parent / "data" / "todos.duckdb"
    store = TodoStore(db_path if db_path is not None else os.environ.get("TODO_DB_PATH", default_path))

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        store.open()
        try:
            yield
        finally:
            store.close()

    application = FastAPI(title="Local To-do", lifespan=lifespan)
    application.state.store = store

    @application.get("/api/todos", response_model=list[Todo])
    def list_todos():
        return store.list()

    @application.post("/api/todos", response_model=Todo, status_code=201)
    def add_todo(item: TodoInput):
        return store.add(item.title)

    @application.patch("/api/todos/{item_id}", response_model=Todo)
    def update_todo(item_id: str, item: TodoInput):
        updated = store.update(item_id, item.title)
        if updated is None:
            raise HTTPException(status_code=404, detail="To-do item not found")
        return updated

    @application.delete("/api/todos/{item_id}", status_code=204)
    def delete_todo(item_id: str):
        if not store.delete(item_id):
            raise HTTPException(status_code=404, detail="To-do item not found")
        return Response(status_code=204)

    static_path = Path(__file__).resolve().parent / "static"
    if static_path.is_dir():
        application.mount("/static", StaticFiles(directory=static_path), name="static")

        @application.get("/", include_in_schema=False)
        def index():
            return FileResponse(static_path / "index.html")

    return application


app = create_app()
