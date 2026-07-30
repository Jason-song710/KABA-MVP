from __future__ import annotations

from html import unescape
from io import BytesIO
import re
from typing import TYPE_CHECKING
from urllib.parse import unquote
from zipfile import BadZipFile, ZipFile

if TYPE_CHECKING:
    import httpx

try:
    from pypdf import PdfReader
except Exception:  # pragma: no cover - optional dependency fallback
    PdfReader = None


DETAIL_LABELS = {
    "industry": {"업종제한사항", "업종제한", "참가가능업종", "허용업종", "제한업종"},
    "region": {"지역제한", "지역제한사항", "참가가능지역"},
    "qualification": {"입찰참가자격", "입찰자격", "참가자격", "투찰자격"},
    "task": {
        "과업내용",
        "과업 내용",
        "과업개요",
        "과업 개요",
        "사업내용",
        "사업 내용",
        "사업개요",
        "사업 개요",
        "용역내용",
        "용역 내용",
        "공사내용",
        "공사 내용",
        "주요내용",
        "주요 내용",
        "제안요청내용",
        "제안 요청 내용",
        "수행내용",
        "수행 내용",
    },
}

NEXT_SECTION_LABELS = {
    "입찰자격",
    "참가자격",
    "투찰제한",
    "투찰제한-일반",
    "공동수급",
    "첨부파일",
    "물품정보",
    "공고서",
    "낙찰자선정",
    "계약조건",
    "담당자",
    "평가기준",
    "제출서류",
}

INDUSTRY_HINT_PATTERN = re.compile(
    r"(소프트웨어사업자|컴퓨터관련서비스사업|디지털콘텐츠개발서비스사업|정보통신공사업|전기공사업|"
    r"건설업|전문공사업|측량업|공공측량업|측지측량업|수로측량업|지도제작업|지하시설물측량업|"
    r"엔지니어링사업자|기술사사무소|공사업|사업자|면허|허가|등록한 업체|등록 업체|업종을 등록|"
    r"입찰참가자격등록)",
    re.IGNORECASE,
)

TASK_HINT_PATTERN = re.compile(
    r"(구축|개발|고도화|운영|유지관리|정비|제작|설치|조사|측량|공사|용역|사업|DB|데이터|"
    r"GIS|공간정보|지도|수치지도|도로대장|정사영상|주소|디지털트윈|BIM|LiDAR|라이다|플랫폼|시스템)",
    re.IGNORECASE,
)

RAW_FIELD_PATTERN = re.compile(r"\b[a-z][a-z0-9]{2,}(?:Nm|No|Cd|Yn|Dt|Url|Amt|Mthd|Text):", re.IGNORECASE)
URL_PATTERN = re.compile(r"https?://\S+", re.IGNORECASE)
NOISE_PATTERN = re.compile(r"(클릭|조회|확인하시기 바랍니다|유의하시기 바랍니다|아래는|No\s+투찰가능업종)", re.IGNORECASE)
IMPORTANT_ATTACHMENT_PATTERN = re.compile(
    r"(공고|제안|요청|과업|시방|규격|설계|내역|유의|계약|평가|자격|업종|제한|첨부)",
    re.IGNORECASE,
)

MAX_ATTACHMENT_FETCHES = 3
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024


def clean_line(value: str) -> str:
    return re.sub(r"\s+", " ", unescape(value or "")).strip()


