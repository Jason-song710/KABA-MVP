from datetime import datetime, time

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.constants import FINAL_CATEGORIES
from app.database import get_db
from app.models import Notice, NoticeClassification, User
from app.schemas import NoticeListResponse, NoticeOut, UploadResponse
from app.services.auth import get_current_user, require_admin
from app.services.csv_importer import import_csv_content

router = APIRouter(prefix="/notices", tags=["notices"])


def category_filter(category: str):
    return or_(
        and_(
            NoticeClassification.is_manual.is_(True),
            NoticeClassification.manual_category == category,
        ),
        and_(
            NoticeClassification.is_manual.is_(False),
            NoticeClassification.final_category == category,
        ),
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
        filters.append(or_(Notice.deadline_at.is_(None), Notice.deadline_at >= datetime.now()))
    return filters


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
    content = await file.read()
    created_count, updated_count, duplicate_count, classified_count, errors = import_csv_content(db, content, source="csv")
    return UploadResponse(
        created_count=created_count,
        updated_count=updated_count,
        duplicate_count=duplicate_count,
        classified_count=classified_count,
        errors=errors,
    )
