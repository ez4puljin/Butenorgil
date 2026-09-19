"""Нэмэлт талбар (мастер) — Эрхэтээс ирдэггүй, энэ системд өөрсдөө хөтөлдөг
багануудыг Бараа / Харилцагч дээр хадгална.

  CustomField  — талбарын тодорхойлолт: ямар объект (product/customer), нэр,
                 төрөл (text/number/select/bool/date), сонголтууд. Харилцагчийн
                 талбар `group_filter`-тэй бол зөвхөн тухайн «Бүлэг (систем)»-ийн
                 харилцагч дээр харагдана (ж: Нийлүүлэгч → Байршил, Тооцоо, НӨАТ).
  CustomRecord — нэг бараа/харилцагчийн утгууд (JSON). Кодоос гадна
                 «зангуу» (нэр, баркод, утас, данс)-г хадгалдаг тул Эрхэт дээр код
                 өөрчлөгдөж дахин импортлоход хуучин код алга болсон бичлэгийг
                 зангуугаар нь шинэ кодтой автоматаар холбоно (prev_codes-д түүх
                 үлдэнэ). Холбогдож чадаагүй бол status="orphan" болж гараар
                 холбохыг хүлээнэ — утга хэзээ ч автоматаар устахгүй.
"""
from datetime import datetime


from sqlalchemy import Boolean, Column, DateTime, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base

ENTITIES = ("product", "customer")
FIELD_TYPES = ("text", "number", "select", "bool", "date")


class CustomField(Base):
    __tablename__ = "custom_fields"
    __table_args__ = (UniqueConstraint("entity", "key", name="uq_custom_field_entity_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity: Mapped[str] = mapped_column(String(20), index=True, nullable=False)
    key: Mapped[str] = mapped_column(String(60), nullable=False)          # латин slug (JSON түлхүүр)
    label: Mapped[str] = mapped_column(String(120), nullable=False)       # Excel баганын гарчиг
    ftype: Mapped[str] = mapped_column(String(10), default="text")
    options: Mapped[str] = mapped_column(Text, default="[]")              # select сонголтууд (JSON list)
    group_filter: Mapped[str] = mapped_column(String(120), default="")    # зөвхөн энэ бүлэгт харагдана ("" = бүгд)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class CustomRecord(Base):
    __tablename__ = "custom_records"
    __table_args__ = (
        UniqueConstraint("entity", "code", name="uq_custom_record_entity_code"),
        Index("ix_custom_record_entity_status", "entity", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity: Mapped[str] = mapped_column(String(20), nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)        # одоогийн Эрхэт код
    name: Mapped[str] = mapped_column(String(255), default="")           # сүүлд харсан нэр (лавлагаа)
    anchors: Mapped[str] = mapped_column(Text, default="{}")             # {"name","barcodes","phone","bank_acct","email"}
    values: Mapped[str] = mapped_column(Text, default="{}")              # {field_key: value}
    status: Mapped[str] = mapped_column(String(10), default="active")    # active | orphan
    prev_codes: Mapped[str] = mapped_column(Text, default="[]")          # [{"code","at","by"}]
    updated_by: Mapped[str] = mapped_column(String(100), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    # Py3.14 + SQLAlchemy дээр Mapped[datetime | None] алдаа өгдөг тул plain Column
    seen_at = Column(DateTime, nullable=True)   # сүүлд импортын файлд байсан
