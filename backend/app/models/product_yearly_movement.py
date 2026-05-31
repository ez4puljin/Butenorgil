"""Барааны жилийн хөдөлгөөн — Бараа болгоны жил тутмын хөдөлгөөний тоо.

Эх сурвалж: Хэрэглэгч жил бүр 2 Excel файл оруулна:
  - Үндсэн заалны хөдөлгөөн (main)
  - Архи заалны хөдөлгөөн (liquor)

Нэг (item_code, year) хослолд нэг л мөр байна. Үндсэн + Архи заалны
qty-г 2 тусдаа баган дээр хадгална — нэг тал нь дутуу upload бол нөгөө
талыг хадгална. Нийт хөдөлгөөн = qty_main + qty_liquor (query үед нэмж тооцно).

ЗӨВХӨН ОНООР — сар бүрийн задаргаа байхгүй (Сарын борлуулалтаас ялгаатай).
"""
from sqlalchemy import Integer, String, Float, DateTime, UniqueConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime

from app.core.db import Base


# kind enum (frontend болон API-д хэрэглэнэ)
PYM_KIND_MAIN   = "main"     # Үндсэн заал
PYM_KIND_LIQUOR = "liquor"   # Архи заал
PYM_KINDS = {PYM_KIND_MAIN, PYM_KIND_LIQUOR}


class ProductYearlyMovement(Base):
    __tablename__ = "product_yearly_movement"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # Эрхэт дотоод код
    item_code: Mapped[str] = mapped_column(String(64), index=True, nullable=False)

    year: Mapped[int] = mapped_column(Integer, index=True, nullable=False)

    # Үндсэн + Архи заал тусдаа баган — нэг талыг upload хийсэн ч нөгөөг хөндөхгүй
    qty_main:   Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    qty_liquor: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    __table_args__ = (
        # 1 бараа × 1 жил = 1 мөр (upsert key)
        UniqueConstraint("item_code", "year", name="uq_pym_code_year"),
        Index("ix_pym_code_year", "item_code", "year"),
    )
