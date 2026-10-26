"""Үнийн тохиргоо — Хархорин агуулахын зарах үнийг сүүлийн орлогын үнээр (app/services/price_cost).

pc_income_rows    — Эрхэтийн орлогын мөр (kind=-4, тохируулсан байршил), record_id давтагдахгүй
pc_pos_sales      — POS «Хархорин агуулах»-ын борлуулалтын мөр (бодит үнэ)
pc_sync_runs      — синк бүрийн бүртгэл (унших)
pc_managed_plans  — ЭНЭ систем үүсгэсэн erxes pricing plan (бусдын plan-д хүрэхгүйн тулд _id-аар таньдаг)
pc_price_audit    — plan үүсгэх/засах/идэвхгүй болгох бүрийн бүртгэл
"""
from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class PcIncomeRow(Base):
    __tablename__ = "pc_income_rows"

    record_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tr_id: Mapped[int] = mapped_column(Integer, default=0)
    date: Mapped[str] = mapped_column(String(10), index=True)          # YYYY-MM-DD
    location_id: Mapped[str] = mapped_column(String(10), default="")
    code: Mapped[str] = mapped_column(String(40), index=True)
    name: Mapped[str] = mapped_column(String(300), default="")
    customer: Mapped[str] = mapped_column(String(300), default="")
    bill_number: Mapped[str] = mapped_column(String(60), default="")
    count: Mapped[float] = mapped_column(Float, default=0)
    total: Mapped[float] = mapped_column(Float, default=0)             # total_with_vat
    description: Mapped[str] = mapped_column(String(500), default="")


class PcPosSale(Base):
    __tablename__ = "pc_pos_sales"

    item_id: Mapped[str] = mapped_column(String(40), primary_key=True)   # posOrders.items[]._id
    order_id: Mapped[str] = mapped_column(String(40), index=True)
    number: Mapped[str] = mapped_column(String(40), default="")
    paid_at: Mapped[datetime] = mapped_column(DateTime, index=True)     # UTC
    product_id: Mapped[str] = mapped_column(String(40), index=True)
    count: Mapped[float] = mapped_column(Float, default=0)
    unit_price: Mapped[float] = mapped_column(Float, default=0)
    discount: Mapped[float] = mapped_column(Float, default=0)


class PcSyncRun(Base):
    __tablename__ = "pc_sync_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(20), default="read")       # read (зөвхөн унших)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="running")  # running | ok | error
    by: Mapped[str] = mapped_column(String(120), default="")
    stats: Mapped[str] = mapped_column(Text, default="{}")
    error: Mapped[str] = mapped_column(Text, default="")


class PcManagedPlan(Base):
    __tablename__ = "pc_managed_plans"

    plan_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    code: Mapped[str] = mapped_column(String(40), index=True)
    product_id: Mapped[str] = mapped_column(String(40), index=True)
    value: Mapped[float] = mapped_column(Float, default=0)
    status: Mapped[str] = mapped_column(String(20), default="active")
    created_by: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class PcPriceAudit(Base):
    __tablename__ = "pc_price_audit"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    by: Mapped[str] = mapped_column(String(120), default="")
    action: Mapped[str] = mapped_column(String(20))                     # create | update | deactivate | rollback
    batch: Mapped[str] = mapped_column(String(40), default="", index=True)
    plan_id: Mapped[str] = mapped_column(String(40), default="")
    code: Mapped[str] = mapped_column(String(40), default="")
    name: Mapped[str] = mapped_column(String(300), default="")
    old_value: Mapped[float] = mapped_column(Float, nullable=True)
    new_value: Mapped[float] = mapped_column(Float, nullable=True)
    bill_number: Mapped[str] = mapped_column(String(60), default="")
    note: Mapped[str] = mapped_column(String(500), default="")
