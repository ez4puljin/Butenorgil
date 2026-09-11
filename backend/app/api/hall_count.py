"""Заалны тооллого — API.

Эрх:
  • Скáн / хайх / жагсаалт үзэх — НЭВТЭРСЭН ХЭН Ч (заалны ажилтнууд .apk-аар тоолно).
  • Тооллого эхлүүлэх / дахин эхлүүлэх / батлах / экспорт — admin, supervisor, manager.
  • Скáн устгах — өөрийн скáныг хэн ч; бусдынхыг admin/supervisor/manager.

Endpoint-ууд (prefix /hall-count):
  GET    /session                      — нээлттэй тооллого + дүн + төхөөрөмжүүд
  POST   /session/start                — hall_count файлаас шинэ тооллого эхлүүлэх
  POST   /session/reset                — бүх скáныг устгаж (үлдэгдэл хэвээр) дахин эхлүүлэх
  DELETE /session                      — нээлттэй тооллогыг бүрмөсөн устгах (admin)
  POST   /session/confirm              — батлах {uncounted_as_zero, note}
  GET    /lookup?q=                    — баркод/код → бараа + тооллогын мөр
  POST   /scan                         — {code, qty, device_id, device_label}
  GET    /items?filter=&q=&limit=&offset=
  GET    /items/{item_id}/scans
  DELETE /scans/{scan_id}
  GET    /sessions                     — түүх (батлагдсан)
  POST   /sessions/{id}/reopen         — батлагдсаныг буцааж нээх (admin)
  GET    /sessions/{id}/export-preview
  GET    /sessions/{id}/export?kind=income|expense|report&date=&note=&account=&related_account=&location=
"""
from __future__ import annotations

import re
from datetime import datetime, date as date_cls
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, require_role
from app.core.audit import audit
from app.models.balance_file import BAL_KIND_HALL_COUNT, BalanceFile
from app.models.hall_count import (
    HallCountItem,
    HallCountScan,
    HallCountSession,
    HC_STATUS_CONFIRMED,
    HC_STATUS_OPEN,
)
from app.models.user import User
from app.services import hall_count as svc

router = APIRouter(prefix="/hall-count", tags=["hall-count"])

BALANCE_UPLOAD_DIR = Path("app/data/uploads/balance")
MANAGER_ROLES = ("admin", "supervisor", "manager")
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _is_manager(u: User) -> bool:
    eff = u.base_role if u.base_role else u.role
    return eff in MANAGER_ROLES


def _uid(u: User) -> int:
    return int(getattr(u, "id", 0) or 0)


def _uname(u: User) -> str:
    return str(getattr(u, "nickname", "") or getattr(u, "username", "") or "")


def _iso(d: Optional[datetime]) -> Optional[str]:
    return d.isoformat() if d else None


def _sess_dict(s: HallCountSession) -> dict:
    return {
        "id": s.id, "status": s.status,
        "created_at": _iso(s.created_at), "created_by": s.created_by_name or "",
        "source_filename": s.source_filename or "",
        "balance_uploaded_at": _iso(s.balance_uploaded_at),
        "item_count": s.item_count or 0,
        "confirmed_at": _iso(s.confirmed_at), "confirmed_by": s.confirmed_by_name or "",
        "note": s.note or "", "uncounted_as_zero": bool(s.uncounted_as_zero),
        "sum_counted_items": s.sum_counted_items or 0, "sum_diff_items": s.sum_diff_items or 0,
        "sum_surplus_amount": s.sum_surplus_amount or 0.0,
        "sum_shortage_amount": s.sum_shortage_amount or 0.0,
    }


def _item_dict(it: HallCountItem, devices: Optional[list[dict]] = None, uz: bool = False) -> dict:
    """uz=False: тоолоогүй барааны зөрүүг харуулахгүй (нээлттэй тооллогод «—»).
    Тоолоогүйг 0 гэж тооцох эсэхийг зөвхөн батлах үед шийднэ."""
    d = svc.item_diff(it, uz)
    return {
        "id": it.id, "code": it.code, "name": it.name,
        "balance_qty": it.balance_qty, "unit_cost": it.unit_cost, "in_list": bool(it.in_list),
        "counted_qty": it.counted_qty, "scan_count": it.scan_count, "device_count": it.device_count,
        "last_scanned_at": _iso(it.last_scanned_at),
        "diff": d, "diff_amount": (round(d * (it.unit_cost or 0), 2) if d is not None else None),
        "status": svc.classify(it),
        "devices": devices if devices is not None else [],
    }


