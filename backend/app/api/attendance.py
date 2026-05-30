"""
Цаг бүртгэл (Time Attendance) API — Timely.mn маягийн систем.

Self-service (бүх нэвтэрсэн хэрэглэгч):
  POST   /attendance/punch              — ирсэн/явсан бүртгэх
  GET    /attendance/today              — өнөөдрийн миний punch + дараагийн товч
  GET    /attendance/me                 — миний сарын summary
  POST   /attendance/adjustments        — нөхөн бүртгэлийн хүсэлт
  GET    /attendance/adjustments/me     — миний хүсэлтүүд

Админ/Супервайзер:
  GET    /attendance/admin/summary      — бүх ажилтны өдөр бүрийн summary
  GET    /attendance/admin/export       — Excel татах
  GET    /attendance/adjustments        — хүлээгдэж буй хүсэлтүүд
  PATCH  /attendance/adjustments/{id}/respond — батлах/татгалзах
  GET    /attendance/schedules          — хуваарь жагсаалт (глобал + per-employee)
  PUT    /attendance/schedules/{employee_id} — хуваарь тохируулах
  GET    /attendance/employees          — ажилтны жагсаалт (тохиргооны select-д)

Бүх цаг Монголын орон нутгийн (UTC+8) — app.core.timez.mn_now().
"""
from __future__ import annotations

import io
from datetime import datetime, date as date_type, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from openpyxl import Workbook

from app.api.deps import get_db, get_current_user, require_role
from app.core.audit import audit, _client_ip
from app.core.event_bus import publish as _publish_event
from app.core.timez import mn_now, mn_today
from app.models.user import User
from app.models.attendance import (
    AttendancePunch, AttendanceAdjustmentRequest, AttendanceSchedule,
    PUNCH_IN, PUNCH_OUT, ADJ_PENDING, ADJ_APPROVED, ADJ_REJECTED,
)

router = APIRouter(prefix="/attendance", tags=["attendance"])

WEEKDAY_MN = ["Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба", "Ням"]


def _notify(action: str = "update", **extra) -> None:
    try:
        _publish_event("attendance", action=action, **extra)
    except Exception:
        pass


# ── Helpers ──────────────────────────────────────────────────────────────────

def _parse_hm(s: str) -> Optional[int]:
    """'HH:MM' → өдрийн эхнээс тоологдсон минут. Буруу бол None."""
    try:
        h, m = (s or "").split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return None


def _minutes_of(dt: datetime) -> int:
    return dt.hour * 60 + dt.minute


def _schedule_map(db: Session) -> tuple[dict, AttendanceSchedule]:
    """Бүх per-employee хуваарь + глобал default-г буцаана."""
    rows = db.query(AttendanceSchedule).all()
    per_emp: dict[int, AttendanceSchedule] = {}
    default: Optional[AttendanceSchedule] = None
    for r in rows:
        if r.employee_id is None:
            default = r
        else:
            per_emp[r.employee_id] = r
    if default is None:
        # Fallback (анхдагч мөр алга болсон тохиолдол)
        default = AttendanceSchedule(
            employee_id=None, work_days="0,1,2,3,4,5",
            work_start="09:00", work_end="18:00", grace_minutes=10,
        )
    return per_emp, default


def _sched_for(emp_id: int, per_emp: dict, default: AttendanceSchedule) -> AttendanceSchedule:
    return per_emp.get(emp_id) or default


def _serialize_punch(p: AttendancePunch) -> dict:
    return {
        "id": p.id,
        "employee_id": p.employee_id,
        "punch_at": p.punch_at.isoformat() if p.punch_at else None,
        "punch_date": p.punch_date.isoformat() if p.punch_date else None,
        "kind": p.kind,
        "source": p.source,
        "note": p.note or "",
    }


