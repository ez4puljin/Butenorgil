"""Поддон хураалт — барааг поддонд хэрхэн өрөхийг тэмдэглэх.

  PalletTemplate — поддоны загвар (урт/өргөн/өндөр см, даац кг). Гараар цөөн
                   загвар үүсгээд бараа бүр дээр сонгоно.
  ProductPallet  — бараа бүрийн хураалтын тохиргоо: аль загвар, хайрцагны
                   хэмжээ, нэг үед хэдэн хайрцаг, хэдэн үе. Дүн (нийт өндөр,
                   хайрцаг/ширхэг, жин) нь хадгалагдахгүй — Product-ийн
                   pack_ratio (ш/хайрцаг), unit_weight (кг/ш)-аас тухай бүр бодогдоно.
"""
from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class PalletTemplate(Base):
    __tablename__ = "pallet_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    length_cm: Mapped[float] = mapped_column(Float, default=120.0)
    width_cm: Mapped[float] = mapped_column(Float, default=80.0)
    height_cm: Mapped[float] = mapped_column(Float, default=15.0)     # поддоны өөрийн өндөр
    max_weight_kg: Mapped[float] = mapped_column(Float, default=0.0)   # 0 = хязгааргүй/мэдэгдэхгүй
    max_height_cm: Mapped[float] = mapped_column(Float, default=0.0)   # шалнаас дээд хайрцаг хүртэл зөвшөөрөгдөх (0 = хязгааргүй)
    note: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ProductPallet(Base):
    __tablename__ = "product_pallets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_code: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    template_id: Mapped[int] = mapped_column(Integer, index=True, nullable=False)

    box_length_cm: Mapped[float] = mapped_column(Float, default=0.0)
    box_width_cm: Mapped[float] = mapped_column(Float, default=0.0)
    box_height_cm: Mapped[float] = mapped_column(Float, default=0.0)
    boxes_per_layer: Mapped[int] = mapped_column(Integer, default=0)
    layers: Mapped[int] = mapped_column(Integer, default=0)
    # Мастерын утга буруу/хоосон үед гараар засах (0 = мастераас)
    pcs_per_box_override: Mapped[float] = mapped_column(Float, default=0.0)
    unit_weight_kg_override: Mapped[float] = mapped_column(Float, default=0.0)   # ширхгийн хувийн жин (0 = мастераас)
    box_weight_kg_override: Mapped[float] = mapped_column(Float, default=0.0)
    note: Mapped[str] = mapped_column(String(300), default="")

    updated_by: Mapped[str] = mapped_column(String(120), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint("item_code", name="uq_product_pallet_item"),)
