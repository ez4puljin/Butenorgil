"""Үлдэгдлийн файл — он жил + төрлөөр оруулсан ТҮҮХИЙ Excel файлын метадата.

Хэрэглэгч жил бүр 3 төрлийн үлдэгдлийн файл оруулна:
  - Бүх агуулахын үлдэгдэл (warehouse)
  - Үндсэн заалны үлдэгдэл (main)
  - Архины заалны үлдэгдэл (liquor)

⚠️ ЯМАР Ч ШАЛГУУРГҮЙ: оруулсан файлыг боловсруулахгүй, шүүхгүй, хэвээр нь
хадгална. Файлыг хэрхэн ашиглах (үлдэгдэл/stock задлах г.м)-ийг хожим
зааврын дагуу тусдаа хийнэ.

Нэг (year, kind) хослолд нэг л идэвхтэй файл байна (дахин оруулбал солигдоно).
"""
from sqlalchemy import Integer, String, DateTime, UniqueConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime

from app.core.db import Base


# kind enum (frontend болон API-д хэрэглэнэ)
BAL_KIND_WAREHOUSE = "warehouse"   # Бүх агуулахын үлдэгдэл
BAL_KIND_MAIN      = "main"        # Үндсэн заалны үлдэгдэл
BAL_KIND_LIQUOR    = "liquor"      # Архины заалны үлдэгдэл
BAL_KINDS = {BAL_KIND_WAREHOUSE, BAL_KIND_MAIN, BAL_KIND_LIQUOR}


class BalanceFile(Base):
    __tablename__ = "balance_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    year: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(16), index=True, nullable=False)  # warehouse | main | liquor

    original_filename: Mapped[str] = mapped_column(String(300), default="")
    stored_filename:   Mapped[str] = mapped_column(String(300), default="")    # UPLOAD_DIR-д харьцангуй
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    row_count:  Mapped[int] = mapped_column(Integer, default=0)                # best-effort, мэдэгдэхгүй бол 0

    uploaded_by_id:   Mapped[int] = mapped_column(Integer, default=0)
    uploaded_by_name: Mapped[str] = mapped_column(String(120), default="")
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("year", "kind", name="uq_balance_file_year_kind"),
        Index("ix_balance_file_year_kind", "year", "kind"),
    )
