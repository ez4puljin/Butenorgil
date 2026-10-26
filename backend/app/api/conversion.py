"""Хөрвүүлэлтийн бараа (app/services/conversion).

  GET  /conversion/products?q=                 — бараа хайх (код, баркод, нэр)
  GET  /conversion/settings  · PUT (admin)     — erxes stage/харилцагч, Эрхэтийн харилцагч/данс/байршил
  GET  /conversion/orders?status=              — жагсаалт
  POST /conversion/orders                      — {lines:[{code, qty}], note, conv_date} → erxes deal үүсгэнэ
  GET  /conversion/orders/{id}
  PUT  /conversion/orders/{id}                 — {conv_date, note}
  PUT  /conversion/orders/{id}/lines/{line_id} — {results:[{code, qty}]} хөрвүүлэлтийн үр дүн
  PUT  /conversion/orders/{id}/lines         — {lines:[{code, qty}]} задлах барааг засах (Эрхэтэд зарлага ороогүй үед)
  POST /conversion/orders/{id}/sync-deal     — erxes deal-ийн одоогийн тоогоор мөрийг шинэчлэх
  POST /conversion/orders/{id}/cancel
  GET  /conversion/orders/{id}/xlsx?kind=so|income
  POST /conversion/orders/{id}/erkhet          — {confirm:true} Эрхэт рүү зарлага + орлого (НЭГ удаа)
"""
from __future__ import annotations

import json
from datetime import date, datetime
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, require_role
from app.core.audit import audit
from app.models.conversion import ConversionLine, ConversionOrder, ConversionResult
from app.models.user import User
from app.services import conversion as svc
from app.services import erkhet_import

router = APIRouter(prefix="/conversion", tags=["conversion"])
SEND_ROLES = erkhet_import.IMPORT_ROLES            # Эрхэт рүү импорт — admin, accountant, supervisor
MAX_LINES = 100


def _get(db: Session, oid: int) -> ConversionOrder:
    o = db.get(ConversionOrder, oid)
    if not o:
        raise HTTPException(404, "Хөрвүүлэлт олдсонгүй.")
    return o


def _refresh_erkhet(db: Session, o: ConversionOrder) -> None:
    """Эрхэтийн queue-ээс зарлага/орлогын бодит төлөвийг шинэчилнэ. Аль нэг нь амжилтгүй бол
    захиалгыг «converted» буцааж, «Эрхэт рүү илгээх» дахин гарна — дахин илгээхэд ЗӨВХӨН амжилтгүй хэсэг явна.
    (2026-10-26 #1: илгээх үед хоёулаа «queued», орлого дараа нь Эрхэтийн DB deadlock-оор унасан.)"""
    from app.models.purchase_order import ErkhetImportLog
    res: dict = json.loads(o.erkhet_result or "{}")
    ids = {k: (v or {}).get("log_id") for k, v in res.items() if (v or {}).get("status") in ("queued", "unknown")}
    if not ids:
        return
    logs = {l.id: l for l in db.query(ErkhetImportLog).filter(ErkhetImportLog.id.in_([i for i in ids.values() if i])).all()}
    try:
        erkhet_import.refresh_logs(db, list(logs.values()))
    except Exception as e:      # noqa: BLE001 — Эрхэт түр хүрэхгүй бол хуучин төлөвөөр
        print(f"[conversion] Эрхэтийн төлөв шинэчилж чадсангүй: {e}")
        return
    for k, lid in ids.items():
        l = logs.get(lid)
        if l:
            res[k].update(status=l.status, message=l.message, queue_id=l.queue_id or None)
    o.erkhet_result = json.dumps(res, ensure_ascii=False)
    if any((res.get(k) or {}).get("status") == "fail" for k in ("so", "income")) and o.status == "sent":
        o.status = "converted"
    db.commit()


def _role(u: User) -> str:
    return (getattr(u, "base_role", None) or u.role or "").lower()


@router.get("/products")
def products(q: str = "", scope: str = "", _: User = Depends(get_current_user)):
    """scope=result — «юу болгож хөрвүүлсэн» сонголт: зөвхөн тохиргооны segment-ийн бараа."""
    try:
        return {"items": svc.search_results(q) if scope == "result" else svc.search(q)}
    except Exception as e:      # noqa: BLE001
        raise HTTPException(502, f"Барааны жагсаалт ачаалж чадсангүй: {str(e)[:120]}")