def _day_summary(emp_id: int, d: date_type, punches: list, sched: AttendanceSchedule) -> dict:
    """Нэг ажилтны нэг өдрийн summary тооцоо."""
    ins = sorted([p for p in punches if p.kind == PUNCH_IN], key=lambda x: x.punch_at)
    outs = sorted([p for p in punches if p.kind == PUNCH_OUT], key=lambda x: x.punch_at)
    first_in = ins[0].punch_at if ins else None
    last_out = outs[-1].punch_at if outs else None

    work_days = [int(x) for x in (sched.work_days or "").split(",") if x.strip().isdigit()]
    is_work_day = d.weekday() in work_days

    start_min = _parse_hm(sched.work_start) or 540
    end_min = _parse_hm(sched.work_end) or 1080
    grace = sched.grace_minutes or 0

    late_min = 0
    early_min = 0
    worked_min = 0
    if first_in:
        fi = _minutes_of(first_in)
        if fi > start_min + grace:
            late_min = fi - start_min
    if last_out:
        lo = _minutes_of(last_out)
        if lo < end_min:
            early_min = end_min - lo
    if first_in and last_out and last_out > first_in:
        worked_min = int((last_out - first_in).total_seconds() // 60)

    # Төлөв
    if not is_work_day:
        status = "off"          # Амралт
    elif not first_in and not last_out:
        status = "absent"       # Тасалсан
    elif late_min > 0:
        status = "late"         # Хоцорсон
    else:
        status = "present"      # Ирсэн

    return {
        "date": d.isoformat(),
        "weekday": WEEKDAY_MN[d.weekday()],
        "first_in": first_in.strftime("%H:%M") if first_in else "",
        "last_out": last_out.strftime("%H:%M") if last_out else "",
        "late_minutes": late_min,
        "early_minutes": early_min,
        "worked_minutes": worked_min,
        "punch_count": len(punches),
        "is_work_day": is_work_day,
        "status": status,
    }


# ── Schemas ──────────────────────────────────────────────────────────────────

class PunchIn(BaseModel):
    kind: str                       # "in" | "out"
    note: Optional[str] = ""


class AdjustmentIn(BaseModel):
    target_date: str                # "YYYY-MM-DD"
    requested_in: Optional[str] = ""    # "HH:MM"
    requested_out: Optional[str] = ""
    reason: Optional[str] = ""


class AdjustmentRespondIn(BaseModel):
    status: str                     # "approved" | "rejected"
    response_note: Optional[str] = ""


class ScheduleIn(BaseModel):
    work_days: str = "0,1,2,3,4,5"
    work_start: str = "09:00"
    work_end: str = "18:00"
    grace_minutes: int = 10


# ── Self-service: punch ────────────────────────────────────────────────────────

@router.post("/punch")
def punch(
    body: PunchIn,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    kind = (body.kind or "").strip().lower()
    if kind not in (PUNCH_IN, PUNCH_OUT):
        raise HTTPException(400, "kind нь 'in' эсвэл 'out' байх ёстой.")

    now = mn_now()
    p = AttendancePunch(
        employee_id=u.id,
        punch_at=now,
        punch_date=now.date(),
        kind=kind,
        source="self",
        ip_address=_client_ip(request),
        note=(body.note or "").strip(),
        created_by_id=u.id,
    )
    db.add(p)
    db.commit()
    db.refresh(p)

    audit(db, request, u, action=f"attendance_punch_{kind}",
          entity_type="attendance_punch", entity_id=p.id,
          extra={"punch_at": now.isoformat()}, autocommit=True)
    _notify("punch", employee_id=u.id)
    return _serialize_punch(p)


@router.get("/today")
def today_status(
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    d = mn_today()
    punches = db.query(AttendancePunch).filter(
        AttendancePunch.employee_id == u.id,
        AttendancePunch.punch_date == d,
    ).order_by(AttendancePunch.punch_at.asc()).all()
    last = punches[-1] if punches else None
    # Дараагийн санал болгох товч: сүүлд "in" бол → "out", эсрэгээр "in"
    next_kind = PUNCH_OUT if (last and last.kind == PUNCH_IN) else PUNCH_IN
    return {
        "date": d.isoformat(),
        "punches": [_serialize_punch(p) for p in punches],
        "last_kind": last.kind if last else None,
        "next_kind": next_kind,
    }


@router.get("/me")
def my_month(
    year: int = Query(...),
    month: int = Query(...),
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    return _employee_month_summary(db, u.id, year, month)


def _employee_month_summary(db: Session, emp_id: int, year: int, month: int) -> dict:
    if not (1 <= month <= 12):
        raise HTTPException(400, "month буруу.")
    first = date_type(year, month, 1)
    last = date_type(year + 1, 1, 1) if month == 12 else date_type(year, month + 1, 1)

    punches = db.query(AttendancePunch).filter(
        AttendancePunch.employee_id == emp_id,
        AttendancePunch.punch_date >= first,
        AttendancePunch.punch_date < last,
    ).all()
    by_day: dict[date_type, list] = {}
    for p in punches:
        by_day.setdefault(p.punch_date, []).append(p)

    per_emp, default = _schedule_map(db)
    sched = _sched_for(emp_id, per_emp, default)

    days = []
    cur = first
    today = mn_today()
    while cur < last:
        if cur <= today:  # ирээдүйн өдрийг харуулахгүй
            days.append(_day_summary(emp_id, cur, by_day.get(cur, []), sched))
        cur += timedelta(days=1)

    return {
        "employee_id": emp_id,
        "year": year, "month": month,
        "days": days,
        "totals": {
            "present": sum(1 for d in days if d["status"] in ("present", "late")),
            "late": sum(1 for d in days if d["status"] == "late"),
            "absent": sum(1 for d in days if d["status"] == "absent"),
            "late_minutes": sum(d["late_minutes"] for d in days),
            "worked_minutes": sum(d["worked_minutes"] for d in days),
        },
    }


# ── Self-service: adjustment requests ──────────────────────────────────────────

def _serialize_adj(a: AttendanceAdjustmentRequest, emp_name: str = "", approver_name: str = "") -> dict:
    return {
        "id": a.id,
        "employee_id": a.employee_id,
        "employee_name": emp_name,
        "target_date": a.target_date.isoformat() if a.target_date else None,
        "requested_in": a.requested_in or "",
        "requested_out": a.requested_out or "",
        "reason": a.reason or "",
        "status": a.status,
        "approver_id": a.approver_id,
        "approver_name": approver_name,
        "response_note": a.response_note or "",
        "responded_at": a.responded_at.isoformat() if a.responded_at else None,
        "created_at": a.created_at.isoformat() if a.created_at else None,
    }


@router.post("/adjustments")
def create_adjustment(
    body: AdjustmentIn,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    try:
        td = date_type.fromisoformat(body.target_date)
    except Exception:
        raise HTTPException(400, "target_date буруу (YYYY-MM-DD).")
    if not (body.requested_in or body.requested_out):
        raise HTTPException(400, "Ирсэн эсвэл явсан цагийн аль нэгийг оруулна уу.")

    a = AttendanceAdjustmentRequest(
        employee_id=u.id,
        target_date=td,
        requested_in=(body.requested_in or "").strip(),
        requested_out=(body.requested_out or "").strip(),
        reason=(body.reason or "").strip(),
        status=ADJ_PENDING,
        created_at=mn_now(),
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    _notify("adjustment_created", employee_id=u.id)
    return _serialize_adj(a, emp_name=u.nickname or u.username)


@router.get("/adjustments/me")
def my_adjustments(
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    rows = db.query(AttendanceAdjustmentRequest).filter(
        AttendanceAdjustmentRequest.employee_id == u.id,
    ).order_by(AttendanceAdjustmentRequest.id.desc()).limit(100).all()
    return [_serialize_adj(a, emp_name=u.nickname or u.username) for a in rows]


# ── Admin/Supervisor: adjustments listing + respond ─────────────────────────────

@router.get("/adjustments")
def list_adjustments(
    status: str = Query("pending"),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor")),
):
    q = db.query(AttendanceAdjustmentRequest)
    if status and status != "all":
        q = q.filter(AttendanceAdjustmentRequest.status == status)
    rows = q.order_by(AttendanceAdjustmentRequest.id.desc()).limit(300).all()
    # Нэрсийн map
    uids = {r.employee_id for r in rows} | {r.approver_id for r in rows if r.approver_id}
    names = {
        usr.id: (usr.nickname or usr.username)
        for usr in db.query(User).filter(User.id.in_(uids)).all()
    } if uids else {}
    return [
        _serialize_adj(a, emp_name=names.get(a.employee_id, ""),
                       approver_name=names.get(a.approver_id, "") if a.approver_id else "")
        for a in rows
    ]


@router.patch("/adjustments/{adj_id}/respond")
def respond_adjustment(
    adj_id: int,
    body: AdjustmentRespondIn,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor")),
):
    a = db.query(AttendanceAdjustmentRequest).filter(
        AttendanceAdjustmentRequest.id == adj_id
    ).first()
    if not a:
        raise HTTPException(404, "Хүсэлт олдсонгүй.")
    if a.status != ADJ_PENDING:
        raise HTTPException(400, "Энэ хүсэлт аль хэдийн хариулагдсан.")

    new_status = (body.status or "").strip().lower()
    if new_status not in (ADJ_APPROVED, ADJ_REJECTED):
        raise HTTPException(400, "status нь approved/rejected байх ёстой.")

    a.status = new_status
    a.approver_id = u.id
    a.response_note = (body.response_note or "").strip()
    a.responded_at = mn_now()

    created_punches = 0
    if new_status == ADJ_APPROVED:
        # Нөхөн punch үүсгэнэ (source=makeup)
        for kind, hm in ((PUNCH_IN, a.requested_in), (PUNCH_OUT, a.requested_out)):
            mins = _parse_hm(hm)
            if mins is None:
                continue
            punch_dt = datetime(a.target_date.year, a.target_date.month, a.target_date.day,
                                mins // 60, mins % 60)
            db.add(AttendancePunch(
                employee_id=a.employee_id,
                punch_at=punch_dt,
                punch_date=a.target_date,
                kind=kind,
                source="makeup",
                note=f"Нөхөн бүртгэл (хүсэлт #{a.id})",
                created_by_id=u.id,
                created_at=mn_now(),
            ))
            created_punches += 1

    db.commit()
    audit(db, request, u, action=f"attendance_adjustment_{new_status}",
          entity_type="attendance_adjustment", entity_id=a.id,
          extra={"employee_id": a.employee_id, "target_date": a.target_date.isoformat(),
                 "punches_created": created_punches}, autocommit=True)
    _notify("adjustment_responded", employee_id=a.employee_id)
    return _serialize_adj(a)


# ── Admin: dashboard summary ────────────────────────────────────────────────────

def _active_employees(db: Session) -> list[User]:
    return db.query(User).filter(User.is_active == True).order_by(User.id.asc()).all()  # noqa: E712


@router.get("/admin/summary")
def admin_summary(
    date_from: str = Query(...),     # "YYYY-MM-DD"
    date_to: str = Query(...),
    employee_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor")),
):
    try:
        d_from = date_type.fromisoformat(date_from)
        d_to = date_type.fromisoformat(date_to)
    except Exception:
        raise HTTPException(400, "Огноо буруу (YYYY-MM-DD).")
    if d_to < d_from:
        raise HTTPException(400, "Эцсийн огноо эхнээсээ өмнө байж болохгүй.")
    if (d_to - d_from).days > 92:
        raise HTTPException(400, "Хугацааны муж хэт урт (≤ 3 сар).")

    employees = _active_employees(db)
    if employee_id:
        employees = [e for e in employees if e.id == employee_id]
    emp_ids = [e.id for e in employees]
    if not emp_ids:
        return {"rows": [], "employees": [], "totals": {}}

    punches = db.query(AttendancePunch).filter(
        AttendancePunch.employee_id.in_(emp_ids),
        AttendancePunch.punch_date >= d_from,
        AttendancePunch.punch_date <= d_to,
    ).all()
    # (emp_id, date) → [punches]
    bucket: dict[tuple[int, date_type], list] = {}
    for p in punches:
        bucket.setdefault((p.employee_id, p.punch_date), []).append(p)

    per_emp, default = _schedule_map(db)
    today = mn_today()

    rows = []
    tot_present = tot_late = tot_absent = 0
    cur = d_from
    while cur <= d_to and cur <= today:
        for e in employees:
            sched = _sched_for(e.id, per_emp, default)
            summ = _day_summary(e.id, cur, bucket.get((e.id, cur), []), sched)
            # Зөвхөн утга бүхий мөрийг харуулна (ажлын өдөр эсвэл punch-тай)
            if summ["status"] == "off" and summ["punch_count"] == 0:
                continue
            rows.append({
                "employee_id": e.id,
                "employee_name": e.nickname or e.username,
                **summ,
            })
            if summ["status"] in ("present", "late"):
                tot_present += 1
            if summ["status"] == "late":
                tot_late += 1
            if summ["status"] == "absent":
                tot_absent += 1
        cur += timedelta(days=1)

    return {
        "date_from": d_from.isoformat(),
        "date_to": d_to.isoformat(),
        "rows": rows,
        "employees": [{"id": e.id, "name": e.nickname or e.username} for e in employees],
        "totals": {
            "employee_count": len(employees),
            "present": tot_present,
            "late": tot_late,
            "absent": tot_absent,
        },
    }


@router.get("/admin/export")
def admin_export(
    date_from: str = Query(...),
    date_to: str = Query(...),
    employee_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor")),
):
    data = admin_summary(date_from=date_from, date_to=date_to, employee_id=employee_id, db=db, u=u)

    wb = Workbook()
    ws = wb.active
    ws.title = "Цаг бүртгэл"
    headers = ["Огноо", "Гараг", "Ажилтан", "Ирсэн", "Явсан",
               "Хоцролт (мин)", "Эрт явсан (мин)", "Ажилласан (цаг)", "Төлөв"]
    ws.append(headers)

    status_label = {"present": "Ирсэн", "late": "Хоцорсон",
                    "absent": "Тасалсан", "off": "Амралт"}
    for r in data["rows"]:
        worked_h = round(r["worked_minutes"] / 60, 1) if r["worked_minutes"] else 0
        ws.append([
            r["date"], r["weekday"], r["employee_name"],
            r["first_in"], r["last_out"],
            r["late_minutes"] or "", r["early_minutes"] or "",
            worked_h or "", status_label.get(r["status"], r["status"]),
        ])

    # Баганы өргөн
    widths = [12, 8, 22, 8, 8, 13, 14, 15, 12]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = w

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    from urllib.parse import quote
    lbl = f"{date_from.replace('-', '')}_{date_to.replace('-', '')}"
    filename = f"Tsag_burtgel_{lbl}.xlsx"
    display = f"Цаг_бүртгэл_{lbl}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=\"{filename}\"; filename*=UTF-8''{quote(display)}"},
    )


# ── Admin: schedules ────────────────────────────────────────────────────────────

def _serialize_sched(s: AttendanceSchedule, name: str = "") -> dict:
    return {
        "id": s.id,
        "employee_id": s.employee_id,
        "employee_name": name,
        "work_days": s.work_days or "",
        "work_start": s.work_start or "",
        "work_end": s.work_end or "",
        "grace_minutes": s.grace_minutes or 0,
    }


@router.get("/schedules")
def list_schedules(
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor")),
):
    per_emp, default = _schedule_map(db)
    employees = _active_employees(db)
    name_map = {e.id: (e.nickname or e.username) for e in employees}
    return {
        "default": _serialize_sched(default),
        "employees": [
            {
                "id": e.id,
                "name": e.nickname or e.username,
                "role": e.role,
                "schedule": (_serialize_sched(per_emp[e.id], name_map.get(e.id, ""))
                             if e.id in per_emp else None),
            }
            for e in employees
        ],
    }


@router.put("/schedules/{employee_id}")
def set_schedule(
    employee_id: int,    # 0 → глобал default
    body: ScheduleIn,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor")),
):
    target_emp = None if employee_id == 0 else employee_id
    s = db.query(AttendanceSchedule).filter(
        AttendanceSchedule.employee_id.is_(None) if target_emp is None
        else AttendanceSchedule.employee_id == target_emp
    ).first()
    if not s:
        s = AttendanceSchedule(employee_id=target_emp)
        db.add(s)
    s.work_days = (body.work_days or "0,1,2,3,4,5").strip()
    s.work_start = (body.work_start or "09:00").strip()
    s.work_end = (body.work_end or "18:00").strip()
    s.grace_minutes = max(0, int(body.grace_minutes or 0))
    db.commit()
    db.refresh(s)
    audit(db, request, u, action="attendance_schedule_set",
          entity_type="attendance_schedule", entity_id=s.id,
          extra={"employee_id": target_emp}, autocommit=True)
    _notify("schedule_changed")
    return _serialize_sched(s)


@router.delete("/schedules/{employee_id}")
def clear_schedule(
    employee_id: int,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor")),
):
    """Ажилтны хувийн хуваарийг устгаж глобал default-руу буцаана."""
    if employee_id == 0:
        raise HTTPException(400, "Глобал default-ыг устгаж болохгүй.")
    s = db.query(AttendanceSchedule).filter(
        AttendanceSchedule.employee_id == employee_id
    ).first()
    if s:
        db.delete(s)
        db.commit()
        _notify("schedule_changed")
    return {"ok": True}


@router.get("/employees")
def list_attendance_employees(
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor")),
):
    return [
        {"id": e.id, "name": e.nickname or e.username, "role": e.role}
        for e in _active_employees(db)
    ]
