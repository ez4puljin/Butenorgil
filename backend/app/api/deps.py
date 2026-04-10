from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from app.core.db import SessionLocal
from app.core.security import decode_token
from app.models.user import User

oauth2 = OAuth2PasswordBearer(tokenUrl="/auth/login")

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def get_current_user(db: Session = Depends(get_db), token: str = Depends(oauth2)) -> User:
    try:
        payload = decode_token(token)
        username = payload.get("sub")
    except Exception:
        raise HTTPException(401, "Invalid token")

    u = db.query(User).filter(User.username == username).first()
    if not u or not u.is_active:
        raise HTTPException(401, "User inactive or not found")
    return u

def require_role(*roles: str):
    def _guard(u: User = Depends(get_current_user)):
        # Check effective permission level: base_role (if set) or role
        effective = u.base_role if u.base_role else u.role
        if effective not in roles:
            raise HTTPException(403, "Forbidden")
        return u
    return _guard

def parse_tag_ids(tag_ids_csv: str) -> list[int]:
    out: list[int] = []
    for x in (tag_ids_csv or "").split(","):
        x = x.strip()
        if not x:
            continue
        try:
            out.append(int(x))
        except:
            pass
    return out