def _scan_dict(s: HallCountScan) -> dict:
    return {
        "id": s.id, "item_id": s.item_id, "code": s.code, "qty": s.qty,
        "device_id": s.device_id, "device_label": s.device_label,
        "user_id": s.user_id, "username": s.username, "created_at": _iso(s.created_at),
    }


def _get_open(db: Session) -> HallCountSession:
    s = svc.open_session(db)
    if not s:
        raise HTTPException(409, "Нээлттэй заалны тооллого алга. Эхлээд «Заалны тоолох барааны үлдэгдэл» файл оруулна уу.")
    return s


def _hall_balance_path(db: Session) -> tuple[Path, str]:
    bf = db.query(BalanceFile).filter(BalanceFile.kind == BAL_KIND_HALL_COUNT).first()
    if not bf or not bf.stored_filename:
        raise HTTPException(400, "«Заалны тоолох барааны үлдэгдэл» файл оруулаагүй байна (/imports/balance-file).")
    p = BALANCE_UPLOAD_DIR / bf.stored_filename
    if not p.exists():
        raise HTTPException(400, "Хадгалсан үлдэгдлийн файл олдсонгүй — дахин оруулна уу.")
    return p, bf.original_filename or bf.stored_filename


# ── Session ──────────────────────────────────────────────────────────────────

@router.get("/session")
def get_session(db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    s = svc.open_session(db)
    if not s:
        bf = db.query(BalanceFile).filter(BalanceFile.kind == BAL_KIND_HALL_COUNT).first()
        return {"session": None, "summary": None, "devices": [],
                "balance_file": ({"filename": bf.original_filename, "uploaded_at": _iso(bf.uploaded_at)} if bf else None),
                "can_manage": _is_manager(u)}
    return {
        "session": _sess_dict(s),
        "summary": svc.session_summary(db, s),
        "devices": svc.session_devices(db, s.id),
        "can_manage": _is_manager(u),
    }


@router.post("/session/start")
def start_session(
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role(*MANAGER_ROLES)),
):
    """hall_count үлдэгдлийн файлаас ШИНЭ тооллого эхлүүлнэ (нээлттэй байвал 409)."""
    if svc.open_session(db):
        raise HTTPException(409, "Нээлттэй тооллого аль хэдийн байна. Батлах эсвэл устгасны дараа шинээр эхлүүлнэ.")
    path, fname = _hall_balance_path(db)
    s = svc.sync_session_from_file(db, path, filename=fname, user_id=_uid(u), user_name=_uname(u))
    db.commit()
    audit(db, request, u, action="hall_count_start", entity_type="hall_count_session",
          entity_id=s.id, extra={"items": s.item_count, "file": fname}, autocommit=True)
    return {"ok": True, "session": _sess_dict(s)}


@router.post("/session/reset")
def reset_session(
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role(*MANAGER_ROLES)),
):
    """Бүх скáныг устгаж 0-ээс эхлүүлнэ. Үлдэгдэл хэвээр. Жагсаалтад байгаагүй мөр устна."""
    s = _get_open(db)
    n = db.query(HallCountScan).filter(HallCountScan.session_id == s.id).delete(synchronize_session=False)
    db.query(HallCountItem).filter(HallCountItem.session_id == s.id, HallCountItem.in_list == False).delete(synchronize_session=False)  # noqa: E712
    db.query(HallCountItem).filter(HallCountItem.session_id == s.id).update(
        {"counted_qty": 0.0, "scan_count": 0, "device_count": 0, "last_scanned_at": None},
        synchronize_session=False)
    db.commit()
    audit(db, request, u, action="hall_count_reset", entity_type="hall_count_session",
          entity_id=s.id, extra={"scans_removed": int(n or 0)}, autocommit=True)
    return {"ok": True, "scans_removed": int(n or 0)}


