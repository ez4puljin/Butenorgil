"""
"Бараа тулгаж авах" — захиалгагүй шууд ирсэн бараанд баркод/нэрээр хайж
орлого авах систем. PO-оос ангид — баримт тулгаж хийнэ.

Статус flow:
  matching (Тулгаж байна) → price_review (Үнэ хянагдаж байна) → received (Орлого авсан)
  * archived (Архив) — хэдийд ч шилжиж болно
"""
from sqlalchemy import Integer, String, Float, Date, DateTime, ForeignKey, Boolean, UniqueConstraint, Column
from sqlalchemy.orm import Mapped, mapped_column, relationship
from datetime import datetime, date as date_type
from app.core.db import Base


class ReceivingSession(Base):
    __tablename__ = "receiving_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    date: Mapped[date_type] = mapped_column(Date, nullable=False, index=True)
    notes: Mapped[str] = mapped_column(String(1000), default="")
    status: Mapped[str] = mapped_column(String(20), default="matching", nullable=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    lines = relationship("ReceivingLine", back_populates="session", cascade="all, delete-orphan")
    brand_statuses = relationship("ReceivingBrandStatus", back_populates="session", cascade="all, delete-orphan")


class ReceivingLine(Base):
    __tablename__ = "receiving_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("receiving_sessions.id"), nullable=False, index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), nullable=False, index=True)
    qty_pcs: Mapped[float] = mapped_column(Float, default=0.0)         # Ирсэн тоо (ширхгээр)
    unit_price: Mapped[float] = mapped_column(Float, default=0.0)      # Ирсэн үнэ (ширхгийн)
    note: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    session = relationship("ReceivingSession", back_populates="lines")


class ReceivingBrandStatus(Base):
    """Бренд тус бүрийн тулгалт + баримтны зураг."""
    __tablename__ = "receiving_brand_statuses"
    __table_args__ = (UniqueConstraint("session_id", "brand"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("receiving_sessions.id"), nullable=False, index=True)
    brand: Mapped[str] = mapped_column(String(100), nullable=False)
    is_matched: Mapped[bool] = mapped_column(Boolean, default=False)
    receipt_image_path: Mapped[str] = mapped_column(String(500), default="")
    supplier_total_pcs: Mapped[float] = mapped_column(Float, default=0.0)
    supplier_total_amount: Mapped[float] = mapped_column(Float, default=0.0)
    matched_at = Column(DateTime, nullable=True)

    session = relationship("ReceivingSession", back_populates="brand_statuses")
