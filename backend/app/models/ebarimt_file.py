"""Ebarimt тайлангийн эх файлууд — сар бүрээр оруулсан ТҮҮХИЙ Excel-ийн метадата.

Сар бүр 3 төрлийн файл оруулна (хуучин Tailan.xlsm-ийн эх үүсвэрүүд):
  - data      (Data.xlsx      — харилцагчийн мастер: Код, Нэр, Регистр, Утас, Нөат=хариуцсан ажилтан)
  - ebarimt   (EBARIMT.xlsx   — Оргил руу шивсэн Ebarimt баримтууд)
  - ebarimt2  (EBARIMT2.xlsx  — Хархорин руу шивсэн Ebarimt баримтууд)
Хуучин (2026-10-06 хүртэл): orgil/harhorin (.xls — Эрхэтээс татсан өглөгийн тайлан) — одоо ХА нь
Файл оруулалтын орлогын файлаас бодогддог; хуучин файлууд орлогын файлгүй сард л ашиглагдана.

Файлыг ЯМАР Ч ШАЛГУУРГҮЙ хэвээр нь хадгална; тайланг унших үедээ parse хийж
(mtime cache-тэй) тооцоолно. (жил, сар, төрөл) тус бүрд нэг л идэвхтэй файл —
дахин оруулбал солигдоно.
"""
from sqlalchemy import Column, Integer, Float, String, DateTime, UniqueConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime

from app.core.db import Base


EBARIMT_KINDS = {"data", "orgil", "harhorin", "ebarimt", "ebarimt2"}


class EbarimtFile(Base):
    __tablename__ = "ebarimt_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    year:  Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    month: Mapped[int] = mapped_column(Integer, nullable=False, index=True)   # 1-12
    kind:  Mapped[str] = mapped_column(String(16), nullable=False)            # data|orgil|harhorin|ebarimt|ebarimt2

    original_filename: Mapped[str] = mapped_column(String(300), default="")
    stored_filename:   Mapped[str] = mapped_column(String(300), default="")   # UPLOAD_DIR-д харьцангуй
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    row_count:  Mapped[int] = mapped_column(Integer, default=0)               # best-effort

    uploaded_by_id:   Mapped[int] = mapped_column(Integer, default=0)
    uploaded_by_name: Mapped[str] = mapped_column(String(120), default="")
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("year", "month", "kind", name="uq_ebarimt_file_ym_kind"),
    )


class EbarimtNote(Base):
    """Хэрэглэгчийн гараар бичсэн тайлбар — (жил, сар, харилцагчийн код) бүрээр.

    Data.xlsx-ийн "Тайлбар" баганаас ТУСДАА: эх файлыг дахин оруулахад
    алга болохгүй, DB-д хадгалагдана. Ажилтан харилцагчтайгаа ярьсан
    тэмдэглэлээ энд бичнэ."""
    __tablename__ = "ebarimt_notes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    year:  Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    month: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    code:  Mapped[str] = mapped_column(String(30), nullable=False, index=True)   # харилцагчийн код

    note: Mapped[str] = mapped_column(String(500), default="")

    updated_by_name: Mapped[str] = mapped_column(String(120), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("year", "month", "code", name="uq_ebarimt_note_ym_code"),
    )


