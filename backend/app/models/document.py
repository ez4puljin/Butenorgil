"""
Бичиг баримт (Documents) — Админ-д зориулсан файлын архив.

Бүтэц:
  DocumentGroup  — Журам, Гэрээ, KPI гэх мэт ерөнхий бүлэг.
  DocumentFile   — бүлэг доторх тодорхой файл (диск дээр хадгалагдсан).

Зөвхөн админ эрхтэй ажилтан энэ цэстэй ажиллана. Файлууд нь дискэн
дээр backend/uploaded_documents/{group_id}/{uuid}_filename бичигдэнэ.
"""
from sqlalchemy import Integer, String, DateTime, ForeignKey, Column
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime
from app.core.db import Base


class DocumentGroup(Base):
    __tablename__ = "document_groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False, default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)


class DocumentFile(Base):
    __tablename__ = "document_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    group_id = Column(Integer, ForeignKey("document_groups.id"), nullable=False, index=True)

    # User-facing display name (заавал биш filename-тай ижил)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    # Diskэн дээр хадгалагдах stored filename (UUID prefix-тэй)
    stored_filename: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    # Анхны филений нэр (download үед сэргээх)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    mime_type: Mapped[str] = mapped_column(String(120), default="")
    file_size: Mapped[int] = mapped_column(Integer, default=0)   # bytes

    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    uploaded_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
