"""Бренд → Захиалагч (нийлүүлэгчээс захиалга өгдөг ажилтан, ж: Бямбасүрэн, Нарантуяа).

Захиалгын dashboard дээр брендүүдийг захиалагчаар бүлэглэхэд хэрэглэнэ. Бренд нь
Product.brand (Эрхэтийн «Брэнд нэр») мөр — BrandSupplierMap-тай адил нэрээр холбоно.
Захиалагчдын нэрсийн жагсаалт app/data/orderers.json-д (сонголтын дараалал).
"""
from datetime import datetime

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class BrandOrderer(Base):
    __tablename__ = "brand_orderers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    brand: Mapped[str] = mapped_column(String(200), unique=True, index=True, nullable=False)
    orderer: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    updated_by: Mapped[str] = mapped_column(String(100), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
