import time
from collections.abc import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, declarative_base, sessionmaker

from app.config import get_settings


settings = get_settings()

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db_with_retry(max_attempts: int = 30, delay_seconds: float = 2.0) -> None:
    from app import models  # noqa: F401

    last_error: OperationalError | None = None
    for _ in range(max_attempts):
        try:
            Base.metadata.create_all(bind=engine)
            ensure_schema_updates()
            return
        except OperationalError as exc:
            last_error = exc
            time.sleep(delay_seconds)
    if last_error:
        raise last_error


def ensure_schema_updates() -> None:
    statements = [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS company_name VARCHAR(255)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_name VARCHAR(120)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(80)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_status VARCHAR(40) NOT NULL DEFAULT 'approved'",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_notes TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP",
        """
        UPDATE notices
        SET notice_url = CASE notice_no
            WHEN 'SAMPLE-20260702-001' THEN 'https://www.g2b.go.kr:8101/ep/tbid/tbidFwd.do?bidno=20260702001&bidseq=00&bidtype=1'
            WHEN 'SAMPLE-20260702-002' THEN 'https://www.g2b.go.kr:8101/ep/tbid/tbidFwd.do?bidno=20260702002&bidseq=00&bidtype=1'
            WHEN 'SAMPLE-20260702-003' THEN 'https://www.g2b.go.kr:8101/ep/tbid/tbidFwd.do?bidno=20260702003&bidseq=00&bidtype=1'
            WHEN 'SAMPLE-20260702-004' THEN 'https://www.g2b.go.kr:8101/ep/tbid/tbidFwd.do?bidno=20260702004&bidseq=00&bidtype=1'
            WHEN 'SAMPLE-20260702-005' THEN 'https://www.g2b.go.kr:8101/ep/tbid/tbidFwd.do?bidno=20260702005&bidseq=00&bidtype=1'
            WHEN 'SAMPLE-20260702-006' THEN 'https://www.g2b.go.kr:8101/ep/tbid/tbidFwd.do?bidno=20260702006&bidseq=00&bidtype=1'
            WHEN 'SAMPLE-20260702-007' THEN 'https://www.g2b.go.kr:8101/ep/tbid/tbidFwd.do?bidno=20260702007&bidseq=00&bidtype=1'
            WHEN 'SAMPLE-20260702-008' THEN 'https://www.g2b.go.kr:8101/ep/tbid/tbidFwd.do?bidno=20260702008&bidseq=00&bidtype=1'
            WHEN 'SAMPLE-20260702-009' THEN 'https://www.g2b.go.kr:8101/ep/tbid/tbidFwd.do?bidno=20260702009&bidseq=00&bidtype=1'
            WHEN 'SAMPLE-20260702-010' THEN 'https://www.g2b.go.kr:8101/ep/tbid/tbidFwd.do?bidno=20260702010&bidseq=00&bidtype=1'
            ELSE notice_url
        END
        WHERE notice_url LIKE '%example.go.kr%'
        """,
        "UPDATE notices SET attachment_urls = '[]'::jsonb WHERE attachment_urls::text LIKE '%example.go.kr%'",
    ]
    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))
