"""
Сарын борлуулалтын тоо ширхэг — Бараа болгоны сар тутмын борлуулалт.

Эх сурвалж: Хэрэглэгч сар бүр 3 Excel файл оруулна:
  - Агуулахын борлуулалт (warehouse)
  - Заалны борлуулалт (showroom)
  - Заалны архины борлуулалт (liquor)

Нэг (item_code, year, month) хослолд нэг л мөр байна. Төрөл бүрийн qty-г
тусдаа баганад хадгална — аль нэг нь дутуу upload бол бусдыг хадгална.
Нийт борлуулалт = qty_warehouse + qty_showroom + qty_liquor
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
PMS_KIND_LIQUOR    = "liquor"      # Заалны архи (архины заалны тусдаа борлуулалт)
PMS_KINDS = {PMS_KIND_WAREHOUSE, PMS_KIND_SHOWROOM, PMS_KIND_LIQUOR}
# kind → хадгалах багана, монгол нэр
PMS_KIND_FIELDS = {
    PMS_KIND_WAREHOUSE: "qty_warehouse",
    PMS_KIND_SHOWROOM:  "qty_showroom",
    PMS_KIND_LIQUOR:    "qty_liquor",
}
PMS_KIND_LABELS = {
    PMS_KIND_WAREHOUSE: "Агуулах",
    PMS_KIND_SHOWROOM:  "Заал",
    PMS_KIND_LIQUOR:    "Заалны архи",
}
# kind → борлуулалтын дүнгийн багана (Эрхэтийн «Нийт борлуулалт», НӨАТ-гүй ₮)
PMS_KIND_AMOUNT_FIELDS = {
    PMS_KIND_WAREHOUSE: "amount_warehouse",
    PMS_KIND_SHOWROOM:  "amount_showroom",
    PMS_KIND_LIQUOR:    "amount_liquor",
}


class ProductMonthlySales(Base):
    __tablename__ = "product_monthly_sales"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # Эрхэт дотоод код
    item_code: Mapped[str] = mapped_column(String(64), index=True, nullable=False)

    year:  Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    month: Mapped[int] = mapped_column(Integer, index=True, nullable=False)

    # Агуулах, Заал, Заалны архи тусдаа баган — нэгийг upload хийсэн ч бусдыг хөндөхгүй
    qty_warehouse: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    qty_showroom:  Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    qty_liquor:    Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    # Борлуулалтын дүн (₮, НӨАТ-гүй) — файлын «Нийт борлуулалт» баганаас; график/шинжилгээнд
    amount_warehouse: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    amount_showroom:  Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    amount_liquor:    Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

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
