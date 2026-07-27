from datetime import datetime
import re
from urllib.parse import unquote

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


ATTACHMENT_NAME_KEYS = [
    "ntceSpecDocNm",
    "ntceSpecFileNm",
    "ntceSpecDocFileNm",
    "specDocNm",
    "specDocFileNm",
    "bidNtceSpecDocNm",
    "bidNtceSpecDocFileNm",
    "atchFileNm",
    "atchFileName",
    "fileNm",
    "fileName",
    "realFileNm",
    "docNm",
    "ntceDocNm",
    "bidNtceDocNm",
    "pblancFileNm",
]


def clean_attachment_label(value: object) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        text = unquote(text.replace("+", " "))
    except Exception:
        pass
    text = re.sub(r"[_\s]+", " ", text).strip(" -_/")
    if not text or text.lower().startswith("http"):
        return None
    return text


def collect_attachment_labels_from_raw(raw: object) -> list[str]:
    labels: list[str] = []
    seen: set[str] = set()

    def add(value: object) -> None:
        label = clean_attachment_label(value)
        if label and label not in seen:
            seen.add(label)
            labels.append(label)

    if isinstance(raw, dict):
        for index in range(1, 21):
            for prefix in ATTACHMENT_NAME_KEYS:
                add(raw.get(f"{prefix}{index}"))
        for key, value in raw.items():
            lowered = str(key).lower()
            if "url" not in lowered and (
                "filenm" in lowered
                or "filename" in lowered
                or "docnm" in lowered
                or "docname" in lowered
                or "specdoc" in lowered
                or "첨부" in str(key)
                or "파일명" in str(key)
                or "문서명" in str(key)
            ):
                add(value)
            if isinstance(value, (dict, list)):
                for nested in collect_attachment_labels_from_raw(value):
                    add(nested)
    elif isinstance(raw, list):
        for item in raw:
            for nested in collect_attachment_labels_from_raw(item):
                add(nested)
    return labels


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class Notice(Base, TimestampMixin):
    __tablename__ = "notices"
    __table_args__ = (
        UniqueConstraint("notice_no", name="uq_notices_notice_no"),
        UniqueConstraint("title", "ordering_agency", "posted_at", name="uq_notices_title_agency_posted"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    notice_no: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(500), nullable=False, index=True)
    ordering_agency: Mapped[str | None] = mapped_column(String(300), nullable=True, index=True)
    posted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deadline_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    budget_amount: Mapped[float | None] = mapped_column(Numeric(18, 2), nullable=True)
    notice_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    detail_content: Mapped[str | None] = mapped_column(Text, nullable=True)
    attachment_urls: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    source: Mapped[str] = mapped_column(String(60), default="csv", nullable=False, index=True)
    source_raw: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    @property
    def attachment_labels(self) -> list[str]:
        labels = collect_attachment_labels_from_raw(self.source_raw or {})
        if len(labels) < len(self.attachment_urls or []):
            labels.extend([""] * (len(self.attachment_urls or []) - len(labels)))
        return labels[: len(self.attachment_urls or [])]

    classification: Mapped["NoticeClassification | None"] = relationship(
        "NoticeClassification",
        back_populates="notice",
        cascade="all, delete-orphan",
        uselist=False,
    )
    ai_logs: Mapped[list["AIClassificationLog"]] = relationship(
        "AIClassificationLog",
        back_populates="notice",
        cascade="all, delete-orphan",
    )
    reviews: Mapped[list["NoticeReview"]] = relationship(
        "NoticeReview",
        back_populates="notice",
        cascade="all, delete-orphan",
    )


class NoticeClassification(Base, TimestampMixin):
    __tablename__ = "notice_classifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    notice_id: Mapped[int] = mapped_column(ForeignKey("notices.id", ondelete="CASCADE"), unique=True, nullable=False)
    primary_score: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    primary_category: Mapped[str] = mapped_column(String(80), nullable=False)
    matched_keywords: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    excluded_keyword_hits: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)

    final_category: Mapped[str] = mapped_column(String(80), nullable=False)
    ai_relevance_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    matched_industries: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    recommended_member_types: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    risk_notes: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    ai_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_status: Mapped[str] = mapped_column(String(40), default="not_requested", nullable=False)

    is_manual: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    manual_category: Mapped[str | None] = mapped_column(String(80), nullable=True)
    manual_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    manual_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    classified_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    notice: Mapped[Notice] = relationship("Notice", back_populates="classification")

    @property
    def effective_category(self) -> str:
        if self.is_manual and self.manual_category:
            return self.manual_category
        return self.final_category


class KeywordDictionary(Base, TimestampMixin):
    __tablename__ = "keyword_dictionary"
    __table_args__ = (UniqueConstraint("keyword", "grade", name="uq_keyword_dictionary_keyword_grade"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    keyword: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    grade: Mapped[str] = mapped_column(String(1), nullable=False, index=True)
    score: Mapped[int] = mapped_column(Integer, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class ExcludedKeyword(Base, TimestampMixin):
    __tablename__ = "excluded_keywords"
    __table_args__ = (UniqueConstraint("keyword", name="uq_excluded_keywords_keyword"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    keyword: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    is_strong: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class AIClassificationLog(Base):
    __tablename__ = "ai_classification_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    notice_id: Mapped[int] = mapped_column(ForeignKey("notices.id", ondelete="CASCADE"), nullable=False, index=True)
    model: Mapped[str | None] = mapped_column(String(120), nullable=True)
    request_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    response_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    parsed_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    success: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    notice: Mapped[Notice] = relationship("Notice", back_populates="ai_logs")


class User(Base, TimestampMixin):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("email", name="uq_users_email"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    hashed_password: Mapped[str | None] = mapped_column(String(255), nullable=True)
    role: Mapped[str] = mapped_column(String(40), default="viewer", nullable=False)
    company_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    contact_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(80), nullable=True)
    member_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    preferred_industries: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    approval_status: Mapped[str] = mapped_column(String(40), default="pending", nullable=False, index=True)
    approval_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    notice_reviews: Mapped[list["NoticeReview"]] = relationship(
        "NoticeReview",
        back_populates="user",
        cascade="all, delete-orphan",
    )
    saved_searches: Mapped[list["SavedSearch"]] = relationship(
        "SavedSearch",
        back_populates="user",
        cascade="all, delete-orphan",
    )


class NoticeReview(Base, TimestampMixin):
    __tablename__ = "notice_reviews"
    __table_args__ = (UniqueConstraint("user_id", "notice_id", name="uq_notice_reviews_user_notice"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    notice_id: Mapped[int] = mapped_column(ForeignKey("notices.id", ondelete="CASCADE"), nullable=False, index=True)
    review_status: Mapped[str] = mapped_column(String(40), default="미확인", nullable=False, index=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    announcement_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)

    user: Mapped[User] = relationship("User", back_populates="notice_reviews")
    notice: Mapped[Notice] = relationship("Notice", back_populates="reviews")


class SavedSearch(Base, TimestampMixin):
    __tablename__ = "saved_searches"
    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_saved_searches_user_name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    query: Mapped[str | None] = mapped_column(String(500), nullable=True)
    view_key: Mapped[str] = mapped_column(String(80), default="all", nullable=False)
    category: Mapped[str | None] = mapped_column(String(80), nullable=True)
    today: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    active_only: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    closed_only: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    user: Mapped[User] = relationship("User", back_populates="saved_searches")


class CollectionLog(Base):
    __tablename__ = "collection_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    source: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    operation: Mapped[str | None] = mapped_column(String(120), nullable=True)
    status: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    fetched_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    raw_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
