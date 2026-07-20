from decimal import Decimal, InvalidOperation
import re

from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.models import Notice
from app.schemas import NoticeCreate


def parse_budget(value: object) -> Decimal | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    cleaned = (
        text.replace(",", "")
        .replace("원", "")
        .replace("₩", "")
        .replace(" ", "")
    )
    try:
        return Decimal(cleaned)
    except (InvalidOperation, ValueError):
        return None


def is_placeholder_url(url: str | None) -> bool:
    return bool(url and "example.go.kr" in url)


def normalized_notice_url(notice: NoticeCreate) -> str | None:
    if notice.notice_url and not is_placeholder_url(notice.notice_url):
        return notice.notice_url
    if notice.notice_no:
        return g2b_notice_url_from_notice_no(notice.notice_no)
    return None


def g2b_notice_url_from_notice_no(notice_no: str) -> str | None:
    text = str(notice_no or "").strip()
    if not text:
        return None

    match = re.search(r"([A-Za-z0-9]+)\s*[-_]\s*(\d+)", text)
    if match:
        bid_no, bid_seq = match.group(1), match.group(2)
    else:
        parts = re.findall(r"[A-Za-z0-9]+", text)
        if not parts:
            return None
        bid_no = parts[0]
        bid_seq = parts[1] if len(parts) > 1 and parts[1].isdigit() else "000"

    return f"https://www.g2b.go.kr:8101/ep/tbid/tbidFwd.do?bidno={bid_no}&bidseq={bid_seq}&bidtype=1"


def find_duplicate_notice(db: Session, notice: NoticeCreate) -> Notice | None:
    if notice.notice_no:
        existing = db.execute(select(Notice).where(Notice.notice_no == notice.notice_no)).scalar_one_or_none()
        if existing:
            return existing

    if notice.title and notice.ordering_agency and notice.posted_at:
        return db.execute(
            select(Notice).where(
                and_(
                    Notice.title == notice.title,
                    Notice.ordering_agency == notice.ordering_agency,
                    Notice.posted_at == notice.posted_at,
                )
            )
        ).scalar_one_or_none()
    return None


def upsert_notice(db: Session, notice: NoticeCreate) -> tuple[Notice, bool, bool]:
    notice_url = normalized_notice_url(notice)
    existing = find_duplicate_notice(db, notice)
    updated = False
    if existing:
        if notice.ordering_agency and existing.ordering_agency != notice.ordering_agency:
            existing.ordering_agency = notice.ordering_agency
            updated = True
        if notice.posted_at and existing.posted_at != notice.posted_at:
            existing.posted_at = notice.posted_at
            updated = True
        if notice.deadline_at and existing.deadline_at != notice.deadline_at:
            existing.deadline_at = notice.deadline_at
            updated = True
        if notice.detail_content and existing.detail_content != notice.detail_content:
            existing.detail_content = notice.detail_content
            updated = True
        if notice_url and existing.notice_url != notice_url:
            existing.notice_url = notice_url
            updated = True
        if notice.attachment_urls and existing.attachment_urls != notice.attachment_urls:
            existing.attachment_urls = notice.attachment_urls
            updated = True
        if notice.budget_amount is not None and existing.budget_amount != notice.budget_amount:
            existing.budget_amount = notice.budget_amount
            updated = True
        if notice.source and existing.source != notice.source:
            existing.source = notice.source
            updated = True
        if notice.source_raw and existing.source_raw != notice.source_raw:
            existing.source_raw = notice.source_raw
            updated = True
        db.add(existing)
        return existing, False, updated

    db_notice = Notice(
        notice_no=notice.notice_no,
        title=notice.title.strip(),
        ordering_agency=notice.ordering_agency.strip() if notice.ordering_agency else None,
        posted_at=notice.posted_at,
        deadline_at=notice.deadline_at,
        budget_amount=notice.budget_amount,
        notice_url=notice_url,
        detail_content=notice.detail_content,
        attachment_urls=notice.attachment_urls,
        source=notice.source,
        source_raw=notice.source_raw,
    )
    db.add(db_notice)
    db.flush()
    return db_notice, True, True
