from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User
from app.schemas import AuthResponse, LoginRequest, RegisterRequest, UserOut
from app.services.auth import create_access_token, get_current_user, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserOut, status_code=201)
def register(payload: RegisterRequest, db: Session = Depends(get_db)) -> UserOut:
    existing = db.execute(select(User).where(User.email == payload.email)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="이미 가입 신청된 이메일입니다.")

    user = User(
        email=payload.email,
        hashed_password=hash_password(payload.password),
        role="viewer",
        company_name=payload.company_name.strip(),
        contact_name=payload.contact_name.strip(),
        phone=payload.phone,
        member_type=payload.member_type,
        preferred_industries=payload.preferred_industries,
        approval_status="pending",
        is_active=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=AuthResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> AuthResponse:
    email = payload.email.strip().lower()
    user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="이메일 또는 비밀번호가 올바르지 않습니다.")
    if user.approval_status == "pending":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="가입 신청이 접수되었습니다. 관리자 승인 후 이용할 수 있습니다.")
    if user.approval_status == "rejected":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="가입 신청이 반려되었습니다. 관리자에게 문의하세요.")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="비활성화된 계정입니다.")
    user.updated_at = datetime.utcnow()
    db.add(user)
    db.commit()
    db.refresh(user)
    return AuthResponse(access_token=create_access_token(user), user=user)


@router.get("/me", response_model=UserOut)
def me(current_user: User = Depends(get_current_user)) -> UserOut:
    return current_user
