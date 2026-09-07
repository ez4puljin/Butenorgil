"""POS sync — erxes-ийн POS захиалгуудыг Эрхэт рүү sync хийх хяналт.

erxes-ийн /check-pos-orders хуудсын үүргийг ERP дотор давтана:
  1. POS сонгох            → GET  /pos-sync/pos-list
  2. Төлсөн огнооны хязгаар → GET  /pos-sync/check
     → sync хийгдээгүй гүйлгээний тоо
  3. "Татах"               → POST /pos-sync/start  (ард нь ажиллана)
     → GET  /pos-sync/status  (явцыг харуулна)

Татах ажиллагаа удаан үргэлжилж болох тул background thread-д ажиллуулж,
UI нь status-ыг тогтмол уншиж явцыг харуулна.
"""
from __future__ import annotations

import threading
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_role
from app.core.config import settings
from app.models.user import User
from app.services.erxes_client import ErxesCancelled, ErxesError, get_client

router = APIRouter(prefix="/pos-sync", tags=["pos-sync"])

# Нэг дор нэг л татах ажиллагаа
_job_lock = threading.Lock()
_job: dict = {
    "running": False, "total": 0, "done": 0, "ok": 0, "failed": 0,
    "started_at": None, "finished_at": None, "message": "", "error": "",
    "pos_name": "", "log": [],
}

BATCH = 20          # нэг удаад хэдэн захиалга sync хийх
MAX_LOG = 40

# ── Шалгалтыг цуцлах ─────────────────────────────────────────────────
# /check нь синхрон бөгөөд «Бүх POS» + олон хоног сонговол хэдэн минут
# үргэлжилнэ. Санамсаргүй буруу сонголт хийсэн хэрэглэгч хүлээх ёсгүй.
# Үеийн дугаараар (generation) цуцална: цуцлах хүсэлт ирэхэд, эсвэл ШИНЭ
# шалгалт эхлэхэд хуучин нь автоматаар зогсоно (хоёр шалгалт зэрэг
# erxes-ийг ачаалахгүй).
_check_state = {"gen": 0, "cancel_gen": -1}
_check_lock = threading.Lock()


def _begin_check() -> int:
    with _check_lock:
        _check_state["gen"] += 1
        return _check_state["gen"]


def _cancelled(my_gen: int) -> bool:
    with _check_lock:
        return (_check_state["cancel_gen"] >= my_gen
                or _check_state["gen"] != my_gen)


def _reset_job(pos_name: str, total: int) -> None:
    _job.update({
        "running": True, "total": total, "done": 0, "ok": 0, "failed": 0,
        "started_at": datetime.utcnow().isoformat(timespec="seconds"),
        "finished_at": None, "message": "Эхэлж байна…", "error": "",
        "pos_name": pos_name, "log": [],
    })


def _log(msg: str) -> None:
    _job["log"] = ([f"{datetime.now():%H:%M:%S} {msg}"] + _job["log"])[:MAX_LOG]


@router.get("/status")
def status(_: User = Depends(require_role("admin", "supervisor", "manager"))):
    """Одоогийн татах ажиллагааны явц (UI тогтмол уншина)."""
    return {
        "enabled": bool((settings.erxes_email or "").strip()),
        **{k: v for k, v in _job.items()},
    }


@router.get("/pos-list")
def pos_list(_: User = Depends(require_role("admin", "supervisor", "manager"))):
    """Сонгох боломжтой POS-ууд."""
    try:
        return {"pos": get_client().pos_list()}
    except ErxesError as e:
        raise HTTPException(502, f"erxes: {e}")


