import json
import re
from datetime import datetime
from json import JSONDecodeError

from sqlalchemy.orm import Session

from app.config import get_settings
from app.constants import AI_JSON_INSTRUCTION, AI_SYSTEM_PROMPT, FINAL_CATEGORIES, PRIMARY_TO_FINAL_CATEGORY
from app.models import AIClassificationLog, Notice, NoticeClassification
from app.services.classifier import business_tags_from_notice, final_category_from_relevance, unique_values


def build_prompt(notice: Notice, classification: NoticeClassification) -> str:
    attachment_summary = "\n".join(notice.attachment_urls or []) or "첨부파일 URL 없음"
    return f"""{AI_SYSTEM_PROMPT}

{AI_JSON_INSTRUCTION}

[1차 분류 결과]
- 점수: {classification.primary_score}
- 후보 분류: {classification.primary_category}
- 매칭 키워드: {json.dumps(classification.matched_keywords, ensure_ascii=False)}
- 제외 키워드: {json.dumps(classification.excluded_keyword_hits, ensure_ascii=False)}

[공고]
- 공고명: {notice.title}
- 발주기관: {notice.ordering_agency or "미상"}
- 공고일: {notice.posted_at or "미상"}
- 마감일: {notice.deadline_at or "미상"}
- 예산: {notice.budget_amount or "미상"}
- 공고 URL: {notice.notice_url or "없음"}
- 상세내용:
{notice.detail_content or "상세내용 없음"}

[첨부요약]
{attachment_summary}
"""


def fallback_to_primary(classification: NoticeClassification, error_message: str) -> None:
    classification.final_category = PRIMARY_TO_FINAL_CATEGORY.get(classification.primary_category, "제외공고")
    classification.ai_status = "failed"
    classification.ai_reason = f"AI 분류 실패로 1차 키워드 분류 결과를 적용했습니다. 원인: {error_message}"
    classification.ai_relevance_score = None
    classification.matched_industries = unique_values(classification.matched_industries or [])
    classification.recommended_member_types = []
    classification.risk_notes = []
    classification.classified_at = datetime.utcnow()


def build_notice_summary(notice: Notice, classification: NoticeClassification) -> str:
    agency = notice.ordering_agency or "발주기관 미상"
    score = classification.ai_relevance_score if classification.ai_relevance_score is not None else classification.primary_score
    posted = notice.posted_at.strftime("%Y-%m-%d") if notice.posted_at else "공고일 미상"
    deadline = notice.deadline_at.strftime("%Y-%m-%d %H:%M") if notice.deadline_at else "마감일 미상"
    budget = f"{int(notice.budget_amount):,}원" if notice.budget_amount is not None else "예산 미상"
    detail = " ".join((notice.detail_content or "").split())
    if len(detail) > 360:
        detail = f"{detail[:360]}..."
    matched = []
    for grade in ["S", "A", "B", "C", "D"]:
        values = classification.matched_keywords.get(grade, [])
        if values:
            matched.append(f"{grade}등급 {', '.join(values)}")
    matched_text = "; ".join(matched) if matched else "주소산업 키워드 매칭 없음"
    tag_text = ", ".join(classification.matched_industries or []) if classification.matched_industries else "업무 구분자 없음"
    return (
        f"{agency}에서 발주한 '{notice.title}' 공고입니다. 공고일은 {posted}, 마감일은 {deadline}, 예산은 {budget}입니다. "
        f"상세 과업은 '{detail or '상세내용 없음'}'이며, 키워드 근거는 {matched_text}입니다. "
        f"업무 구분자는 {tag_text}입니다. 현재 AI/분류 점수는 {score}점이고 최종 분류는 '{classification.final_category}'입니다."
    )


def validate_ai_payload(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("AI response is not a JSON object")

    raw_score = payload.get("relevance_score")
    if isinstance(raw_score, str):
        match = re.search(r"\d+", raw_score)
        if not match:
            raise ValueError("relevance_score must be numeric")
        relevance_score = int(match.group(0))
    else:
        relevance_score = int(raw_score)
    if relevance_score < 0 or relevance_score > 100:
        raise ValueError("relevance_score must be between 0 and 100")

    expected_category = final_category_from_relevance(relevance_score)
    final_category = payload.get("final_category") or expected_category
    if final_category not in FINAL_CATEGORIES:
        raise ValueError("final_category is not allowed")

    if final_category != expected_category:
        final_category = expected_category

    def list_value(key: str) -> list[str]:
        value = payload.get(key, [])
        if not isinstance(value, list):
            return []
        return [str(item) for item in value]

    return {
        "final_category": final_category,
        "relevance_score": relevance_score,
        "matched_industries": list_value("matched_industries"),
        "reason": str(payload.get("reason", "")),
        "recommended_member_types": list_value("recommended_member_types"),
        "risk_notes": list_value("risk_notes"),
    }


def apply_ai_classification(db: Session, notice: Notice, classification: NoticeClassification) -> NoticeClassification:
    settings = get_settings()
    prompt = build_prompt(notice, classification)
    log = AIClassificationLog(
        notice_id=notice.id,
        model=settings.openai_model,
        request_prompt=prompt,
        success=False,
    )
    db.add(log)

    if not settings.openai_api_key:
        fallback_to_primary(classification, "OPENAI_API_KEY가 설정되어 있지 않습니다.")
        classification.ai_summary = build_notice_summary(notice, classification)
        log.error_message = "OPENAI_API_KEY missing"
        db.add(classification)
        db.flush()
        return classification

    try:
        from openai import OpenAI

        client = OpenAI(api_key=settings.openai_api_key)
        response = client.chat.completions.create(
            model=settings.openai_model,
            temperature=0.1,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": AI_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
        )
        raw_text = response.choices[0].message.content or "{}"
        log.response_text = raw_text
        parsed = validate_ai_payload(json.loads(raw_text))
        log.parsed_json = parsed
        log.success = True

        classification.final_category = parsed["final_category"]
        classification.ai_relevance_score = parsed["relevance_score"]
        classification.matched_industries = unique_values(business_tags_from_notice(notice) + parsed["matched_industries"])
        classification.recommended_member_types = parsed["recommended_member_types"]
        classification.risk_notes = parsed["risk_notes"]
        classification.ai_reason = parsed["reason"]
        classification.ai_summary = build_notice_summary(notice, classification)
        classification.ai_status = "success"
        classification.classified_at = datetime.utcnow()
    except (JSONDecodeError, ValueError, KeyError, TypeError) as exc:
        log.error_message = f"AI JSON validation failed: {exc}"
        fallback_to_primary(classification, log.error_message)
        classification.ai_summary = build_notice_summary(notice, classification)
    except Exception as exc:  # OpenAI/network failures must fall back cleanly.
        log.error_message = f"AI request failed: {exc}"
        fallback_to_primary(classification, log.error_message)
        classification.ai_summary = build_notice_summary(notice, classification)

    db.add(classification)
    if not classification.ai_summary:
        classification.ai_summary = build_notice_summary(notice, classification)
    db.flush()
    return classification
