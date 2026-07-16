from datetime import datetime, timedelta
from typing import Any
from xml.etree import ElementTree

import httpx
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.models import CollectionLog
from app.schemas import CollectResponse, NoticeCreate
from app.services.ai_classifier import apply_ai_classification
from app.services.classifier import run_primary_classification
from app.services.csv_importer import parse_attachment_urls, parse_datetime_value
from app.services.notices import parse_budget, upsert_notice


G2B_QUERY_LABELS = {
    "1": "최근등록",
    "2": "마감기준",
}


def first_non_empty(item: dict[str, Any], keys: list[str]) -> str | None:
    for key in keys:
        value = item.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def parse_items_from_json(payload: dict[str, Any]) -> list[dict[str, Any]]:
    body = payload.get("response", {}).get("body", {})
    items = body.get("items", {})
    item = items.get("item") if isinstance(items, dict) else items
    if item is None:
        return []
    if isinstance(item, list):
        return [row for row in item if isinstance(row, dict)]
    if isinstance(item, dict):
        return [item]
    return []


def parse_items_from_xml(text: str) -> list[dict[str, Any]]:
    root = ElementTree.fromstring(text)
    rows: list[dict[str, Any]] = []
    for item in root.findall(".//item"):
        row = {child.tag.split("}", 1)[-1]: child.text for child in item}
        rows.append(row)
    return rows


def parse_total_count(response: httpx.Response) -> int | None:
    try:
        payload = response.json()
        raw_value = payload.get("response", {}).get("body", {}).get("totalCount")
    except Exception:
        try:
            root = ElementTree.fromstring(response.text)
            raw_value = root.findtext(".//totalCount")
        except Exception:
            raw_value = None

    if raw_value is None or str(raw_value).strip() == "":
        return None
    try:
        return int(str(raw_value).strip())
    except ValueError:
        return None


def parse_response_items(response: httpx.Response) -> list[dict[str, Any]]:
    content_type = response.headers.get("content-type", "")
    if "json" in content_type:
        return parse_items_from_json(response.json())
    try:
        return parse_items_from_json(response.json())
    except Exception:
        return parse_items_from_xml(response.text)


def compact_detail_content(item: dict[str, Any]) -> str:
    interesting_keys = [
        "bidNtceNm",
        "ntceInsttNm",
        "dminsttNm",
        "cntrctCnclsMthdNm",
        "bidMethdNm",
        "presmptPrce",
        "asignBdgtAmt",
        "bidPrtcptLmtYn",
        "rgnLmtBidLocplcJdgmBssCdNm",
        "rgnLmtBidLocplcJdgmBssCd",
        "prtcptPsblRgnNm",
        "prtcptPsblRgnCd",
        "indstrytyLmtYn",
        "indstrytyLmtCd",
        "indstrytyLmtCdNm",
        "indstrytyNm",
        "bidprcPsblIndstrytyNm",
        "pubPrcrmntLrgClsfcNm",
        "pubPrcrmntMidClsfcNm",
        "pubPrcrmntClsfcNm",
        "bidNtceDtlUrl",
    ]
    lines = []
    for key in interesting_keys:
        value = item.get(key)
        if value is not None and str(value).strip():
            lines.append(f"{key}: {value}")
    return "\n".join(lines)


def map_g2b_item_to_notice(item: dict[str, Any], operation: str) -> NoticeCreate:
    notice_no = first_non_empty(item, ["bidNtceNo", "ntceNo", "bidNo"])
    notice_order = first_non_empty(item, ["bidNtceOrd", "ntceOrd"])
    if notice_no and notice_order:
        notice_no = f"{notice_no}-{notice_order}"

    attachment_values = []
    for index in range(1, 11):
        attachment = first_non_empty(
            item,
            [
                f"ntceSpecDocUrl{index}",
                f"specDocUrl{index}",
                f"bidNtceSpecDocUrl{index}",
                f"atchFileUrl{index}",
            ],
        )
        if attachment:
            attachment_values.append(attachment)

    title = first_non_empty(item, ["bidNtceNm", "ntceNm", "pblancNm", "bidPblancNm"])
    if not title:
        raise ValueError("나라장터 응답에 공고명이 없습니다.")

    return NoticeCreate(
        notice_no=notice_no,
        title=title,
        ordering_agency=first_non_empty(item, ["ntceInsttNm", "dminsttNm", "orderInsttNm", "dminsttOfclDeptNm"]),
        posted_at=parse_datetime_value(first_non_empty(item, ["bidNtceDt", "ntceDt", "rgstDt", "bidNtceBgn"])),
        deadline_at=parse_datetime_value(first_non_empty(item, ["bidClseDt", "opengDt", "bidNtceEndDt"])),
        budget_amount=parse_budget(first_non_empty(item, ["asignBdgtAmt", "presmptPrce", "bdgtAmt"])),
        notice_url=first_non_empty(item, ["bidNtceDtlUrl", "bidNtceUrl", "pblancUrl", "ntceUrl"]),
        detail_content=compact_detail_content(item),
        attachment_urls=attachment_values or parse_attachment_urls(first_non_empty(item, ["atchFileUrl", "fileUrl"])),
        source=f"g2b:{operation}",
        source_raw=item,
    )


def g2b_datetime(value: datetime) -> str:
    return value.strftime("%Y%m%d%H%M")


