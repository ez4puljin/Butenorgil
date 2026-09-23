"""Шинэ бараа таниулах — бүртгэлийн ноорог (Эрхэт рүү «Бараа материалын нэр төрөл»
импорт хийгдэх хүртэл, тэгээд мастерт орсныг хүртэл хянана).

Төлөв: draft (ноорог, алдаатай) → ready (бүрэн) → sent (Эрхэтэд илгээсэн, дараалалд)
       → imported (Эрхэтэд амжилттай) → registered (мастер нэгтгэлд орсон)
       fail (Эрхэт алдаа буцаасан — засаад дахин илгээнэ)
"""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class NewProduct(Base):
    __tablename__ = "new_products"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    status: Mapped[str] = mapped_column(String(12), default="draft", index=True)

    item_code: Mapped[str] = mapped_column(String(32), default="", index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    foreign_name: Mapped[str] = mapped_column(String(255), default="")
    category_code: Mapped[str] = mapped_column(String(32), default="")
    category_name: Mapped[str] = mapped_column(String(120), default="")
    brand_code: Mapped[str] = mapped_column(String(32), default="")
    brand_name: Mapped[str] = mapped_column(String(200), default="")
    barcode: Mapped[str] = mapped_column(String(120), default="", index=True)
    unit_code: Mapped[str] = mapped_column(String(16), default="ш")
    weight_kg: Mapped[float] = mapped_column(Float, default=0.0)          # 1 ширхгийн жин
    pack_ratio: Mapped[float] = mapped_column(Float, default=1.0)         # хайрцаг дахь ширхэг
    box_unit_code: Mapped[str] = mapped_column(String(16), default="ха")
    retail_price: Mapped[float] = mapped_column(Float, default=0.0)
    wholesale_price: Mapped[float] = mapped_column(Float, default=0.0)
    sales_account: Mapped[str] = mapped_column(String(16), default="510101")
    cost_account: Mapped[str] = mapped_column(String(16), default="610101")
    type_code: Mapped[str] = mapped_column(String(16), default="")
    gs1_code: Mapped[str] = mapped_column(String(32), default="")         # Бүт.Үйл нэгдсэн код
    vat_free: Mapped[bool] = mapped_column(Boolean, default=False)
    tax_exempt_code: Mapped[str] = mapped_column(String(32), default="")
    notes: Mapped[str] = mapped_column(String(1000), default="")

    image_path: Mapped[str] = mapped_column(String(300), default="")      # үндсэн зураг
    photos: Mapped[str] = mapped_column(Text, default="[]")               # бусад зургийн зам (JSON)
    ai_json: Mapped[str] = mapped_column(Text, default="{}")

    erkhet_log_id: Mapped[int] = mapped_column(Integer, default=0)
    erkhet_message: Mapped[str] = mapped_column(String(1000), default="")
    created_by: Mapped[str] = mapped_column(String(100), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
