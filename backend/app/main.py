import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.database import SessionLocal, init_db_with_retry
from app.routers import admin, auth, notices
from app.services.collector import collect_from_g2b
from app.services.seed import remove_sample_notices, seed_keywords, seed_sample_notices, seed_users


def run_scheduled_collection(run_ai: bool) -> None:
    with SessionLocal() as db:
        collect_from_g2b(db, run_ai=run_ai)


async def scheduled_collect_loop() -> None:
    settings = get_settings()
    if not settings.g2b_api_key:
        return

    interval_seconds = max(settings.g2b_auto_collect_interval_minutes, 1) * 60
    if not settings.g2b_auto_collect_on_startup:
        await asyncio.sleep(interval_seconds)
    else:
        await asyncio.sleep(5)

    while True:
        try:
            await asyncio.to_thread(run_scheduled_collection, settings.g2b_auto_collect_run_ai)
        except Exception as exc:
            print(f"scheduled g2b collection failed: {exc}")
        await asyncio.sleep(interval_seconds)


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    init_db_with_retry()
    with SessionLocal() as db:
        seed_keywords(db)
        seed_users(db)
        if settings.seed_sample_data and not settings.g2b_api_key:
            seed_sample_notices(db)
        else:
            remove_sample_notices(db)

    collector_task: asyncio.Task | None = None
    if settings.g2b_auto_collect_enabled and settings.g2b_api_key:
        collector_task = asyncio.create_task(scheduled_collect_loop())

    try:
        yield
    finally:
        if collector_task:
            collector_task.cancel()
            with suppress(asyncio.CancelledError):
                await collector_task


settings = get_settings()
app = FastAPI(title=settings.project_name, version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(notices.router, prefix=settings.api_prefix)
app.include_router(admin.router, prefix=settings.api_prefix)
app.include_router(auth.router, prefix=settings.api_prefix)


@app.get("/health", tags=["system"])
def health_check() -> dict[str, str]:
    return {"status": "ok"}
