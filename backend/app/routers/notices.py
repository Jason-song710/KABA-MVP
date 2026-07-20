from datetime import datetime, time

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy import and_, func, not_, or_, select
from sqlalchemy.orm import Session, selectinload

from app.constants import FINAL_CATEGORIES
from app.database import get_db
from app.models import Notice, NoticeClassification, User
from app.schemas import NoticeListResponse, NoticeOut, UploadResponse
from app.services.auth import get_current_user, require_admin
from app.services.classifier import normalize, text_contains_keyword
from app.services.csv_importer import import_csv_content

router = APIRouter(prefix="/notices", tags=["notices"])


def category_filter(category: str):
    excluded_filter = and_(
        NoticeClassification.primary_category == "제외공고 후보",
        NoticeClassification.excluded_keyword_hits != [],
    )
    if category == "주소산업 핵심공고":
        score_filter = and_(NoticeClassification.primary_score >= 20, not_(excluded_filter))
    elif category == "주소산업 관련공고":
        score_filter = and_(
            NoticeClassification.primary_score >= 10,
            NoticeClassification.primary_score < 20,
            not_(excluded_filter),
        )
    elif category == "참고공고":
        score_filter = and_(NoticeClassification.primary_score < 10, not_(excluded_filter))
    elif category == "제외공고":
        score_filter = excluded_filter
    else:
        raise HTTPException(status_code=400, detail="지원하지 않는 분류입니다.")

    return or_(
        and_(
            NoticeClassification.is_manual.is_(True),
            NoticeClassification.manual_category == category,
        ),
        and_(
            NoticeClassification.is_manual.is_(False),
            score_filter,
        ),
    )


def active_bid_filter():
    discussion_filter = or_(
        Notice.title.ilike("%수의시담%"),
        Notice.detail_content.ilike("%수의시담%"),
    )
    return and_(
        or_(Notice.deadline_at.is_(None), Notice.deadline_at >= datetime.now()),
        not_(discussion_filter),
    )


def build_notice_query(
    q: str | None,
    category: str | None,
    today: bool,
    active_only: bool,
):
    filters = []
    if q:
        like = f"%{q}%"
        filters.append(
            or_(
                Notice.title.ilike(like),
                Notice.ordering_agency.ilike(like),
                Notice.detail_content.ilike(like),
            )
        )
    if category:
        if category not in FINAL_CATEGORIES:
            raise HTTPException(status_code=400, detail="지원하지 않는 분류입니다.")
        filters.append(category_filter(category))
    if today:
        start = datetime.combine(datetime.now().date(), time.min)
        end = datetime.combine(datetime.now().date(), time.max)
        filters.append(Notice.posted_at.between(start, end))
    if active_only:
        filters.append(active_bid_filter())
    return filters


def effective_category(notice: Notice) -> str | None:
    if not notice.classification:
        return None
    return notice.classification.effective_category


def recommendation_terms(user: User) -> list[str]:
    raw_terms = [
        *(user.preferred_industries or []),
        user.member_type or "",
    ]
    terms: list[str] = []
    seen: set[str] = set()
    for term in raw_terms:
        cleaned = str(term).strip()
        if not cleaned or cleaned == "-":
            continue
        variants = [
            cleaned,
            cleaned.replace(" 기업", "").replace("기업", "").strip(),
            cleaned.replace(" 업체", "").replace("업체", "").strip(),
            cleaned.replace(" 전문", "").replace("전문", "").strip(),
        ]
        for variant in variants:
            if len(variant) < 2:
                continue
            key = normalize(variant)
            if key not in seen:
                seen.add(key)
                terms.append(variant)
    return terms


def recommendation_text(notice: Notice) -> str:
    classification = notice.classification
    matched_keywords: list[str] = []
    if classification:
        for values in (classification.matched_keywords or {}).values():
            matched_keywords.extend(str(value) for value in values)
        matched_keywords.extend(classification.matched_industries or [])
        matched_keywords.extend(classification.recommended_member_types or [])

    parts = [
        notice.title,
        notice.ordering_agency,
        notice.detail_content,
        " ".join(notice.attachment_urls or []),
        " ".join(matched_keywords),
    ]
    return normalize("\n".join(part for part in parts if part))


