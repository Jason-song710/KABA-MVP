from pathlib import Path

from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.constants import EXCLUDED_KEYWORD_SEED, KEYWORD_SEED
from app.config import get_settings
from app.models import ExcludedKeyword, KeywordDictionary, Notice, User
from app.services.auth import approve_user, hash_password
from app.services.csv_importer import import_csv_content


def seed_keywords(db: Session) -> None:
    for grade, payload in KEYWORD_SEED.items():
        for keyword in payload["keywords"]:
            existing = db.execute(
                select(KeywordDictionary).where(
                    KeywordDictionary.keyword == keyword,
                    KeywordDictionary.grade == grade,
                )
            ).scalar_one_or_none()
            if not existing:
                db.add(
                    KeywordDictionary(
                        keyword=keyword,
                        grade=grade,
                        score=payload["score"],
                        is_active=True,
                    )
                )

    for keyword in EXCLUDED_KEYWORD_SEED:
        existing = db.execute(
            select(ExcludedKeyword).where(ExcludedKeyword.keyword == keyword)
        ).scalar_one_or_none()
        if not existing:
            db.add(ExcludedKeyword(keyword=keyword, is_strong=True, is_active=True))

    db.commit()


def seed_users(db: Session) -> None:
    settings = get_settings()
    existing = db.execute(select(User).where(User.email == settings.admin_email)).scalar_one_or_none()
    if existing:
        if not existing.hashed_password:
            existing.hashed_password = hash_password(settings.admin_password)
        approve_user(existing, role="admin", notes="시스템 기본 관리자")
        existing.company_name = existing.company_name or "주소기반산업협회"
        existing.contact_name = existing.contact_name or "관리자"
        db.add(existing)
        db.commit()
        return

    admin = User(
        email=settings.admin_email,
        hashed_password=hash_password(settings.admin_password),
        role="admin",
        company_name="주소기반산업협회",
        contact_name="관리자",
        member_type="협회 관리자",
        preferred_industries=["주소정보", "공간정보", "AI·데이터"],
    )
    approve_user(admin, role="admin", notes="시스템 기본 관리자")
    db.add(admin)
    db.commit()
    db.add(
        User(
            email="member@example.com",
            hashed_password=hash_password("member1234"),
            role="viewer",
            company_name="샘플 주소정제 기업",
            contact_name="회원사 담당자",
            phone="02-0000-0000",
            member_type="주소정제 기업",
            preferred_industries=["주소정보", "AI·데이터"],
            approval_status="pending",
            is_active=False,
        )
    )
    db.commit()


def seed_sample_notices(db: Session) -> None:
    notice_count = db.execute(select(func.count(Notice.id))).scalar_one()
    if notice_count:
        return

    sample_path = Path(__file__).resolve().parents[2] / "data" / "sample_notices.csv"
    if sample_path.exists():
        import_csv_content(db, sample_path.read_bytes(), source="sample")


def remove_sample_notices(db: Session) -> None:
    db.execute(
        delete(Notice).where(
            or_(
                Notice.source == "sample",
                Notice.notice_no.like("SAMPLE-%"),
                Notice.notice_url.like("%example.go.kr%"),
            )
        )
    )
    db.commit()
