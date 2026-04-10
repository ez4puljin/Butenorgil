from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from app.api.deps import get_db, parse_tag_ids
from app.core.security import verify_password, create_access_token
from app.models.user import User
from app.models.role import Role
from app.schemas.auth import TokenOut

router = APIRouter(prefix="/auth", tags=["auth"])

@router.post("/login", response_model=TokenOut)
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    u = db.query(User).filter(User.username == form.username).first()
    if not u:
        raise HTTPException(401, "Хэрэглэгчийн нэр олдсонгүй")
    if not u.is_active:
        raise HTTPException(401, "Хэрэглэгчийн эрх хаагдсан байна")
    if not verify_password(form.password, u.password_hash):
        raise HTTPException(401, "Нууц үг буруу байна")

    role_obj = db.query(Role).filter(Role.value == u.role).first()
    permissions = [p for p in (role_obj.permissions or "").split(",") if p] if role_obj else []

    token = create_access_token(sub=u.username, role=u.role)
    return TokenOut(
        access_token=token,
        role=u.role,
        base_role=u.base_role or u.role,
        username=u.username,
        nickname=u.nickname or "",
        permissions=permissions,
        tag_ids=parse_tag_ids(u.tag_ids),
        user_id=u.id,
    )