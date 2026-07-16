from datetime import datetime, timedelta
from html import unescape
import re
from typing import Any, Callable
from xml.etree import ElementTree

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.models import CollectionLog, KeywordDictionary
from app.schemas import CollectResponse, NoticeCreate
from app.services.ai_classifier import apply_ai_classification
from app.services.classifier import run_primary_classification
from app.services.csv_importer import parse_attachment_urls, parse_datetime_value
from app.services.notices import parse_budget, upsert_notice


G2B_QUERY_LABELS = {
    "1": "최근등록",
    "2": "마감기준",
}

G2B_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
}

ProgressCallback = Callable[[dict[str, Any]], None]

KEYWORD_GRADE_PRIORITY = {"S": 0, "A": 1, "B": 2, "C": 3, "D": 4}

DETAIL_LABELS = {
    "industry": {"업종제한사항", "업종제한", "참가가능업종", "허용업종"},
    "region": {"지역제한", "지역제한사항", "참가가능지역"},
    "qualification": {"입찰참가자격", "입찰자격"},
}

NEXT_SECTION_LABELS = {
    "입찰자격",
    "투찰제한-일반",
    "공동수급",
    "첨부파일",
    "물품정보",
    "공고서",
    "낙찰자선정",
    "계약조건",
    "담당자",
}

INDUSTRY_HINT_PATTERN = re.compile(
    r"(소프트웨어사업자|정보통신공사업|전기공사업|건설업|전문공사업|측량업|엔지니어링사업자|"
    r"공사업|사업자|면허|허가|등록한 업체|등록 업체|업종을 등록)",
    re.IGNORECASE,
)


def first_non_empty(item: dict[str, Any], keys: list[str]) -> str | None:
    for key in keys:
        value = item.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def g2b_item_dedupe_key(item: dict[str, Any]) -> str | None:
    notice_no = first_non_empty(item, ["bidNtceNo", "ntceNo", "bidNo"])
    notice_order = first_non_empty(item, ["bidNtceOrd", "ntceOrd"])
    if notice_no:
        return f"notice:{notice_no}-{notice_order or '000'}"

    title = first_non_empty(item, ["bidNtceNm", "ntceNm", "pblancNm", "bidPblancNm"])
    agency = first_non_empty(item, ["ntceInsttNm", "dminsttNm", "orderInsttNm", "dminsttOfclDeptNm"])
    posted_at = first_non_empty(item, ["bidNtceDt", "ntceDt", "rgstDt", "bidNtceBgn"])
    if title and agency and posted_at:
        compact = "|".join(part.strip() for part in [title, agency, posted_at])
        return f"fallback:{compact}"
    return None


def keyword_precollect_terms(db: Session, settings: Settings) -> list[str]:
    if not settings.g2b_keyword_precollect_enabled:
        return []

    keywords = db.execute(
        select(KeywordDictionary).where(KeywordDictionary.is_active.is_(True))
    ).scalars().all()
    ordered = sorted(
        keywords,
        key=lambda item: (
            KEYWORD_GRADE_PRIORITY.get(item.grade, 9),
            -len(item.keyword.strip()),
            item.keyword,
        ),
    )

    terms: list[str] = []
    seen: set[str] = set()
    max_terms = settings.g2b_keyword_precollect_max_terms
    for keyword in ordered:
        term = keyword.keyword.strip()
        compact = re.sub(r"\s+", "", term).upper()
        if not term or compact in seen:
            continue
        if len(compact) < 2 and not re.search(r"[가-힣]", term):
            continue
        seen.add(compact)
        terms.append(term)
        if max_terms > 0 and len(terms) >= max_terms:
            break
    return terms


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