def score_recommendation(notice: Notice, terms: list[str]) -> tuple[int, int, int, list[str], list[str]]:
    text = recommendation_text(notice)
    matched: list[str] = []
    company_score = 0

    for term in terms:
        if text_contains_keyword(text, term):
            matched.append(term)
            company_score += 25 if len(term) >= 4 else 15

    address_score = 0
    category = effective_category(notice)
    if category == "주소산업 핵심공고":
        address_score += 20
    elif category == "주소산업 관련공고":
        address_score += 12
    elif category == "참고공고":
        address_score += 5
    elif category == "제외공고" and not matched:
        address_score -= 20

    if notice.classification:
        address_score += min(notice.classification.primary_score // 2, 15)

    address_score = max(address_score, 0)
    total_score = company_score + address_score
    tags: list[str] = []
    reasons = [f"회사관련 키워드: {', '.join(matched)}"] if matched else []
    if company_score > 0:
        tags.append("회사관련")
    if category and category != "제외공고":
        tags.append("주소관련")
        reasons.append(f"주소관련 분류: {category}")
    return total_score, company_score, address_score, tags, reasons


@router.get("/recommended", response_model=NoticeListResponse)
def list_recommended_notices(
    q: str | None = Query(default=None),
    active_only: bool = Query(default=True),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> NoticeListResponse:
    terms = recommendation_terms(current_user)
    if not terms:
        return NoticeListResponse(items=[], total=0, limit=limit, offset=offset)

    filters = build_notice_query(q=q, category=None, today=False, active_only=active_only)
    stmt = (
        select(Notice)
        .outerjoin(NoticeClassification)
        .options(selectinload(Notice.classification))
        .order_by(Notice.deadline_at.asc().nullslast(), Notice.posted_at.desc().nullslast(), Notice.created_at.desc())
    )
    if filters:
        stmt = stmt.where(*filters)

    candidates = db.execute(stmt.limit(500)).scalars().all()
    scored: list[tuple[int, int, int, Notice, list[str], list[str]]] = []
    for notice in candidates:
        score, company_score, address_score, tags, reasons = score_recommendation(notice, terms)
        if company_score > 0 and score >= 15:
            scored.append((score, company_score, address_score, notice, tags, reasons))

    scored.sort(
        key=lambda item: (
            -item[1],
            -item[0],
            item[3].deadline_at or datetime.max,
            -(item[3].posted_at.timestamp() if item[3].posted_at else 0),
        )
    )
    page = scored[offset : offset + limit]
    items: list[NoticeOut] = []
    for score, company_score, address_score, notice, tags, reasons in page:
        output = NoticeOut.model_validate(notice)
        output.recommendation_score = score
        output.recommendation_company_score = company_score
        output.recommendation_address_score = address_score
        output.recommendation_tags = tags
        output.recommendation_reasons = reasons
        items.append(output)
    return NoticeListResponse(items=items, total=len(scored), limit=limit, offset=offset)


@router.get("", response_model=NoticeListResponse)
def list_notices(
    q: str | None = Query(default=None),
    category: str | None = Query(default=None),
    today: bool = Query(default=False),
    active_only: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> NoticeListResponse:
    filters = build_notice_query(q, category, today, active_only)
    order_by = (
        [Notice.deadline_at.asc().nullslast(), Notice.posted_at.desc().nullslast(), Notice.created_at.desc()]
        if active_only
        else [Notice.posted_at.desc().nullslast(), Notice.created_at.desc()]
    )
    stmt = (
        select(Notice)
        .outerjoin(NoticeClassification)
        .options(selectinload(Notice.classification))
        .order_by(*order_by)
    )
    count_stmt = select(func.count(Notice.id)).select_from(Notice).outerjoin(NoticeClassification)
    if filters:
        stmt = stmt.where(*filters)
        count_stmt = count_stmt.where(*filters)

    total = db.execute(count_stmt).scalar_one()
    notices = db.execute(stmt.limit(limit).offset(offset)).scalars().all()
    return NoticeListResponse(items=notices, total=total, limit=limit, offset=offset)


@router.get("/{notice_id}", response_model=NoticeOut)
def get_notice(
    notice_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> NoticeOut:
    notice = db.execute(
        select(Notice)
        .where(Notice.id == notice_id)
        .options(selectinload(Notice.classification))
    ).scalar_one_or_none()
    if not notice:
        raise HTTPException(status_code=404, detail="공고를 찾을 수 없습니다.")
    return notice


@router.post("/upload-csv", response_model=UploadResponse)
async def upload_csv(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> UploadResponse:
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="CSV 파일만 업로드할 수 있습니다.")
    try:
        content = await file.read()
        created_count, updated_count, duplicate_count, classified_count, errors = import_csv_content(db, content, source="g2b-csv")
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"CSV 업로드 처리 중 오류가 발생했습니다: {exc}") from exc
    return UploadResponse(
        created_count=created_count,
        updated_count=updated_count,
        duplicate_count=duplicate_count,
        classified_count=classified_count,
        errors=errors,
    )
