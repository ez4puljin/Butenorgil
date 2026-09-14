"""Орлогын файл — он жилээр оруулсан ТҮҮХИЙ Excel файлын метадата.

Хэрэглэгч жил бүр нэг "Бүх орлого" файл оруулна (төрөл байхгүй).

⚠️ ЯМАР Ч ШАЛГУУРГҮЙ: оруулсан файлыг боловсруулахгүй, шүүхгүй, хэвээр нь
хадгална. Файлыг хэрхэн ашиглахыг хожим тусдаа зааврын дагуу нэмнэ.
Одоохондоо зөвхөн оноор нь хадгалж, дахин татаж авах боломжтой байлгана.

2026 оноос эхлэн САР БҮРЭЭР оруулна (month=1..12) — оны бүх орлого нэг Excel-д
багтахаа больсон. Өмнөх онууд month=0 (бүтэн он) хэвээр.
Нэг (он, сар)-д нэг л идэвхтэй файл байна (дахин оруулбал солигдоно).
"""
from sqlalchemy import Integer, String, DateTime, UniqueConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime

from app.core.db import Base


class IncomeFile(Base):
    __tablename__ = "income_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    year: Mapped[int] = mapped_column(Integer, nullable=False)
    # 0 = бүтэн оны файл (хуучин загвар), 1..12 = тухайн сарын файл
    month: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    original_filename: Mapped[str] = mapped_column(String(300), default="")
    stored_filename:   Mapped[str] = mapped_column(String(300), default="")    # UPLOAD_DIR-д харьцангуй
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    row_count:  Mapped[int] = mapped_column(Integer, default=0)                # best-effort, мэдэгдэхгүй бол 0
    price_updated: Mapped[int] = mapped_column(Integer, default=0)             # сүүлийн орлогын үнэ шинэчилсэн барааны тоо

    uploaded_by_id:   Mapped[int] = mapped_column(Integer, default=0)
    uploaded_by_name: Mapped[str] = mapped_column(String(120), default="")
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("year", "month", name="uq_income_file_year_month"),
        Index("ix_income_file_year_month", "year", "month"),
    )
