"""Заалны тооллого — гар утасны скáннераар хийдэг бодит цагийн тооллого.

Урсгал:
  1. /imports/balance-file дээр "Заалны тоолох барааны үлдэгдэл" (kind=hall_count)
     Excel оруулна → нээлттэй тооллого (session) үүснэ / шинэчлэгдэнэ.
     Файлын мөр бүр HallCountItem болно (код, нэр, үлдэгдэл, нэгж өртөг).
  2. Ажилтнууд .apk-аар баркод уншуулж тоо оруулна → HallCountScan.
     Хэд хэдэн хүн заалыг хувааж тоолдог тул нэг барааны тоо ОЛОН скáнаас
     НЭМЭГДЭЖ хуримтлагдана (counted_qty = Σ scans.qty). Төхөөрөмж бүр device_id-тай
     тул "2+ төхөөрөмжөөс тоологдсон" барааг шүүж болно.
  3. Админ тооллогыг батлахад session хаагдаж, зөрүүгээр Эрхэтийн орлого /
     зарлагын импорт Excel гаргана.

Нэг зэрэг ЗӨВХӨН НЭГ нээлттэй session байна (status="open").
"""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


HC_STATUS_OPEN = "open"
HC_STATUS_CONFIRMED = "confirmed"


class HallCountSession(Base):
    __tablename__ = "hall_count_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    status: Mapped[str] = mapped_column(String(16), index=True, default=HC_STATUS_OPEN)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    created_by_id: Mapped[int] = mapped_column(Integer, default=0)
    created_by_name: Mapped[str] = mapped_column(String(120), default="")

    # Үлдэгдлийн эх файл (сүүлд оруулсан)
    source_filename: Mapped[str] = mapped_column(String(300), default="")
    balance_uploaded_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    item_count: Mapped[int] = mapped_column(Integer, default=0)      # файлаас ирсэн мөр

    confirmed_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    confirmed_by_id: Mapped[int] = mapped_column(Integer, default=0)
    confirmed_by_name: Mapped[str] = mapped_column(String(120), default="")
    note: Mapped[str] = mapped_column(String(500), default="")
    # Батлахад: огт уншуулаагүй барааг 0 гэж тооцох уу (→ үлдэгдэл бүхэлдээ дутагдал)
    # эсвэл зөрүүнээс хасах уу. Экспорт энэ утгыг ашиглана — дараа нь өөрчлөгдөхгүй.
    uncounted_as_zero: Mapped[bool] = mapped_column(Boolean, default=True)

    # Батлах үеийн товч дүн (түүхэнд харуулахад — дахин тооцохгүй)
    sum_counted_items: Mapped[int] = mapped_column(Integer, default=0)
    sum_diff_items: Mapped[int] = mapped_column(Integer, default=0)
    sum_surplus_amount: Mapped[float] = mapped_column(Float, default=0.0)   # илүүдэл ₮
    sum_shortage_amount: Mapped[float] = mapped_column(Float, default=0.0)  # дутагдал ₮


class HallCountItem(Base):
    __tablename__ = "hall_count_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    code: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), default="")
    balance_qty: Mapped[float] = mapped_column(Float, default=0.0)     # файлын эцсийн үлдэгдэл
    unit_cost: Mapped[float] = mapped_column(Float, default=0.0)       # файлын нэгж өртөг (0 = мэдэгдэхгүй)
    # Үлдэгдлийн файлд байсан эсэх. False = скáнаар нэмэгдсэн (жагсаалтад байгаагүй бараа)
    in_list: Mapped[bool] = mapped_column(Boolean, default=True)

    # Денормал (скáн бүр дээр дахин тооцно) — жагсаалт хурдан ачаалахад
    counted_qty: Mapped[float] = mapped_column(Float, default=0.0)
    scan_count: Mapped[int] = mapped_column(Integer, default=0)
    device_count: Mapped[int] = mapped_column(Integer, default=0)
    last_scanned_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)

    __table_args__ = (
        UniqueConstraint("session_id", "code", name="uq_hall_count_item_code"),
    )


class HallCountScan(Base):
    __tablename__ = "hall_count_scans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    item_id: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    code: Mapped[str] = mapped_column(String(64), default="")
    qty: Mapped[float] = mapped_column(Float, default=0.0)             # нэмэгдэх тоо (сөрөг = засвар)
    device_id: Mapped[str] = mapped_column(String(64), index=True, default="")
    device_label: Mapped[str] = mapped_column(String(120), default="")
    user_id: Mapped[int] = mapped_column(Integer, default=0)
    username: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
