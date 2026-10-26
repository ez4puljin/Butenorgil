"""Үнийн тохиргоо — Хархорин агуулахын үнэ vs сүүлийн орлого (app/services/price_cost). 2-р шат: ЗӨВХӨН УНШИНА.

  GET  /price-cost/data       — сүүлийн үр дүн + төлөв + тохиргоо + сүүлийн синкүүд
  POST /price-cost/run        — гараар шинэчлэх (?full=true — Эрхэтийн орлогыг оны эхнээс)
  PUT  /price-cost/settings   — {brands, accounts, exclude_customers, locations, guard_pct, max_apply} (admin)
  GET  /price-cost/xlsx       — Excel экспорт
  POST /price-cost/apply      — {codes} сонгосон бараанд plan үүсгэх/засах (admin, erxes рүү БИЧНЭ)
  POST /price-cost/rollback   — {batch} тухайн багцыг буцаах (admin)
  GET  /price-cost/batch      — батлалт/буцаалтын явц
  GET  /price-cost/audit      — өөрчлөлтийн бүртгэл
(bare GET /price-cost-г тавихгүй — frontend хуудасны замтай давхцана.)
"""
from __future__ import annotations

import io
import json
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, require_role
from app.models.price_cost import PcPriceAudit, PcSyncRun
from app.models.user import User
from app.services import price_cost as svc
from app.services import price_cost_apply as ap
from app.core.audit import audit

router = APIRouter(prefix="/price-cost", tags=["price-cost"])

STATUS_LABEL = {"eq": "Таарч байна", "high": "Орлогоос өндөр", "low": "Орлогоос доогуур", "none": "Орлогогүй"}


