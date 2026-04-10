from sqlalchemy import Integer, String, DateTime
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime
from app.core.db import Base

class ImportLog(Base):
    __tablename__ = "import_logs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    import_key: Mapped[str] = mapped_column(String(50), index=True)
    username: Mapped[str] = mapped_column(String(50), default="")
    filename: Mapped[str] = mapped_column(String(255), default="")
    status: Mapped[str] = mapped_column(String(20), default="ok")  # ok|fail
    message: Mapped[str] = mapped_column(String(500), default="")
