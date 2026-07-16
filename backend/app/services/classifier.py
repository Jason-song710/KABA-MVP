from datetime import datetime
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.constants import BUSINESS_TAG_RULES, PRIMARY_TO_FINAL_CATEGORY
from app.models import ExcludedKeyword, KeywordDictionary, Notice, NoticeClassification


GRADE_SCORE_CAPS = {
    "S": 20,
    "A": 16,
    "B": 10,
    "C": 6,
    "D": 3,
}

RAW_G2B_FIELD_PATTERN = re.compile(
    r"\b(?:bidNtceNm|bidNtceNo|ntceInsttNm|dminsttNm|cntrctCnclsMthdNm|bidMethdNm|"
    r"presmptPrce|asignBdgtAmt|bidPrtcptLmtYn|indstrytyLmtYn|pubPrcmntLrgClsfcNm|"
    r"bidNtceDt|bidClseDt|ntceKindNm|bsnsDivNm|rgnLmtBidLocplcJdgmBssCdNm|"
    r"rgnLmtBidLocplcJdgmBssNm|rgnLmtBidLocplcJdgmBssCd|prtcptPsblRgnNm|"
    r"prtcptPsblRgnCd|prdctClsfcLmtYn|dtilPrdctClsfcNo|dtilPrdctClsfcNoNm|indstrytyLmtCd|"
    r"indstrytyLmtCdNm|indstrytyNm|indstrytyClsfcNm|indstrytyPrtcptLmtYn|"
    r"bidprcPsblIndstrytyNm|bidprcPsblIndstrytyCd|bidprcPsblIndstrytyCdNm|"
    r"prtcptPsblIndstrytyNm|prtcptPsblIndstrytyCd|prtcptPsblIndstrytyCdNm|"
    r"g2bDetailIndustryLimitText|g2bDetailRegionLimitText|g2bDetailQualificationText|"
    r"g2bDetailRestrictionSourceUrl)\b",
    re.IGNORECASE,
)


def normalize(value: str | None) -> str:
    return (value or "").casefold()


def keyword_signature(value: str | None) -> str:
    return re.sub(r"\s+", "", normalize(value))


def notice_text(notice: Notice) -> str:
    parts = [
        notice.title,
        notice.ordering_agency,
        notice.detail_content,
        " ".join(notice.attachment_urls or []),
    ]
    return "\n".join(part for part in parts if part)


def primary_category_from_score(score: int, has_strong_exclusion: bool) -> str:
    if has_strong_exclusion:
        return "제외공고 후보"
    if score >= 20:
        return "주소산업 핵심공고 후보"
    if score >= 10:
        return "주소산업 관련공고 후보"
    return "참고공고 후보"


def compact_text(value: str | None, limit: int = 260) -> str:
    text = " ".join((value or "").split())
    if not text:
        return "상세내용이 제공되지 않았습니다."
    if RAW_G2B_FIELD_PATTERN.search(text):
        return "상세내용은 원문 링크에서 확인할 수 있습니다."
    if len(text) > limit:
        return f"{text[:limit]}..."
    return text


def matched_keyword_sentence(matched_keywords: dict[str, list[str]]) -> str:
    parts = []
    for grade in ["S", "A", "B", "C", "D"]:
        values = matched_keywords.get(grade, [])
        if values:
            parts.append(f"{grade}등급 {', '.join(values)}")
    return "; ".join(parts) if parts else "주소산업 키워드 매칭 없음"


