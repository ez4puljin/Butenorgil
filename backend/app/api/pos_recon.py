"""POS тулгалтын календарь — касс → erxes → Эрхэт хоёр шатны хяналт.

    GET  /pos-recon/month?year=&month=   → календарийн өдөр тутмын төлөв
    GET  /pos-recon/day?day=             → өдрийн дэлгэрэнгүй + буцаалтууд
    POST /pos-recon/run                  → нэг өдөр эсвэл хугацааг дахин шалгах
    GET  /pos-recon/run-status           → явц
    POST /pos-recon/cancel               → зогсоох

Шалгалт удаан (POS тутамд ~13 сек) тул ард нь thread-д ажиллуулж, явцыг
status-аас уншина. Календарь нь ХАДГАЛСАН датаг уншдаг тул шуурхай.
"""
from __future__ import annotations

import threading
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_role
from app.core.config import settings
from app.models.user import User
from app.services import pos_reconcile

router = APIRouter(prefix="/pos-recon", tags=["pos-recon"])

MAX_DAYS = 62          # нэг удаад нөхөж болох хамгийн их хоног

_job: dict = {
    "running": False, "total": 0, "done": 0, "day": "",
    "message": "", "error": "", "started_at": None, "finished_at": None,
    "log": [],
}
_job_lock = threading.Lock()
_cancel = {"flag": False}
MAX_LOG = 40


def _log(msg: str) -> None:
    _job["log"] = ([f"{datetime.now():%H:%M:%S} {msg}"] + _job["log"])[:MAX_LOG]


@router.get("/month")
def month(
    year: int = Query(..., ge=2000, le=2100),
    month: int = Query(..., ge=1, le=12),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Календарийн өдөр тутмын төлөв — хадгалсан датанаас (шуурхай)."""
    out = pos_reconcile.month_summary(db, year, month)
    out["enabled"] = bool((settings.erxes_email or "").strip())
    out["pos_urls"] = pos_reconcile.local_urls()
    return out


@router.get("/day")
def day(
    day: str = Query(..., min_length=10, max_length=10),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Өдрийн дэлгэрэнгүй.

    POS тус бүрээр: кассын нийт = erxes дээрх + буцаалт.
    Буцаалт байвал хэн, хэдэн цагт, ямар баримт буцаасныг харуулна."""
    return pos_reconcile.day_detail(db, day)


class RunIn(BaseModel):
    day: str = ""        # ганц өдөр (YYYY-MM-DD)
    start: str = ""      # эсвэл хугацаа — өнгөрсөн өдрүүдийг нөхөхөд
    end: str = ""


def _days_of(body: RunIn) -> list[str]:
    if body.day:
        return [body.day[:10]]
    if not (body.start and body.end):
        return [(date.today() - timedelta(days=1)).isoformat()]
    try:
        a = date.fromisoformat(body.start[:10])
        b = date.fromisoformat(body.end[:10])
    except ValueError:
        raise HTTPException(400, "Огноо буруу — 'YYYY-MM-DD' хэлбэрээр өгнө үү.")
    if b < a:
        a, b = b, a
    if (b - a).days + 1 > MAX_DAYS:
        raise HTTPException(400, f"Хэт урт хугацаа — хамгийн ихдээ {MAX_DAYS} хоног.")
    return [(a + timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]


def _run_job(days: list[str]) -> None:
    """Background thread — өдөр бүрийг дараалан шалгаж хадгална."""
    try:
        for d in days:
            if _cancel["flag"]:
                _job["message"] = "Цуцлагдлаа"
                _log("Цуцлагдлаа")
                return
            _job["day"] = d
            _job["message"] = f"{d} шалгаж байна…"
            try:
                res = pos_reconcile.run_and_save(
                    d, should_cancel=lambda: _cancel["flag"])
                bad = sum(1 for r in res["rows"] if r["error"])
                _log(f"{d}: зөрүү {res['unexplained']} · Эрхэтэд ороогүй "
                     f"{res['unsynced']}" + (f" · {bad} POS алдаатай" if bad else ""))
            except Exception as e:      # noqa: BLE001 — нэг өдөр унасан ч үргэлжилнэ
                _log(f"{d}: АЛДАА {str(e)[:70]}")
            _job["done"] += 1
        _job["message"] = f"Дууслаа — {_job['done']}/{_job['total']} хоног"
    except Exception as e:              # noqa: BLE001
        _job["error"] = str(e)[:200]
        _job["message"] = "Алдаа гарлаа"
    finally:
        _job["running"] = False
        _job["finished_at"] = datetime.utcnow().isoformat(timespec="seconds")


@router.post("/run")
def run(
    body: RunIn,
    _: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Тулгалтыг гар аргаар ажиллуулна (өнгөрсөн өдрүүдийг нөхөхөд ч)."""
    days = _days_of(body)
    with _job_lock:
        if _job["running"]:
            raise HTTPException(409, "Тулгалт аль хэдийн явж байна.")
        _cancel["flag"] = False
        _job.update({"running": True, "total": len(days), "done": 0,
                     "day": days[0], "message": "Эхэлж байна…", "error": "",
                     "started_at": datetime.utcnow().isoformat(timespec="seconds"),
                     "finished_at": None, "log": []})
    threading.Thread(target=_run_job, args=(days,), daemon=True).start()
    return {"ok": True, "days": len(days)}


@router.get("/run-status")
def run_status(_: User = Depends(require_role("admin", "supervisor", "manager"))):
    """Явц (UI тогтмол уншина)."""
    return {"enabled": bool((settings.erxes_email or "").strip()), **_job}


@router.post("/cancel")
def cancel(_: User = Depends(require_role("admin", "supervisor", "manager"))):
    """Явж буй тулгалтыг зогсооно."""
    _cancel["flag"] = True
    return {"ok": True, "cancelled": True}
