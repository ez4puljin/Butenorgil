"""Хөдөлгөөний файл — он жил + төрлөөр оруулсан ТҮҮХИЙ Excel файлын метадата.

Хэрэглэгч жил бүр 2 төрлийн хөдөлгөөний файл оруулна:
  - Үндсэн заал (main)
  - Архи заал (liquor)

⚠️ Энэ нь ямар ч шалгуур/боловсруулалтгүйгээр файлыг хэвээр нь хадгална.
Файлыг хэрхэн ашиглах (код/тоо багана задлах г.м)-ийг хожим зааврын дагуу
тусдаа хийнэ. Одоохондоо зөвхөн (year, kind)-аар нь хадгалж, дахин татаж
авах боломжтой байлгана.

Нэг (year, kind) хослолд нэг л идэвхтэй файл байна (дахин оруулбал солигдоно).
"""
from sqlalchemy import Integer, String, DateTime, UniqueConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime

from app.core.db import Base


# kind enum (frontend болон API-д хэрэглэнэ)
PYM_KIND_MAIN   = "main"     # Үндсэн заал
PYM_KIND_LIQUOR = "liquor"   # Архи заал
PYM_KINDS = {PYM_KIND_MAIN, PYM_KIND_LIQUOR}


class MovementFile(Base):
    __tablename__ = "movement_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    year: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(16), index=True, nullable=False)  # main | liquor

    original_filename: Mapped[str] = mapped_column(String(300), default="")
    stored_filename:   Mapped[str] = mapped_column(String(300), default="")    # UPLOAD_DIR-д харьцангуй
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    row_count:  Mapped[int] = mapped_column(Integer, default=0)                # best-effort, мэдэгдэхгүй бол 0

    uploaded_by_id:   Mapped[int] = mapped_column(Integer, default=0)
    uploaded_by_name: Mapped[str] = mapped_column(String(120), default="")
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("year", "kind", name="uq_movement_file_year_kind"),
        Index("ix_movement_file_year_kind", "year", "kind"),
    )