def resolve_query_window(
    settings: Settings,
    inqry_div: str,
    start_date: datetime | None,
    end_date: datetime | None,
) -> tuple[datetime, datetime]:
    now = datetime.now()
    if start_date or end_date:
        start = start_date or (now - timedelta(days=settings.g2b_recent_window_days))
        end = end_date or now
    elif inqry_div == "2":
        start = now
        end = now + timedelta(days=settings.g2b_deadline_window_days)
    else:
        end = now
        start = end - timedelta(days=settings.g2b_recent_window_days)

    if start > end:
        start, end = end, start
    return start, end


def fetch_g2b_page(
    client: httpx.Client,
    settings: Settings,
    operation: str,
    inqry_div: str,
    start: datetime,
    end: datetime,
    page_no: int,
) -> tuple[list[dict[str, Any]], int | None]:
    url = f"{settings.g2b_api_endpoint.rstrip('/')}/{operation}"
    num_rows = max(1, settings.g2b_num_rows)
    params = {
        "serviceKey": settings.g2b_api_key,
        "pageNo": page_no,
        "numOfRows": num_rows,
        "type": "json",
        "inqryDiv": inqry_div,
        "inqryBgnDt": g2b_datetime(start),
        "inqryEndDt": g2b_datetime(end),
    }
    response = client.get(url, params=params)
    response.raise_for_status()
    return parse_response_items(response), parse_total_count(response)


def process_g2b_items(
    db: Session,
    operation: str,
    items: list[dict[str, Any]],
    run_ai: bool,
) -> tuple[int, int, int, int, list[str]]:
    created_count = 0
    updated_count = 0
    duplicate_count = 0
    classified_count = 0
    errors: list[str] = []

    for item in items:
        try:
            notice_data = map_g2b_item_to_notice(item, operation)
            notice, created, updated = upsert_notice(db, notice_data)
            if created:
                created_count += 1
            elif updated:
                updated_count += 1
            else:
                duplicate_count += 1
            classification = run_primary_classification(db, notice)
            if run_ai:
                apply_ai_classification(db, notice, classification)
            classified_count += 1
        except Exception as exc:
            errors.append(f"{operation}: {exc}")

    return created_count, updated_count, duplicate_count, classified_count, errors


def collect_from_g2b(
    db: Session,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    run_ai: bool = False,
) -> CollectResponse:
    settings = get_settings()
    if not settings.g2b_api_key:
        log = CollectionLog(
            source="g2b",
            operation=None,
            status="failed",
            message="G2B_API_KEY가 설정되어 있지 않습니다.",
            raw_error="missing_api_key",
        )
        db.add(log)
        db.commit()
        return CollectResponse(
            fetched_count=0,
            created_count=0,
            updated_count=0,
            duplicate_count=0,
            classified_count=0,
            errors=["G2B_API_KEY가 설정되어 있지 않습니다."],
        )

    fetched_count = 0
    created_count = 0
    updated_count = 0
    duplicate_count = 0
    classified_count = 0
    errors: list[str] = []

    max_pages = max(1, settings.g2b_max_pages_per_operation)
    timeout = httpx.Timeout(connect=10.0, read=45.0, write=10.0, pool=10.0)
    with httpx.Client(timeout=timeout) as client:
        for operation in settings.g2b_operations:
            for inqry_div in settings.g2b_inqry_div_list:
                operation_label = f"{operation}:inqryDiv={inqry_div}"
                operation_fetched = 0
                operation_created = 0
                operation_updated = 0
                operation_duplicate = 0
                try:
                    start, end = resolve_query_window(settings, inqry_div, start_date, end_date)
                    pages_read = 0

                    for page_no in range(1, max_pages + 1):
                        items, total_count = fetch_g2b_page(
                            client=client,
                            settings=settings,
                            operation=operation,
                            inqry_div=inqry_div,
                            start=start,
                            end=end,
                            page_no=page_no,
                        )
                        pages_read = page_no
                        if not items:
                            break

                        operation_fetched += len(items)
                        fetched_count += len(items)
                        (
                            page_created,
                            page_updated,
                            page_duplicate,
                            page_classified,
                            page_errors,
                        ) = process_g2b_items(db, operation, items, run_ai)

                        operation_created += page_created
                        operation_updated += page_updated
                        operation_duplicate += page_duplicate
                        created_count += page_created
                        updated_count += page_updated
                        duplicate_count += page_duplicate
                        classified_count += page_classified
                        errors.extend(page_errors)

                        if total_count is not None and page_no * max(1, settings.g2b_num_rows) >= total_count:
                            break

                    db.add(
                        CollectionLog(
                            source="g2b",
                            operation=operation_label,
                            status="success",
                            message=(
                                f"나라장터 공고 수집 완료 ({G2B_QUERY_LABELS.get(inqry_div, inqry_div)}, "
                                f"{pages_read}페이지, 갱신 {operation_updated}건, 중복 {operation_duplicate}건)"
                            ),
                            fetched_count=operation_fetched,
                            created_count=operation_created,
                        )
                    )
                    db.commit()
                except Exception as exc:
                    errors.append(f"{operation_label}: {exc}")
                    db.rollback()
                    db.add(
                        CollectionLog(
                            source="g2b",
                            operation=operation_label,
                            status="failed",
                            message="나라장터 공고 수집 실패",
                            fetched_count=operation_fetched,
                            created_count=operation_created,
                            raw_error=str(exc),
                        )
                    )
                    db.commit()

    return CollectResponse(
        fetched_count=fetched_count,
        created_count=created_count,
        updated_count=updated_count,
        duplicate_count=duplicate_count,
        classified_count=classified_count,
        errors=errors,
    )
