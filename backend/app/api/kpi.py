from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import extract
from datetime import datetime, date as date_type, timedelta
from typing import Optional
from pydantic import BaseModel

from app.api.deps import get_db, get_current_user, require_role
from app.models.kpi import (
    KpiTaskGroup, KpiTaskTemplate, KpiEmployeeTaskConfig,
    KpiDailyChecklist, KpiChecklistEntry, KpiAdminDailyTask,
    KpiEmployeePlan, KpiScheduledDay, KpiShiftTransfer, KpiAuditLog,
)
from app.models.user import User

router = APIRouter(prefix="/kpi", tags=["kpi"])


# ── Schemas ─────────────────────────────────────────────────────────────────

class GroupIn(BaseModel):
    name: str
    sort_order: int = 0
    is_active: bool = True


class TemplateIn(BaseModel):
    name: str
    description: str = ""
    monetary_value: float = 0.0
    weight_points: float = 0.0           # daily task-д оноо; inventory-д 0
    task_category: str = "daily"         # "daily" | "inventory"
    group_id: Optional[int] = None
    period: str = "daily"                # daily | weekly | monthly
    day_of_week: Optional[int] = None    # 0=Mon…6=Sun (weekly-д)
    day_of_month: Optional[int] = None   # 1–31 (monthly-д)
    is_active: bool = True


class ConfigIn(BaseModel):
    employee_id: int
    template_id: int
    approver_id: int
    sort_order: int = 0


class ConfigUpdateIn(BaseModel):
    approver_id: Optional[int] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


class CheckIn(BaseModel):
    is_checked: bool


class AdhocIn(BaseModel):
    task_name: str
    monetary_value: float
    approver_id: int


class ApproveIn(BaseModel):
    approval_status: str           # approved | rejected
    approval_note: str = ""
    approved_value: Optional[float] = None   # approver can override monetary value


class AdminTaskIn(BaseModel):
    task_name: str
    monetary_value: float = 0.0
    task_category: str = "daily"   # "daily" | "inventory"
    date: date_type
    approver_id: int
    is_active: bool = True
    target_employee_ids: list[int] = []  # хоосон = бүгдэд


class EmployeePlanIn(BaseModel):
    employee_id: int
    year: int
    month: int
    daily_kpi_cap: float
    monthly_max_kpi: float


class EmployeePlanUpdateIn(BaseModel):
    daily_kpi_cap: Optional[float] = None
    monthly_max_kpi: Optional[float] = None


# ── Serializers ──────────────────────────────────────────────────────────────

def _username(db: Session, user_id: Optional[int]) -> str:
    if not user_id:
        return ""
    u = db.query(User).filter(User.id == user_id).first()
    return u.username if u else ""

def _display_name(db: Session, user_id: Optional[int]) -> str:
    """Nickname байвал nickname, үгүй бол username буцаана."""
    if not user_id:
        return ""
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        return ""
    return (u.nickname.strip() if u.nickname and u.nickname.strip() else u.username)


def _ser_group(g: KpiTaskGroup) -> dict:
    return {
        "id": g.id,
        "name": g.name,
        "sort_order": g.sort_order,
        "is_active": g.is_active,
    }


def _ser_template(t: KpiTaskTemplate, db: Session) -> dict:
    grp = db.query(KpiTaskGroup).filter(KpiTaskGroup.id == t.group_id).first() if t.group_id else None
    return {
        "id": t.id,
        "name": t.name,
        "description": t.description,
        "monetary_value": t.monetary_value,
        "weight_points": t.weight_points or 0.0,
        "task_category": t.task_category or "daily",
        "group_id": t.group_id,
        "group_name": grp.name if grp else None,
        "period": t.period or "daily",
        "day_of_week": t.day_of_week,
        "day_of_month": t.day_of_month,
        "is_active": t.is_active,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }


def _ser_config(c: KpiEmployeeTaskConfig, db: Session) -> dict:
    tpl = db.query(KpiTaskTemplate).filter(KpiTaskTemplate.id == c.template_id).first()
    return {
        "id": c.id,
        "employee_id": c.employee_id,
        "employee_username": _display_name(db, c.employee_id),
        "template_id": c.template_id,
        "template_name": tpl.name if tpl else "",
        "template_monetary_value": tpl.monetary_value if tpl else 0,
        "approver_id": c.approver_id,
        "approver_username": _display_name(db, c.approver_id),
        "is_active": c.is_active,
        "sort_order": c.sort_order,
    }



def _ser_entry(e: KpiChecklistEntry, db: Session) -> dict:
    period = None
    day_of_week = None
    day_of_month = None
    if e.template_id and not e.is_adhoc and not e.admin_task_id:
        tpl = db.query(KpiTaskTemplate).filter(KpiTaskTemplate.id == e.template_id).first()
        if tpl:
            period = tpl.period
            day_of_week = tpl.day_of_week
            day_of_month = tpl.day_of_month
    return {
        "id": e.id,
        "checklist_id": e.checklist_id,
        "template_id": e.template_id,
        "config_id": e.config_id,
        "task_name": e.task_name,
        "monetary_value": e.monetary_value,
        "approver_id": e.approver_id,
        "approver_username": _display_name(db, e.approver_id),
        "is_adhoc": e.is_adhoc,
        "admin_task_id": e.admin_task_id,
        "is_checked": e.is_checked,
        "approval_status": e.approval_status,
        "approval_note": e.approval_note,
        "approved_value": e.approved_value,
        "approved_at": e.approved_at.isoformat() if e.approved_at else None,
        "approved_by_id": e.approved_by_id,
        "approved_by_username": _display_name(db, e.approved_by_id),
        "period": period,           # daily | weekly | monthly | None
        "day_of_week": day_of_week,
        "day_of_month": day_of_month,
        "task_category": e.task_category or "daily",
    }


def _ser_admin_task(t: KpiAdminDailyTask, db: Session) -> dict:
    return {
        "id": t.id,
        "task_name": t.task_name,
        "monetary_value": t.monetary_value,
        "task_category": t.task_category or "daily",
        "date": t.date.isoformat(),
        "approver_id": t.approver_id,
        "approver_username": _display_name(db, t.approver_id),
        "is_active": t.is_active,
        "target_employee_ids": [int(x) for x in (t.target_employee_ids or "").split(",") if x.strip()],
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }


def _ser_checklist(c: KpiDailyChecklist, entries: list, db: Session) -> dict:
    return {
        "id": c.id,
        "employee_id": c.employee_id,
        "employee_username": _display_name(db, c.employee_id),
        "date": c.date.isoformat(),
        "status": c.status,
        "submitted_at": c.submitted_at.isoformat() if c.submitted_at else None,
        "attendance_status": c.attendance_status or "pending",
        "attendance_note": c.attendance_note or "",
        "attendance_approved_by": c.attendance_approved_by,
        "entries": [_ser_entry(e, db) for e in entries],
    }


# ── Task Groups ──────────────────────────────────────────────────────────────