@router.delete("/session")
def discard_session(
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    s = _get_open(db)
    db.query(HallCountScan).filter(HallCountScan.session_id == s.id).delete(synchronize_session=False)
    db.query(HallCountItem).filter(HallCountItem.session_id == s.id).delete(synchronize_session=False)
    sid = s.id
    db.delete(s)
    db.commit()
    audit(db, request, u, action="hall_count_discard", entity_type="hall_count_session",
          entity_id=sid, autocommit=True)
    return {"ok": True}


class ConfirmIn(BaseModel):
    uncounted_as_zero: bool = True
    note: str = ""


@router.post("/session/confirm")
def confirm_session(
    body: ConfirmIn,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role(*MANAGER_ROLES)),
):
    s = _get_open(db)
    summ = svc.session_summary(db, s)
    if summ["scan_total"] <= 0:
        raise HTTPException(400, "Нэг ч бараа уншуулаагүй байна — батлах зүйл алга.")
    s.uncounted_as_zero = bool(body.uncounted_as_zero)
    s.note = (body.note or "").strip()[:500]
    s.status = HC_STATUS_CONFIRMED
    s.confirmed_at = datetime.utcnow()
    s.confirmed_by_id = _uid(u)
    s.confirmed_by_name = _uname(u)
    c = summ["counts"]
    s.sum_counted_items = c["counted"]
    s.sum_diff_items = c["diff"] + (c["uncounted"] if s.uncounted_as_zero else 0)
    s.sum_surplus_amount = summ["surplus_amount"]
    s.sum_shortage_amount = summ["shortage_amount"] + (summ["uncounted_amount"] if s.uncounted_as_zero else 0)
    db.commit()
    audit(db, request, u, action="hall_count_confirm", entity_type="hall_count_session",
          entity_id=s.id, extra={"counts": c, "uncounted_as_zero": s.uncounted_as_zero}, autocommit=True)
    return {"ok": True, "session": _sess_dict(s), "export_preview": svc.export_preview(db, s)}


# ── Хайх / скáн ──────────────────────────────────────────────────────────────

def _session_codes(db: Session, session_id: int) -> set[str]:
    return {c for (c,) in db.query(HallCountItem.code).filter(HallCountItem.session_id == session_id).all()}


def _lookup_impl(db: Session, s: HallCountSession, q: str, device_id: str) -> dict:
    qn = svc._norm_code(q)
    item = db.query(HallCountItem).filter(HallCountItem.session_id == s.id, HallCountItem.code == qn).first()
    product = None
    if not item:
        product = svc.resolve_product(db, qn, _session_codes(db, s.id))
        if product:
            item = (db.query(HallCountItem)
                      .filter(HallCountItem.session_id == s.id, HallCountItem.code == product.item_code).first())
    if not item and not product:
        return {"query": q, "found": False, "item": None, "product": None}
    code = item.code if item else product.item_code
    if product is None:
        product = db.query(svc.Product).filter(svc.Product.item_code == code).first()
    devices = svc.device_breakdown(db, s.id, [item.id])[item.id] if item else []
    my_qty = 0.0
    if item and device_id:
        my_qty = float(sum(d["qty"] for d in devices if d["device_id"] == device_id))
    return {
        "query": q, "found": True,
        "item": _item_dict(item, devices) if item else None,
        "my_device_qty": my_qty,
        "product": ({
            "code": product.item_code, "name": product.name or "",
            "barcode": product.barcode or "", "warehouse_name": product.warehouse_name or "",
            "last_purchase_price": float(product.last_purchase_price or 0),
        } if product else {"code": code, "name": item.name if item else "", "barcode": "",
                           "warehouse_name": "", "last_purchase_price": 0.0}),
    }


