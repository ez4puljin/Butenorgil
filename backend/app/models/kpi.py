from datetime import datetime, date as date_type
from sqlalchemy import Column, Integer, String, Float, Boolean, Date, DateTime, ForeignKey, UniqueConstraint
from app.core.db import Base


class KpiTaskGroup(Base):
    __tablename__ = "kpi_task_groups"

    id         = Column(Integer, primary_key=True, index=True)
    name       = Column(String(100), nullable=False)
    sort_order = Column(Integer, default=0)
    is_active  = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class KpiTaskTemplate(Base):
    __tablename__ = "kpi_task_templates"

    id             = Column(Integer, primary_key=True, index=True)
    name           = Column(String(200), nullable=False)
    description    = Column(String(500), default="")
    monetary_value = Column(Float, nullable=False)
    weight_points  = Column(Float, default=0.0)              # daily task-д оноо (scoring)
    task_category  = Column(String(20), default="daily")     # "daily" | "inventory"
    group_id       = Column(Integer, ForeignKey("kpi_task_groups.id"), nullable=True)
    period         = Column(String(20), default="daily")     # daily | weekly | monthly
    day_of_week    = Column(Integer, nullable=True)          # 0=Mon…6=Sun (weekly-д)
    day_of_month   = Column(Integer, nullable=True)          # 1–31 (monthly-д)
    is_active      = Column(Boolean, default=True)
    created_at     = Column(DateTime, default=datetime.utcnow)


class KpiEmployeeTaskConfig(Base):
    __tablename__ = "kpi_employee_task_configs"
    __table_args__ = (UniqueConstraint("employee_id", "template_id"),)

    id          = Column(Integer, primary_key=True, index=True)
    employee_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    template_id = Column(Integer, ForeignKey("kpi_task_templates.id"), nullable=False)
    approver_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    is_active   = Column(Boolean, default=True)
    sort_order  = Column(Integer, default=0)


class KpiDailyChecklist(Base):
    __tablename__ = "kpi_daily_checklists"
    __table_args__ = (UniqueConstraint("employee_id", "date"),)

    id                      = Column(Integer, primary_key=True, index=True)
    employee_id             = Column(Integer, ForeignKey("users.id"), nullable=False)
    date                    = Column(Date, nullable=False, index=True)
    status                  = Column(String(20), default="draft")   # draft | submitted
    submitted_at            = Column(DateTime, nullable=True)
    created_at              = Column(DateTime, default=datetime.utcnow)
    # ── Ирц (attendance) ────────────────────────────────────────────────────
    attendance_status       = Column(String(20), default="pending")  # pending | approved | rejected
    attendance_note         = Column(String(500), default="")
    attendance_approved_by  = Column(Integer, ForeignKey("users.id"), nullable=True)
    attendance_approved_at  = Column(DateTime, nullable=True)


class KpiChecklistEntry(Base):
    __tablename__ = "kpi_checklist_entries"

    id              = Column(Integer, primary_key=True, index=True)
    checklist_id    = Column(Integer, ForeignKey("kpi_daily_checklists.id"), nullable=False, index=True)
    template_id     = Column(Integer, ForeignKey("kpi_task_templates.id"), nullable=True)
    config_id       = Column(Integer, ForeignKey("kpi_employee_task_configs.id"), nullable=True)
    task_name       = Column(String(200), nullable=False)
    monetary_value  = Column(Float, nullable=False)   # daily: weight_points; inventory: ₮ дүн
    task_category   = Column(String(20), default="daily")   # "daily" | "inventory" (snapshot)
    approver_id     = Column(Integer, ForeignKey("users.id"), nullable=False)
    is_adhoc        = Column(Boolean, default=False)
    admin_task_id   = Column(Integer, ForeignKey("kpi_admin_daily_tasks.id"), nullable=True)
    is_checked      = Column(Boolean, default=False)
    approval_status = Column(String(20), default="pending")   # pending | approved | rejected
    approval_note   = Column(String(500), default="")
    approved_value  = Column(Float, nullable=True)   # daily: авсан оноо; inventory: авсан ₮
    approved_at     = Column(DateTime, nullable=True)
    approved_by_id  = Column(Integer, ForeignKey("users.id"), nullable=True)


class KpiAdminDailyTask(Base):
    __tablename__ = "kpi_admin_daily_tasks"

    id             = Column(Integer, primary_key=True, index=True)
    task_name      = Column(String(200), nullable=False)
    monetary_value = Column(Float, default=0.0)
    task_category  = Column(String(20), default="daily")   # "daily" | "inventory"
    date           = Column(Date, nullable=False, index=True)
    approver_id    = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_by     = Column(Integer, ForeignKey("users.id"), nullable=True)
    is_active           = Column(Boolean, default=True)
    target_employee_ids = Column(String(500), default="")  # comma-separated; хоосон = бүгдэд
    created_at          = Column(DateTime, default=datetime.utcnow)


