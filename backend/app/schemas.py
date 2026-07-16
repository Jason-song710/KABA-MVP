from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.constants import FINAL_CATEGORIES


class NoticeBase(BaseModel):
    notice_no: str | None = None
    title: str
    ordering_agency: str | None = None
    posted_at: datetime | None = None
    deadline_at: datetime | None = None
    budget_amount: Decimal | None = None
    notice_url: str | None = None
    detail_content: str | None = None
    attachment_urls: list[str] = Field(default_factory=list)
    source: str = "csv"


class NoticeCreate(NoticeBase):
    source_raw: dict = Field(default_factory=dict)


class ClassificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    primary_score: int
    primary_category: str
    matched_keywords: dict
    excluded_keyword_hits: list[str]
    final_category: str
    effective_category: str
    ai_relevance_score: int | None = None
    matched_industries: list[str]
    recommended_member_types: list[str]
    risk_notes: list[str]
    ai_reason: str | None = None
    ai_summary: str | None = None
    ai_status: str
    is_manual: bool
    manual_category: str | None = None
    manual_reason: str | None = None
    classified_at: datetime
    updated_at: datetime


class NoticeOut(NoticeBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    updated_at: datetime
    classification: ClassificationOut | None = None
    recommendation_score: int | None = None
    recommendation_company_score: int | None = None
    recommendation_address_score: int | None = None
    recommendation_tags: list[str] = Field(default_factory=list)
    recommendation_reasons: list[str] = Field(default_factory=list)


class NoticeListResponse(BaseModel):
    items: list[NoticeOut]
    total: int
    limit: int
    offset: int


class ManualClassificationUpdate(BaseModel):
    final_category: str
    manual_reason: str | None = None

    @field_validator("final_category")
    @classmethod
    def validate_category(cls, value: str) -> str:
        if value not in FINAL_CATEGORIES:
            raise ValueError(f"final_category must be one of {', '.join(FINAL_CATEGORIES)}")
        return value


class KeywordCreate(BaseModel):
    keyword: str
    grade: str
    score: int | None = None
    is_active: bool = True

    @field_validator("grade")
    @classmethod
    def validate_grade(cls, value: str) -> str:
        normalized = value.strip().upper()
        if normalized not in {"S", "A", "B", "C", "D"}:
            raise ValueError("grade must be one of S, A, B, C, D")
        return normalized


class KeywordOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    keyword: str
    grade: str
    score: int
    is_active: bool
    created_at: datetime
    updated_at: datetime


class ExcludedKeywordCreate(BaseModel):
    keyword: str
    is_strong: bool = True
    is_active: bool = True


class ExcludedKeywordOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    keyword: str
    is_strong: bool
    is_active: bool
    created_at: datetime
    updated_at: datetime


class CollectRequest(BaseModel):
    start_date: datetime | None = None
    end_date: datetime | None = None
    run_ai: bool = False


class CollectResponse(BaseModel):
    fetched_count: int
    created_count: int
    updated_count: int = 0
    duplicate_count: int
    classified_count: int
    message: str | None = None
    errors: list[str] = Field(default_factory=list)


class ReclassifyRequest(BaseModel):
    run_ai: bool = True


class ReclassifyAllResponse(BaseModel):
    updated_count: int
    ai_count: int = 0
    ai_success_count: int = 0
    ai_failed_count: int = 0
    errors: list[str] = Field(default_factory=list)


class AIStatusResponse(BaseModel):
    configured: bool
    model: str
    total_logs: int
    failed_logs: int
    latest_success: bool | None = None
    latest_error_message: str | None = None
    latest_created_at: datetime | None = None


class UploadResponse(BaseModel):
    created_count: int
    updated_count: int = 0
    duplicate_count: int
    classified_count: int
    errors: list[str] = Field(default_factory=list)


class CollectionLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source: str
    operation: str | None
    status: str
    message: str | None
    fetched_count: int
    created_count: int
    raw_error: str | None
    created_at: datetime


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    role: str
    company_name: str | None = None
    contact_name: str | None = None
    phone: str | None = None
    member_type: str | None = None
    preferred_industries: list[str]
    approval_status: str
    approval_notes: str | None = None
    approved_at: datetime | None = None
    is_active: bool
    created_at: datetime
    updated_at: datetime


class RegisterRequest(BaseModel):
    email: str
    password: str = Field(min_length=8)
    company_name: str
    contact_name: str
    phone: str | None = None
    member_type: str | None = None
    preferred_industries: list[str] = Field(default_factory=list)
    business_areas: str | None = None
    main_products: str | None = None
    main_services: str | None = None
    recommendation_keywords: str | None = None

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if "@" not in normalized:
            raise ValueError("올바른 이메일을 입력하세요.")
        return normalized


class LoginRequest(BaseModel):
    email: str
    password: str


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class UserApprovalUpdate(BaseModel):
    approval_status: str
    role: str = "viewer"
    member_type: str | None = None
    approval_notes: str | None = None

    @field_validator("approval_status")
    @classmethod
    def validate_approval_status(cls, value: str) -> str:
        if value not in {"pending", "approved", "rejected"}:
            raise ValueError("approval_status must be pending, approved, or rejected")
        return value

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        if value not in {"viewer", "admin"}:
            raise ValueError("role must be viewer or admin")
        return value


class UserAdminUpdate(BaseModel):
    company_name: str | None = None
    contact_name: str | None = None
    phone: str | None = None
    member_type: str | None = None
    preferred_industries: list[str] | None = None
    role: str | None = None
    approval_status: str | None = None
    approval_notes: str | None = None
    is_active: bool | None = None

    @field_validator("approval_status")
    @classmethod
    def validate_approval_status(cls, value: str | None) -> str | None:
        if value is not None and value not in {"pending", "approved", "rejected"}:
            raise ValueError("approval_status must be pending, approved, or rejected")
        return value

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str | None) -> str | None:
        if value is not None and value not in {"viewer", "admin"}:
            raise ValueError("role must be viewer or admin")
        return value


class UserWithdrawRequest(BaseModel):
    reason: str | None = None