@router.get("/lookup")
def lookup(
    q: str = Query(..., min_length=1, max_length=80),
    device_id: str = Query("", max_length=64),
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    s = _get_open(db)
    return _lookup_impl(db, s, q, device_id)


class ScanIn(BaseModel):
    code: str                 # баркод эсвэл код (lookup-тай ижил тайлагдана)
    qty: float
    device_id: str = ""
    device_label: str = ""


@router.post("/scan")
def add_scan(
    body: ScanIn,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    s = _get_open(db)
    qty = float(body.qty or 0)
    if abs(qty) < svc.EPS:
        raise HTTPException(400, "Тоо 0 байж болохгүй.")
    if abs(qty) > 100000:
        raise HTTPException(400, "Тоо хэт их байна.")
    qn = svc._norm_code(body.code)
    item = db.query(HallCountItem).filter(HallCountItem.session_id == s.id, HallCountItem.code == qn).first()
    product = None
    if not item:
        product = svc.resolve_product(db, qn, _session_codes(db, s.id))
        if not product:
            raise HTTPException(404, f"«{body.code}» бараа олдсонгүй (баркод ч, код ч таарсангүй).")
        item = (db.query(HallCountItem)
                  .filter(HallCountItem.session_id == s.id, HallCountItem.code == product.item_code).first())
        if not item:
            # Жагсаалтад байгаагүй бараа — үлдэгдэл 0-тэйгээр нэмнэ (хэрэглэгч тэмдэглэгээг харна)
            item = HallCountItem(
                session_id=s.id, code=product.item_code, name=product.name or "",
                balance_qty=0.0, unit_cost=float(product.last_purchase_price or 0), in_list=False,
            )
            db.add(item)
            try:
                db.flush()
            except IntegrityError:
                # Хоёр утас нэг шинэ барааг зэрэг уншуулсан — нөгөө нь түрүүлж үүсгэсэн
                db.rollback()
                item = (db.query(HallCountItem)
                          .filter(HallCountItem.session_id == s.id, HallCountItem.code == product.item_code).first())
                if not item:
                    raise HTTPException(500, "Мөр үүсгэж чадсангүй — дахин оролдоно уу.")
    if item.counted_qty + qty < -svc.EPS:
        raise HTTPException(400, f"Тоолсон тоо сөрөг болно (одоо {svc._num(item.counted_qty)}).")
    device_id = (body.device_id or "").strip()[:64]
    scan = HallCountScan(
        session_id=s.id, item_id=item.id, code=item.code, qty=qty,
        device_id=device_id or f"user-{_uid(u)}",
        device_label=(body.device_label or "").strip()[:120] or _uname(u),
        user_id=_uid(u), username=_uname(u), created_at=datetime.utcnow(),
    )
    db.add(scan)
    db.flush()
    svc.recount_item(db, item)
    db.commit()
    devices = svc.device_breakdown(db, s.id, [item.id]).get(item.id, [])
    my_qty = float(sum(d["qty"] for d in devices if d["device_id"] == scan.device_id))
    return {"ok": True, "scan": _scan_dict(scan), "item": _item_dict(item, devices), "my_device_qty": my_qty}


@router.get("/items")
def list_items(
    filter: str = Query("all"),
    q: str = Query("", max_length=80),
    device_id: str = Query("", max_length=64),
    limit: int = Query(300, ge=1, le=3000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """filter: all | counted | matched | diff | uncounted | multi_device | not_in_list | mine
    (mine = энэ төхөөрөмжөөс уншуулсан). Хайлт код/нэрээр."""
    s = _get_open(db)
    qry = db.query(HallCountItem).filter(HallCountItem.session_id == s.id)
    if q.strip():
        like = f"%{q.strip()}%"
        qry = qry.filter(or_(HallCountItem.code.like(like), HallCountItem.name.like(like)))
    if filter == "counted":
        qry = qry.filter(HallCountItem.scan_count > 0)
    elif filter == "uncounted":
        qry = qry.filter(HallCountItem.scan_count <= 0, HallCountItem.in_list == True)  # noqa: E712
    elif filter == "multi_device":
        qry = qry.filter(HallCountItem.device_count >= 2)
    elif filter == "not_in_list":
        qry = qry.filter(HallCountItem.in_list == False)  # noqa: E712
    elif filter == "mine":
        if not device_id:
            raise HTTPException(400, "device_id шаардлагатай.")
        sub = (db.query(HallCountScan.item_id).filter(HallCountScan.session_id == s.id,
                                                        HallCountScan.device_id == device_id).distinct())
        qry = qry.filter(HallCountItem.id.in_(sub))
    elif filter in ("matched", "diff"):
        qry = qry.filter(HallCountItem.scan_count > 0)
    elif filter != "all":
        raise HTTPException(400, "filter буруу.")
    rows = qry.all()
    if filter == "matched":
        rows = [it for it in rows if svc.classify(it) == "matched"]
    elif filter == "diff":
        rows = [it for it in rows if svc.classify(it) in ("diff", "not_in_list")]

    def sort_key(it: HallCountItem):
        if filter in ("diff", "multi_device", "not_in_list"):
            return (-abs((it.counted_qty - it.balance_qty) * (it.unit_cost or 0)), it.code)
        if filter in ("counted", "matched", "mine"):
            return (-(it.last_scanned_at.timestamp() if it.last_scanned_at else 0), it.code)
        if filter == "uncounted":
            return (-(it.balance_qty * (it.unit_cost or 0)), it.code)
        # all: уншуулсан нь эхэнд (сүүлд уншуулсан дээр), дараа нь тоолоогүй нэрээр
        return (0 if it.scan_count > 0 else 1,
                -(it.last_scanned_at.timestamp() if it.last_scanned_at else 0), it.name, it.code)

    rows.sort(key=sort_key)
    total = len(rows)
    page = rows[offset:offset + limit]
    dev = svc.device_breakdown(db, s.id, [it.id for it in page if it.scan_count > 0])
    return {
        "total": total, "offset": offset, "limit": limit,
        "items": [_item_dict(it, dev.get(it.id, [])) for it in page],
    }


@router.get("/items/{item_id}/scans")
def item_scans(item_id: int, db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    it = db.query(HallCountItem).filter(HallCountItem.id == item_id).first()
    if not it:
        raise HTTPException(404, "Мөр олдсонгүй.")
    scans = (db.query(HallCountScan).filter(HallCountScan.item_id == item_id)
               .order_by(HallCountScan.created_at.desc()).all())
    return {"item": _item_dict(it, svc.device_breakdown(db, it.session_id, [it.id]).get(it.id, [])),
            "scans": [_scan_dict(x) for x in scans]}


@router.delete("/scans/{scan_id}")
def delete_scan(
    scan_id: int,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    sc = db.query(HallCountScan).filter(HallCountScan.id == scan_id).first()
    if not sc:
        raise HTTPException(404, "Скáн олдсонгүй.")
    sess = db.query(HallCountSession).filter(HallCountSession.id == sc.session_id).first()
    if not sess or sess.status != HC_STATUS_OPEN:
        raise HTTPException(409, "Батлагдсан тооллогын скáныг өөрчлөх боломжгүй.")
    if not _is_manager(u) and sc.user_id != _uid(u):
        raise HTTPException(403, "Зөвхөн өөрийн уншуулсан бүртгэлийг устгаж болно.")
    item = db.query(HallCountItem).filter(HallCountItem.id == sc.item_id).first()
    info = _scan_dict(sc)
    db.delete(sc)
    db.flush()
    removed_item = False
    if item:
        svc.recount_item(db, item)
        if item.scan_count == 0 and not item.in_list:
            db.delete(item)
            removed_item = True
    db.commit()
    audit(db, request, u, action="hall_count_scan_delete", entity_type="hall_count_scan",
          entity_id=scan_id, extra=info, autocommit=True)
    return {"ok": True, "item": (None if (removed_item or not item) else
                                 _item_dict(item, svc.device_breakdown(db, sess.id, [item.id]).get(item.id, [])))}


# ── Түүх / экспорт ───────────────────────────────────────────────────────────

@router.get("/sessions")
def list_sessions(
    limit: int = Query(30, ge=1, le=200),
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    rows = (db.query(HallCountSession).filter(HallCountSession.status == HC_STATUS_CONFIRMED)
              .order_by(HallCountSession.confirmed_at.desc()).limit(limit).all())
    return [_sess_dict(s) for s in rows]


@router.post("/sessions/{session_id}/reopen")
def reopen_session(
    session_id: int,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    s = db.query(HallCountSession).filter(HallCountSession.id == session_id).first()
    if not s:
        raise HTTPException(404, "Тооллого олдсонгүй.")
    if s.status == HC_STATUS_OPEN:
        return {"ok": True, "session": _sess_dict(s)}
    if svc.open_session(db):
        raise HTTPException(409, "Өөр нээлттэй тооллого байна — эхлээд түүнийг батлах/устгана уу.")
    s.status = HC_STATUS_OPEN
    s.confirmed_at = None
    s.confirmed_by_id = 0
    s.confirmed_by_name = ""
    db.commit()
    audit(db, request, u, action="hall_count_reopen", entity_type="hall_count_session",
          entity_id=s.id, autocommit=True)
    return {"ok": True, "session": _sess_dict(s)}


def _get_session_any(db: Session, session_id: int) -> HallCountSession:
    s = db.query(HallCountSession).filter(HallCountSession.id == session_id).first()
    if not s:
        raise HTTPException(404, "Тооллого олдсонгүй.")
    return s


@router.get("/sessions/{session_id}/export-preview")
def export_preview(
    session_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role(*MANAGER_ROLES)),
):
    s = _get_session_any(db, session_id)
    return {"session": _sess_dict(s), "preview": svc.export_preview(db, s)}


def _xlsx_response(data: bytes, filename: str) -> Response:
    ascii_fallback = re.sub(r"[^\w\-.]", "_", filename.encode("ascii", "ignore").decode("ascii")) or "export.xlsx"
    return Response(
        content=data, media_type=XLSX_MIME,
        headers={"Content-Disposition": f"attachment; filename={ascii_fallback}; filename*=UTF-8''{quote(filename, safe='')}"},
    )


@router.get("/sessions/{session_id}/export")
def export_session(
    session_id: int,
    request: Request,
    kind: str = Query(..., pattern="^(income|expense|report)$"),
    date: str = Query(""),
    note: str = Query("", max_length=200),
    account: str = Query("", max_length=40),
    related_account: str = Query("", max_length=40),
    location: str = Query("", max_length=40),
    db: Session = Depends(get_db),
    u: User = Depends(require_role(*MANAGER_ROLES)),
):
    s = _get_session_any(db, session_id)
    if kind == "report":
        data, fname = svc.build_report_xlsx(db, s)
        return _xlsx_response(data, fname)

    # Орлого/зарлага — зөвхөн БАТЛАГДСАН тооллогоос. Нээлттэй үед гаргавал
    # дараа нь өөрчлөгдөж Эрхэт дээр буруу/давхар бүртгэл үүснэ.
    if s.status != HC_STATUS_CONFIRMED:
        raise HTTPException(400, "Эхлээд тооллогыг батална уу — батлагдаагүй тооллогоос импорт файл гаргахгүй.")
    if not account.strip():
        raise HTTPException(400, "«Данс» хоосон байна (жишээ 150101).")
    if not location.strip():
        raise HTTPException(400, "«Барааны байршил» (заалны кодыг) оруулна уу.")
    try:
        d = datetime.strptime(date, "%Y-%m-%d").date() if date else (s.confirmed_at or datetime.utcnow()).date()
    except ValueError:
        raise HTTPException(400, "Огноо YYYY-MM-DD хэлбэртэй байх ёстой.")
    if not note.strip():
        note = f"Заалны тооллогын {'илүүдэл' if kind == 'income' else 'дутагдал'} {d:%Y-%m-%d}"
    data, fname, stats = svc.build_erp_xlsx(
        db, s, kind=kind, doc_date=d, note=note.strip(),
        account=account.strip(), related_account=related_account.strip(), location=location.strip(),
    )
    if stats["rows"] == 0:
        why = ("Илүүдэлтэй мөр алга." if kind == "income" else "Дутагдалтай мөр алга.")
        if kind == "income" and stats["skipped"]:
            why += f" ({stats['skipped']} мөр үнэгүй тул хасагдав — тайланг харна уу.)"
        raise HTTPException(400, why)
    audit(db, request, u, action=f"hall_count_export_{kind}", entity_type="hall_count_session",
          entity_id=s.id, extra=stats, autocommit=True)
    return _xlsx_response(data, fname)
