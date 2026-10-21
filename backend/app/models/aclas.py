"""Aclas LB1H жин ↔ erxes барааны segment sync (app/services/aclas_sync, api/aclas).

Жин зөвхөн дотоод сүлжээнд (UDP 5001) — дэлгүүрийн PC дээрх 32-бит «Aclas Agent» сервер рүү outbound
холбогдож даалгавар татна (aclas_agent/). Сервер даалгавар, PLU файл, нөөц, хувилбарыг хадгална.

aclas_scales    — жин: нэр, салбар, IP, шошгоны дугаар, сүүлд мэдэгдсэн PLU төлөв (scale_state)
aclas_settings  — key/value: segment_ids, interval_min, dry_run, agent_token_hash, …
aclas_plu_ids   — тоон биш кодтой барааны тогтвортой PLU дугаар
aclas_jobs      — агентын даалгавар (ping | backup | sync | restore | label), төлөв, үр дүн
aclas_backups   — жингээс татсан PLU / шошгоны нөөц (сэргээх боломжтой)
"""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class AclasScale(Base):
    __tablename__ = "aclas_scales"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    branch: Mapped[str] = mapped_column(String(120), default="")
    ip: Mapped[str] = mapped_column(String(40), default="")
    label_index: Mapped[int] = mapped_column(Integer, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # Жин дээр байгаа гэдэг нь сүүлд баталгаажсан PLU файл (жингээс татсан, cp1251 байт)
    state_raw: Mapped[bytes] = mapped_column(LargeBinary, nullable=True)
    state_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    # Бидний sync-ээр оруулсан PLU ID-ууд (JSON) — segment-ээс гарвал зөвхөн эдгээрийг хасна
    managed_ids: Mapped[str] = mapped_column(Text, default="[]")
    # Хасах гэсэн ч жин дээр үлдсэн ID-ууд (жин upsert хийдэг бол) — дахин оролдохгүй
    stale_ids: Mapped[str] = mapped_column(Text, default="[]")
    last_ping_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    last_ping_ok: Mapped[bool] = mapped_column(Boolean, nullable=True)
    last_info: Mapped[str] = mapped_column(Text, default="")
    last_sync_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AclasSetting(Base):
    __tablename__ = "aclas_settings"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_by: Mapped[str] = mapped_column(String(120), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AclasPluId(Base):
    __tablename__ = "aclas_plu_ids"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[str] = mapped_column(String(40))
    code: Mapped[str] = mapped_column(String(60), default="")
    plu: Mapped[int] = mapped_column(Integer)

    __table_args__ = (UniqueConstraint("product_id", name="uq_aclas_plu_product"),
                      UniqueConstraint("plu", name="uq_aclas_plu_plu"))


class AclasJob(Base):
    __tablename__ = "aclas_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    scale_id: Mapped[int] = mapped_column(Integer, index=True)
    kind: Mapped[str] = mapped_column(String(20))            # ping | backup | sync | restore | label
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)  # pending|running|done|error
    payload: Mapped[str] = mapped_column(Text, default="{}")
    plan: Mapped[str] = mapped_column(Text, default="{}")    # sync: diff хураангуй, мөрүүд
    result: Mapped[str] = mapped_column(Text, default="{}")
    error: Mapped[str] = mapped_column(Text, default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_try_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    created_by: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    heartbeat_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)


class AclasBackup(Base):
    __tablename__ = "aclas_backups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    scale_id: Mapped[int] = mapped_column(Integer, index=True)
    job_id: Mapped[int] = mapped_column(Integer, nullable=True)
    reason: Mapped[str] = mapped_column(String(60), default="")
    plu_raw: Mapped[bytes] = mapped_column(LargeBinary, nullable=True)
    label_index: Mapped[int] = mapped_column(Integer, nullable=True)
    label_format: Mapped[bytes] = mapped_column(LargeBinary, nullable=True)
    label_map: Mapped[bytes] = mapped_column(LargeBinary, nullable=True)
    plu_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