def html_to_lines(value: str) -> list[str]:
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", value)
    text = re.sub(r"(?i)<\s*(td|th|tr|p|div|li|br|h[1-6])(?:\s[^>]*)?>", "\n", text)
    text = re.sub(r"(?i)</(td|th|tr|p|div|li|br|h[1-6])\s*>", "\n", text)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    text = unescape(text)
    return [re.sub(r"\s+", " ", line).strip() for line in text.splitlines() if re.sub(r"\s+", " ", line).strip()]


def is_section_boundary(line: str) -> bool:
    return line in NEXT_SECTION_LABELS or bool(re.fullmatch(r".{0,20}(제한|자격|정보|첨부|계약|담당자).{0,10}", line)) and len(line) <= 20


def extract_after_label(lines: list[str], labels: set[str], prefer_industry_hint: bool = False) -> str | None:
    for index, line in enumerate(lines):
        if not any(label in line for label in labels):
            continue
        candidates: list[str] = []
        for next_line in lines[index + 1 : index + 8]:
            if next_line in labels:
                continue
            if is_section_boundary(next_line) and candidates:
                break
            if next_line in {"투찰제한", "허용업종", "No", "-", "공고서참조", "참조"}:
                continue
            if prefer_industry_hint and not INDUSTRY_HINT_PATTERN.search(next_line) and len(next_line) < 20:
                continue
            candidates.append(next_line)
            if prefer_industry_hint and INDUSTRY_HINT_PATTERN.search(next_line):
                break
        if candidates:
            return " ".join(candidates[:2])
    return None


def extract_industry_text(lines: list[str]) -> str | None:
    labeled = extract_after_label(lines, DETAIL_LABELS["industry"], prefer_industry_hint=True)
    if labeled:
        return labeled

    matches: list[str] = []
    for line in lines:
        if INDUSTRY_HINT_PATTERN.search(line) and len(line) <= 500:
            matches.append(line)
    return " / ".join(dict.fromkeys(matches[:3])) if matches else None


def legacy_detail_urls(item: dict[str, Any]) -> list[str]:
    bid_no = first_non_empty(item, ["bidNtceNo", "bidNo", "ntceNo"])
    bid_ord = first_non_empty(item, ["bidNtceOrd", "bidSeq", "bidseq", "ntceOrd"]) or "000"
    if not bid_no:
        return []
    return [
        f"https://www.g2b.go.kr:8101/ep/tbid/tbidFwd.do?bidno={bid_no}&bidseq={bid_ord}&bidtype=1",
        f"https://www.g2b.go.kr/ep/tbid/tbidFwd.do?bidno={bid_no}&bidseq={bid_ord}&bidtype=1",
    ]


def should_fetch_detail_page(item: dict[str, Any]) -> bool:
    text = " ".join(str(item.get(key, "")) for key in ["cntrctCnclsMthdNm", "bidMethdNm", "bidNtceNm"])
    flags = [
        first_non_empty(item, ["indstrytyLmtYn", "indstrytyPrtcptLmtYn"]),
        first_non_empty(item, ["prdctClsfcLmtYn"]),
        first_non_empty(item, ["bidPrtcptLmtYn"]),
    ]
    return any(str(value).strip().upper() == "Y" for value in flags if value) or any(token in text for token in ["제한", "수의", "시담"])