@router.get("/groups")
def list_groups(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    groups = db.query(KpiTaskGroup).order_by(KpiTaskGroup.sort_order, KpiTaskGroup.id).all()
    return [_ser_group(g) for g in groups]


@router.post("/groups")
def create_group(
    body: GroupIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    g = KpiTaskGroup(name=body.name.strip(), sort_order=body.sort_order, is_active=body.is_active)
    db.add(g)
    db.commit()
    db.refresh(g)
    return _ser_group(g)


@router.put("/groups/{group_id}")
def update_group(
    group_id: int,
    body: GroupIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    g = db.query(KpiTaskGroup).filter(KpiTaskGroup.id == group_id).first()
    if not g:
        raise HTTPException(404, "Бүлэг олдсонгүй")
    g.name = body.name.strip()
    g.sort_order = body.sort_order
    g.is_active = body.is_active
    db.commit()
    db.refresh(g)
    return _ser_group(g)


@router.delete("/groups/{group_id}")
def delete_group(
    group_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    g = db.query(KpiTaskGroup).filter(KpiTaskGroup.id == group_id).first()
    if not g:
        raise HTTPException(404, "Бүлэг олдсонгүй")
    refs = db.query(KpiTaskTemplate).filter(KpiTaskTemplate.group_id == group_id).first()
    if refs:
        raise HTTPException(400, "Энэ бүлэгт хамааралтай загвар байна. Эхлээд загваруудыг өөр бүлэгт шилжүүлнэ үү.")
    db.delete(g)
    db.commit()
    return {"ok": True}


# ── Task Templates ───────────────────────────────────────────────────────────

@router.get("/templates")
def list_templates(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    templates = db.query(KpiTaskTemplate).order_by(KpiTaskTemplate.group_id.nullslast(), KpiTaskTemplate.id).all()
    return [_ser_template(t, db) for t in templates]


@router.post("/templates")
def create_template(
    body: TemplateIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    t = KpiTaskTemplate(
        name=body.name.strip(),
        description=body.description.strip(),
        monetary_value=body.monetary_value,
        weight_points=body.weight_points,
        task_category=body.task_category,
        group_id=body.group_id,
        period=body.period,
        day_of_week=body.day_of_week,
        day_of_month=body.day_of_month,
        is_active=body.is_active,
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return _ser_template(t, db)


@router.put("/templates/{template_id}")
def update_template(
    template_id: int,
    body: TemplateIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    t = db.query(KpiTaskTemplate).filter(KpiTaskTemplate.id == template_id).first()
    if not t:
        raise HTTPException(404, "Template олдсонгүй")
    t.name = body.name.strip()
    t.description = body.description.strip()
    t.monetary_value = body.monetary_value
    t.weight_points = body.weight_points
    t.task_category = body.task_category
    t.group_id = body.group_id
    t.period = body.period
    t.day_of_week = body.day_of_week
    t.day_of_month = body.day_of_month
    t.is_active = body.is_active
    db.commit()
    db.refresh(t)
    return _ser_template(t, db)


# ── Employee-Task Configs ────────────────────────────────────────────────────

@router.get("/configs/all")
def list_all_configs(
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    configs = db.query(KpiEmployeeTaskConfig).order_by(
        KpiEmployeeTaskConfig.employee_id, KpiEmployeeTaskConfig.sort_order
    ).all()
    return [_ser_config(c, db) for c in configs]


@router.get("/configs")
def list_configs(
    employee_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    configs = (
        db.query(KpiEmployeeTaskConfig)
        .filter(KpiEmployeeTaskConfig.employee_id == employee_id)
        .order_by(KpiEmployeeTaskConfig.sort_order)
        .all()
    )
    return [_ser_config(c, db) for c in configs]


@router.post("/configs")
def create_config(
    body: ConfigIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    existing = db.query(KpiEmployeeTaskConfig).filter(
        KpiEmployeeTaskConfig.employee_id == body.employee_id,
        KpiEmployeeTaskConfig.template_id == body.template_id,
    ).first()
    if existing:
        raise HTTPException(400, "Энэ ажилтанд тухайн ажил аль хэдийн хуваарилагдсан байна")

    c = KpiEmployeeTaskConfig(
        employee_id=body.employee_id,
        template_id=body.template_id,
        approver_id=body.approver_id,
        sort_order=body.sort_order,
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    return _ser_config(c, db)


@router.put("/configs/{config_id}")
def update_config(
    config_id: int,
    body: ConfigUpdateIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    c = db.query(KpiEmployeeTaskConfig).filter(KpiEmployeeTaskConfig.id == config_id).first()
    if not c:
        raise HTTPException(404, "Config олдсонгүй")
    if body.approver_id is not None:
        c.approver_id = body.approver_id
    if body.sort_order is not None:
        c.sort_order = body.sort_order
    if body.is_active is not None:
        c.is_active = body.is_active
    db.commit()
    db.refresh(c)
    return _ser_config(c, db)


@router.delete("/configs/{config_id}")
def delete_config(
    config_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    c = db.query(KpiEmployeeTaskConfig).filter(KpiEmployeeTaskConfig.id == config_id).first()
    if not c:
        raise HTTPException(404, "Config олдсонгүй")
    db.delete(c)
    db.commit()
    return {"ok": True}


# ── Daily Checklist (Employee) ───────────────────────────────────────────────

@router.get("/my-checklist")
def get_or_create_checklist(
    date: date_type,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    checklist = db.query(KpiDailyChecklist).filter(
        KpiDailyChecklist.employee_id == u.id,
        KpiDailyChecklist.date == date,
    ).first()

    if not checklist:
        # Auto-create empty checklist skeleton
        checklist = KpiDailyChecklist(employee_id=u.id, date=date)
        db.add(checklist)
        db.flush()
        db.commit()
        db.refresh(checklist)

    # ── Inject missing config entries (runs every load, not only on first create) ──
    # Энэ нь Admin ажил хуваарилахаас өмнө нээгдсэн checklist-д ч шинэ config-уудыг нэмдэг.
    if checklist.status == "draft":
        configs = (
            db.query(KpiEmployeeTaskConfig)
            .filter(
                KpiEmployeeTaskConfig.employee_id == u.id,
                KpiEmployeeTaskConfig.is_active == True,
            )
            .order_by(KpiEmployeeTaskConfig.sort_order)
            .all()
        )
        # Тухайн checklist-д аль хэдийн байгаа config_id-уудыг цуглуулна (давхардал хориглоно)
        existing_cfg_ids = {
            e.config_id
            for e in db.query(KpiChecklistEntry).filter(
                KpiChecklistEntry.checklist_id == checklist.id,
                KpiChecklistEntry.config_id.isnot(None),
            ).all()
        }
        cfg_needs_commit = False
        for cfg in configs:
            if cfg.id in existing_cfg_ids:
                continue   # аль хэдийн байгаа → алгасна

            tpl = db.query(KpiTaskTemplate).filter(KpiTaskTemplate.id == cfg.template_id).first()
            if not tpl or not tpl.is_active:
                continue

            period = tpl.period or "daily"

            if period == "weekly":
                # day_of_week тодорхойлогдсон бол тухайн гаригаас өмнөх өдөр нээхэд харагдахгүй
                if tpl.day_of_week is not None and date.weekday() < tpl.day_of_week:
                    continue
                # Тухайн ISO долоо хоногт (Даваа–Ням) config_id-р entry аль хэдийн байвал алгасна
                week_start = date - timedelta(days=date.weekday())
                week_end   = week_start + timedelta(days=6)
                already = (
                    db.query(KpiChecklistEntry)
                    .join(KpiDailyChecklist, KpiDailyChecklist.id == KpiChecklistEntry.checklist_id)
                    .filter(
                        KpiDailyChecklist.employee_id == u.id,
                        KpiDailyChecklist.date >= week_start,
                        KpiDailyChecklist.date <= week_end,
                        KpiChecklistEntry.config_id == cfg.id,
                    )
                    .first()
                )
                if already:
                    continue

            elif period == "monthly":
                # day_of_month тодорхойлогдсон бол тухайн өдрөөс өмнө харагдахгүй
                if tpl.day_of_month is not None and date.day < tpl.day_of_month:
                    continue
                # Тухайн он/сард config_id-р entry аль хэдийн байвал алгасна
                already = (
                    db.query(KpiChecklistEntry)
                    .join(KpiDailyChecklist, KpiDailyChecklist.id == KpiChecklistEntry.checklist_id)
                    .filter(
                        KpiDailyChecklist.employee_id == u.id,
                        extract("year",  KpiDailyChecklist.date) == date.year,
                        extract("month", KpiDailyChecklist.date) == date.month,
                        KpiChecklistEntry.config_id == cfg.id,
                    )
                    .first()
                )
                if already:
                    continue

            db.add(KpiChecklistEntry(
                checklist_id=checklist.id,
                template_id=cfg.template_id,
                config_id=cfg.id,
                task_name=tpl.name,
                # daily task: monetary_value-д weight_points хадгална (scoring-д ашиглана)
                # inventory task: monetary_value-д шууд мөнгөн дүн
                monetary_value=tpl.weight_points if (tpl.task_category or "daily") == "daily" else tpl.monetary_value,
                task_category=tpl.task_category or "daily",
                approver_id=cfg.approver_id,
            ))
            cfg_needs_commit = True

        if cfg_needs_commit:
            db.commit()

    # ── Inject any active admin broadcast tasks for this date not yet in the checklist ──
    admin_tasks = (
        db.query(KpiAdminDailyTask)
        .filter(
            KpiAdminDailyTask.date == date,
            KpiAdminDailyTask.is_active == True,
        )
        .all()
    )
    existing_admin_ids = {
        e.admin_task_id
        for e in db.query(KpiChecklistEntry).filter(
            KpiChecklistEntry.checklist_id == checklist.id,
            KpiChecklistEntry.admin_task_id != None,
        ).all()
    }
    needs_commit = False
    for at in admin_tasks:
        if at.id not in existing_admin_ids:
            # target_employee_ids шалгах — хоосон бол бүгдэд, байвал зөвхөн тэдэнд
            target_ids = [int(x) for x in (at.target_employee_ids or "").split(",") if x.strip()]
            if target_ids and u.id not in target_ids:
                continue  # Энэ ажилтанд зориулагдаагүй
            db.add(KpiChecklistEntry(
                checklist_id=checklist.id,
                task_name=at.task_name,
                monetary_value=at.monetary_value,
                task_category=at.task_category or "daily",
                approver_id=at.approver_id,
                is_adhoc=False,
                admin_task_id=at.id,
            ))
            needs_commit = True
    if needs_commit:
        db.commit()

    entries = (
        db.query(KpiChecklistEntry)
        .filter(KpiChecklistEntry.checklist_id == checklist.id)
        .all()
    )
    return _ser_checklist(checklist, entries, db)


@router.patch("/entries/{entry_id}/check")
def toggle_entry(
    entry_id: int,
    body: CheckIn,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    entry = db.query(KpiChecklistEntry).filter(KpiChecklistEntry.id == entry_id).first()
    if not entry:
        raise HTTPException(404, "Entry олдсонгүй")

    checklist = db.query(KpiDailyChecklist).filter(KpiDailyChecklist.id == entry.checklist_id).first()
    if not checklist or checklist.employee_id != u.id:
        raise HTTPException(403, "Зөвшөөрөл байхгүй")
    if checklist.status == "submitted":
        raise HTTPException(400, "Илгээсэн checklist-ийг засах боломжгүй")
    from datetime import date as _dt
    if checklist.date > _dt.today():
        raise HTTPException(400, "Ирээдүйн өдрийн даалгавар check хийх боломжгүй")
    # Ээлж шилжүүлсэн бол check хийх боломжгүй (pending/approved)
    shift_out = db.query(KpiShiftTransfer).filter(
        KpiShiftTransfer.original_employee_id == u.id,
        KpiShiftTransfer.date == checklist.date,
        KpiShiftTransfer.status.in_(["pending", "approved"]),
    ).first()
    if shift_out:
        raise HTTPException(400, "Ээлж шилжүүлсэн өдрийн даалгавар check хийх боломжгүй")

    entry.is_checked = body.is_checked
    db.commit()
    return _ser_entry(entry, db)


@router.post("/checklists/{checklist_id}/submit")
def submit_checklist(
    checklist_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    checklist = db.query(KpiDailyChecklist).filter(KpiDailyChecklist.id == checklist_id).first()
    if not checklist:
        raise HTTPException(404, "Checklist олдсонгүй")
    if checklist.employee_id != u.id:
        raise HTTPException(403, "Зөвшөөрөл байхгүй")
    if checklist.status == "submitted":
        raise HTTPException(400, "Аль хэдийн илгээсэн байна")
    from datetime import date as _dt
    if checklist.date > _dt.today():
        raise HTTPException(400, "Ирээдүйн өдрийн чеклист илгээх боломжгүй")
    # Ээлж шилжүүлсэн бол submit боломжгүй
    shift_out = db.query(KpiShiftTransfer).filter(
        KpiShiftTransfer.original_employee_id == u.id,
        KpiShiftTransfer.date == checklist.date,
        KpiShiftTransfer.status.in_(["pending", "approved"]),
    ).first()
    if shift_out:
        raise HTTPException(400, "Ээлж шилжүүлсэн өдрийн чеклист илгээх боломжгүй")

    checklist.status = "submitted"
    checklist.submitted_at = datetime.utcnow()
    db.commit()
    entries = db.query(KpiChecklistEntry).filter(KpiChecklistEntry.checklist_id == checklist.id).all()
    return _ser_checklist(checklist, entries, db)


@router.post("/checklists/{checklist_id}/adhoc")
def add_adhoc_entry(
    checklist_id: int,
    body: AdhocIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor")),
):
    checklist = db.query(KpiDailyChecklist).filter(KpiDailyChecklist.id == checklist_id).first()
    if not checklist:
        raise HTTPException(404, "Checklist олдсонгүй")

    approver = db.query(User).filter(User.id == body.approver_id).first()
    if not approver:
        raise HTTPException(404, "Зөвшөөрөгч хэрэглэгч олдсонгүй")

    entry = KpiChecklistEntry(
        checklist_id=checklist.id,
        task_name=body.task_name.strip(),
        monetary_value=body.monetary_value,
        approver_id=body.approver_id,
        is_adhoc=True,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return _ser_entry(entry, db)


# ── Approvals ────────────────────────────────────────────────────────────────

@router.get("/pending-approvals")
def pending_approvals(
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    entries = (
        db.query(KpiChecklistEntry)
        .join(KpiDailyChecklist, KpiDailyChecklist.id == KpiChecklistEntry.checklist_id)
        .filter(
            KpiChecklistEntry.approver_id == u.id,
            KpiChecklistEntry.approval_status == "pending",
            KpiDailyChecklist.status == "submitted",
        )
        .order_by(KpiDailyChecklist.date.desc(), KpiDailyChecklist.employee_id)
        .all()
    )

    # Group by employee + date
    groups: dict = {}
    for e in entries:
        cl = db.query(KpiDailyChecklist).filter(KpiDailyChecklist.id == e.checklist_id).first()
        key = (cl.employee_id, cl.date.isoformat())
        if key not in groups:
            groups[key] = {
                "employee_id": cl.employee_id,
                "employee_username": _display_name(db, cl.employee_id),
                "checklist_id": cl.id,
                "date": cl.date.isoformat(),
                "entries": [],
            }
        groups[key]["entries"].append(_ser_entry(e, db))

    return list(groups.values())


@router.get("/approval-history")
def approval_history(
    date_from: date_type,
    date_to: date_type,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """
    Тухайн зөвшөөрөгчийн өгсөн зөвшөөрлийн түүх (approved | rejected).
    date_from, date_to огноогоор шүүнэ.
    """
    entries = (
        db.query(KpiChecklistEntry)
        .join(KpiDailyChecklist, KpiDailyChecklist.id == KpiChecklistEntry.checklist_id)
        .filter(
            KpiChecklistEntry.approver_id == u.id,
            KpiChecklistEntry.approval_status.in_(["approved", "rejected"]),
            KpiDailyChecklist.date >= date_from,
            KpiDailyChecklist.date <= date_to,
        )
        .order_by(KpiDailyChecklist.date.desc(), KpiDailyChecklist.employee_id)
        .all()
    )

    groups: dict = {}
    for e in entries:
        cl = db.query(KpiDailyChecklist).filter(KpiDailyChecklist.id == e.checklist_id).first()
        key = (cl.employee_id, cl.date.isoformat())
        if key not in groups:
            groups[key] = {
                "employee_id": cl.employee_id,
                "employee_username": _display_name(db, cl.employee_id),
                "checklist_id": cl.id,
                "date": cl.date.isoformat(),
                "entries": [],
            }
        groups[key]["entries"].append(_ser_entry(e, db))

    return list(groups.values())


@router.patch("/entries/{entry_id}/approve")
def approve_entry(
    entry_id: int,
    body: ApproveIn,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    if body.approval_status not in ("approved", "rejected"):
        raise HTTPException(400, "approval_status буруу байна (approved | rejected)")

    entry = db.query(KpiChecklistEntry).filter(KpiChecklistEntry.id == entry_id).first()
    if not entry:
        raise HTTPException(404, "Entry олдсонгүй")

    # Only designated approver or admin can approve
    if entry.approver_id != u.id and u.role != "admin":
        raise HTTPException(403, "Та энэ ажлыг баталгаажуулах эрхгүй")

    checklist = db.query(KpiDailyChecklist).filter(KpiDailyChecklist.id == entry.checklist_id).first()
    if not checklist or checklist.status != "submitted":
        raise HTTPException(400, "Checklist илгээгдээгүй байна")

    entry.approval_status = body.approval_status
    entry.approval_note = body.approval_note.strip()
    # Store approved_value: use override if provided, else original monetary_value
    if body.approved_value is not None:
        entry.approved_value = body.approved_value
    else:
        entry.approved_value = entry.monetary_value
    entry.approved_at = datetime.utcnow()
    entry.approved_by_id = u.id
    db.commit()
    return _ser_entry(entry, db)


# ── Admin Broadcast Daily Tasks ──────────────────────────────────────────────

@router.get("/admin-tasks")
def list_admin_tasks(
    date: Optional[date_type] = None,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    q = db.query(KpiAdminDailyTask)
    if date:
        q = q.filter(KpiAdminDailyTask.date == date)
    tasks = q.order_by(KpiAdminDailyTask.date.desc(), KpiAdminDailyTask.id).all()
    return [_ser_admin_task(t, db) for t in tasks]


@router.post("/admin-tasks")
def create_admin_task(
    body: AdminTaskIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    approver = db.query(User).filter(User.id == body.approver_id).first()
    if not approver:
        raise HTTPException(404, "Зөвшөөрөгч хэрэглэгч олдсонгүй")
    target_ids_str = ",".join(str(x) for x in body.target_employee_ids) if body.target_employee_ids else ""
    t = KpiAdminDailyTask(
        task_name=body.task_name.strip(),
        monetary_value=body.monetary_value,
        task_category=body.task_category,
        date=body.date,
        approver_id=body.approver_id,
        created_by=u.id,
        is_active=body.is_active,
        target_employee_ids=target_ids_str,
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return _ser_admin_task(t, db)


@router.put("/admin-tasks/{task_id}")
def update_admin_task(
    task_id: int,
    body: AdminTaskIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    t = db.query(KpiAdminDailyTask).filter(KpiAdminDailyTask.id == task_id).first()
    if not t:
        raise HTTPException(404, "Ажил олдсонгүй")
    approver = db.query(User).filter(User.id == body.approver_id).first()
    if not approver:
        raise HTTPException(404, "Зөвшөөрөгч хэрэглэгч олдсонгүй")
    t.task_name = body.task_name.strip()
    t.monetary_value = body.monetary_value
    t.task_category = body.task_category
    t.date = body.date
    t.approver_id = body.approver_id
    t.is_active = body.is_active
    t.target_employee_ids = ",".join(str(x) for x in body.target_employee_ids) if body.target_employee_ids else ""
    db.commit()
    db.refresh(t)
    return _ser_admin_task(t, db)


@router.delete("/admin-tasks/{task_id}")
def delete_admin_task(
    task_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    t = db.query(KpiAdminDailyTask).filter(KpiAdminDailyTask.id == task_id).first()
    if not t:
        raise HTTPException(404, "Ажил олдсонгүй")
    # Guard: if entries reference this task, deactivate instead of hard delete
    refs = db.query(KpiChecklistEntry).filter(KpiChecklistEntry.admin_task_id == task_id).first()
    if refs:
        t.is_active = False
        db.commit()
        return {"ok": True, "deactivated": True}
    db.delete(t)
    db.commit()
    return {"ok": True, "deactivated": False}


# ── KPI Employee Plans ───────────────────────────────────────────────────────

def _ser_plan(p: KpiEmployeePlan, db: Session) -> dict:
    return {
        "id": p.id,
        "employee_id": p.employee_id,
        "employee_username": _display_name(db, p.employee_id),
        "year": p.year,
        "month": p.month,
        "daily_kpi_cap": p.daily_kpi_cap,
        "monthly_max_kpi": p.monthly_max_kpi,
    }


@router.get("/employee-plans")
def list_employee_plans(
    year: int,
    month: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    plans = db.query(KpiEmployeePlan).filter(
        KpiEmployeePlan.year == year,
        KpiEmployeePlan.month == month,
    ).all()
    return [_ser_plan(p, db) for p in plans]


@router.post("/employee-plans")
def upsert_employee_plan(
    body: EmployeePlanIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    """Байгаа бол шинэчилнэ, байхгүй бол үүсгэнэ (upsert)."""
    plan = db.query(KpiEmployeePlan).filter(
        KpiEmployeePlan.employee_id == body.employee_id,
        KpiEmployeePlan.year == body.year,
        KpiEmployeePlan.month == body.month,
    ).first()
    if plan:
        plan.daily_kpi_cap = body.daily_kpi_cap
        plan.monthly_max_kpi = body.monthly_max_kpi
        plan.updated_at = datetime.utcnow()
    else:
        plan = KpiEmployeePlan(
            employee_id=body.employee_id,
            year=body.year,
            month=body.month,
            daily_kpi_cap=body.daily_kpi_cap,
            monthly_max_kpi=body.monthly_max_kpi,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add(plan)
    db.commit()
    db.refresh(plan)
    return _ser_plan(plan, db)


@router.post("/employee-plans/bulk")
def bulk_upsert_plans(
    plans: list[EmployeePlanIn],
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    """Олон ажилтны планыг нэг дор хадгалах."""
    result = []
    for body in plans:
        plan = db.query(KpiEmployeePlan).filter(
            KpiEmployeePlan.employee_id == body.employee_id,
            KpiEmployeePlan.year == body.year,
            KpiEmployeePlan.month == body.month,
        ).first()
        if plan:
            plan.daily_kpi_cap = body.daily_kpi_cap
            plan.monthly_max_kpi = body.monthly_max_kpi
            plan.updated_at = datetime.utcnow()
        else:
            plan = KpiEmployeePlan(
                employee_id=body.employee_id,
                year=body.year,
                month=body.month,
                daily_kpi_cap=body.daily_kpi_cap,
                monthly_max_kpi=body.monthly_max_kpi,
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            )
            db.add(plan)
        result.append(plan)
    db.commit()
    return [_ser_plan(p, db) for p in result]


# ── Salary Report (Admin) ────────────────────────────────────────────────────

def _calc_kpi_for_employee(employee_id: int, year: int, month: int, db: Session) -> dict:
    """
    Нэг ажилтны сарын KPI тооцоо:
      daily_payout  = daily_kpi_cap × (approved_points / total_points)
      inventory_payout = sum(approved_value of inventory entries)
      total_kpi     = min(daily_payout + inventory_payout, monthly_max_kpi)
    """
    from datetime import date as dt, timedelta
    month_start = dt(year, month, 1)
    if month == 12:
        month_end = dt(year + 1, 1, 1) - timedelta(days=1)
    else:
        month_end = dt(year, month + 1, 1) - timedelta(days=1)

    entries = (
        db.query(KpiChecklistEntry)
        .join(KpiDailyChecklist, KpiDailyChecklist.id == KpiChecklistEntry.checklist_id)
        .filter(
            KpiDailyChecklist.employee_id == employee_id,
            KpiDailyChecklist.date >= month_start,
            KpiDailyChecklist.date <= month_end,
        )
        .all()
    )

    # Daily entries scoring
    daily_entries = [e for e in entries if (e.task_category or "daily") == "daily"]
    total_possible  = sum(e.monetary_value for e in daily_entries)
    total_approved_pts = sum(
        (e.approved_value if e.approved_value is not None else e.monetary_value)
        for e in daily_entries if e.approval_status == "approved"
    )
    daily_score = (total_approved_pts / total_possible) if total_possible > 0 else 0.0

    # Inventory (тооллого) entries — оноогоор тооцоолно
    inv_entries = [e for e in entries if (e.task_category or "daily") == "inventory"]
    inv_total_pts = sum(e.monetary_value for e in inv_entries)
    inv_approved_pts = sum(
        (e.approved_value if e.approved_value is not None else e.monetary_value)
        for e in inv_entries if e.approval_status == "approved"
    )

    # Extra (нэмэлт ажил) entries — шууд мөнгөн дүнгээр
    extra_entries = [e for e in entries if (e.task_category or "daily") == "extra"]
    extra_payout = sum(
        (e.approved_value if e.approved_value is not None else e.monetary_value)
        for e in extra_entries if e.approval_status == "approved"
    )

    # Plan caps
    plan = db.query(KpiEmployeePlan).filter(
        KpiEmployeePlan.employee_id == employee_id,
        KpiEmployeePlan.year == year,
        KpiEmployeePlan.month == month,
    ).first()

    daily_kpi_cap   = plan.daily_kpi_cap if plan else 0.0
    monthly_max_kpi = plan.monthly_max_kpi if plan else 0.0

    daily_payout = daily_kpi_cap * daily_score

    # Тооллогоны дүн = (max - cap) * (approved_pts / total_pts)
    inventory_budget = max(0.0, monthly_max_kpi - daily_kpi_cap)
    inv_score = (inv_approved_pts / inv_total_pts) if inv_total_pts > 0 else 0.0
    inventory_payout = inventory_budget * inv_score

    raw_total    = daily_payout + inventory_payout + extra_payout
    total_kpi    = (min(raw_total - extra_payout, monthly_max_kpi) + extra_payout) if monthly_max_kpi > 0 else raw_total

    # Pending / rejected stats
    pending_pts  = sum(e.monetary_value for e in daily_entries if e.approval_status == "pending")
    rejected_pts = sum(e.monetary_value for e in daily_entries if e.approval_status == "rejected")

    # ── Ажиллах ёстой өдрүүд (хуваарь) ────────────────────────────────────
    scheduled_days = (
        db.query(KpiScheduledDay)
        .filter(
            KpiScheduledDay.employee_id == employee_id,
            KpiScheduledDay.date >= month_start,
            KpiScheduledDay.date <= month_end,
        )
        .count()
    )
    # Бодит ажилласан өдрүүд (checklist илгээсэн)
    worked_days = (
        db.query(KpiDailyChecklist)
        .filter(
            KpiDailyChecklist.employee_id == employee_id,
            KpiDailyChecklist.date >= month_start,
            KpiDailyChecklist.date <= month_end,
        )
        .count()
    )

    # Хасагдсан дүн = daily_kpi_cap - daily_payout (зөвхөн daily-д)
    daily_deducted = round(daily_kpi_cap - daily_payout) if daily_kpi_cap > 0 else 0

    # ── Ээлж нөхсөн нэмэгдэл ──────────────────────────────────────────────
    # Тухайн ажилтан бусдын ээлж авсан (replacement) батлагдсан тоо
    shift_received = (
        db.query(KpiShiftTransfer)
        .filter(
            KpiShiftTransfer.replacement_employee_id == employee_id,
            KpiShiftTransfer.date >= month_start,
            KpiShiftTransfer.date <= month_end,
            KpiShiftTransfer.status == "approved",
        )
        .all()
    )
    shift_cover_days = len(shift_received)
    # Нэмэгдэл = daily_kpi_cap / scheduled_days * shift_cover_days
    shift_bonus = round((daily_kpi_cap / scheduled_days) * shift_cover_days) if scheduled_days > 0 and shift_cover_days > 0 else 0
    total_kpi = total_kpi + shift_bonus

    return {
        "employee_id": employee_id,
        "employee_username": _display_name(db, employee_id),
        "daily_score_pct": round(daily_score * 100, 1),
        "daily_payout": round(daily_payout),
        "inventory_payout": round(inventory_payout),
        "total_kpi": round(total_kpi),
        "daily_kpi_cap": daily_kpi_cap,
        "monthly_max_kpi": monthly_max_kpi,
        "plan_exists": plan is not None,
        # Дэлгэрэнгүй оноо
        "total_possible_pts": round(total_possible),       # Нийт цуглуулах оноо
        "total_approved_pts": round(total_approved_pts),    # Авсан оноо
        "total_rejected_pts": round(rejected_pts),          # Татгалзсан оноо
        "total_pending_pts": round(pending_pts),            # Хүлээгдэж буй оноо
        # Ажлын өдрүүд
        "scheduled_days": scheduled_days,                   # Ажиллах ёстой
        "worked_days": worked_days,                         # Бодит ажилласан
        # Тооллого дэлгэрэнгүй
        "inventory_total_pts": round(inv_total_pts),        # Тооллогоны нийт оноо
        "inventory_approved_pts": round(inv_approved_pts),  # Тооллогоны авсан оноо
        "inventory_budget": round(inventory_budget),        # Тооллогоос авах max дүн
        # Нэмэлт ажил (шууд ₮)
        "extra_payout": round(extra_payout),                # Нэмэлт ажлын дүн (₮)
        # Ээлж нөхсөн нэмэгдэл
        "shift_cover_days": shift_cover_days,               # Ээлж нөхсөн өдөр
        "shift_bonus": shift_bonus,                         # Нэмэгдэл дүн (₮)
        # Хасалт
        "daily_deducted": daily_deducted,                   # Хасагдсан дүн (₮)
        # Legacy fields (backward compat)
        "total_approved": round(total_kpi),
        "total_pending": pending_pts,
        "total_rejected": rejected_pts,
        "entries_approved": sum(1 for e in daily_entries if e.approval_status == "approved"),
    }


@router.get("/salary-report")
def salary_report(
    year: int,
    month: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    # Тухайн сард checklist-тэй ажилтнуудыг олно
    from datetime import date as dt, timedelta
    month_start = dt(year, month, 1)
    if month == 12:
        month_end = dt(year + 1, 1, 1) - timedelta(days=1)
    else:
        month_end = dt(year, month + 1, 1) - timedelta(days=1)

    employee_ids = [
        row[0] for row in
        db.query(KpiDailyChecklist.employee_id)
        .filter(KpiDailyChecklist.date >= month_start, KpiDailyChecklist.date <= month_end)
        .distinct()
        .all()
    ]
    result = [_calc_kpi_for_employee(eid, year, month, db) for eid in employee_ids]
    return sorted(result, key=lambda x: x["employee_username"])


@router.get("/salary-report/detail")
def salary_report_detail(
    employee_id: int,
    year: int,
    month: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    from datetime import date as dt, timedelta
    month_start = dt(year, month, 1)
    if month == 12:
        month_end = dt(year + 1, 1, 1) - timedelta(days=1)
    else:
        month_end = dt(year, month + 1, 1) - timedelta(days=1)

    checklists = (
        db.query(KpiDailyChecklist)
        .filter(
            KpiDailyChecklist.employee_id == employee_id,
            KpiDailyChecklist.date >= month_start,
            KpiDailyChecklist.date <= month_end,
        )
        .order_by(KpiDailyChecklist.date)
        .all()
    )
    result = []
    for cl in checklists:
        entries = db.query(KpiChecklistEntry).filter(KpiChecklistEntry.checklist_id == cl.id).all()
        result.append(_ser_checklist(cl, entries, db))
    # Include KPI summary at the end
    kpi_summary = _calc_kpi_for_employee(employee_id, year, month, db)
    return {"checklists": result, "kpi_summary": kpi_summary}


# ── Attendance (Ирц) schemas ──────────────────────────────────────────────────

class AttendanceApproveIn(BaseModel):
    attendance_status: str   # "approved" | "rejected"
    attendance_note: str = ""


class AttendanceAdminOverrideIn(BaseModel):
    attendance_status: str   # "approved" | "rejected" | "pending"
    reason: str              # REQUIRED: тайлбар заавал


class ScheduledDaysBulkIn(BaseModel):
    employee_id: int
    dates: list[str]         # ISO date strings: ["2026-03-01", ...]


class ShiftTransferIn(BaseModel):
    date: date_type
    replacement_employee_id: int
    approver_id: int
    note: str = ""


class ShiftTransferRespondIn(BaseModel):
    status: str              # "approved" | "rejected"
    response_note: str = ""


# ── Schedule (Хуваарь) endpoints ──────────────────────────────────────────────

def _ser_scheduled_day(s: KpiScheduledDay) -> dict:
    return {
        "id": s.id,
        "employee_id": s.employee_id,
        "date": s.date.isoformat(),
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


@router.get("/my-schedule")
def get_my_schedule(
    year: int,
    month: int,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Өөрийн тухайн сарын хуваарийн өдрүүд."""
    from datetime import date as dt
    month_start = dt(year, month, 1)
    if month == 12:
        month_end = dt(year + 1, 1, 1) - timedelta(days=1)
    else:
        month_end = dt(year, month + 1, 1) - timedelta(days=1)

    rows = (
        db.query(KpiScheduledDay)
        .filter(
            KpiScheduledDay.employee_id == u.id,
            KpiScheduledDay.date >= month_start,
            KpiScheduledDay.date <= month_end,
        )
        .order_by(KpiScheduledDay.date)
        .all()
    )
    return [s.date.isoformat() for s in rows]


@router.get("/schedule")
def get_schedule(
    employee_id: int,
    year: int,
    month: int,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Ажилтны тухайн сарын хуваарийн өдрүүд."""
    from datetime import date as dt
    month_start = dt(year, month, 1)
    if month == 12:
        month_end = dt(year + 1, 1, 1) - timedelta(days=1)
    else:
        month_end = dt(year, month + 1, 1) - timedelta(days=1)

    rows = (
        db.query(KpiScheduledDay)
        .filter(
            KpiScheduledDay.employee_id == employee_id,
            KpiScheduledDay.date >= month_start,
            KpiScheduledDay.date <= month_end,
        )
        .order_by(KpiScheduledDay.date)
        .all()
    )
    return [s.date.isoformat() for s in rows]


@router.post("/schedule/bulk")
def set_schedule_bulk(
    body: ScheduledDaysBulkIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    """Ажилтны ажиллах өдрүүдийг бүхэлд нь тохируулах.
    Тухайн сарын хуучин хуваарийг арилгаад body.dates-р солино."""
    from datetime import date as dt
    parsed = []
    for d in body.dates:
        try:
            parsed.append(dt.fromisoformat(d))
        except ValueError:
            raise HTTPException(400, f"Огноо буруу формат: {d}")

    if not parsed:
        # Empty list = clear all scheduled days for the given month
        # We need month context — take it from the first deletion
        raise HTTPException(400, "dates хоосон байж болохгүй. Устгахдаа /schedule/clear ашиглана уу.")

    year  = parsed[0].year
    month = parsed[0].month
    month_start = dt(year, month, 1)
    if month == 12:
        month_end = dt(year + 1, 1, 1) - timedelta(days=1)
    else:
        month_end = dt(year, month + 1, 1) - timedelta(days=1)

    # Delete current month schedule for employee
    db.query(KpiScheduledDay).filter(
        KpiScheduledDay.employee_id == body.employee_id,
        KpiScheduledDay.date >= month_start,
        KpiScheduledDay.date <= month_end,
    ).delete()

    for d in parsed:
        s = KpiScheduledDay(
            employee_id=body.employee_id,
            date=d,
            created_by=u.id,
            created_at=datetime.utcnow(),
        )
        db.add(s)
    db.commit()
    return {"ok": True, "count": len(parsed)}


@router.delete("/schedule/clear")
def clear_schedule(
    employee_id: int,
    year: int,
    month: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    """Ажилтны тухайн сарын бүх хуваарийг устгана."""
    from datetime import date as dt
    month_start = dt(year, month, 1)
    if month == 12:
        month_end = dt(year + 1, 1, 1) - timedelta(days=1)
    else:
        month_end = dt(year, month + 1, 1) - timedelta(days=1)

    deleted = db.query(KpiScheduledDay).filter(
        KpiScheduledDay.employee_id == employee_id,
        KpiScheduledDay.date >= month_start,
        KpiScheduledDay.date <= month_end,
    ).delete()
    db.commit()
    return {"ok": True, "deleted": deleted}


# ── Attendance approval (Ирц батлах) endpoints ───────────────────────────────

def _ser_checklist_with_attendance(c: KpiDailyChecklist, db: Session) -> dict:
    return {
        "id": c.id,
        "employee_id": c.employee_id,
        "employee_username": _display_name(db, c.employee_id),
        "date": c.date.isoformat(),
        "status": c.status,
        "attendance_status": c.attendance_status or "pending",
        "attendance_note": c.attendance_note or "",
        "attendance_approved_by": c.attendance_approved_by,
        "attendance_approved_by_name": _display_name(db, c.attendance_approved_by),
        "attendance_approved_at": c.attendance_approved_at.isoformat() if c.attendance_approved_at else None,
        "submitted_at": c.submitted_at.isoformat() if c.submitted_at else None,
    }


@router.get("/pending-attendance")
def list_pending_attendance(
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Ирц батлагдаагүй checklist-үүдийг буцаана (approver болон admin-д)."""
    q = db.query(KpiDailyChecklist).filter(
        KpiDailyChecklist.status == "submitted",
        KpiDailyChecklist.attendance_status == "pending",
    )
    # Non-admin users see only their assigned employees' checklists
    if u.role != "admin":
        # Find employee IDs where this user is approver
        config_employee_ids = [
            c.employee_id for c in
            db.query(KpiEmployeeTaskConfig).filter(
                KpiEmployeeTaskConfig.approver_id == u.id,
                KpiEmployeeTaskConfig.is_active == True,
            ).all()
        ]
        q = q.filter(KpiDailyChecklist.employee_id.in_(config_employee_ids))
    checklists = q.order_by(KpiDailyChecklist.date.desc()).all()
    return [_ser_checklist_with_attendance(c, db) for c in checklists]


@router.patch("/checklists/{checklist_id}/attendance")
def approve_attendance(
    checklist_id: int,
    body: AttendanceApproveIn,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Checklist-ийн ирцийг батлах/цуцлах."""
    if body.attendance_status not in ("approved", "rejected"):
        raise HTTPException(400, "attendance_status буруу: 'approved' | 'rejected'")

    cl = db.query(KpiDailyChecklist).filter(KpiDailyChecklist.id == checklist_id).first()
    if not cl:
        raise HTTPException(404, "Checklist олдсонгүй")
    if cl.status != "submitted":
        raise HTTPException(400, "Илгээгдээгүй checklist-ийн ирцийг батлах боломжгүй")

    # Permission: admin or designated approver for that employee
    if u.role != "admin":
        has_config = db.query(KpiEmployeeTaskConfig).filter(
            KpiEmployeeTaskConfig.employee_id == cl.employee_id,
            KpiEmployeeTaskConfig.approver_id == u.id,
            KpiEmployeeTaskConfig.is_active == True,
        ).first()
        if not has_config:
            raise HTTPException(403, "Та энэ ажилтны ирцийг батлах эрхгүй")

    old_status = cl.attendance_status or "pending"
    cl.attendance_status = body.attendance_status
    cl.attendance_note = body.attendance_note.strip()
    cl.attendance_approved_by = u.id
    cl.attendance_approved_at = datetime.utcnow()

    # If rejected → set all entries' approval_status to rejected (score = 0)
    if body.attendance_status == "rejected":
        entries = db.query(KpiChecklistEntry).filter(
            KpiChecklistEntry.checklist_id == checklist_id
        ).all()
        for e in entries:
            if e.approval_status == "pending":
                e.approval_status = "rejected"
                e.approval_note = "Ирц хүчингүй болсон тул автоматаар татгалзав"
                e.approved_value = 0.0
                e.approved_at = datetime.utcnow()
                e.approved_by_id = u.id

    db.commit()
    return _ser_checklist_with_attendance(cl, db)


@router.patch("/checklists/{checklist_id}/attendance/admin-override")
def admin_override_attendance(
    checklist_id: int,
    body: AttendanceAdminOverrideIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    """Admin аливаа хүний аливаа өдрийн ирцийг засаж болно — ТАЙЛБАР заавал."""
    if not body.reason.strip():
        raise HTTPException(400, "Тайлбар (reason) заавал оруулна")

    cl = db.query(KpiDailyChecklist).filter(KpiDailyChecklist.id == checklist_id).first()
    if not cl:
        raise HTTPException(404, "Checklist олдсонгүй")

    old_value = cl.attendance_status or "pending"
    cl.attendance_status = body.attendance_status
    cl.attendance_note = f"[Admin: {body.reason.strip()}]"
    cl.attendance_approved_by = u.id
    cl.attendance_approved_at = datetime.utcnow()

    # If rejected → entries score 0
    if body.attendance_status == "rejected":
        entries = db.query(KpiChecklistEntry).filter(
            KpiChecklistEntry.checklist_id == checklist_id
        ).all()
        for e in entries:
            e.approval_status = "rejected"
            e.approval_note = f"Admin ирц хүчингүй: {body.reason.strip()}"
            e.approved_value = 0.0
            e.approved_at = datetime.utcnow()
            e.approved_by_id = u.id

    # Audit log
    log = KpiAuditLog(
        admin_id=u.id,
        action="attendance_override",
        target_employee_id=cl.employee_id,
        target_date=cl.date,
        old_value=old_value,
        new_value=body.attendance_status,
        reason=body.reason.strip(),
        created_at=datetime.utcnow(),
    )
    db.add(log)
    db.commit()
    return _ser_checklist_with_attendance(cl, db)


# ── Shift Transfer (Ээлж шилжүүлэх) endpoints ────────────────────────────────

def _ser_shift_transfer(t: KpiShiftTransfer, db: Session) -> dict:
    return {
        "id": t.id,
        "date": t.date.isoformat(),
        "original_employee_id": t.original_employee_id,
        "original_employee_name": _display_name(db, t.original_employee_id),
        "replacement_employee_id": t.replacement_employee_id,
        "replacement_employee_name": _display_name(db, t.replacement_employee_id),
        "approver_id": t.approver_id,
        "approver_name": _display_name(db, t.approver_id),
        "status": t.status,
        "note": t.note or "",
        "response_note": t.response_note or "",
        "responded_at": t.responded_at.isoformat() if t.responded_at else None,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }


@router.get("/employees")
def list_employees_for_kpi(
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Нэвтэрсэн хэн ч хэрэглэгчдийн жагсаалт авах (ээлж шилжүүлэх, орлох ажилтан сонгох)."""
    rows = db.query(User).filter(User.is_active == True).order_by(User.id.asc()).all()
    return [
        {"id": r.id, "username": r.username, "nickname": r.nickname or "", "role": r.role}
        for r in rows if r.id != u.id  # Өөрийгөө жагсаалтаас хасна
    ]


@router.get("/shift-transfers")
def list_shift_transfers(
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Өөртэй холбоотой бүх ээлж шилжүүлэх хүсэлтүүд."""
    q = db.query(KpiShiftTransfer)
    if u.role != "admin":
        q = q.filter(
            (KpiShiftTransfer.original_employee_id == u.id) |
            (KpiShiftTransfer.replacement_employee_id == u.id) |
            (KpiShiftTransfer.approver_id == u.id)
        )
    transfers = q.order_by(KpiShiftTransfer.created_at.desc()).all()
    return [_ser_shift_transfer(t, db) for t in transfers]


@router.post("/shift-transfers")
def create_shift_transfer(
    body: ShiftTransferIn,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Ээлж шилжүүлэх хүсэлт үүсгэх (ажилтан өөрөө)."""
    # Verify the date is scheduled for the requester
    scheduled = db.query(KpiScheduledDay).filter(
        KpiScheduledDay.employee_id == u.id,
        KpiScheduledDay.date == body.date,
    ).first()
    if not scheduled:
        raise HTTPException(400, "Тухайн өдөр таны хуваарьт байхгүй")

    # Чеклист илгээсэн бол ээлж шилжүүлэх боломжгүй
    existing_cl = db.query(KpiDailyChecklist).filter(
        KpiDailyChecklist.employee_id == u.id,
        KpiDailyChecklist.date == body.date,
        KpiDailyChecklist.status == "submitted",
    ).first()
    if existing_cl:
        raise HTTPException(400, "Тухайн өдрийн чеклист илгээгдсэн тул ээлж шилжүүлэх боломжгүй")

    replacement = db.query(User).filter(User.id == body.replacement_employee_id).first()
    if not replacement:
        raise HTTPException(404, "Орлох ажилтан олдсонгүй")

    approver = db.query(User).filter(User.id == body.approver_id).first()
    if not approver:
        raise HTTPException(404, "Батлах хүн олдсонгүй")

    t = KpiShiftTransfer(
        date=body.date,
        original_employee_id=u.id,
        replacement_employee_id=body.replacement_employee_id,
        approver_id=body.approver_id,
        status="pending",
        note=body.note.strip(),
        created_at=datetime.utcnow(),
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return _ser_shift_transfer(t, db)


@router.patch("/shift-transfers/{transfer_id}/respond")
def respond_shift_transfer(
    transfer_id: int,
    body: ShiftTransferRespondIn,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Ээлж шилжүүлэх хүсэлтэд хариу өгөх (зөвшөөрөгч)."""
    if body.status not in ("approved", "rejected"):
        raise HTTPException(400, "status буруу: 'approved' | 'rejected'")

    t = db.query(KpiShiftTransfer).filter(KpiShiftTransfer.id == transfer_id).first()
    if not t:
        raise HTTPException(404, "Ээлж шилжүүлэх хүсэлт олдсонгүй")
    if t.status != "pending":
        raise HTTPException(400, "Хүсэлт аль хэдийн шийдэгдсэн байна")

    if t.approver_id != u.id and u.role != "admin":
        raise HTTPException(403, "Та энэ хүсэлтийг батлах эрхгүй")

    t.status = body.status
    t.response_note = body.response_note.strip()
    t.responded_at = datetime.utcnow()

    if body.status == "approved":
        # Add scheduled day for replacement employee (if not already)
        existing = db.query(KpiScheduledDay).filter(
            KpiScheduledDay.employee_id == t.replacement_employee_id,
            KpiScheduledDay.date == t.date,
        ).first()
        if not existing:
            db.add(KpiScheduledDay(
                employee_id=t.replacement_employee_id,
                date=t.date,
                created_by=u.id,
                created_at=datetime.utcnow(),
            ))
        # Remove original employee's scheduled day
        db.query(KpiScheduledDay).filter(
            KpiScheduledDay.employee_id == t.original_employee_id,
            KpiScheduledDay.date == t.date,
        ).delete()

        # ── Анхны ажилтны даалгавруудыг орлох хүний чеклистэд нэмэх ──────────
        # Орлох хүний чеклист үүсгэх/олох
        repl_cl = db.query(KpiDailyChecklist).filter(
            KpiDailyChecklist.employee_id == t.replacement_employee_id,
            KpiDailyChecklist.date == t.date,
        ).first()
        if not repl_cl:
            repl_cl = KpiDailyChecklist(employee_id=t.replacement_employee_id, date=t.date)
            db.add(repl_cl)
            db.flush()

        # Анхны ажилтны чеклист
        orig_cl = db.query(KpiDailyChecklist).filter(
            KpiDailyChecklist.employee_id == t.original_employee_id,
            KpiDailyChecklist.date == t.date,
        ).first()
        if orig_cl:
            orig_entries = db.query(KpiChecklistEntry).filter(
                KpiChecklistEntry.checklist_id == orig_cl.id,
            ).all()
            orig_name = _display_name(db, t.original_employee_id)
            for oe in orig_entries:
                # Ижил admin_task_id аль хэдийн байвал давхардуулахгүй
                if oe.admin_task_id:
                    dup = db.query(KpiChecklistEntry).filter(
                        KpiChecklistEntry.checklist_id == repl_cl.id,
                        KpiChecklistEntry.admin_task_id == oe.admin_task_id,
                    ).first()
                    if dup:
                        continue
                db.add(KpiChecklistEntry(
                    checklist_id=repl_cl.id,
                    template_id=oe.template_id,
                    config_id=oe.config_id,
                    task_name=f"{oe.task_name} [{orig_name} ээлж]",
                    monetary_value=oe.monetary_value,
                    task_category=oe.task_category,
                    approver_id=oe.approver_id,
                    is_adhoc=True,
                    admin_task_id=oe.admin_task_id,
                ))

        # Audit log
        log = KpiAuditLog(
            admin_id=u.id,
            action="shift_transfer_approved",
            target_employee_id=t.original_employee_id,
            target_date=t.date,
            old_value=f"employee_{t.original_employee_id}",
            new_value=f"employee_{t.replacement_employee_id}",
            reason=f"Ээлж шилжүүлэх батлагдав. {body.response_note.strip()}",
            created_at=datetime.utcnow(),
        )
        db.add(log)

    db.commit()
    return _ser_shift_transfer(t, db)


# ── Audit Log (Admin) ─────────────────────────────────────────────────────────

def _ser_audit_log(l: KpiAuditLog, db: Session) -> dict:
    return {
        "id": l.id,
        "admin_id": l.admin_id,
        "admin_name": _display_name(db, l.admin_id),
        "action": l.action,
        "target_employee_id": l.target_employee_id,
        "target_employee_name": _display_name(db, l.target_employee_id),
        "target_date": l.target_date.isoformat(),
        "old_value": l.old_value or "",
        "new_value": l.new_value or "",
        "reason": l.reason,
        "created_at": l.created_at.isoformat() if l.created_at else None,
    }


@router.get("/audit-logs")
def list_audit_logs(
    employee_id: Optional[int] = None,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    """Admin-ийн бүх өөрчлөлтийн бүртгэл."""
    q = db.query(KpiAuditLog)
    if employee_id:
        q = q.filter(KpiAuditLog.target_employee_id == employee_id)
    logs = q.order_by(KpiAuditLog.created_at.desc()).limit(500).all()
    return [_ser_audit_log(l, db) for l in logs]


# ── Schedule Admin bulk (month-level) ────────────────────────────────────────

@router.get("/schedule/all")
def get_all_schedules(
    year: int,
    month: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    """Admin-ийн харагдах: бүх ажилтны тухайн сарын хуваарь."""
    from datetime import date as dt
    month_start = dt(year, month, 1)
    if month == 12:
        month_end = dt(year + 1, 1, 1) - timedelta(days=1)
    else:
        month_end = dt(year, month + 1, 1) - timedelta(days=1)

    rows = (
        db.query(KpiScheduledDay)
        .filter(
            KpiScheduledDay.date >= month_start,
            KpiScheduledDay.date <= month_end,
        )
        .order_by(KpiScheduledDay.employee_id, KpiScheduledDay.date)
        .all()
    )
    # Group by employee
    by_emp: dict = {}
    for s in rows:
        eid = s.employee_id
        if eid not in by_emp:
            by_emp[eid] = {
                "employee_id": eid,
                "employee_name": _display_name(db, eid),
                "dates": [],
            }
        by_emp[eid]["dates"].append(s.date.isoformat())
    return list(by_emp.values())
