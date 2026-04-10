from sqlalchemy.orm import Session
from app.models.user import User
from app.core.security import hash_password

def ensure_admin(db: Session):
    if db.query(User).count() > 0:
        return
    admin = User(
        username="admin",
        password_hash=hash_password("admin123"),
        role="admin",
        is_active=True,
        tag_ids="1,2,12,11,3"
    )
    db.add(admin)
    db.commit()