@router.get("/check")
def check(
    pos_id: str = Query("", description="POS-ийн _id. Хоосон бол бүгд."),
    paid_start: str = Query(..., description="Төлсөн огноо эхлэл YYYY-MM-DD"),
    paid_end: str = Query(..., description="Төлсөн огноо төгсгөл YYYY-MM-DD"),
    per_page: int = Query(500, ge=1, le=2000),
    _: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Хугацаанд хэдэн гүйлгээ байгаа, тэдгээрээс хэд нь sync хийгдээгүйг тоолно.

    Цуцлагдах боломжтой — /cancel-check дуудахад хуудас/багцын завсарт зогсоно."""
    my_gen = _begin_check()

    def cancel() -> bool:
        return _cancelled(my_gen)

    try:
        c = get_client()
        orders = c.pos_orders_all(pos_id, paid_start, paid_end,
                                  page_size=per_page, should_cancel=cancel)
        ids = [o["_id"] for o in orders if o.get("_id")]
        checked = c.check_synced(ids, should_cancel=cancel)
        synced_ids = {r["_id"] for r in checked if r.get("isSynced")}
        unsynced = [o for o in orders if o["_id"] not in synced_ids]
        return {
            "cancelled": False,
            "total": len(orders),
            "synced": len(synced_ids),
            "unsynced_count": len(unsynced),
            "unsynced_amount": round(sum(float(o.get("totalAmount") or 0) for o in unsynced)),
            "unsynced": [
                {"_id": o["_id"], "number": o.get("number"),
                 "paidDate": o.get("paidDate"), "totalAmount": o.get("totalAmount")}
                for o in unsynced[:200]
            ],
        }
    except ErxesCancelled:
        # Цуцлалт бол алдаа биш — UI хоосон үр дүнг харуулалгүй өмнөхөө хадгална.
        return {"cancelled": True, "total": 0, "synced": 0, "unsynced_count": 0,
                "unsynced_amount": 0, "unsynced": []}
    except ErxesError as e:
        raise HTTPException(502, f"erxes: {e}")


@router.post("/cancel-check")
def cancel_check(_: User = Depends(require_role("admin", "supervisor", "manager"))):
    """Явж буй шалгалтыг зогсооно."""
    with _check_lock:
        _check_state["cancel_gen"] = _check_state["gen"]
    return {"ok": True, "cancelled": True}


class StartIn(BaseModel):
    pos_id: str = ""
    pos_name: str = ""
    paid_start: str = Field(..., min_length=10, max_length=10)
    paid_end: str = Field(..., min_length=10, max_length=10)


def _run_sync(pos_id: str, pos_name: str, paid_start: str, paid_end: str) -> None:
    """Background thread — sync хийгээгүй захиалгуудыг багцаар татна."""
    c = get_client()
    try:
        _job["message"] = "Гүйлгээ шалгаж байна…"
        orders = c.pos_orders_all(pos_id, paid_start, paid_end)
        ids = [o["_id"] for o in orders if o.get("_id")]
        checked = c.check_synced(ids)
        synced = {r["_id"] for r in checked if r.get("isSynced")}
        todo = [i for i in ids if i not in synced]

        _job["total"] = len(todo)
        _log(f"Нийт {len(orders)} гүйлгээ, {len(todo)} нь татагдаагүй")
        if not todo:
            _job["message"] = "Татах гүйлгээ алга — бүгд sync хийгдсэн байна"
            return

        for i in range(0, len(todo), BATCH):
            batch = todo[i:i + BATCH]
            try:
                c.sync_orders(batch)
                _job["ok"] += len(batch)
                _log(f"✓ {len(batch)} гүйлгээ татагдлаа")
            except ErxesError as e:
                _job["failed"] += len(batch)
                _log(f"✗ {len(batch)} алдаа: {str(e)[:70]}")
            _job["done"] += len(batch)
            _job["message"] = f"{_job['done']}/{_job['total']} боловсруулав"
        _job["message"] = f"Дууслаа — {_job['ok']} амжилттай, {_job['failed']} алдаатай"
    except Exception as e:
        _job["error"] = str(e)[:200]
        _log(f"АЛДАА: {str(e)[:80]}")
        _job["message"] = "Алдаа гарлаа"
    finally:
        _job["running"] = False
        _job["finished_at"] = datetime.utcnow().isoformat(timespec="seconds")


@router.post("/start")
def start(
    body: StartIn,
    _: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Татах ажиллагааг ард нь эхлүүлнэ. Явцыг /status-аас уншина."""
    with _job_lock:
        if _job["running"]:
            raise HTTPException(409, "Татах ажиллагаа аль хэдийн явж байна.")
        _reset_job(body.pos_name or body.pos_id or "Бүх POS", 0)
    threading.Thread(
        target=_run_sync,
        args=(body.pos_id, body.pos_name, body.paid_start, body.paid_end),
        daemon=True,
    ).start()
    return {"ok": True, "started": True}


@router.get("/returns")
def returns(
    start: str = Query(..., description="Буцаасан огноо эхлэл YYYY-MM-DD"),
    end: str = Query("", description="Төгсгөл. Хоосон бол start-тай ижил."),
    _: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Хугацаанд хийгдсэн Е-баримтын буцаалт/устгал — хэн хийсэн нь оруулаад.

    Яагаад хэрэгтэй вэ: захиалга erxes рүү очсон ч хэрэглэгч буцаавал
    posOrders-оос алга болно. Ингэснээр sync-ийн тоо төгс таарч байхад
    борлуулалт чимээгүй хасагдана. Огноог БУЦААСАН өдрөөр шүүнэ —
    захиалгын өдөр өөр байж болно (маргааш нь буцаасан тохиолдол гардаг)."""
    try:
        rows = get_client().pos_returns(start, end or start)
    except ErxesError as e:
        raise HTTPException(502, f"erxes: {e}")
    return {
        "count": len(rows),
        "amount": round(sum(float(r.get("amount") or 0) for r in rows)),
        "rows": rows,
    }