class EbarimtCustomerOverride(Base):
    """Харилцагчийн мэдээллийн гар засвар — Код-оор (бүх сард нийтлэг).

    Data.xlsx-д дутуу/буруу байгаа мэдээллийг (Регистр, Утас, хариуцсан
    ажилтан, тайлбар) гараар засна. Жишээ: регистргүй харилцагчид регистр
    оруулбал Ebarimt шивэлт нь шууд тооцоологдож эхэлнэ.

    NULL = засвар байхгүй (Data файлын утгыг ашиглана).
    ""   = зориуд хоосон болгосон (Data-д утга байсан ч хоосон гэж үзнэ).
    Код болон Харилцагчийн нэрийг засахгүй (эх файлын түлхүүр).
    """
    __tablename__ = "ebarimt_customer_overrides"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(30), unique=True, index=True, nullable=False)

    # Python 3.14 + SQLAlchemy дээр Mapped[str | None] асуудалтай тул plain Column
    registry = Column(String(200), nullable=True)
    phone    = Column(String(60),  nullable=True)
    employee = Column(String(120), nullable=True)
    tailbar  = Column(String(300), nullable=True)

    updated_by_name: Mapped[str] = mapped_column(String(120), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class EbarimtExempt(Base):
    """НӨАТ чөлөөлөгдөх дүн — (он, сар, харилцагчийн код) бүрээр, салбар тус бүрд гараар оруулна.
    Зөрүү = Худалдан авалт − Манайд шивсэн НӨАТ (Ebarimt) − НӨАТ чөлөөлөгдөх дүн."""
    __tablename__ = "ebarimt_exempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    year:  Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    month: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    code:  Mapped[str] = mapped_column(String(30), nullable=False, index=True)

    orgil    = Column(Float, nullable=False, default=0.0)
    harhorin = Column(Float, nullable=False, default=0.0)

    updated_by_name: Mapped[str] = mapped_column(String(120), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("year", "month", "code", name="uq_ebarimt_exempt_ym_code"),
    )


class EbarimtEmployeeAssign(Base):
    """Харилцагчийн хариуцсан ажилтныг САР БҮРЭЭР солих (зөвхөн админ) — тухайн сарын Data.xlsx-ийн
    «Нөат» баганаас давамгайлна. Тухайн сарын Data-ийн ажилтантай ижил болговол бичлэгийг устгана.
    Нэгтгэсэн тайланд харилцагч бүр аль ажилтанд хэдэн сар хуваарилагдсаныг эндээс (сар бүрийн
    эцсийн ажилтнаар) харуулна."""
    __tablename__ = "ebarimt_employee_assigns"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    year:  Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    month: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    code:  Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    employee: Mapped[str] = mapped_column(String(120), nullable=False)

    updated_by_name: Mapped[str] = mapped_column(String(120), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("year", "month", "code", name="uq_ebarimt_emp_ym_code"),
    )


class EbarimtEmployee(Base):
    """Data.xlsx-д бүртгэлгүй, админ гараар нэмсэн ажилтан — сар бүрийн хуваарилалтын сонголтод."""
    __tablename__ = "ebarimt_employees"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    created_by_name: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class EbarimtHistory(Base):
    """Харилцагчийн сарын утгуудын түүх — ажилтан (emp), ХА (po/ph), Ebarimt (vo/vh).

    Файл анх оруулах/шинэчлэх (Data, орлогын, Ebarimt), гараар солих бүрт ӨӨРЧЛӨГДСӨН утгыг дараалан
    бичнэ (id = дараалал). Тайлан дээр mouse аваачихад «Анх А → гараар Б» гэх мэтээр харуулна.
    kind: init (анх) | file (файл шинэчлэгдсэн) | legacy (хуучин өглөгийн тайлан) |
          edit (файлгүй өөрчлөлт, ж: регистр засвар) | manual (гараар сольсон) | revert (Data руу буцаасан)
    """
    __tablename__ = "ebarimt_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    year:  Mapped[int] = mapped_column(Integer, nullable=False)
    month: Mapped[int] = mapped_column(Integer, nullable=False)
    code:  Mapped[str] = mapped_column(String(30), nullable=False)
    field: Mapped[str] = mapped_column(String(8), nullable=False)      # emp | po | ph | vo | vh
    text = Column(String(200), nullable=True)                           # ажилтан
    num  = Column(Float, nullable=True)                                 # дүн
    kind: Mapped[str] = mapped_column(String(12), nullable=False)
    file: Mapped[str] = mapped_column(String(300), default="")         # эх файлын нэр
    file_key: Mapped[str] = mapped_column(String(300), default="")     # файлын хувилбар (өөрчлөлтийн шалтгаан)
    at = Column(DateTime, nullable=True)                                # файл оруулсан / гараар сольсон цаг (UTC)
    by_name: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_ebarimt_history_ym", "year", "month"),
    )


class EbarimtReceiptLink(Base):
    """Data-д бүртгэлгүй регистрээр шивсэн Ebarimt баримтыг (ДДТД-ээр) харилцагчид гараар холбох.

    Холбосон баримтын «Нийт дүн» тухайн харилцагчийн Ebarimt дүнд нэмэгдэж, регистрээр тулгах
    дүнгээс хасагдана — тэр регистр хожим Data/гар засвараар бүртгэгдсэн ч давхар тоологдохгүй
    (холбоос давамгайлна). Ebarimt файл дахин оруулахад баримт (ДДТД) байсаар байвал хэвээр,
    алга бол тоологдохгүй (stale)."""
    __tablename__ = "ebarimt_receipt_links"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    year:  Mapped[int] = mapped_column(Integer, nullable=False)
    month: Mapped[int] = mapped_column(Integer, nullable=False)
    which: Mapped[str] = mapped_column(String(10), nullable=False)      # orgil | harhorin
    rkey:  Mapped[str] = mapped_column(String(80), nullable=False)      # ДДТД (эсвэл Падаан №|огноо|ТТД|дүн)
    ttd:   Mapped[str] = mapped_column(String(40), default="")
    code:  Mapped[str] = mapped_column(String(30), nullable=False)      # харилцагчийн код
    amount = Column(Float, nullable=True)                               # холбох үеийн «Нийт дүн» (мэдээлэл)

    created_by_name: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("year", "month", "which", "rkey", name="uq_ebarimt_receipt_link"),
        Index("ix_ebarimt_receipt_link_ym", "year", "month"),
    )
