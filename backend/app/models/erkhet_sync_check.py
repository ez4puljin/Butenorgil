"""Erkhet sync шалгалт — erxes-ийн deal бүр Эрхэт рүү авлага (debtAmount) болж sync хийгдсэн эсэх.

erkhet_sync_check_runs  — нэг шалгалт (background job): параметр, явц, хураангуй
erkhet_sync_check_items — deal бүрийн үр дүн (statuses JSON, дэлгэрэнгүй data JSON)
erkhet_sync_settings    — stage-ийн ангилал (expected|pending|cancel), pipeline-ийг хасах — UI-аас засна
erkhet_sync_actions     — дахин sync-ийн audit (хэн, хэзээ, config, dateType, paymentsData өмнө/дараа, үр дүн)
"""
from datetime import datetime

from sqlalchemy import Index, Integer, String, Text, DateTime, Float, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class ErkhetSyncRun(Base):
    __tablename__ = "erkhet_sync_check_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(20), default="check")       # check | resync
    status: Mapped[str] = mapped_column(String(20), default="running")   # running | done | error
    params: Mapped[str] = mapped_column(Text, default="{}")
    progress: Mapped[str] = mapped_column(String(300), default="")
    done_n: Mapped[int] = mapped_column(Integer, default=0)
    total_n: Mapped[int] = mapped_column(Integer, default=0)
    summary: Mapped[str] = mapped_column(Text, default="{}")
    error: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)


class ErkhetSyncItem(Base):
    __tablename__ = "erkhet_sync_check_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(Integer, index=True)
    deal_id: Mapped[str] = mapped_column(String(40))
    number: Mapped[str] = mapped_column(String(60), default="")
    name: Mapped[str] = mapped_column(String(300), default="")
    pipeline_id: Mapped[str] = mapped_column(String(40), default="")
    stage_id: Mapped[str] = mapped_column(String(40), default="")
    category: Mapped[str] = mapped_column(String(20), default="")
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    severity: Mapped[str] = mapped_column(String(10), default="ok")       # error | warn | info | ok
    statuses: Mapped[str] = mapped_column(Text, default="[]")
    data: Mapped[str] = mapped_column(Text, default="{}")

    __table_args__ = (Index("ix_erkhet_sync_item_run_deal", "run_id", "deal_id"),)


class ErkhetSyncSetting(Base):
    __tablename__ = "erkhet_sync_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(20))           # stage | pipeline
    ref_id: Mapped[str] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(String(300), default="")
    value: Mapped[str] = mapped_column(String(40), default="")   # stage: expected|pending|cancel; pipeline: include|exclude
    updated_by: Mapped[str] = mapped_column(String(120), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint("kind", "ref_id", name="uq_erkhet_sync_setting"),)


class ErkhetSyncAction(Base):
    __tablename__ = "erkhet_sync_actions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(Integer, index=True)
    deal_id: Mapped[str] = mapped_column(String(40))
    number: Mapped[str] = mapped_column(String(60), default="")
    config_stage_id: Mapped[str] = mapped_column(String(40), default="")
    config_title: Mapped[str] = mapped_column(String(300), default="")
    date_type: Mapped[str] = mapped_column(String(30), default="")
    payments_before: Mapped[str] = mapped_column(Text, default="")
    payments_after: Mapped[str] = mapped_column(Text, default="")
    before_statuses: Mapped[str] = mapped_column(Text, default="[]")
    after_statuses: Mapped[str] = mapped_column(Text, default="[]")
    result: Mapped[str] = mapped_column(String(20), default="")          # ok | error | skipped
    message: Mapped[str] = mapped_column(Text, default="")
    user_name: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
