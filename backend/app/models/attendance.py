"""
Цаг бүртгэл (Time Attendance) — Timely.mn маягийн систем.

- AttendancePunch: ажилтны ирсэн/явсан товшилт (нэг өдөрт олон удаа).
- AttendanceAdjustmentRequest: мартсан/буруу бүртгэлийг нөхөн бүртгүүлэх
  хүсэлт (KpiShiftTransfer-ийг тусгасан). Админ/Супервайзер батална.
- AttendanceSchedule: ажилтны ажлын хуваарь (хоцролт/таслалт тооцоход).
  employee_id=NULL → глобал default (хувийн хуваарьгүй бүх ажилтанд).

Бүх цаг Монголын орон нутгийн (UTC+8) — app.core.timez.mn_now().
"""
from sqlalchemy import Integer, String, Date, DateTime, ForeignKey, Column
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime, date as date_type

from app.core.db import Base


# Punch kind
PUNCH_IN = "in"
PUNCH_OUT = "out"

# Adjustment статус
ADJ_PENDING = "pending"
ADJ_APPROVED = "approved"
ADJ_REJECTED = "rejected"


class AttendancePunch(Base):
    __tablename__ = "attendance_punches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    employee_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)

    punch_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)        # MN local
    punch_date: Mapped[date_type] = mapped_column(Date, nullable=False, index=True)  # MN local өдөр
    kind: Mapped[str] = mapped_column(String(8), default=PUNCH_IN)              # "in" | "out"
    source: Mapped[str] = mapped_column(String(12), default="self")            # self | makeup | admin
    ip_address: Mapped[str] = mapped_column(String(64), default="")
    note: Mapped[str] = mapped_column(String(300), default="")

    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)      # makeup/admin үед
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AttendanceAdjustmentRequest(Base):
    __tablename__ = "attendance_adjustment_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    employee_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)

    target_date: Mapped[date_type] = mapped_column(Date, nullable=False)
    requested_in: Mapped[str] = mapped_column(String(5), default="")            # "HH:MM" (хоосон=өөрчлөхгүй)
    requested_out: Mapped[str] = mapped_column(String(5), default="")
    reason: Mapped[str] = mapped_column(String(500), default="")

    status: Mapped[str] = mapped_column(String(20), default=ADJ_PENDING, index=True)
    approver_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    response_note: Mapped[str] = mapped_column(String(500), default="")
    responded_at = Column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AttendanceSchedule(Base):
    __tablename__ = "attendance_schedules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # NULL → глобал default. Бусад → тухайн ажилтны хувийн хуваарь.
    employee_id = Column(Integer, ForeignKey("users.id"), nullable=True, unique=True, index=True)

    work_days: Mapped[str] = mapped_column(String(20), default="0,1,2,3,4,5")   # 0=Дав .. 6=Ням
    work_start: Mapped[str] = mapped_column(String(5), default="09:00")         # default эхлэх цаг
    work_end: Mapped[str] = mapped_column(String(5), default="18:00")           # default дуусах цаг
    grace_minutes: Mapped[int] = mapped_column(Integer, default=10)             # хоцролтын тэвчээр (мин)
    # Гариг бүрийн өөр цаг (JSON): {"0":["08:00","15:00"], "1":["11:00","19:00"]}
    # Тухайн гаригт байвал түүнийг, үгүй бол work_start/work_end-ийг ашиглана.
    day_hours: Mapped[str] = mapped_column(String(500), default="")

    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
