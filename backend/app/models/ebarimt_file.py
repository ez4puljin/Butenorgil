"""Ebarimt тайлангийн эх файлууд — сар бүрээр оруулсан ТҮҮХИЙ Excel-ийн метадата.

Сар бүр 5 төрлийн файл оруулна (хуучин Tailan.xlsm-ийн эх үүсвэрүүд):
  - data      (Data.xlsx      — харилцагчийн мастер: Код, Нэр, Регистр, Утас, Нөат=хариуцсан ажилтан)
  - orgil     (orgil.xls      — Эрхэтээс татсан Оргилын өглөгийн тайлан)
  - harhorin  (harhorin.xls   — Эрхэтээс татсан Хархорины өглөгийн тайлан)
  - ebarimt   (EBARIMT.xlsx   — Оргил руу шивсэн Ebarimt баримтууд)
  - ebarimt2  (EBARIMT2.xlsx  — Хархорин руу шивсэн Ebarimt баримтууд)

Файлыг ЯМАР Ч ШАЛГУУРГҮЙ хэвээр нь хадгална; тайланг унших үедээ parse хийж
(mtime cache-тэй) тооцоолно. (жил, сар, төрөл) тус бүрд нэг л идэвхтэй файл —
дахин оруулбал солигдоно.
"""
from sqlalchemy import Integer, String, DateTime, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime

from app.core.db import Base


EBARIMT_KINDS = {"data", "orgil", "harhorin", "ebarimt", "ebarimt2"}


class EbarimtFile(Base):
    __tablename__ = "ebarimt_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    year:  Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    month: Mapped[int] = mapped_column(Integer, nullable=False, index=True)   # 1-12
    kind:  Mapped[str] = mapped_column(String(16), nullable=False)            # data|orgil|harhorin|ebarimt|ebarimt2

    original_filename: Mapped[str] = mapped_column(String(300), default="")
    stored_filename:   Mapped[str] = mapped_column(String(300), default="")   # UPLOAD_DIR-д харьцангуй
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    row_count:  Mapped[int] = mapped_column(Integer, default=0)               # best-effort

    uploaded_by_id:   Mapped[int] = mapped_column(Integer, default=0)
    uploaded_by_name: Mapped[str] = mapped_column(String(120), default="")
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("year", "month", "kind", name="uq_ebarimt_file_ym_kind"),
    )


class EbarimtNote(Base):
    """Хэрэглэгчийн гараар бичсэн тайлбар — (жил, сар, харилцагчийн код) бүрээр.

    Data.xlsx-ийн "Тайлбар" баганаас ТУСДАА: эх файлыг дахин оруулахад
    алга болохгүй, DB-д хадгалагдана. Ажилтан харилцагчтайгаа ярьсан
    тэмдэглэлээ энд бичнэ."""
    __tablename__ = "ebarimt_notes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    year:  Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    month: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    code:  Mapped[str] = mapped_column(String(30), nullable=False, index=True)   # харилцагчийн код

    note: Mapped[str] = mapped_column(String(500), default="")

    updated_by_name: Mapped[str] = mapped_column(String(120), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("year", "month", "code", name="uq_ebarimt_note_ym_code"),
    )