@router.get("/settings")
def get_settings(u: User = Depends(get_current_user)):
    return {**svc.load_settings(), "can_send": _role(u) in SEND_ROLES}


@router.put("/settings")
def put_settings(body: dict, _: User = Depends(require_role("admin"))):
    return svc.save_settings(body)


@router.get("/orders")
def list_orders(status: str = "", limit: int = 50, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    q = db.query(ConversionOrder)
    if status:
        q = q.filter(ConversionOrder.status.in_(status.split(",")))
    rows = q.order_by(ConversionOrder.id.desc()).limit(min(limit, 200)).all()
    return {"items": [svc.to_dict(o, with_lines=False) for o in rows]}


class LineIn(BaseModel):
    code: str
    qty: float


class CreateIn(BaseModel):
    lines: list[LineIn]
    note: str = ""
    conv_date: Optional[str] = None
    client_uid: str = ""            # давхар илгээлтээс сэргийлэх (утасны ноорог бүрт нэг)
    with_deal: bool = True          # False — erxes захиалгагүй, зөвхөн гараар хөрвүүлэлт


@router.post("/orders")
def create_order(body: CreateIn, request: Request, db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    uid = (body.client_uid or "").strip()[:64]
    if uid:
        prev = db.query(ConversionOrder).filter(ConversionOrder.client_uid == uid).first()
        if prev:                    # хариу тасарч дахин дарсан — шинэ deal үүсгэхгүй
            return {**svc.to_dict(prev), "deduped": True}
    items: dict[str, float] = {}
    for l in body.lines:
        if l.qty and l.qty > 0 and l.code.strip():
            items[l.code.strip()] = items.get(l.code.strip(), 0) + float(l.qty)
    if not items:
        raise HTTPException(400, "Бараа сонгоогүй байна.")
    if len(items) > MAX_LINES:
        raise HTTPException(400, f"Нэг захиалгад {MAX_LINES}-аас ихгүй бараа.")
    prods = {}
    for code in items:
        p = svc.product_by_code(code)
        if not p:
            raise HTTPException(400, f"{code} код erxes-д идэвхтэй бараагаар олдсонгүй.")
        prods[code] = p
    try:
        d = date.fromisoformat(body.conv_date) if body.conv_date else svc.today_ub()
    except ValueError:
        raise HTTPException(400, "Огноо буруу.")
    o = ConversionOrder(status="ordered", conv_date=d, note=body.note.strip()[:500], client_uid=uid,
                        created_by=(u.nickname or u.username or "")[:120])
    db.add(o)
    db.flush()
    for code, qty in items.items():
        p = prods[code]
        db.add(ConversionLine(order_id=o.id, code=code, name=p["name"][:300], erxes_id=p["id"] or "",
                              uom=p["uom"], qty=qty, unit_price=p["price"]))
    db.flush()
    db.refresh(o)
    if body.with_deal:
        try:
            o.deal_id, o.deal_number = svc.create_deal(o, list(o.lines))
        except Exception as e:      # noqa: BLE001 — deal үүсээгүй бол захиалгыг хадгалахгүй
            db.rollback()
            raise HTTPException(502, f"erxes-д deal үүсгэж чадсангүй: {str(e)[:200]}")
        if not o.deal_id:
            db.rollback()
            raise HTTPException(502, "erxes deal үүсгэсэнгүй (хариу хоосон).")
    db.commit()
    audit(db, request, u, action="conversion_order", entity_type="conversion",
          extra={"id": o.id, "deal": o.deal_number or "(гараар)", "lines": len(items)}, autocommit=True)
    db.refresh(o)
    return svc.to_dict(o)


@router.get("/orders/{oid}")
def get_order(oid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    o = _get(db, oid)
    _refresh_erkhet(db, o)
    return svc.to_dict(o)


class OrderEdit(BaseModel):
    conv_date: Optional[str] = None
    note: Optional[str] = None


@router.put("/orders/{oid}")
def edit_order(oid: int, body: OrderEdit, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    o = _get(db, oid)
    if o.status in ("sent", "cancelled"):
        raise HTTPException(400, "Эрхэт рүү илгээсэн/цуцалсан хөрвүүлэлтийг засахгүй.")
    if body.conv_date:
        try:
            o.conv_date = date.fromisoformat(body.conv_date)
        except ValueError:
            raise HTTPException(400, "Огноо буруу.")
    if body.note is not None:
        o.note = body.note.strip()[:500]
    db.commit()
    return svc.to_dict(o)


class ResultsIn(BaseModel):
    results: list[LineIn]


@router.put("/orders/{oid}/lines/{line_id}")
def set_results(oid: int, line_id: int, body: ResultsIn, db: Session = Depends(get_db),
                _: User = Depends(get_current_user)):
    o = _get(db, oid)
    if o.status in ("sent", "cancelled"):
        raise HTTPException(400, "Эрхэт рүү илгээсэн/цуцалсан хөрвүүлэлтийг засахгүй.")
    line = next((l for l in o.lines if l.id == line_id), None)
    if not line:
        raise HTTPException(404, "Мөр олдсонгүй.")
    new = []
    allowed = svc.result_codes()
    for r in body.results:
        if not r.code.strip() or not r.qty or r.qty <= 0:
            continue
        p = svc.product_by_code(r.code)
        if not p:
            raise HTTPException(400, f"{r.code} код олдсонгүй.")
        if p["code"] not in allowed:
            raise HTTPException(400, f"{p['code']} {p['name']} — хөрвүүлэлтийн бараанд (segment) ороогүй.")
        new.append(ConversionResult(line_id=line.id, code=p["code"], name=p["name"][:300], uom=p["uom"],
                                    qty=float(r.qty), unit_price=p["price"]))
    for r in list(line.results):
        db.delete(r)
    db.flush()
    for r in new:
        db.add(r)
    db.flush()
    db.refresh(o)
    svc.refresh_status(o)
    db.commit()
    db.refresh(o)
    return svc.to_dict(o)


class LinesIn(BaseModel):
    lines: list[LineIn]


def _apply_lines(db: Session, o: ConversionOrder, wanted: dict[str, float]) -> dict:
    """Задлах барааны мөрийг wanted {код: тоо}-оор тааруулна. Хасагдсан мөрийн хөрвүүлэлт хамт устна,
    үлдсэн мөрийн хөрвүүлэлт хэвээр. → {added, removed, changed}."""
    cur = {l.code: l for l in o.lines}
    out = {"added": [], "removed": [], "changed": []}
    for code, l in cur.items():
        if code not in wanted or wanted[code] <= 0:
            out["removed"].append(code)
            db.delete(l)
        elif abs(l.qty - wanted[code]) > 1e-9:
            out["changed"].append({"code": code, "from": l.qty, "to": wanted[code]})
            l.qty = wanted[code]
    for code, qty in wanted.items():
        if qty > 0 and code not in cur:
            p = svc.product_by_code(code)
            if not p:
                raise HTTPException(400, f"{code} код erxes-д идэвхтэй бараагаар олдсонгүй.")
            db.add(ConversionLine(order_id=o.id, code=code, name=p["name"][:300], erxes_id=p["id"] or "",
                                  uom=p["uom"], qty=qty, unit_price=p["price"]))
            out["added"].append(code)
    db.flush()
    db.refresh(o)
    if not o.lines:
        raise HTTPException(400, "Наад зах нь нэг бараа үлдэх ёстой (хөрвүүлэлтийг цуцалж болно).")
    svc.refresh_status(o)
    return out


@router.put("/orders/{oid}/lines")
def edit_lines(oid: int, body: LinesIn, request: Request, db: Session = Depends(get_db),
               u: User = Depends(get_current_user)):
    o = _get(db, oid)
    _refresh_erkhet(db, o)
    if not svc.lines_editable(o):
        raise HTTPException(400, "Эрхэтэд зарлага орсон (эсвэл цуцалсан) тул засахгүй.")
    wanted: dict[str, float] = {}
    for l in body.lines:
        if l.code.strip():
            wanted[l.code.strip()] = wanted.get(l.code.strip(), 0) + max(0.0, float(l.qty or 0))
    if len([q for q in wanted.values() if q > 0]) > MAX_LINES:
        raise HTTPException(400, f"Нэг захиалгад {MAX_LINES}-аас ихгүй бараа.")
    diff = _apply_lines(db, o, wanted)
    db.commit()
    audit(db, request, u, action="conversion_edit_lines", entity_type="conversion", extra={"id": o.id, **diff},
          autocommit=True)
    db.refresh(o)
    return {**svc.to_dict(o), "diff": diff}


@router.post("/orders/{oid}/sync-deal")
def sync_deal(oid: int, request: Request, db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    """erxes deal-ийн одоогийн тоогоор (агуулах үлдэгдэл хүрээгүй тул өөрчилсөн) мөрийг шинэчилнэ. erxes-т бичихгүй."""
    o = _get(db, oid)
    if not o.deal_id:
        raise HTTPException(400, "Энэ хөрвүүлэлт erxes захиалгагүй (гараар).")
    _refresh_erkhet(db, o)
    if not svc.lines_editable(o):
        raise HTTPException(400, "Эрхэтэд зарлага орсон (эсвэл цуцалсан) тул засахгүй.")
    try:
        rows = svc.deal_products(o.deal_id)
    except Exception as e:      # noqa: BLE001
        raise HTTPException(502, f"erxes-ээс захиалга уншиж чадсангүй: {str(e)[:150]}")
    if not rows:
        raise HTTPException(400, "erxes захиалгад бараа алга — хоосон болсон бол хөрвүүлэлтийг цуцална уу.")
    diff = _apply_lines(db, o, {r["code"]: r["qty"] for r in rows})
    db.commit()
    audit(db, request, u, action="conversion_sync_deal", entity_type="conversion", extra={"id": o.id, **diff},
          autocommit=True)
    db.refresh(o)
    return {**svc.to_dict(o), "diff": diff}


@router.post("/orders/{oid}/cancel")
def cancel(oid: int, request: Request, db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    o = _get(db, oid)
    if o.status == "sent":
        raise HTTPException(400, "Эрхэт рүү илгээсэн хөрвүүлэлтийг цуцлахгүй.")
    o.status = "cancelled"
    db.commit()
    audit(db, request, u, action="conversion_cancel", entity_type="conversion", extra={"id": o.id}, autocommit=True)
    return svc.to_dict(o)


@router.get("/orders/{oid}/xlsx")
def xlsx(oid: int, kind: str = "so", db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    if kind not in ("so", "income"):
        raise HTTPException(400, "kind буруу.")
    data, fn, n = svc.build_excel(_get(db, oid), kind)
    if not n:
        raise HTTPException(404, "Мөр алга.")
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f"attachment; filename=\"conversion_{oid}_{kind}.xlsx\"; "
                                                    f"filename*=UTF-8''{quote(fn)}"})


class SendIn(BaseModel):
    confirm: bool = False


@router.post("/orders/{oid}/erkhet")
def send_erkhet(oid: int, body: SendIn, request: Request, db: Session = Depends(get_db),
                u: User = Depends(get_current_user)):
    if _role(u) not in SEND_ROLES:
        raise HTTPException(403, "Эрхэт рүү илгээх эрхгүй (админ, нягтлан, хянагч).")
    o = _get(db, oid)
    _refresh_erkhet(db, o)
    if o.status == "sent":
        raise HTTPException(409, "Энэ хөрвүүлэлт Эрхэт рүү аль хэдийн илгээгдсэн.")
    if o.status != "converted":
        raise HTTPException(400, "Бүх мөрөнд хөрвүүлэлтийн үр дүн оруулна уу.")
    if not body.confirm:
        raise HTTPException(400, "Баталгаажуулна уу (confirm).")
    res: dict = json.loads(o.erkhet_result or "{}")
    for kind, ikind in (("so", "inv_so"), ("income", "inv_income")):
        if (res.get(kind) or {}).get("status") in ("ok", "queued", "unknown"):
            continue                                   # өмнө нь орсон хэсгийг давтахгүй
        data, fn, n = svc.build_excel(o, kind)
        log, r = erkhet_import.submit(db, data=data, filename=fn, nrows=n, year=o.conv_date.year,
                                      company=erkhet_import.IMPORT_COMPANY, brand=f"Хөрвүүлэлт #{o.id}",
                                      qty_source="conversion", username=u.username, kind=ikind, tag=f"CONV{o.id}")
        res[kind] = {"status": log.status, "log_id": log.id, "queue_id": log.queue_id or None,
                     "message": log.message, "errors": r.get("errors") or []}
        if log.status == "fail":
            break
    o.erkhet_result = json.dumps(res, ensure_ascii=False)
    if all((res.get(k) or {}).get("status") in ("ok", "queued", "unknown") for k in ("so", "income")):
        o.status, o.sent_by, o.sent_at = "sent", u.username, datetime.utcnow()
    db.commit()
    audit(db, request, u, action="conversion_erkhet", entity_type="conversion",
          extra={"id": o.id, "result": {k: (v or {}).get("status") for k, v in res.items()}}, autocommit=True)
    return svc.to_dict(o)
