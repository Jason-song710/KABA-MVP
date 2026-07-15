from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.constants import KEYWORD_SEED
from app.database import get_db
from app.models import CollectionLog, ExcludedKeyword, KeywordDictionary, Notice, User
from app.routers.notices import list_notices
from app.schemas import (
    CollectRequest,
    CollectResponse,
    CollectionLogOut,
    ExcludedKeywordCreate,
    ExcludedKeywordOut,
    KeywordCreate,
    KeywordOut,
    ManualClassificationUpdate,
    NoticeListResponse,
    NoticeOut,
    ReclassifyRequest,
    UserApprovalUpdate,
    UserOut,
)
from app.services.ai_classifier import apply_ai_classification
from app.services.auth import approve_user, require_admin
from app.services.classifier import run_primary_classification
from app.services.collector import collect_from_g2b

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/notices", response_model=NoticeListResponse)
def list_admin_notices(
    q: str | None = Query(default=None),
    category: str | None = Query(default=None),
    today: bool = Query(default=False),
    active_only: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> NoticeListResponse:
    return list_notices(
        q=q,
        category=category,
        today=today,
        active_only=active_only,
        limit=limit,
        offset=offset,
        db=db,
        current_user=current_user,
    )


@router.post("/collect", response_model=CollectResponse)
def collect_notices(
    payload: CollectRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> CollectResponse:
    return collect_from_g2b(db, payload.start_date, payload.end_date, payload.run_ai)


@router.post("/notices/{notice_id}/reclassify", response_model=NoticeOut)
def reclassify_notice(
    notice_id: int,
    payload: ReclassifyRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> NoticeOut:
    notice = db.execute(
        select(Notice)
        .where(Notice.id == notice_id)
        .options(selectinload(Notice.classification))
    ).scalar_one_or_none()
    if not notice:
        raise HTTPException(status_code=404, detail="공고를 찾을 수 없습니다.")

    classification = run_primary_classification(db, notice)
    if payload.run_ai:
        apply_ai_classification(db, notice, classification)
    db.commit()
    db.refresh(notice)
    return notice


@router.patch("/notices/{notice_id}/classification", response_model=NoticeOut)
def update_manual_classification(
    notice_id: int,
    payload: ManualClassificationUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> NoticeOut:
    notice = db.execute(
        select(Notice)
        .where(Notice.id == notice_id)
        .options(selectinload(Notice.classification))
    ).scalar_one_or_none()
    if not notice:
        raise HTTPException(status_code=404, detail="공고를 찾을 수 없습니다.")

    classification = notice.classification or run_primary_classification(db, notice)
    classification.is_manual = True
    classification.manual_category = payload.final_category
    classification.manual_reason = payload.manual_reason
    classification.manual_updated_at = datetime.utcnow()
    db.add(classification)
    db.commit()
    db.refresh(notice)
    return notice


@router.get("/keywords", response_model=list[KeywordOut])
def list_keywords(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> list[KeywordOut]:
    return db.execute(
        select(KeywordDictionary).order_by(KeywordDictionary.grade, KeywordDictionary.keyword)
    ).scalars().all()


@router.post("/keywords", response_model=KeywordOut)
def create_keyword(
    payload: KeywordCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> KeywordOut:
    score = payload.score
    if score is None:
        score = KEYWORD_SEED[payload.grade]["score"]
    keyword = KeywordDictionary(
        keyword=payload.keyword.strip(),
        grade=payload.grade,
        score=score,
        is_active=payload.is_active,
    )
    db.add(keyword)
    db.commit()
    db.refresh(keyword)
    return keyword


@router.delete("/keywords/{keyword_id}", status_code=204)
def delete_keyword(
    keyword_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> None:
    keyword = db.get(KeywordDictionary, keyword_id)
    if not keyword:
        raise HTTPException(status_code=404, detail="키워드를 찾을 수 없습니다.")
    db.delete(keyword)
    db.commit()


@router.get("/excluded-keywords", response_model=list[ExcludedKeywordOut])
def list_excluded_keywords(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> list[ExcludedKeywordOut]:
    return db.execute(
        select(ExcludedKeyword).order_by(ExcludedKeyword.keyword)
    ).scalars().all()


@router.post("/excluded-keywords", response_model=ExcludedKeywordOut)
def create_excluded_keyword(
    payload: ExcludedKeywordCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> ExcludedKeywordOut:
    keyword = ExcludedKeyword(
        keyword=payload.keyword.strip(),
        is_strong=payload.is_strong,
        is_active=payload.is_active,
    )
    db.add(keyword)
    db.commit()
    db.refresh(keyword)
    return keyword


@router.delete("/excluded-keywords/{keyword_id}", status_code=204)
def delete_excluded_keyword(
    keyword_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> None:
    keyword = db.get(ExcludedKeyword, keyword_id)
    if not keyword:
        raise HTTPException(status_code=404, detail="제외 키워드를 찾을 수 없습니다.")
    db.delete(keyword)
    db.commit()


@router.get("/collection-logs", response_model=list[CollectionLogOut])
def list_collection_logs(
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> list[CollectionLogOut]:
    return db.execute(
        select(CollectionLog).order_by(CollectionLog.created_at.desc()).limit(limit)
    ).scalars().all()


@router.get("/users", response_model=list[UserOut])
def list_users(
    approval_status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> list[UserOut]:
    stmt = select(User).order_by(User.created_at.desc())
    if approval_status:
        stmt = stmt.where(User.approval_status == approval_status)
    return db.execute(stmt).scalars().all()


@router.patch("/users/{user_id}/approval", response_model=UserOut)
def update_user_approval(
    user_id: int,
    payload: UserApprovalUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> UserOut:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다.")

    if payload.approval_status == "approved":
        approve_user(user, role=payload.role, notes=payload.approval_notes)
    elif payload.approval_status == "rejected":
        user.approval_status = "rejected"
        user.is_active = False
        user.approval_notes = payload.approval_notes
        user.role = "viewer"
    else:
        user.approval_status = "pending"
        user.is_active = False
        user.approval_notes = payload.approval_notes
        user.role = "viewer"

    if payload.member_type is not None:
        user.member_type = payload.member_type

    db.add(user)
    db.commit()
    db.refresh(user)
    return user
