"""paymentsData скан ба засвар (Erkhet sync шалгалтын дэд хэсэг).

payments_scan_runs    — скан / засвар / автомат скан (background job)
payments_scan_items   — deal бүрийн үр дүн: paymentsData issue, Erxes↔Erkhet дүн, CASH, хариугүй
payments_fix_actions  — засвар бүрийн audit: хуучин paymentsData (rollback), өмнө/дараах snapshot, sync үр дүн
"""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class PaymentsScanRun(Base):
    __tablename__ = "payments_scan_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(20), default="scan")        # scan | auto | fix
    status: Mapped[str] = mapped_column(String(20), default="running")   # running | done | error | aborted
    params: Mapped[str] = mapped_column(Text, default="{}")
    progress: Mapped[str] = mapped_column(String(300), default="")
    done_n: Mapped[int] = mapped_column(Integer, default=0)
    total_n: Mapped[int] = mapped_column(Integer, default=0)
    summary: Mapped[str] = mapped_column(Text, default="{}")
    error: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)


class PaymentsScanItem(Base):
    __tablename__ = "payments_scan_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(Integer, index=True)
    deal_id: Mapped[str] = mapped_column(String(40))
    number: Mapped[str] = mapped_column(String(60), default="")
    name: Mapped[str] = mapped_column(String(300), default="")
    pipeline_id: Mapped[str] = mapped_column(String(40), default="")
    stage_id: Mapped[str] = mapped_column(String(40), default="")
    category: Mapped[str] = mapped_column(String(20), default="")
    erxes_amount: Mapped[float] = mapped_column(Float, default=0.0)
    erkhet_amount: Mapped[float] = mapped_column(Float, nullable=True)
    amount_diff: Mapped[float] = mapped_column(Float, default=0.0)        # Erkhet − Erxes
    erkhet_payment: Mapped[str] = mapped_column(String(20), default="")  # PAYMENT_CARD | CASH | ""
    last_sync_undefined: Mapped[bool] = mapped_column(Boolean, default=False)
    payments_bad: Mapped[bool] = mapped_column(Boolean, default=False)
    severity: Mapped[str] = mapped_column(String(10), default="ok")
    issues: Mapped[str] = mapped_column(Text, default="[]")              # issue code-ууд
    data: Mapped[str] = mapped_column(Text, default="{}")

    __table_args__ = (Index("ix_payments_scan_item_run_deal", "run_id", "deal_id"),)


class PaymentsFixAction(Base):
    __tablename__ = "payments_fix_actions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(Integer, index=True)
    deal_id: Mapped[str] = mapped_column(String(40), index=True)
    number: Mapped[str] = mapped_column(String(60), default="")
    action: Mapped[str] = mapped_column(String(30), default="")          # fix_sync | fix_only | sync_only
    payments_before: Mapped[str] = mapped_column(Text, default="")       # rollback-д
    payments_after: Mapped[str] = mapped_column(Text, default="")
    snapshot_before: Mapped[str] = mapped_column(Text, default="{}")
    snapshot_after: Mapped[str] = mapped_column(Text, default="{}")
    config_stage_id: Mapped[str] = mapped_column(String(40), default="")
    config_title: Mapped[str] = mapped_column(String(300), default="")
    date_type: Mapped[str] = mapped_column(String(30), default="")
    erkhet_before: Mapped[float] = mapped_column(Float, nullable=True)
    erkhet_after: Mapped[float] = mapped_column(Float, nullable=True)
    result: Mapped[str] = mapped_column(String(20), default="")          # ok | error | skipped | aborted
    message: Mapped[str] = mapped_column(Text, default="")
    user_name: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
