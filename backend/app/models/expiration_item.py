"""
Хугацааны хяналт — Барааны дуусах хугацааны бүртгэл.

Нэг бараа олон удаа орж ирж болно (өөр өөр серийн дугаартай эсвэл өөр
огноотойгоор) — тиймээс product_id-аар нэг item биш, харин нэг item-д
expiration_date холбоотойгоор тус тусдаа бүртгэл болно.

Зорилго: Бүх ажилчид хугацаа дуусах гэж байгаа барааг хянаж, бараа
ямар status-тай байгаа, хариуцлагыг хэн хүлээх вэ гэх мэт мэдээллийг
бүртгэх.
"""
from sqlalchemy import Integer, String, Float, Date, DateTime, ForeignKey, Column
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime, date as date_type
from app.core.db import Base


# ── Status options ────────────────────────────────────────────────────────
# review        — Хянагдаж байна (default — шинээр оруулсан)
# city_return   — Хот буцаалт хийгдсэн (нийлүүлэгч рүү буцаасан)
# internal_sale — Дотоод хямдрал (20%) зарагдаж байна
# archived      — Архивлагдсан (зарагдаж дууссан, төгсгөл)
EXPIRATION_STATUSES = {"review", "city_return", "internal_sale", "archived"}

# ── Liability options ─────────────────────────────────────────────────────
# none      — Хариуцлага байхгүй
# specific  — Тодорхой ажилчид (liability_role_ids эсвэл liability_user_ids)
# all_staff — Бүх ажилчдын цалингаас
LIABILITY_TYPES = {"none", "specific", "all_staff"}


class ExpirationItem(Base):
    __tablename__ = "expiration_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id = Column(Integer, ForeignKey("products.id"), nullable=False, index=True)
    expiration_date: Mapped[date_type] = mapped_column(Date, nullable=False, index=True)

    # Үлдэгдэл — Заал (sales floor) + Агуулах (warehouse)
    qty_floor: Mapped[float]     = mapped_column(Float, default=0.0)
    qty_warehouse: Mapped[float] = mapped_column(Float, default=0.0)

    # Бараа ямар status-тай (review / city_return / internal_sale / archived)
    status: Mapped[str] = mapped_column(String(30), default="review", index=True)

    # Хариуцлага хүлээх (none / specific / all_staff)
    liability_type: Mapped[str] = mapped_column(String(20), default="none")
    # comma-separated role values (e.g. "cashier,supervisor")
    liability_role_ids: Mapped[str] = mapped_column(String(500), default="")
    # comma-separated user IDs (e.g. "5,12,18")
    liability_user_ids: Mapped[str] = mapped_column(String(500), default="")
    # Free-text тайлбар (жишээ нь: "Цалингаас 50% тус бүр")
    liability_note: Mapped[str] = mapped_column(String(500), default="")

    notes: Mapped[str] = mapped_column(String(1000), default="")

    # Архив metadata
    archived_at    = Column(DateTime, nullable=True)
    archived_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)

    # Бүртгэлийн metadata
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
