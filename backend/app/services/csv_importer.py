import csv
from datetime import datetime
from io import StringIO
import re

from sqlalchemy.orm import Session

from app.schemas import NoticeCreate
from app.services.classifier import run_primary_classification
from app.services.notices import parse_budget, upsert_notice


try:
    csv.field_size_limit(50 * 1024 * 1024)
except OverflowError:
    csv.field_size_limit(10 * 1024 * 1024)


HEADER_ALIASES = {
    "notice_no": ["notice_no", "공고번호", "입찰공고번호", "입찰공고번호-차수", "입찰공고번호차수", "입찰공고번호/차수", "공고번호-차수", "공고번호차수", "공고관리번호", "참조번호", "bidNtceNo", "bidNtceNo-bidNtceOrd", "bid_no"],
    "title": ["title", "공고명", "입찰공고명", "입찰건명", "공고명(사업명)", "사업명", "용역명", "공사명", "물품명", "bidNtceNm", "name"],
    "ordering_agency": ["ordering_agency", "발주기관", "발주처", "수요기관", "수요기관명", "공고기관", "공고기관명", "공고기관", "발주부서", "ntceInsttNm", "dminsttNm", "agency"],
    "posted_at": ["posted_at", "공고일", "공고일시", "게시일시", "게시일", "입찰공고일", "입찰공고일시", "입찰공고일자", "bidNtceDt", "posted_date"],
    "deadline_at": ["deadline_at", "마감일", "마감일시", "입찰마감일", "입찰마감일시", "입찰서마감일시", "투찰마감일시", "개찰일", "개찰일시", "입찰마감", "bidClseDt", "opengDt", "deadline"],
    "budget_amount": ["budget_amount", "예산", "추정가격", "추정금액", "배정예산", "기초금액", "예정가격", "사업금액", "예산액", "asignBdgtAmt", "presmptPrce", "budget"],
    "notice_url": ["notice_url", "공고URL", "공고 URL", "공고링크", "공고상세URL", "상세URL", "원문링크", "나라장터URL", "링크", "bidNtceDtlUrl", "url"],
    "detail_content": ["detail_content", "상세내용", "내용", "공고내용", "제한사항", "입찰자격", "투찰제한", "업종제한", "지역제한", "description", "detail"],
    "attachment_urls": ["attachment_urls", "첨부파일URL", "첨부파일 URL", "첨부파일", "첨부파일링크", "공고서", "첨부문서", "문서파일", "attachments", "files"],
}


def normalize_header(value: str) -> str:
    return re.sub(r"[^0-9a-zA-Z가-힣]+", "", str(value or "")).casefold()


def normalized_aliases(field: str) -> set[str]:
    return {normalize_header(alias) for alias in HEADER_ALIASES[field]}


def clean_csv_row(row: dict[str | None, object]) -> dict[str, str]:
    clean: dict[str, str] = {}
    for header, value in row.items():
        if header is None:
            continue
        header_text = str(header).strip()
        if not header_text:
            continue
        clean[header_text] = str(value).strip() if value is not None else ""
    extra_values = row.get(None)
    if isinstance(extra_values, list):
        extra_text = "; ".join(str(value).strip() for value in extra_values if str(value).strip())
        if extra_text:
            clean["_extra_columns"] = extra_text
    return clean


def find_header_start_line(lines: list[str]) -> int:
    title_aliases = normalized_aliases("title")
    supporting_aliases = (
        normalized_aliases("notice_no")
        | normalized_aliases("ordering_agency")
        | normalized_aliases("posted_at")
        | normalized_aliases("deadline_at")
    )
    for index, line in enumerate(lines[:30]):
        if not line.strip():
            continue
        try:
            columns = next(csv.reader([line]))
        except csv.Error:
            continue
        normalized_columns = {normalize_header(column) for column in columns}
        if normalized_columns & title_aliases and normalized_columns & supporting_aliases:
            return index
    return 0


