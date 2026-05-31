"""Орлогын файл — он жилээр оруулсан ТҮҮХИЙ Excel файлын метадата.

Хэрэглэгч жил бүр нэг "Бүх орлого" файл оруулна (төрөл байхгүй).

⚠️ ЯМАР Ч ШАЛГУУРГҮЙ: оруулсан файлыг боловсруулахгүй, шүүхгүй, хэвээр нь
хадгална. Файлыг хэрхэн ашиглахыг хожим тусдаа зааврын дагуу нэмнэ.
Одоохондоо зөвхөн оноор нь хадгалж, дахин татаж авах боломжтой байлгана.

Нэг жилд нэг л идэвхтэй файл байна (дахин оруулбал солигдоно).
"""
from sqlalchemy import Integer, String, DateTime, UniqueConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime

from app.core.db import Base


class IncomeFile(Base):
    __tablename__ = "income_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    year: Mapped[int] = mapped_column(Integer, index=True, nullable=False)

    original_filename: Mapped[str] = mapped_column(String(300), default="")
    stored_filename:   Mapped[str] = mapped_column(String(300), default="")    # UPLOAD_DIR-д харьцангуй
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    row_count:  Mapped[int] = mapped_column(Integer, default=0)                # best-effort, мэдэгдэхгүй бол 0
    price_updated: Mapped[int] = mapped_column(Integer, default=0)             # сүүлийн орлогын үнэ шинэчилсэн барааны тоо

    uploaded_by_id:   Mapped[int] = mapped_column(Integer, default=0)
    uploaded_by_name: Mapped[str] = mapped_column(String(120), default="")
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("year", name="uq_income_file_year"),
        Index("ix_income_file_year", "year"),
    )
