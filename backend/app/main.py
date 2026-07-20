import asyncio
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.database import SessionLocal, init_db_with_retry
from app.routers import admin, auth, notices
from app.services.collector import collect_from_g2b
from app.services.seed import remove_sample_notices, seed_keywords, seed_sample_notices, seed_users


def run_scheduled_collection(run_ai: bool) -> None:
    settings = get_settings()
    with SessionLocal() as db:
        collect_from_g2b(
            db,
            run_ai=run_ai,
            keyword_limit=settings.g2b_auto_collect_keyword_limit,
            inqry_divs=settings.g2b_auto_collect_inqry_div_list,
            recent_window_days=settings.g2b_auto_collect_recent_window_days,
            stop_on_rate_limit=True,
        )


def seconds_until_next_collect(minute: int) -> float:
    now = datetime.now()
    safe_minute = min(max(minute, 0), 59)
    next_run = now.replace(minute=safe_minute, second=0, microsecond=0)
    if next_run <= now:
        next_run += timedelta(hours=1)
    return max((next_run - now).total_seconds(), 0.0)


async def scheduled_collect_loop() -> None:
    settings = get_settings()
    if not settings.g2b_api_key:
        return

    if settings.g2b_auto_collect_on_startup:
        await asyncio.sleep(5)
        try:
            await asyncio.to_thread(run_scheduled_collection, settings.g2b_auto_collect_run_ai)
        except Exception as exc:
            print(f"scheduled g2b startup collection failed: {exc}")

    while True:
        wait_seconds = seconds_until_next_collect(settings.g2b_auto_collect_minute)
        await asyncio.sleep(wait_seconds)
        try:
            await asyncio.to_thread(run_scheduled_collection, settings.g2b_auto_collect_run_ai)
        except Exception as exc:
            print(f"scheduled g2b collection failed: {exc}")


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