def fetch_detail_restrictions(client: httpx.Client, item: dict[str, Any]) -> dict[str, str]:
    if not should_fetch_detail_page(item):
        return {}

    urls = [
        url
        for url in [
            first_non_empty(item, ["bidNtceDtlUrl", "bidNtceUrl", "pblancUrl", "ntceUrl"]),
            *legacy_detail_urls(item),
        ]
        if url
    ]
    for url in dict.fromkeys(urls):
        try:
            response = client.get(url, headers=G2B_BROWSER_HEADERS, timeout=15.0)
            response.raise_for_status()
        except Exception:
            continue

        lines = html_to_lines(response.text)
        industry = extract_industry_text(lines)
        region = extract_after_label(lines, DETAIL_LABELS["region"])
        qualification = extract_after_label(lines, DETAIL_LABELS["qualification"])
        if industry or region or qualification:
            result = {"g2bDetailRestrictionSourceUrl": url}
            if industry:
                result["g2bDetailIndustryLimitText"] = industry
            if region:
                result["g2bDetailRegionLimitText"] = region
            if qualification:
                result["g2bDetailQualificationText"] = qualification
            return result
    return {}


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
        "rgnLmtBidLocplcJdgmBssNm",
        "rgnLmtBidLocplcJdgmBssCd",
        "prtcptPsblRgnNm",
        "prtcptPsblRgnCd",
        "prdctClsfcLmtYn",
        "dtilPrdctClsfcNo",
        "dtilPrdctClsfcNoNm",
        "indstrytyLmtYn",
        "indstrytyLmtCd",
        "indstrytyLmtCdNm",
        "indstrytyNm",
        "indstrytyClsfcNm",
        "indstrytyPrtcptLmtYn",
        "bidprcPsblIndstrytyNm",
        "bidprcPsblIndstrytyCd",
        "bidprcPsblIndstrytyCdNm",
        "prtcptPsblIndstrytyNm",
        "prtcptPsblIndstrytyCd",
        "prtcptPsblIndstrytyCdNm",
        "pubPrcrmntLrgClsfcNm",
        "pubPrcrmntMidClsfcNm",
        "pubPrcrmntClsfcNm",
        "g2bDetailIndustryLimitText",
        "g2bDetailRegionLimitText",
        "g2bDetailQualificationText",
        "g2bDetailRestrictionSourceUrl",
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
    title_query: str | None = None,
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
    if title_query:
        params["bidNtceNm"] = title_query
    response = client.get(url, params=params)
    response.raise_for_status()
    return parse_response_items(response), parse_total_count(response)


def process_g2b_items(
    db: Session,
    client: httpx.Client,
    operation: str,
    items: list[dict[str, Any]],
    run_ai: bool,
    seen_notice_keys: set[str] | None = None,
) -> tuple[int, int, int, int, list[str]]:
    created_count = 0
    updated_count = 0
    duplicate_count = 0
    classified_count = 0
    errors: list[str] = []

    for item in items:
        try:
            dedupe_key = g2b_item_dedupe_key(item)
            if seen_notice_keys is not None and dedupe_key:
                if dedupe_key in seen_notice_keys:
                    duplicate_count += 1
                    continue
                seen_notice_keys.add(dedupe_key)

            detail_restrictions = fetch_detail_restrictions(client, item)
            if detail_restrictions:
                item = {**item, **detail_restrictions}
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


def emit_progress(
    progress_callback: ProgressCallback | None,
    operation_label: str,
    page_no: int,
    pages_read: int,
    total_count: int | None,
    fetched_count: int,
    created_count: int,
    updated_count: int,
    duplicate_count: int,
    classified_count: int,
    operation_fetched: int,
    operation_created: int,
    operation_updated: int,
    operation_duplicate: int,
    keyword: str | None = None,
) -> None:
    if not progress_callback:
        return
    progress_callback(
        {
            "operation": operation_label,
            "keyword": keyword,
            "page_no": page_no,
            "pages_read": pages_read,
            "total_count": total_count,
            "fetched_count": fetched_count,
            "created_count": created_count,
            "updated_count": updated_count,
            "duplicate_count": duplicate_count,
            "classified_count": classified_count,
            "operation_fetched": operation_fetched,
            "operation_created": operation_created,
            "operation_updated": operation_updated,
            "operation_duplicate": operation_duplicate,
        }
    )


