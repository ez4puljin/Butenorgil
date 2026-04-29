"""
"Тооцоо хаах" — Хаанбанкны хуулга импорт хийж, гүйлгээ бүрт
харилцагч/данс/тайлбар оруулан Эрхэт систем рүү экспортлох.
"""
from sqlalchemy import Integer, String, Float, Date, DateTime, ForeignKey, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship
from datetime import datetime, date as date_type
from app.core.db import Base


class BankStatement(Base):
    """Хаанбанкны нэг данс, нэг хугацааны хуулга."""
    __tablename__ = "bank_statements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_number: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    currency: Mapped[str] = mapped_column(String(10), default="MNT")
    date_from: Mapped[date_type] = mapped_column(Date, nullable=True)
    date_to: Mapped[date_type] = mapped_column(Date, nullable=True)
    filename: Mapped[str] = mapped_column(String(300), default="")
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    uploaded_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=True)

    transactions = relationship(
        "BankTransaction",
        back_populates="statement",
        cascade="all, delete-orphan",
        order_by="BankTransaction.txn_date",
    )


class BankTransaction(Base):
    """Хуулгын нэг гүйлгээний мөр."""
    __tablename__ = "bank_transactions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    statement_id: Mapped[int] = mapped_column(ForeignKey("bank_statements.id"), nullable=False, index=True)

    # ── Банкнаас ирсэн өгөгдөл ────────────────────────────────────────
    txn_date: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    debit: Mapped[float] = mapped_column(Float, default=0.0)
    credit: Mapped[float] = mapped_column(Float, default=0.0)
    bank_description: Mapped[str] = mapped_column(String(1000), default="")
    bank_counterpart: Mapped[str] = mapped_column(String(100), default="")
    is_fee: Mapped[bool] = mapped_column(Boolean, default=False)

    # ── Хэрэглэгчийн гараас оруулах ───────────────────────────────────
    partner_name: Mapped[str] = mapped_column(String(200), default="")
    partner_account: Mapped[str] = mapped_column(String(100), default="")
    custom_description: Mapped[str] = mapped_column(String(500), default="")
    action: Mapped[str] = mapped_column(String(20), default="")   # "" | "close" | "create"

    statement = relationship("BankStatement", back_populates="transactions")


class BankAccountConfig(Base):
    """Тооцоо хаахад байнга хэрэглэгддэг данс/харилцагчийн мэдээлэл (Тохиргоо)."""
    __tablename__ = "bank_account_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_number: Mapped[str] = mapped_column(String(50), default="")   # Дансны дугаар
    partner_name: Mapped[str] = mapped_column(String(200), default="")    # Харилцагчийн нэр
    bank_name: Mapped[str] = mapped_column(String(100), default="Хаанбанк")
    is_fee_default: Mapped[bool] = mapped_column(Boolean, default=False)  # Шимтгэл хаах данс
    note: Mapped[str] = mapped_column(String(300), default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