def unique_values(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        cleaned = clean_line(value).strip(" -:;")
        key = cleaned.casefold()
        if not cleaned or key in seen:
            continue
        seen.add(key)
        result.append(cleaned)
    return result


def compact_join(values: list[str], limit: int = 900) -> str | None:
    text = " / ".join(unique_values(values))
    if not text:
        return None
    return text if len(text) <= limit else f"{text[:limit].rstrip()}..."


def html_to_lines(value: str) -> list[str]:
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", value or "")
    text = re.sub(r"(?i)<\s*(td|th|tr|p|div|li|br|h[1-6]|section|table)(?:\s[^>]*)?>", "\n", text)
    text = re.sub(r"(?i)</(td|th|tr|p|div|li|br|h[1-6]|section|table)\s*>", "\n", text)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    return [line for line in (clean_line(line) for line in text.splitlines()) if line]


def text_to_lines(value: str) -> list[str]:
    return [line for line in (clean_line(line) for line in re.split(r"[\r\n]+", value or "")) if line]


def is_section_boundary(line: str) -> bool:
    if line in NEXT_SECTION_LABELS:
        return True
    return bool(re.fullmatch(r".{0,20}(제한|자격|정보|첨부|계약|담당자|평가|서류).{0,10}", line)) and len(line) <= 24


def is_noise_line(line: str) -> bool:
    return (
        len(line) < 2
        or URL_PATTERN.search(line) is not None
        or RAW_FIELD_PATTERN.search(line) is not None
        or NOISE_PATTERN.search(line) is not None
    )


def inline_label_value(line: str, labels: set[str]) -> str | None:
    for label in labels:
        if label not in line:
            continue
        after = line.split(label, 1)[1]
        after = clean_line(after).strip(" :-[]()")
        if after and not is_noise_line(after):
            return after
    return None


def extract_after_label(lines: list[str], labels: set[str], prefer_hint: re.Pattern[str] | None = None) -> str | None:
    for index, line in enumerate(lines):
        if not any(label in line for label in labels):
            continue
        inline = inline_label_value(line, labels)
        if inline and (prefer_hint is None or prefer_hint.search(inline)):
            return inline

        candidates: list[str] = []
        for next_line in lines[index + 1 : index + 12]:
            if next_line in labels:
                continue
            if is_section_boundary(next_line) and candidates:
                break
            if next_line in {"투찰제한", "허용업종", "No", "-", "공고서참조", "공고서 참조", "참조"}:
                continue
            if is_noise_line(next_line):
                continue
            if prefer_hint is not None and not prefer_hint.search(next_line) and len(next_line) < 30:
                continue
            candidates.append(next_line)
            if prefer_hint is not None and prefer_hint.search(next_line):
                break
        if candidates:
            return " ".join(candidates[:2])
    return None


def extract_industry_text(lines: list[str]) -> str | None:
    labeled = extract_after_label(lines, DETAIL_LABELS["industry"], prefer_hint=INDUSTRY_HINT_PATTERN)
    matches = [labeled] if labeled else []
    for line in lines:
        if len(line) <= 700 and INDUSTRY_HINT_PATTERN.search(line) and not is_noise_line(line):
            matches.append(line)
    return compact_join([match for match in matches if match], limit=1200)


def extract_task_summary_text(lines: list[str]) -> str | None:
    labeled = extract_after_label(lines, DETAIL_LABELS["task"], prefer_hint=TASK_HINT_PATTERN)
    candidates = [labeled] if labeled else []
    for line in lines:
        if len(line) < 12 or len(line) > 700:
            continue
        if is_noise_line(line):
            continue
        if INDUSTRY_HINT_PATTERN.search(line):
            continue
        if TASK_HINT_PATTERN.search(line):
            candidates.append(line)
        if len(candidates) >= 5:
            break
    return compact_join([candidate for candidate in candidates if candidate], limit=1200)


def extract_detail_page_enrichment(html: str, source_url: str) -> dict[str, str]:
    lines = html_to_lines(html)
    industry = extract_industry_text(lines)
    region = extract_after_label(lines, DETAIL_LABELS["region"])
    qualification = extract_after_label(lines, DETAIL_LABELS["qualification"])
    task_summary = extract_task_summary_text(lines)

    result: dict[str, str] = {"g2bDetailRestrictionSourceUrl": source_url}
    if task_summary:
        result["g2bDetailTaskSummaryText"] = task_summary
    if industry:
        result["g2bDetailIndustryLimitText"] = industry
    if region:
        result["g2bDetailRegionLimitText"] = region
    if qualification:
        result["g2bDetailQualificationText"] = qualification
    return result if len(result) > 1 else {}


def decode_bytes(content: bytes) -> str:
    for encoding in ["utf-8-sig", "cp949", "euc-kr", "utf-16", "latin1"]:
        try:
            text = content.decode(encoding)
        except UnicodeDecodeError:
            continue
        cleaned = clean_line(text[:4000])
        printable_ratio = sum(1 for char in cleaned if char.isprintable()) / max(len(cleaned), 1)
        if printable_ratio > 0.75:
            return text
    return ""


def xml_bytes_to_lines(content: bytes) -> list[str]:
    text = decode_bytes(content)
    if not text:
        return []
    text = re.sub(r"(?i)<(w:p|p|row|tr|table|section|paragraph)[^>]*>", "\n", text)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    return text_to_lines(text)


def extract_zip_document_lines(content: bytes) -> list[str]:
    try:
        with ZipFile(BytesIO(content)) as archive:
            names = [
                name
                for name in archive.namelist()
                if name.lower().endswith(".xml")
                and (
                    name.startswith("word/")
                    or name.startswith("xl/")
                    or name.startswith("Contents/")
                    or name.startswith("Body/")
                    or "hwp" in name.lower()
                    or "section" in name.lower()
                )
            ]
            lines: list[str] = []
            for name in names[:16]:
                try:
                    lines.extend(xml_bytes_to_lines(archive.read(name)[:1_500_000]))
                except Exception:
                    continue
            return lines
    except (BadZipFile, ValueError):
        return []


def extract_pdf_lines(content: bytes) -> list[str]:
    if PdfReader is None:
        return []
    try:
        reader = PdfReader(BytesIO(content))
        text = "\n".join((page.extract_text() or "") for page in reader.pages[:6])
    except Exception:
        return []
    return text_to_lines(text)


def attachment_response_lines(response: httpx.Response, url: str, label: str | None) -> list[str]:
    content = response.content[:MAX_ATTACHMENT_BYTES]
    lowered_hint = f"{url} {label or ''} {response.headers.get('content-type', '')}".casefold()
    if content.startswith(b"%PDF") or ".pdf" in lowered_hint or "application/pdf" in lowered_hint:
        return extract_pdf_lines(content)
    if content.startswith(b"PK"):
        return extract_zip_document_lines(content)
    if any(token in lowered_hint for token in ["text/", "html", "xml", "json", ".txt", ".csv", ".htm"]):
        return html_to_lines(decode_bytes(content))
    decoded = decode_bytes(content)
    if decoded:
        return text_to_lines(decoded)
    return []


def should_fetch_attachment(url: str, label: str | None) -> bool:
    hint = f"{url} {label or ''}"
    return bool(IMPORTANT_ATTACHMENT_PATTERN.search(hint)) or bool(
        re.search(r"\.(pdf|docx|hwpx|hwp|txt|html?|xml)(?:[?#]|$)", url, re.IGNORECASE)
    )


def fetch_attachment_enrichment(
    client: httpx.Client,
    urls: list[str],
    labels: list[str] | None = None,
    headers: dict[str, str] | None = None,
) -> dict[str, str]:
    result: dict[str, str] = {}
    summaries: list[str] = []
    industries: list[str] = []
    sources: list[str] = []
    seen: set[str] = set()
    label_values = labels or []

    for index, url in enumerate(urls[:MAX_ATTACHMENT_FETCHES]):
        if not url or url in seen:
            continue
        seen.add(url)
        label = label_values[index] if index < len(label_values) else None
        if not should_fetch_attachment(url, label):
            continue
        try:
            head_length = None
            response = client.get(url, headers=headers, timeout=12.0, follow_redirects=True)
            length_header = response.headers.get("content-length")
            if length_header and length_header.isdigit():
                head_length = int(length_header)
            if head_length and head_length > MAX_ATTACHMENT_BYTES:
                continue
            response.raise_for_status()
            if len(response.content) > MAX_ATTACHMENT_BYTES:
                continue
        except Exception:
            continue

        lines = attachment_response_lines(response, url, label)
        if not lines:
            continue
        summary = extract_task_summary_text(lines)
        industry = extract_industry_text(lines)
        if summary:
            summaries.append(summary)
        if industry:
            industries.append(industry)
        if summary or industry:
            sources.append(label or unquote(url.split("/")[-1].split("?")[0]) or f"첨부파일 {index + 1}")

    summary_text = compact_join(summaries, limit=1200)
    industry_text = compact_join(industries, limit=1200)
    source_text = compact_join(sources, limit=500)
    if summary_text:
        result["g2bAttachmentTaskSummaryText"] = summary_text
    if industry_text:
        result["g2bAttachmentIndustryLimitText"] = industry_text
    if source_text:
        result["g2bAttachmentInspectionSourceText"] = source_text
    return result
