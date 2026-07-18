from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api import handlers
from api.routers import data_sources, insights, models, sessions, system


@asynccontextmanager
async def lifespan(_: FastAPI):
    await handlers.startup_defaults()
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="AurigaSQL BFF", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "null"],
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=False,
    )
    app.include_router(system.router)
    app.include_router(models.router)
    app.include_router(data_sources.router)
    app.include_router(sessions.router)
    app.include_router(insights.router)
    return app


app = create_app()
