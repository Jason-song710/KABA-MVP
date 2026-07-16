from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.constants import KEYWORD_SEED
from app.config import get_settings
from app.database import SessionLocal, get_db
from app.models import AIClassificationLog, CollectionLog, ExcludedKeyword, KeywordDictionary, Notice, User
from app.routers.notices import list_notices
from app.schemas import (
    AIStatusResponse,
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
    ReclassifyAllResponse,
    ReclassifyRequest,
    UserAdminUpdate,
    UserApprovalUpdate,
    UserOut,
    UserWithdrawRequest,
)
from app.services.ai_classifier import apply_ai_classification
from app.services.auth import approve_user, require_admin
from app.services.classifier import run_primary_classification
from app.services.collector import collect_from_g2b

router = APIRouter(prefix="/admin", tags=["admin"])


def collection_summary_message(result: CollectResponse) -> str:
    return (
        f"나라장터 전체 수집 완료: 수집 {result.fetched_count}건, "
        f"신규 {result.created_count}건, 갱신 {result.updated_count}건, "
        f"중복 {result.duplicate_count}건, 분류 {result.classified_count}건"
    )


def run_collection_job(start_date: datetime | None, end_date: datetime | None, run_ai: bool) -> None:
    with SessionLocal() as db:
        started_log = CollectionLog(
            source="g2b",
            operation="manual",
            status="running",
            message="나라장터 전체 수집을 진행 중입니다.",
        )
        db.add(started_log)
        db.commit()
        db.refresh(started_log)
        print("[collector] 나라장터 전체 수집을 시작했습니다.", flush=True)

        def update_progress(progress: dict) -> None:
            total_text = f", 현재 조회 총 {progress['total_count']}건" if progress.get("total_count") else ""
            message = (
                f"나라장터 전체 수집 중: {progress['operation']} "
                f"{progress['page_no']}페이지 처리{total_text}, 누적 수집 {progress['fetched_count']}건, "
                f"신규 {progress['created_count']}건, 갱신 {progress['updated_count']}건, "
                f"중복 {progress['duplicate_count']}건"
            )
            running_log = db.get(CollectionLog, started_log.id)
            if running_log:
                running_log.status = "running"
                running_log.message = message
                running_log.fetched_count = int(progress["fetched_count"])
                running_log.created_count = int(progress["created_count"])
                db.add(running_log)
                db.commit()
            print(f"[collector] {message}", flush=True)

        try:
            result = collect_from_g2b(db, start_date, end_date, run_ai, progress_callback=update_progress)
            status = "failed" if result.errors else "success"
            raw_error = "\n".join(result.errors[:20]) if result.errors else None
            message = collection_summary_message(result)
            if result.errors:
                message = f"{message} · 오류 {len(result.errors)}건"

            started_log.status = status
            started_log.message = message
            started_log.fetched_count = result.fetched_count
            started_log.created_count = result.created_count
            started_log.raw_error = raw_error
            db.add(
                CollectionLog(
                    source="g2b",
                    operation="manual",
                    status=status,
                    message=message,
                    fetched_count=result.fetched_count,
                    created_count=result.created_count,
                    raw_error=raw_error,
                )
            )
            db.commit()
            print(f"[collector] {message}", flush=True)
        except Exception as exc:
            db.rollback()
            error_text = str(exc)
            started_log = db.get(CollectionLog, started_log.id)
            if started_log:
                started_log.status = "failed"
                started_log.message = "나라장터 전체 수집에 실패했습니다."
                started_log.raw_error = error_text
            db.add(
                CollectionLog(
                    source="g2b",
                    operation="manual",
                    status="failed",
                    message="나라장터 전체 수집에 실패했습니다.",
                    raw_error=error_text,
                )
            )
            db.commit()
            print(f"[collector] 나라장터 전체 수집 실패: {error_text}", flush=True)


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
    background_tasks: BackgroundTasks,
    current_user: User = Depends(require_admin),
) -> CollectResponse:
    background_tasks.add_task(run_collection_job, payload.start_date, payload.end_date, payload.run_ai)
    return CollectResponse(
        fetched_count=0,
        created_count=0,
        updated_count=0,
        duplicate_count=0,
        classified_count=0,
        message="나라장터 전체 수집을 백그라운드에서 시작했습니다. 목록은 자동 갱신되며 완료 건수는 백엔드 로그에서 확인할 수 있습니다.",
    )


@router.get("/ai-status", response_model=AIStatusResponse)
def get_ai_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> AIStatusResponse:
    settings = get_settings()
    latest = db.execute(
        select(AIClassificationLog).order_by(AIClassificationLog.created_at.desc()).limit(1)
    ).scalar_one_or_none()
    total_logs = db.execute(select(func.count(AIClassificationLog.id))).scalar_one()
    failed_logs = db.execute(
        select(func.count(AIClassificationLog.id)).where(AIClassificationLog.success.is_(False))
    ).scalar_one()
    return AIStatusResponse(
        configured=bool(settings.openai_api_key),
        model=settings.openai_model,
        total_logs=total_logs,
        failed_logs=failed_logs,
        latest_success=latest.success if latest else None,
        latest_error_message=latest.error_message if latest else None,
        latest_created_at=latest.created_at if latest else None,
    )


