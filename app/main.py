"""Build with npm run build, then serve with uvicorn app.main:app."""

from contextlib import asynccontextmanager
import json
import math
import os
from pathlib import Path
import stat
import struct
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator

from app.db import DEFAULT_ICON, TodoStore

TodoIcon = Literal["task", "star", "home", "work", "shopping", "heart"]
# Verified from text_config.embedding_dim in this immutable model configuration.
EMBEDDING_MODEL = "onnx-community/embeddinggemma-2-ONNX"
EMBEDDING_REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0"
EMBEDDING_DIMENSIONS = 768
EMBEDDING_INPUT_VERSION = 1
Float32Value = Annotated[float, Field(strict=True, allow_inf_nan=False)]


class TodoInput(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    icon: TodoIcon = DEFAULT_ICON

    @field_validator("title", mode="before")
    @classmethod
    def trim_title(cls, value):
        return value.strip() if isinstance(value, str) else value


class TodoUpdate(TodoInput):
    icon: TodoIcon


class TodoCompletion(BaseModel):
    completed: StrictBool


class QueryEmbedding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    vector: list[Float32Value] = Field(
        min_length=EMBEDDING_DIMENSIONS, max_length=EMBEDDING_DIMENSIONS
    )
    model: Literal[EMBEDDING_MODEL]
    revision: Literal[EMBEDDING_REVISION]
    input_version: StrictInt = Field(ge=EMBEDDING_INPUT_VERSION, le=EMBEDDING_INPUT_VERSION)
    dimensions: StrictInt = Field(ge=EMBEDDING_DIMENSIONS, le=EMBEDDING_DIMENSIONS)

    @field_validator("vector")
    @classmethod
    def validate_vector(cls, values):
        # DuckDB FLOAT[] stores float32. Reject overflow and vectors that become
        # entirely zero after conversion, rather than accepting unusable data.
        try:
            converted = [struct.unpack("f", struct.pack("f", value))[0] for value in values]
        except (OverflowError, struct.error) as error:
            raise ValueError("Embedding values must fit float32") from error
        if not all(math.isfinite(value) for value in converted) or not any(converted):
            raise ValueError("Embedding must have finite, nonzero float32 output")
        return converted


class TaskEmbedding(QueryEmbedding):
    # Do not trim a source snapshot: it must match the confirmed saved values.
    title: str = Field(strict=True, min_length=1, max_length=500)
    icon: TodoIcon


class TodoSearch(QueryEmbedding):
    limit: StrictInt = Field(default=20, ge=1, le=100)


class Todo(BaseModel):
    id: str
    title: str
    icon: TodoIcon
    completed: bool


class SearchMatch(BaseModel):
    todo: Todo
    score: float


class SearchResults(BaseModel):
    matches: list[SearchMatch]
    pending_count: int
    min_score: float


def create_app(
    db_path: str | Path | None = None, *, dist_path: str | Path | None = None
) -> FastAPI:
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

    @application.get("/health")
    def health():
        return {"status": "ok"}

    @application.get("/api/todos", response_model=list[Todo])
    def list_todos():
        return store.list()

    @application.get("/api/todos/embeddings/pending", response_model=list[Todo])
    def pending_embeddings():
        return store.pending_embeddings(
            EMBEDDING_MODEL, EMBEDDING_REVISION, EMBEDDING_INPUT_VERSION, EMBEDDING_DIMENSIONS
        )

    @application.post("/api/todos/search", response_model=SearchResults)
    def search_todos(item: TodoSearch):
        return store.search(**item.model_dump())

    @application.post("/api/todos", response_model=Todo, status_code=201)
    def add_todo(item: TodoInput):
        return store.add(item.title, item.icon)

    @application.put("/api/todos/{item_id}", response_model=Todo)
    def update_todo(item_id: str, item: TodoUpdate):
        updated = store.update(item_id, item.title, item.icon)
        if updated is None:
            raise HTTPException(status_code=404, detail="To-do item not found")
        return updated

    @application.patch("/api/todos/{item_id}", response_model=Todo)
    def set_todo_completed(item_id: str, item: TodoCompletion):
        updated = store.set_completed(item_id, item.completed)
        if updated is None:
            raise HTTPException(status_code=404, detail="To-do item not found")
        return updated

    @application.put("/api/todos/{item_id}/embedding", status_code=204)
    def save_todo_embedding(item_id: str, item: TaskEmbedding):
        result = store.set_embedding(item_id, **item.model_dump())
        if result == "missing":
            raise HTTPException(status_code=404, detail="To-do item not found")
        if result == "stale":
            raise HTTPException(status_code=409, detail="To-do title or icon changed")
        return Response(status_code=204)

    @application.exception_handler(RequestValidationError)
    async def invalid_input(request: Request, error: RequestValidationError):
        if request.scope.get("endpoint") in (save_todo_embedding, search_todos):
            # Non-finite inputs can be parsed from JSON, but cannot be echoed in
            # JSON error responses. Return useful field errors without the vector
            # or non-serializable validator context, including for NaN/Infinity.
            detail = [
                {key: issue[key] for key in ("loc", "msg", "type")}
                for issue in error.errors()
            ]
            return JSONResponse(status_code=422, content={"detail": detail})
        return await request_validation_exception_handler(request, error)

    @application.delete("/api/todos/{item_id}", status_code=204)
    def delete_todo(item_id: str):
        if not store.delete(item_id):
            raise HTTPException(status_code=404, detail="To-do item not found")
        return Response(status_code=204)

    distribution = Path(dist_path) if dist_path is not None else Path(__file__).resolve().parent.parent / "dist"
    assets = StaticFiles(directory=distribution.resolve(), check_dir=False)

    # Use StaticFiles' containment, MIME and ETag handling directly so an
    # absent build still leaves assets as 404s.
    async def browser_asset(request: Request):
        asset_path = assets.get_path(request.scope)
        if asset_path in (".", "index.html"):
            try:
                manifest_path, _ = assets.lookup_path("asset-manifest.json")
                manifest = json.loads(Path(manifest_path).read_text())
                urls = [entry["url"] for entry in manifest["assets"]]
                if not urls or any(not isinstance(url, str) or not url.startswith("/") for url in urls):
                    raise ValueError("Invalid asset manifest")
                required = ["index.html", "service-worker.mjs", "asset-manifest.json"]
                for path in required + [url.lstrip("/") for url in urls]:
                    _, status = assets.lookup_path(path)
                    if status is None or not stat.S_ISREG(status.st_mode):
                        raise ValueError("Incomplete distribution")
            except (OSError, ValueError, KeyError, TypeError):
                raise HTTPException(
                    status_code=503,
                    detail="Browser build is missing or incomplete. Run npm run build in the project directory, then restart the server and reload this origin.",
                    headers={"Cache-Control": "no-cache"},
                ) from None
        response = await assets.get_response("index.html" if asset_path == "." else asset_path, request.scope)
        response.headers["Cache-Control"] = "no-cache"
        return response

    # Limit asset matches so FastAPI can redirect alternate health/API paths.
    for path in ("/", "/index.html", "/service-worker.mjs", "/asset-manifest.json",
                 "/static/{asset_path:path}", "/vendor/{asset_path:path}"):
        application.add_api_route(path, browser_asset, methods=["GET", "HEAD"], include_in_schema=False)

    return application


app = create_app()
