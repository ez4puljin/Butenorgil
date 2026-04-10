from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from datetime import date as date_type
from typing import Optional
from pydantic import BaseModel

from app.api.deps import get_db, get_current_user
from app.models.calendar_event import CalendarEvent
from app.models.user import User

router = APIRouter(prefix="/calendar", tags=["calendar"])

# Predefined task types (kept in sync with frontend TASK_TYPES)
VALID_TASK_TYPES = {
    "unloading", "order", "inventory", "payment",
    "report", "meeting", "shipment", "other",
}


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
    if body.task_type not in VALID_TASK_TYPES:
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
            if body.task_type not in VALID_TASK_TYPES:
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