def collect_from_g2b(
    db: Session,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    run_ai: bool = False,
    progress_callback: ProgressCallback | None = None,
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

    max_pages = settings.g2b_max_pages_per_operation if settings.g2b_max_pages_per_operation > 0 else 500
    keyword_terms = keyword_precollect_terms(db, settings)
    keyword_max_pages = max(1, settings.g2b_keyword_precollect_max_pages_per_term)
    run_full_collect = settings.g2b_full_collect_enabled or not keyword_terms
    seen_notice_keys: set[str] = set()
    timeout = httpx.Timeout(connect=10.0, read=45.0, write=10.0, pool=10.0)
    with httpx.Client(timeout=timeout) as client:
        for keyword in keyword_terms:
            for operation in settings.g2b_operations:
                for inqry_div in settings.g2b_keyword_precollect_inqry_div_list:
                    operation_label = f"keyword:{keyword}:{operation}:inqryDiv={inqry_div}"
                    operation_fetched = 0
                    operation_created = 0
                    operation_updated = 0
                    operation_duplicate = 0
                    try:
                        start, end = resolve_query_window(settings, inqry_div, start_date, end_date)
                        pages_read = 0

                        for page_no in range(1, keyword_max_pages + 1):
                            items, total_count = fetch_g2b_page(
                                client=client,
                                settings=settings,
                                operation=operation,
                                inqry_div=inqry_div,
                                start=start,
                                end=end,
                                page_no=page_no,
                                title_query=keyword,
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
                            ) = process_g2b_items(db, client, operation, items, run_ai, seen_notice_keys)

                            operation_created += page_created
                            operation_updated += page_updated
                            operation_duplicate += page_duplicate
                            created_count += page_created
                            updated_count += page_updated
                            duplicate_count += page_duplicate
                            classified_count += page_classified
                            errors.extend(page_errors)

                            emit_progress(
                                progress_callback,
                                operation_label,
                                page_no,
                                pages_read,
                                total_count,
                                fetched_count,
                                created_count,
                                updated_count,
                                duplicate_count,
                                classified_count,
                                operation_fetched,
                                operation_created,
                                operation_updated,
                                operation_duplicate,
                                keyword=keyword,
                            )

                            if total_count is not None and page_no * max(1, settings.g2b_num_rows) >= total_count:
                                break

                        db.add(
                            CollectionLog(
                                source="g2b",
                                operation=operation_label,
                                status="success",
                                message=(
                                    f"키워드 '{keyword}' 제목검색 수집 완료 "
                                    f"({G2B_QUERY_LABELS.get(inqry_div, inqry_div)}, {pages_read}페이지, "
                                    f"신규 {operation_created}건, 갱신 {operation_updated}건, 중복 {operation_duplicate}건)"
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
                                message=f"키워드 '{keyword}' 제목검색 수집 실패",
                                fetched_count=operation_fetched,
                                created_count=operation_created,
                                raw_error=str(exc),
                            )
                        )
                        db.commit()

        if run_full_collect:
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
                            ) = process_g2b_items(db, client, operation, items, run_ai, seen_notice_keys)

                            operation_created += page_created
                            operation_updated += page_updated
                            operation_duplicate += page_duplicate
                            created_count += page_created
                            updated_count += page_updated
                            duplicate_count += page_duplicate
                            classified_count += page_classified
                            errors.extend(page_errors)

                            emit_progress(
                                progress_callback,
                                operation_label,
                                page_no,
                                pages_read,
                                total_count,
                                fetched_count,
                                created_count,
                                updated_count,
                                duplicate_count,
                                classified_count,
                                operation_fetched,
                                operation_created,
                                operation_updated,
                                operation_duplicate,
                            )

                            if total_count is not None and page_no * max(1, settings.g2b_num_rows) >= total_count:
                                break

                        db.add(
                            CollectionLog(
                                source="g2b",
                                operation=operation_label,
                                status="success",
                                message=(
                                    f"나라장터 전체 수집 완료 ({G2B_QUERY_LABELS.get(inqry_div, inqry_div)}, "
                                    f"{pages_read}페이지, 신규 {operation_created}건, 갱신 {operation_updated}건, 중복 {operation_duplicate}건)"
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
                                message="나라장터 전체 수집 실패",
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
