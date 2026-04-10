from sqlalchemy import String, Integer, Boolean
from sqlalchemy.orm import Mapped, mapped_column
from app.core.db import Base


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    value: Mapped[str] = mapped_column(String(50), unique=True, index=True)   # slug used in user.role
    label: Mapped[str] = mapped_column(String(100))                            # Mongolian display name
    color: Mapped[str] = mapped_column(String(150), default="bg-gray-100 text-gray-600")  # Tailwind badge classes
    base_role: Mapped[str] = mapped_column(String(50), default="manager")     # system permission level
    permissions: Mapped[str] = mapped_column(String(500), default="")         # comma-separated page keys
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)            # system roles can't be deleted