class KpiScheduledDay(Base):
    """Ажилтан тус бүрийн ажиллах ёстой өдрүүд (хуваарь)."""
    __tablename__ = "kpi_scheduled_days"
    __table_args__ = (UniqueConstraint("employee_id", "date"),)

    id          = Column(Integer, primary_key=True, index=True)
    employee_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    date        = Column(Date, nullable=False, index=True)
    created_by  = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at  = Column(DateTime, default=datetime.utcnow)


class KpiShiftTransfer(Base):
    """Ээлж шилжүүлэх хүсэлт."""
    __tablename__ = "kpi_shift_transfers"

    id                    = Column(Integer, primary_key=True, index=True)
    date                  = Column(Date, nullable=False, index=True)
    original_employee_id  = Column(Integer, ForeignKey("users.id"), nullable=False)
    replacement_employee_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    approver_id           = Column(Integer, ForeignKey("users.id"), nullable=False)
    status                = Column(String(20), default="pending")  # pending | approved | rejected
    note                  = Column(String(500), default="")
    response_note         = Column(String(500), default="")
    responded_at          = Column(DateTime, nullable=True)
    created_at            = Column(DateTime, default=datetime.utcnow)


class KpiAuditLog(Base):
    """Admin-ийн хийсэн ирц/хуваарийн өөрчлөлтийн бүртгэл."""
    __tablename__ = "kpi_audit_logs"

    id                 = Column(Integer, primary_key=True, index=True)
    admin_id           = Column(Integer, ForeignKey("users.id"), nullable=False)
    action             = Column(String(50), nullable=False)   # e.g. "attendance_override", "schedule_add", "schedule_remove"
    target_employee_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    target_date        = Column(Date, nullable=False)
    old_value          = Column(String(200), default="")
    new_value          = Column(String(200), default="")
    reason             = Column(String(500), nullable=False)
    created_at         = Column(DateTime, default=datetime.utcnow)


class KpiEmployeePlan(Base):
    """Ажилтан тус бүрийн сарын KPI дээд хязгаар."""
    __tablename__ = "kpi_employee_plans"
    __table_args__ = (UniqueConstraint("employee_id", "year", "month"),)

    id              = Column(Integer, primary_key=True, index=True)
    employee_id     = Column(Integer, ForeignKey("users.id"), nullable=False)
    year            = Column(Integer, nullable=False)
    month           = Column(Integer, nullable=False)   # 1–12
    daily_kpi_cap   = Column(Float, nullable=False, default=0.0)   # өдөр тутмын ажлын дээд хязгаар
    monthly_max_kpi = Column(Float, nullable=False, default=0.0)   # нийт сарын дээд хязгаар

    # ── Тооллогын үнэлгээ (2026-05-13 нэмсэн) ─────────────────────────────────
    # Сарын тооллогын төсөв — ажилтан max оноо авбал ийм мөнгөн дүн авна.
    # Нэгэн жишээ: 200,000₮; ажилтан 25/25 оноо авбал 200K, 20/25 авбал 160K
    # (proportional). Хуучин үед нэрлэсэн "monthly_max_kpi - daily_kpi_cap"
    # формула орлоно. Хоосон (NULL) үед migration startup-аар хуучин
    # формулаар автоматаар backfill хийгдэнэ.
    monthly_inventory_budget = Column(Float, nullable=True)
    # Тооллогын дутагдал — гар утсаар оруулдаг хасалт. Эцсийн цалин =
    # нийт KPI - inventory_shortage.
    inventory_shortage       = Column(Float, nullable=False, default=0.0)

    created_at      = Column(DateTime, default=datetime.utcnow)
    updated_at      = Column(DateTime, default=datetime.utcnow)


class KpiSettings(Base):
    """KPI системийн singleton тохиргоо. Зөвхөн id=1 row л байх ёстой.

    inventory_default_points — тооллого үүсгэх үед ажилтанд автоматаар
    нэмэгдэх KPI entry-ийн анхдагч оноо (хатуу биш — UI-аас дахин засаж
    болно). Энэ оноо нь шинэ inventory KPI entry бүрд хэрэглэгдэнэ;
    хэдэн оноо аваагүй гэдгийг measured score-той харьцуулна.
    """
    __tablename__ = "kpi_settings"

    id = Column(Integer, primary_key=True, default=1)
    inventory_default_points = Column(Float, nullable=False, default=5.0)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