def unique_values(values: list[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for value in values:
        normalized = normalize(value)
        if value and normalized not in seen:
            seen.add(normalized)
            unique.append(value)
    return unique


def text_contains_keyword(normalized_text: str, keyword: str) -> bool:
    normalized_keyword = normalize(keyword)
    if not normalized_keyword:
        return False
    if normalized_keyword.isascii() and normalized_keyword.isalnum() and len(normalized_keyword) <= 3:
        return re.search(rf"(?<![a-z0-9]){re.escape(normalized_keyword)}(?![a-z0-9])", normalized_text) is not None
    return normalized_keyword in normalized_text


def is_shadowed_keyword(signature: str, matched_signatures: list[str]) -> bool:
    if not signature:
        return True
    return any(signature == matched or (len(signature) < len(matched) and signature in matched) for matched in matched_signatures)


def business_tags_from_text(normalized_text: str) -> list[str]:
    tags: list[str] = []
    for tag, keywords in BUSINESS_TAG_RULES.items():
        if any(text_contains_keyword(normalized_text, keyword) for keyword in keywords):
            tags.append(tag)
    return tags


def business_tags_from_notice(notice: Notice) -> list[str]:
    return business_tags_from_text(normalize(notice_text(notice)))


def build_primary_reason(
    score: int,
    primary_category: str,
    matched_keywords: dict[str, list[str]],
    excluded_hits: list[str],
    has_strong_exclusion: bool,
    business_tags: list[str],
) -> str:
    reason = (
        f"1차 키워드 분류 결과 총 {score}점으로 '{primary_category}'에 해당합니다. "
        f"매칭 근거는 {matched_keyword_sentence(matched_keywords)}입니다."
    )
    if business_tags:
        reason += f" 업무 구분자는 {', '.join(business_tags)}입니다."
    if excluded_hits:
        reason += f" 제외 키워드로 {', '.join(excluded_hits)}가 감지되었습니다."
    if has_strong_exclusion:
        reason += " 제외 키워드가 제목에 포함되었거나 복수로 감지되어 제외 후보 판단을 우선 적용했습니다."
    return reason


def build_primary_summary(
    notice: Notice,
    score: int,
    final_category: str,
    matched_keywords: dict[str, list[str]],
    excluded_hits: list[str],
    business_tags: list[str],
) -> str:
    agency = notice.ordering_agency or "발주기관 미상"
    posted = notice.posted_at.strftime("%Y-%m-%d") if notice.posted_at else "공고일 미상"
    deadline = notice.deadline_at.strftime("%Y-%m-%d %H:%M") if notice.deadline_at else "마감일 미상"
    budget = f"{int(notice.budget_amount):,}원" if notice.budget_amount is not None else "예산 미상"
    exclusion_text = f" 제외 키워드는 {', '.join(excluded_hits)}입니다." if excluded_hits else " 제외 키워드는 감지되지 않았습니다."
    tag_text = f" 업무 구분자는 {', '.join(business_tags)}입니다." if business_tags else " 업무 구분자는 감지되지 않았습니다."
    return (
        f"{agency}에서 발주한 '{notice.title}' 공고입니다. 공고일은 {posted}, 마감일은 {deadline}, 예산은 {budget}입니다. "
        f"상세내용 기준 주요 과업은 '{compact_text(notice.detail_content)}'입니다. "
        f"주소산업 키워드 매칭은 {matched_keyword_sentence(matched_keywords)}이며, "
        f"1차 점수 {score}점으로 최종 표시 분류는 '{final_category}'입니다."
        f"{tag_text}{exclusion_text}"
    )


def run_primary_classification(db: Session, notice: Notice) -> NoticeClassification:
    keywords = db.execute(
        select(KeywordDictionary).where(KeywordDictionary.is_active.is_(True))
    ).scalars().all()
    excluded_keywords = db.execute(
        select(ExcludedKeyword).where(ExcludedKeyword.is_active.is_(True))
    ).scalars().all()

    full_text = normalize(notice_text(notice))
    title_text = normalize(notice.title)

    matched_keywords: dict[str, list[str]] = {"S": [], "A": [], "B": [], "C": [], "D": []}
    grade_scores: dict[str, int] = {"S": 0, "A": 0, "B": 0, "C": 0, "D": 0}
    matched_signatures: list[str] = []

    ordered_keywords = sorted(
        keywords,
        key=lambda item: len(keyword_signature(item.keyword)),
        reverse=True,
    )
    for keyword in ordered_keywords:
        signature = keyword_signature(keyword.keyword)
        if is_shadowed_keyword(signature, matched_signatures):
            continue
        if text_contains_keyword(full_text, keyword.keyword):
            matched_keywords.setdefault(keyword.grade, []).append(keyword.keyword)
            grade_scores[keyword.grade] = grade_scores.get(keyword.grade, 0) + keyword.score
            matched_signatures.append(signature)

    score = sum(min(value, GRADE_SCORE_CAPS.get(grade, value)) for grade, value in grade_scores.items())

    excluded_hits: list[str] = []
    strong_title_hits = 0
    for excluded in excluded_keywords:
        if text_contains_keyword(full_text, excluded.keyword):
            excluded_hits.append(excluded.keyword)
            if excluded.is_strong and text_contains_keyword(title_text, excluded.keyword):
                strong_title_hits += 1

    has_strong_exclusion = strong_title_hits > 0 or len(excluded_hits) >= 2
    primary_category = primary_category_from_score(score, has_strong_exclusion)
    fallback_final_category = PRIMARY_TO_FINAL_CATEGORY[primary_category]
    business_tags = business_tags_from_text(full_text)
    primary_reason = build_primary_reason(
        score,
        primary_category,
        matched_keywords,
        excluded_hits,
        has_strong_exclusion,
        business_tags,
    )
    primary_summary = build_primary_summary(
        notice,
        score,
        fallback_final_category,
        matched_keywords,
        excluded_hits,
        business_tags,
    )

    classification = notice.classification
    if classification is None:
        classification = NoticeClassification(
            notice_id=notice.id,
            primary_score=score,
            primary_category=primary_category,
            matched_keywords=matched_keywords,
            excluded_keyword_hits=excluded_hits,
            final_category=fallback_final_category,
            matched_industries=business_tags,
            ai_reason=primary_reason,
            ai_summary=primary_summary,
            ai_status="not_requested",
        )
    else:
        classification.primary_score = score
        classification.primary_category = primary_category
        classification.matched_keywords = matched_keywords
        classification.excluded_keyword_hits = excluded_hits
        classification.matched_industries = unique_values(business_tags + (classification.matched_industries or []))
        if classification.ai_status in {"not_requested", "failed"}:
            classification.final_category = fallback_final_category
            classification.ai_reason = primary_reason
            classification.ai_summary = primary_summary
        classification.classified_at = datetime.utcnow()

    db.add(classification)
    db.flush()
    return classification


def final_category_from_relevance(score: int) -> str:
    if score >= 80:
        return "주소산업 핵심공고"
    if score >= 60:
        return "주소산업 관련공고"
    if score >= 40:
        return "참고공고"
    return "제외공고"