def prepare_csv_text(text: str) -> str:
    lines = text.splitlines()
    if not lines:
        return text
    start_line = find_header_start_line(lines)
    return "\n".join(lines[start_line:])


def csv_reader_for_text(text: str) -> csv.DictReader:
    prepared = prepare_csv_text(text)
    sample = prepared[:8192]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;")
    except csv.Error:
        dialect = csv.excel
    return csv.DictReader(StringIO(prepared), dialect=dialect)


def first_value(row: dict[str, str], field: str) -> str | None:
    aliases = set(HEADER_ALIASES[field])
    normalized_alias_values = {normalize_header(alias) for alias in aliases}
    for header in HEADER_ALIASES[field]:
        if header in row and str(row[header]).strip():
            return str(row[header]).strip()
    for header, value in row.items():
        if normalize_header(header) in normalized_alias_values and str(value).strip():
            return str(value).strip()
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
        pass

    match = re.search(
        r"\d{4}[-./]\d{1,2}[-./]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|\d{8}(?:\d{4}(?:\d{2})?)?",
        text,
    )
    if match and match.group(0) != text:
        return parse_datetime_value(match.group(0))
    return None


def parse_attachment_urls(value: str | None) -> list[str]:
    if not value:
        return []
    normalized = value.replace("\n", ";").replace("|", ";")
    return [item.strip() for item in normalized.split(";") if item.strip()]


def short_error_message(exc: Exception, limit: int = 500) -> str:
    message = str(exc)
    return message if len(message) <= limit else f"{message[: limit - 3]}..."


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
    if content.startswith(b"PK\x03\x04"):
        raise ValueError("엑셀 .xlsx 파일은 직접 업로드할 수 없습니다. Excel에서 'CSV UTF-8' 형식으로 저장한 뒤 업로드해 주세요.")
    if content.startswith(b"\xd0\xcf\x11\xe0"):
        raise ValueError("엑셀 .xls 파일은 직접 업로드할 수 없습니다. Excel에서 'CSV UTF-8' 형식으로 저장한 뒤 업로드해 주세요.")

    encodings = ["utf-8-sig", "utf-8"]
    if b"\x00" in content[:4096]:
        encodings.extend(["utf-16", "utf-16le"])
    encodings.extend(["cp949", "euc-kr"])

    for encoding in encodings:
        try:
            text = content.decode(encoding)
            if "\x00" in text[:1000] and not encoding.startswith("utf-16"):
                continue
            return text
        except UnicodeDecodeError:
            pass
    return content.decode("utf-8", errors="ignore")


def import_csv_content(db: Session, content: bytes, source: str = "csv") -> tuple[int, int, int, int, list[str]]:
    text = decode_csv(content)
    reader = csv_reader_for_text(text)

    created_count = 0
    updated_count = 0
    duplicate_count = 0
    classified_count = 0
    errors: list[str] = []

    if not reader.fieldnames:
        return 0, 0, 0, 0, ["CSV 헤더를 찾을 수 없습니다. 첫 행에 공고명, 입찰공고번호, 수요기관 같은 컬럼명이 있어야 합니다."]

    row_number = 1
    try:
        for row_number, row in enumerate(reader, start=2):
            try:
                clean_row = clean_csv_row(row)
                if not any(clean_row.values()):
                    continue
                notice_data = row_to_notice(clean_row, source=source)
                notice, created, updated = upsert_notice(db, notice_data)
                run_primary_classification(db, notice)
                db.commit()
                if created:
                    created_count += 1
                elif updated:
                    updated_count += 1
                else:
                    duplicate_count += 1
                classified_count += 1
            except Exception as exc:
                db.rollback()
                errors.append(f"{row_number}행: {short_error_message(exc)}")
    except csv.Error as exc:
        db.rollback()
        errors.append(f"{row_number}행 근처 CSV 파싱 오류: {exc}")

    return created_count, updated_count, duplicate_count, classified_count, errors