@router.get("/data")
def data(db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    runs = db.query(PcSyncRun).order_by(PcSyncRun.id.desc()).limit(10).all()
    return {
        "result": svc.load_result(), "status": svc.status(), "settings": svc.load_settings(),
        "is_admin": (u.base_role or u.role) == "admin",
        "runs": [{"id": r.id, "started_at": r.started_at.isoformat() + "Z" if r.started_at else None,
                  "finished_at": r.finished_at.isoformat() + "Z" if r.finished_at else None,
                  "status": r.status, "by": r.by, "stats": json.loads(r.stats or "{}"),
                  "error": (r.error or "").strip().splitlines()[-1][:200] if r.error else ""} for r in runs],
    }


@router.post("/run")
def run(full: bool = False, u: User = Depends(get_current_user)):
    try:
        svc.run_bg(by=u.username, full=full)
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return {"ok": True, "status": svc.status()}


class SettingsIn(BaseModel):
    brands: Optional[list[str]] = None
    exclude_customers: Optional[list[str]] = None
    accounts: Optional[list[str]] = None
    locations: Optional[list[str]] = None
    guard_pct: Optional[int] = None
    max_apply: Optional[int] = None


@router.put("/settings")
def put_settings(body: SettingsIn, u: User = Depends(require_role("admin"))):
    return {"settings": svc.save_settings(body.model_dump(exclude_none=True))}


class ApplyIn(BaseModel):
    codes: list[str]


def _refresh_after():
    """Батлалт дууссаны дараа самбарыг шинэчилнэ (print үнэ дахин уншина)."""
    import threading
    import time as _t

    def wait():
        while ap.batch_status()["running"]:
            _t.sleep(2)
        try:
            svc.run(by="батлалтын дараа", manual=False)
        except Exception as e:  # noqa: BLE001
            print(f"[price_cost] батлалтын дараах шинэчлэл: {e}")
    threading.Thread(target=wait, daemon=True).start()


@router.post("/apply")
def apply(body: ApplyIn, request: Request, db: Session = Depends(get_db), u: User = Depends(require_role("admin"))):
    """Сонгосон бараанд [AUTO-COST HA] plan үүсгэх/засах (erxes рүү БИЧНЭ) — зөвхөн admin."""
    res = svc.load_result() or {}
    by_code = {r["code"]: r for r in res.get("rows", [])}
    bad = [c for c in body.codes if not by_code.get(c, {}).get("action") or by_code[c].get("review")]
    if bad:
        raise HTTPException(400, f"Санал болгоогүй эсвэл «шалгах» төлөвтэй бараа: {', '.join(bad[:10])}")
    try:
        b = ap.apply_codes(body.codes, by=u.username, max_apply=int(svc.load_settings()["max_apply"]))
    except ap.ApplyError as e:
        raise HTTPException(409, str(e))
    audit(db, request, u, action="price_cost_apply", entity_type="price_cost",
          extra={"batch": b, "codes": body.codes[:200]}, autocommit=True)
    _refresh_after()
    return {"batch": b, "status": ap.batch_status()}


class RollbackIn(BaseModel):
    batch: str


@router.post("/rollback")
def rollback(body: RollbackIn, request: Request, db: Session = Depends(get_db),
             u: User = Depends(require_role("admin"))):
    try:
        b = ap.rollback_batch(body.batch, by=u.username)
    except ap.ApplyError as e:
        raise HTTPException(409, str(e))
    audit(db, request, u, action="price_cost_rollback", entity_type="price_cost",
          extra={"batch": body.batch, "rollback_batch": b}, autocommit=True)
    _refresh_after()
    return {"batch": b, "status": ap.batch_status()}


@router.get("/batch")
def batch(_: User = Depends(get_current_user)):
    return ap.batch_status()


@router.get("/audit")
def audit_log(limit: int = 300, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    rows = db.query(PcPriceAudit).order_by(PcPriceAudit.id.desc()).limit(min(limit, 2000)).all()
    return [{"id": r.id, "at": r.at.isoformat() + "Z", "by": r.by, "action": r.action, "batch": r.batch,
             "plan_id": r.plan_id, "code": r.code, "name": r.name, "old": r.old_value, "new": r.new_value,
             "bill": r.bill_number, "note": r.note} for r in rows]


@router.get("/xlsx")
def xlsx(_: User = Depends(get_current_user)):
    res = svc.load_result()
    if not res:
        raise HTTPException(404, "Синк хийгдээгүй байна.")
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    wb = Workbook()
    ws = wb.active
    ws.title = "Үнийн тохиргоо"
    head = ["Код", "Нэр", "Брэнд", "Хэмжих нэгж", "Орлогын огноо", "Нийлүүлэгч", "Баримт №", "Орлогын тоо",
            "Орлогын нэгж үнэ", "Өмнөх орлого", "erxes үндсэн үнэ", "Тохиргоот үнэ", "Тохиргоо − орлого",
            "Тохиргоо %", "Сүүлд зарсан үнэ", "Зарсан огноо", "Захиалга №", "Бодит − орлого", "Бодит %",
            "Орлогоос хойш борлуулалт", "Зарсан үнүүд", "Төлөв", "Бусдын plan", "Plan-ууд", "Санал"]
    ws.append(head)
    fill = {"eq": "E8F5E9", "high": "FFF8E1", "low": "FFEBEE", "none": "F5F5F5"}
    for r in res["rows"]:
        ws.append([r["code"], r["name"], r["brand"], r["uom"], r["income_date"], r["income_customer"], r["income_bill"],
                   r["income_count"], r["income"], r["prev_income"], r["base"], r["config"], r["diff_config"],
                   (r["diff_config_pct"] or 0) / 100 if r["diff_config_pct"] is not None else None,
                   r["real"], r["real_date"], r["real_order"], r["diff_real"],
                   (r["diff_real_pct"] or 0) / 100 if r["diff_real_pct"] is not None else None,
                   r["since_count"], ", ".join(f"{x:,.0f}" for x in r["since_prices"]),
                   STATUS_LABEL.get(r["status"], r["status"]), r["others"],
                   "; ".join(f'{p["name"]} ({p["type"]} {p["value"]})' for p in r["plans"]),
                   {"create": "Plan үүсгэх", "update": "Plan засах"}.get(r["action"], "")
                   + (" — шалгах" if r["review"] else "") + (" (бутархай үнэ)" if r.get("fractional") else "")])
        ws.cell(ws.max_row, 22).fill = PatternFill("solid", start_color=fill.get(r["status"], "FFFFFF"))
    for c in ws[1]:
        c.font = Font(bold=True, name="Arial")
        c.alignment = Alignment(wrap_text=True, vertical="center")
    for col in ("I", "J", "K", "L", "M", "O", "R"):
        for cell in ws[col][1:]:
            cell.number_format = "#,##0.##;-#,##0.##;-"
    for col in ("N", "S"):
        for cell in ws[col][1:]:
            cell.number_format = "0.0%"
    widths = [9, 34, 18, 9, 11, 26, 14, 9, 12, 12, 12, 12, 12, 9, 12, 16, 15, 12, 9, 10, 18, 16, 8, 50, 16]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[ws.cell(1, i).column_letter].width = w
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = ws.dimensions
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    fn = f"Үнийн тохиргоо {res.get('generated_at', '')[:10]}.xlsx"
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(fn)}"})
