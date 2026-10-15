"""Миний тооллого — хүн бүр ӨӨРИЙН тооллогыг үүсгэж, МАСТЕРТ бүртгэлтэй бараагаар тоолно.

/hall-count хуудасны «Миний тооллого» горим (заалны дундын тооллогоос тусдаа):
  · Утасны камераар баркод уншуулж тоо оруулна. Нэг барааг дахин уншуулбал оруулсан
    тоо нь өмнөх тоон дээр НЭМЭГДЭНЭ (MasterCountLine.qty = Σ уншилт).
  · Олон хүн тус тусын тооллогоо зэрэг тоолно — тооллого бүр эзэнтэй, бусад нь өөрчлөхгүй.
  · Дуусгаад .txt (мөр бүр «code,quantity») экспорт.
Бараа нь «Мастер нэгтгэл»-д (app/data/outputs/master_latest.xlsx) бүртгэлтэй байх ёстой
(app/services/master_index).
"""
from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base

MC_OPEN = "open"
MC_DONE = "done"


class MasterCount(Base):
    __tablename__ = "master_counts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    status: Mapped[str] = mapped_column(String(12), index=True, default=MC_OPEN)   # open | done
    owner_id: Mapped[int] = mapped_column(Integer, index=True, default=0)
    owner_name: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)


class MasterCountLine(Base):
    __tablename__ = "master_count_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    count_id: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(255), default="")
    qty: Mapped[float] = mapped_column(Float, default=0.0)          # Σ уншилт (засвар орно)
    scans: Mapped[int] = mapped_column(Integer, default=0)
    first_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("count_id", "code", name="uq_master_count_line_code"),
    )


class MasterCountScan(Base):
    """Уншилт бүрийн түүх — add: нэмсэн тоо, set: гараар зассан (qty = шинэ нийт)."""
    __tablename__ = "master_count_scans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    count_id: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    line_id: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    code: Mapped[str] = mapped_column(String(64), default="")
    barcode: Mapped[str] = mapped_column(String(64), default="")    # уншуулсан утга
    kind: Mapped[str] = mapped_column(String(8), default="add")     # add | set
    qty: Mapped[float] = mapped_column(Float, default=0.0)
    user_name: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