@router.post("/notices/reclassify-all", response_model=ReclassifyAllResponse)
def reclassify_all_notices(
    payload: ReclassifyRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> ReclassifyAllResponse:
    notice_ids = db.execute(select(Notice.id).order_by(Notice.id)).scalars().all()
    updated_count = 0
    ai_count = 0
    ai_success_count = 0
    ai_failed_count = 0
    errors: list[str] = []

    for notice_id in notice_ids:
        notice = db.execute(
            select(Notice)
            .where(Notice.id == notice_id)
            .options(selectinload(Notice.classification))
        ).scalar_one_or_none()
        if not notice:
            continue
        try:
            classification = run_primary_classification(db, notice)
            if payload.run_ai:
                apply_ai_classification(db, notice, classification)
                ai_count += 1
                if classification.ai_status == "success":
                    ai_success_count += 1
                else:
                    ai_failed_count += 1
            db.commit()
            updated_count += 1
        except Exception as exc:
            db.rollback()
            errors.append(f"{notice_id}: {exc}")

    return ReclassifyAllResponse(
        updated_count=updated_count,
        ai_count=ai_count,
        ai_success_count=ai_success_count,
        ai_failed_count=ai_failed_count,
        errors=errors,
    )


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
    refreshed = db.execute(
        select(Notice)
        .where(Notice.id == notice_id)
        .options(selectinload(Notice.classification))
    ).scalar_one()
    return refreshed


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
    keyword_text = payload.keyword.strip()
    if not keyword_text:
        raise HTTPException(status_code=400, detail="키워드를 입력해 주세요.")

    score = payload.score
    if score is None:
        score = KEYWORD_SEED[payload.grade]["score"]

    existing = db.execute(
        select(KeywordDictionary).where(
            KeywordDictionary.keyword == keyword_text,
            KeywordDictionary.grade == payload.grade,
        )
    ).scalar_one_or_none()
    if existing:
        existing.score = score
        existing.is_active = payload.is_active
        db.add(existing)
        db.commit()
        db.refresh(existing)
        return existing

    keyword = KeywordDictionary(
        keyword=keyword_text,
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
    keyword_text = payload.keyword.strip()
    if not keyword_text:
        raise HTTPException(status_code=400, detail="제외 키워드를 입력해 주세요.")

    existing = db.execute(
        select(ExcludedKeyword).where(ExcludedKeyword.keyword == keyword_text)
    ).scalar_one_or_none()
    if existing:
        existing.is_strong = payload.is_strong
        existing.is_active = payload.is_active
        db.add(existing)
        db.commit()
        db.refresh(existing)
        return existing

    keyword = ExcludedKeyword(
        keyword=keyword_text,
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


def _clean_optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _normalize_preferred_industries(values: list[str] | None) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        cleaned = value.strip()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        normalized.append(cleaned)
    return normalized[:80]


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


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    payload: UserAdminUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> UserOut:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다.")

    fields = payload.model_fields_set
    for field_name in ["company_name", "contact_name", "phone", "member_type", "approval_notes"]:
        if field_name in fields:
            setattr(user, field_name, _clean_optional_text(getattr(payload, field_name)))

    if "preferred_industries" in fields:
        user.preferred_industries = _normalize_preferred_industries(payload.preferred_industries)

    if "role" in fields and payload.role is not None:
        if user.id == current_user.id and payload.role != "admin":
            raise HTTPException(status_code=400, detail="현재 로그인한 관리자 권한은 해제할 수 없습니다.")
        user.role = payload.role

    if "approval_status" in fields and payload.approval_status is not None:
        if user.id == current_user.id and payload.approval_status != "approved":
            raise HTTPException(status_code=400, detail="현재 로그인한 관리자 계정은 반려하거나 대기 상태로 변경할 수 없습니다.")
        if payload.approval_status == "approved":
            approve_user(user, role=user.role or "viewer", notes=user.approval_notes)
        elif payload.approval_status == "rejected":
            user.approval_status = "rejected"
            user.is_active = False
            user.approved_at = None
            if user.id != current_user.id:
                user.role = "viewer"
        else:
            user.approval_status = "pending"
            user.is_active = False
            user.approved_at = None
            if user.id != current_user.id:
                user.role = "viewer"

    if "is_active" in fields and payload.is_active is not None:
        if user.id == current_user.id and not payload.is_active:
            raise HTTPException(status_code=400, detail="현재 로그인한 관리자 계정은 비활성화할 수 없습니다.")
        user.is_active = payload.is_active

    user.updated_at = datetime.utcnow()
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/users/{user_id}/withdraw", response_model=UserOut)
def withdraw_user(
    user_id: int,
    payload: UserWithdrawRequest | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
) -> UserOut:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다.")
    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="현재 로그인한 관리자 계정은 탈퇴 처리할 수 없습니다.")

    reason = _clean_optional_text(payload.reason if payload else None) or "관리자 탈퇴 처리"
    user.approval_status = "rejected"
    user.approval_notes = reason
    user.is_active = False
    user.role = "viewer"
    user.approved_at = None
    user.updated_at = datetime.utcnow()

    db.add(user)
    db.commit()
    db.refresh(user)
    return user
