import csv
from datetime import datetime
from io import StringIO

from sqlalchemy.orm import Session

from app.schemas import NoticeCreate
from app.services.classifier import run_primary_classification
from app.services.notices import parse_budget, upsert_notice


HEADER_ALIASES = {
    "notice_no": ["notice_no", "공고번호", "입찰공고번호", "bidNtceNo", "bid_no"],
    "title": ["title", "공고명", "입찰공고명", "bidNtceNm", "name"],
    "ordering_agency": ["ordering_agency", "발주기관", "수요기관", "공고기관", "ntceInsttNm", "agency"],
    "posted_at": ["posted_at", "공고일", "입찰공고일", "bidNtceDt", "posted_date"],
    "deadline_at": ["deadline_at", "마감일", "입찰마감일", "bidClseDt", "deadline"],
    "budget_amount": ["budget_amount", "예산", "추정가격", "배정예산", "asignBdgtAmt", "budget"],
    "notice_url": ["notice_url", "공고URL", "공고링크", "bidNtceDtlUrl", "url"],
    "detail_content": ["detail_content", "상세내용", "내용", "description", "detail"],
    "attachment_urls": ["attachment_urls", "첨부파일URL", "첨부파일", "attachments", "files"],
}


def first_value(row: dict[str, str], field: str) -> str | None:
    for header in HEADER_ALIASES[field]:
        if header in row and str(row[header]).strip():
            return str(row[header]).strip()
    return None


def parse_datetime_value(value: object) -> datetime | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None

    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%Y.%m.%d %H:%M:%S",
        "%Y.%m.%d %H:%M",
        "%Y.%m.%d",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
        "%Y/%m/%d",
        "%Y%m%d%H%M%S",
        "%Y%m%d%H%M",
        "%Y%m%d",
    ):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass

    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def parse_attachment_urls(value: str | None) -> list[str]:
    if not value:
        return []
    normalized = value.replace("\n", ";").replace("|", ";")
    return [item.strip() for item in normalized.split(";") if item.strip()]


def row_to_notice(row: dict[str, str], source: str = "csv") -> NoticeCreate:
    title = first_value(row, "title")
    if not title:
        raise ValueError("공고명이 없는 행은 가져올 수 없습니다.")

    return NoticeCreate(
        notice_no=first_value(row, "notice_no"),
        title=title,
        ordering_agency=first_value(row, "ordering_agency"),
        posted_at=parse_datetime_value(first_value(row, "posted_at")),
        deadline_at=parse_datetime_value(first_value(row, "deadline_at")),
        budget_amount=parse_budget(first_value(row, "budget_amount")),
        notice_url=first_value(row, "notice_url"),
        detail_content=first_value(row, "detail_content"),
        attachment_urls=parse_attachment_urls(first_value(row, "attachment_urls")),
        source=source,
        source_raw=row,
    )


def decode_csv(content: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "cp949"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            pass
    return content.decode("utf-8", errors="ignore")


def import_csv_content(db: Session, content: bytes, source: str = "csv") -> tuple[int, int, int, int, list[str]]:
    text = decode_csv(content)
    reader = csv.DictReader(StringIO(text))

    created_count = 0
    updated_count = 0
    duplicate_count = 0
    classified_count = 0
    errors: list[str] = []

    for row_number, row in enumerate(reader, start=2):
        try:
            notice_data = row_to_notice(row, source=source)
            notice, created, updated = upsert_notice(db, notice_data)
            if created:
                created_count += 1
            elif updated:
                updated_count += 1
            else:
                duplicate_count += 1
            run_primary_classification(db, notice)
            classified_count += 1
        except Exception as exc:
            errors.append(f"{row_number}행: {exc}")

    db.commit()
    return created_count, updated_count, duplicate_count, classified_count, errors
