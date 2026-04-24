from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from datetime import date as date_type
from typing import Optional
from pydantic import BaseModel

from app.api.deps import get_db, get_current_user, require_role
from app.models.calendar_event import CalendarEvent
from app.models.calendar_label import CalendarLabel
from app.models.user import User

router = APIRouter(prefix="/calendar", tags=["calendar"])


def _valid_task_types(db: Session) -> set[str]:
    """Идэвхтэй label-ийн key-ийн set."""
    return {r.key for r in db.query(CalendarLabel).filter(CalendarLabel.is_active == True).all()}


# ── Schemas ────────────────────────────────────────────────────────────────────

class EventCreateIn(BaseModel):
    date: date_type
    task_type: str          # predefined key, stored in `title` column
    notes: str = ""         # optional free text, stored in `description` column


class EventUpdateIn(BaseModel):
    is_done: Optional[bool] = None
    task_type: Optional[str] = None
    notes: Optional[str] = None


def _serialize(ev: CalendarEvent, db: Session) -> dict:
    creator = db.query(User).filter(User.id == ev.created_by_user_id).first()
    return {
        "id": ev.id,
        "date": ev.date.isoformat(),
        "task_type": ev.title,          # task_type key stored in title column
        "notes": ev.description,        # free text stored in description column
        "is_done": ev.is_done,
        "created_by_user_id": ev.created_by_user_id,
        "created_by_username": creator.username if creator else "",
        "created_at": ev.created_at.isoformat() if ev.created_at else None,
    }


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/events")
def list_events(
    year: int,
    month: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    from calendar import monthrange
    _, last_day = monthrange(year, month)
    date_from = date_type(year, month, 1)
    date_to   = date_type(year, month, last_day)

    events = (
        db.query(CalendarEvent)
        .filter(CalendarEvent.date >= date_from, CalendarEvent.date <= date_to)
        .order_by(CalendarEvent.date, CalendarEvent.created_at)
        .all()
    )
    return [_serialize(e, db) for e in events]


@router.post("/events")
def create_event(
    body: EventCreateIn,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    if body.task_type not in _valid_task_types(db):
        raise HTTPException(400, f"task_type буруу байна: {body.task_type}")

    ev = CalendarEvent(
        date=body.date,
        title=body.task_type,           # store task_type in title
        description=body.notes.strip(),
        priority="normal",              # unused but column exists
        created_by_user_id=u.id,
    )
    db.add(ev)
    db.commit()
    db.refresh(ev)
    return _serialize(ev, db)


@router.patch("/events/{event_id}")
def update_event(
    event_id: int,
    body: EventUpdateIn,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    ev = db.query(CalendarEvent).filter(CalendarEvent.id == event_id).first()
    if not ev:
        raise HTTPException(404, "Ажил олдсонгүй")

    if body.is_done is not None:
        ev.is_done = body.is_done

    if body.task_type is not None or body.notes is not None:
        if u.id != ev.created_by_user_id and u.role not in ("admin", "supervisor"):
            raise HTTPException(403, "Зөвхөн үүсгэсэн хүн засах боломжтой")
        if body.task_type is not None:
            if body.task_type not in _valid_task_types(db):
                raise HTTPException(400, f"task_type буруу: {body.task_type}")
            ev.title = body.task_type
        if body.notes is not None:
            ev.description = body.notes.strip()

    db.commit()
    db.refresh(ev)
    return _serialize(ev, db)


@router.delete("/events/{event_id}")
def delete_event(
    event_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    ev = db.query(CalendarEvent).filter(CalendarEvent.id == event_id).first()
    if not ev:
        raise HTTPException(404, "Ажил олдсонгүй")
    if u.id != ev.created_by_user_id and u.role not in ("admin", "supervisor"):
        raise HTTPException(403, "Зөвхөн үүсгэсэн хүн устгах боломжтой")
    db.delete(ev)
    db.commit()
    return {"ok": True}


# ── Label config CRUD (admin only write) ──────────────────────────────────────

class LabelIn(BaseModel):
    key: Optional[str] = None
    label: str
    short: str = ""
    color: str = "gray"
    icon: str = "MoreHorizontal"
    sort_order: Optional[int] = None
    is_active: bool = True


def _label_serialize(lb: CalendarLabel) -> dict:
    return {
        "id": lb.id,
        "key": lb.key,
        "label": lb.label,
        "short": lb.short or lb.label,
        "color": lb.color,
        "icon": lb.icon,
        "sort_order": lb.sort_order,
        "is_active": lb.is_active,
    }


@router.get("/labels")
def list_labels(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    rows = db.query(CalendarLabel).order_by(CalendarLabel.sort_order, CalendarLabel.id).all()
    return [_label_serialize(r) for r in rows]


@router.post("/labels")
def create_label(
    body: LabelIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    if not body.label.strip():
        raise HTTPException(400, "Нэр хоосон байна")
    # key автоматаар ижил нэр бус байхаар үүсгэнэ
    import re
    auto_key = re.sub(r"[^a-z0-9_]", "_", (body.key or body.label.lower()))[:50] or f"lbl_{int(__import__('time').time())}"
    # Давхардалтай бол ард нь тоо залгана
    base = auto_key
    i = 1
    while db.query(CalendarLabel).filter(CalendarLabel.key == auto_key).first():
        auto_key = f"{base}_{i}"
        i += 1
    last_order = (db.query(CalendarLabel).order_by(CalendarLabel.sort_order.desc()).first())
    next_order = body.sort_order if body.sort_order is not None else ((last_order.sort_order + 1) if last_order else 1)
    lb = CalendarLabel(
        key=auto_key,
        label=body.label.strip(),
        short=(body.short or body.label).strip()[:50],
        color=body.color or "gray",
        icon=body.icon or "MoreHorizontal",
        sort_order=next_order,
        is_active=body.is_active,
    )
    db.add(lb); db.commit(); db.refresh(lb)
    return _label_serialize(lb)


@router.patch("/labels/{label_id}")
def update_label(
    label_id: int,
    body: LabelIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    lb = db.query(CalendarLabel).filter(CalendarLabel.id == label_id).first()
    if not lb:
        raise HTTPException(404, "Label олдсонгүй")
    if body.label is not None:
        lb.label = body.label.strip() or lb.label
    if body.short is not None:
        lb.short = body.short.strip()[:50]
    if body.color:
        lb.color = body.color
    if body.icon:
        lb.icon = body.icon
    if body.sort_order is not None:
        lb.sort_order = body.sort_order
    if body.is_active is not None:
        lb.is_active = body.is_active
    db.commit(); db.refresh(lb)
    return _label_serialize(lb)


@router.delete("/labels/{label_id}")
def delete_label(
    label_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    lb = db.query(CalendarLabel).filter(CalendarLabel.id == label_id).first()
    if not lb:
        raise HTTPException(404, "Label олдсонгүй")
    # Ашиглагдаж байгаа эсэхийг шалгах
    used = db.query(CalendarEvent).filter(CalendarEvent.title == lb.key).count()
    if used > 0:
        # Хатуу устгахгүй, зөвхөн идэвхгүй болгоно
        lb.is_active = False
        db.commit()
        return {"ok": True, "deactivated": True, "used_by_events": used}
    db.delete(lb); db.commit()
    return {"ok": True, "deleted": True}
