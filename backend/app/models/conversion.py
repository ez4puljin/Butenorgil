"""Хөрвүүлэлтийн бараа — заалны бараа задлах/хөрвүүлэх (app/services/conversion).

conversion_orders   — нэг захиалга: erxes deal (Заалны хөдөлгөөн → Худалдагчийн Захиалга), Эрхэтийн импорт
conversion_lines    — захиалсан (хөрвүүлэх) бараа: Эрхэтэд 03-Заалаас ЗАРЛАГА
conversion_results  — мөр бүрийг юу болгож хөрвүүлсэн: Эрхэтэд 03-Заалд ОРЛОГО
"""
from datetime import date as date_type, datetime

from sqlalchemy import Date, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base


class ConversionOrder(Base):
    __tablename__ = "conversion_orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # ordered (erxes deal үүссэн) → converted (бүх мөр хөрвүүлэлттэй) → sent (Эрхэт рүү) | cancelled
    status: Mapped[str] = mapped_column(String(20), default="ordered", index=True)
    conv_date: Mapped[date_type] = mapped_column(Date, nullable=False)
    note: Mapped[str] = mapped_column(String(500), default="")
    deal_id: Mapped[str] = mapped_column(String(40), default="")
    # Утасны ноорог бүрийн нэг удаагийн түлхүүр — сүлжээ тасарч дахин дарвал давхар deal үүсгэхгүй
    client_uid: Mapped[str] = mapped_column(String(64), default="", index=True)
    deal_number: Mapped[str] = mapped_column(String(60), default="")
    created_by: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    sent_by: Mapped[str] = mapped_column(String(120), default="")
    sent_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    erkhet_result: Mapped[str] = mapped_column(Text, default="{}")      # {so: {...}, income: {...}}

    lines = relationship("ConversionLine", back_populates="order", cascade="all, delete-orphan",
                         order_by="ConversionLine.id")


class ConversionLine(Base):
    __tablename__ = "conversion_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("conversion_orders.id"), index=True, nullable=False)
    code: Mapped[str] = mapped_column(String(64), default="")
    name: Mapped[str] = mapped_column(String(300), default="")
    erxes_id: Mapped[str] = mapped_column(String(40), default="")
    uom: Mapped[str] = mapped_column(String(20), default="")
    qty: Mapped[float] = mapped_column(Float, default=0.0)
    unit_price: Mapped[float] = mapped_column(Float, default=0.0)

    order = relationship("ConversionOrder", back_populates="lines")
    results = relationship("ConversionResult", back_populates="line", cascade="all, delete-orphan",
                           order_by="ConversionResult.id")


class ConversionResult(Base):
    __tablename__ = "conversion_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    line_id: Mapped[int] = mapped_column(ForeignKey("conversion_lines.id"), index=True, nullable=False)
    code: Mapped[str] = mapped_column(String(64), default="")
    name: Mapped[str] = mapped_column(String(300), default="")
    uom: Mapped[str] = mapped_column(String(20), default="")
    qty: Mapped[float] = mapped_column(Float, default=0.0)
    unit_price: Mapped[float] = mapped_column(Float, default=0.0)

    line = relationship("ConversionLine", back_populates="results")
