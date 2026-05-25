"""
Сарын борлуулалтын тоо ширхэг — Бараа болгоны сар тутмын борлуулалт.

Эх сурвалж: Хэрэглэгч сар бүр 2 Excel файл оруулна:
  - Агуулахын борлуулалт (warehouse)
  - Заалны борлуулалт (showroom)

Нэг (item_code, year, month) хослолд нэг л мөр байна. Агуулах + Заал-ын
qty-г 2 тусдаа баган дээр хадгална — нэг тал нь дутуу upload бол нөгөө
талыг хадгална. Нийт борлуулалт = qty_warehouse + qty_showroom
(query үед нэмж тооцно).

Захиалга бэлдэх үед сүүлийн 12 сарын дундаж, 3 сарын дундаж, сүүлийн
сарын болон өмнөх оны энэ сарын борлуулалтыг харуулахад ашиглана.
"""
from sqlalchemy import Integer, String, Float, DateTime, UniqueConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime

from app.core.db import Base


# kind enum (frontend болон API-д хэрэглэнэ)
PMS_KIND_WAREHOUSE = "warehouse"
PMS_KIND_SHOWROOM  = "showroom"
PMS_KINDS = {PMS_KIND_WAREHOUSE, PMS_KIND_SHOWROOM}


class ProductMonthlySales(Base):
    __tablename__ = "product_monthly_sales"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # Эрхэт дотоод код
    item_code: Mapped[str] = mapped_column(String(64), index=True, nullable=False)

    year:  Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    month: Mapped[int] = mapped_column(Integer, index=True, nullable=False)

    # Агуулах + Заал тусдаа баган — нэг талыг upload хийсэн ч нөгөөг хөндөхгүй
    qty_warehouse: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    qty_showroom:  Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    __table_args__ = (
        # 1 бараа × 1 сар = 1 мөр (upsert key)
        UniqueConstraint("item_code", "year", "month", name="uq_pms_code_year_month"),
        # Stats query-д composite index range scan ашиглана
        Index("ix_pms_code_year_month", "item_code", "year", "month"),
    )
