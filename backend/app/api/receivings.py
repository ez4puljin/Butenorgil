"""
Бараа тулгаж авах (receiving) endpoint-ууд.
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse, FileResponse
from sqlalchemy.orm import Session
from sqlalchemy import func as _func
from datetime import date as date_type, datetime
from pathlib import Path
from pydantic import BaseModel
from typing import Optional
import io
import re

from app.api.deps import get_db, get_current_user, require_role
from app.models.receiving import ReceivingSession, ReceivingLine, ReceivingBrandStatus
from app.models.product import Product
from app.models.user import User

router = APIRouter(prefix="/receivings", tags=["receivings"])

UPLOAD_DIR = Path("app/data/uploads/receiving_receipts")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

STATUS_SEQUENCE = ["matching", "price_review", "received"]
STATUS_LABEL = {
    "matching": "Тулгаж байна",
    "price_review": "Үнэ хянагдаж байна",
    "received": "Орлого авсан",
}


# ── Schemas ────────────────────────────────────────────────────────────────────

class SessionCreateIn(BaseModel):
    date: date_type
    notes: str = ""


class SessionUpdateIn(BaseModel):
    notes: Optional[str] = None
    date: Optional[date_type] = None


class LineIn(BaseModel):
    product_id: int
    qty_pcs: float = 0.0
    unit_price: float = 0.0
    note: str = ""


class LineUpdateIn(BaseModel):
    qty_pcs: Optional[float] = None
    unit_price: Optional[float] = None
    note: Optional[str] = None


class BrandMatchIn(BaseModel):
    supplier_total_pcs: float
    supplier_total_amount: float


class StatusIn(BaseModel):
    status: str


# ── Helpers ────────────────────────────────────────────────────────────────────

def _serialize_line(ln: ReceivingLine, product: Optional[Product]) -> dict:
    pack = float(product.pack_ratio or 1) if product else 1.0
    if pack <= 0:
        pack = 1.0
    box = int(ln.qty_pcs // pack)
    extra = int(round(ln.qty_pcs - box * pack))
    total_amount = round(ln.qty_pcs * ln.unit_price, 2)
    return {
        "id": ln.id,
        "product_id": ln.product_id,
        "item_code": product.item_code if product else "",
        "name": product.name if product else "(устгагдсан)",
        "brand": product.brand if product else "",
        "warehouse_name": product.warehouse_name if product else "",
        "pack_ratio": pack,
        "unit_weight": float(product.unit_weight or 0) if product else 0,
        "last_purchase_price": float(product.last_purchase_price or 0) if product else 0,
        "qty_pcs": ln.qty_pcs,
        "stock_box": box,
        "stock_extra_pcs": extra,
        "unit_price": ln.unit_price,
        "total_amount": total_amount,
        "note": ln.note or "",
    }


def _brand_aggregate(session_id: int, db: Session) -> dict:
    """Бренд тус бүрээр нийт ширхэг + нийт дүн."""
    lines = db.query(ReceivingLine).filter(ReceivingLine.session_id == session_id).all()
    prod_ids = [l.product_id for l in lines]
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(prod_ids)).all()} if prod_ids else {}
    brands: dict[str, dict] = {}
    for l in lines:
        p = products.get(l.product_id)
        brand = (p.brand if p else "") or "Брэнд байхгүй"
        if brand not in brands:
            brands[brand] = {"brand": brand, "line_count": 0, "total_pcs": 0.0, "total_amount": 0.0, "has_price_diff": False}
        brands[brand]["line_count"] += 1
        brands[brand]["total_pcs"] += l.qty_pcs
        brands[brand]["total_amount"] += l.qty_pcs * l.unit_price
        if p and p.last_purchase_price and abs((l.unit_price or 0) - float(p.last_purchase_price)) > 0.01 and l.unit_price > 0:
            brands[brand]["has_price_diff"] = True
    # Attach brand statuses
    statuses = {
        bs.brand: bs
        for bs in db.query(ReceivingBrandStatus).filter(ReceivingBrandStatus.session_id == session_id).all()
    }
    out = []
    for b, stats in sorted(brands.items()):
        bs = statuses.get(b)
        out.append({
            **stats,
            "total_pcs": round(stats["total_pcs"], 2),
            "total_amount": round(stats["total_amount"], 2),
            "is_matched": bool(bs.is_matched) if bs else False,
            "supplier_total_pcs": float(bs.supplier_total_pcs) if bs else 0.0,
            "supplier_total_amount": float(bs.supplier_total_amount) if bs else 0.0,
            "receipt_image_path": (bs.receipt_image_path if bs else "") or "",
            "matched_at": bs.matched_at.isoformat() if bs and bs.matched_at else None,
        })
    return out


def _serialize_session(s: ReceivingSession, db: Session, include_lines: bool = True) -> dict:
    creator = db.query(User).filter(User.id == s.created_by_user_id).first()
    result = {
        "id": s.id,
        "date": s.date.isoformat(),
        "notes": s.notes or "",
        "status": s.status,
        "status_label": STATUS_LABEL.get(s.status, s.status),
        "is_archived": bool(s.is_archived),
        "created_by_username": creator.username if creator else "",
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }
    # Line + brand stats
    lines = db.query(ReceivingLine).filter(ReceivingLine.session_id == s.id).all()
    prod_ids = [l.product_id for l in lines]
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(prod_ids)).all()} if prod_ids else {}
    result["line_count"] = len(lines)
    result["total_pcs"] = round(sum(l.qty_pcs for l in lines), 2)
    result["total_amount"] = round(sum(l.qty_pcs * l.unit_price for l in lines), 2)
    # Brand info
    result["brands"] = _brand_aggregate(s.id, db)
    all_brands_matched = result["brands"] and all(b["is_matched"] for b in result["brands"])
    result["all_brands_matched"] = bool(all_brands_matched)
    if include_lines:
        result["lines"] = [_serialize_line(l, products.get(l.product_id)) for l in lines]
    return result


def _auto_advance_if_all_matched(session: ReceivingSession, db: Session):
    """Бүх брэнд matched болсон бөгөөд одоогоор 'matching' төлөвт байвал 'price_review' рүү шилжүүлнэ."""
    if session.status != "matching":
        return
    all_brands = set(
        (p.brand or "") for p in db.query(Product).join(
            ReceivingLine, ReceivingLine.product_id == Product.id
        ).filter(ReceivingLine.session_id == session.id).distinct().all()
    )
    if not all_brands:
        return
    matched_brands = set(
        bs.brand for bs in db.query(ReceivingBrandStatus).filter(
            ReceivingBrandStatus.session_id == session.id,
            ReceivingBrandStatus.is_matched == True,
        ).all()
    )
    if all_brands.issubset(matched_brands):
        session.status = "price_review"
        db.commit()


# ── Session endpoints ─────────────────────────────────────────────────────────

@router.get("")
def list_sessions(
    status: Optional[str] = Query(None),
    archived: str = Query("false"),  # false | true | only
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    q = db.query(ReceivingSession)
    arch = (archived or "false").lower()
    if arch == "only":
        if u.role not in ("admin", "manager", "supervisor"):
            raise HTTPException(403, "Архив харах эрхгүй")
        q = q.filter(ReceivingSession.is_archived == True)
    elif arch != "true":
        q = q.filter(ReceivingSession.is_archived == False)
    if status:
        q = q.filter(ReceivingSession.status == status)
    rows = q.order_by(ReceivingSession.date.desc(), ReceivingSession.id.desc()).all()
    return [_serialize_session(s, db, include_lines=False) for s in rows]


@router.post("")
def create_session(
    body: SessionCreateIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "manager", "supervisor", "warehouse_clerk", "accountant")),
):
    s = ReceivingSession(
        date=body.date,
        notes=(body.notes or "").strip(),
        status="matching",
        is_archived=False,
        created_by_user_id=u.id,
    )
    db.add(s); db.commit(); db.refresh(s)
    return _serialize_session(s, db, include_lines=True)


@router.get("/{session_id}")
def get_session(
    session_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    s = db.query(ReceivingSession).filter(ReceivingSession.id == session_id).first()
    if not s:
        raise HTTPException(404, "Receiving session олдсонгүй")
    if s.is_archived and u.role not in ("admin", "manager", "supervisor"):
        raise HTTPException(403, "Архивлагдсан тулгалтыг харах эрхгүй")
    return _serialize_session(s, db, include_lines=True)


@router.patch("/{session_id}")
def update_session(
    session_id: int,
    body: SessionUpdateIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "manager", "supervisor", "warehouse_clerk", "accountant")),
):
    s = db.query(ReceivingSession).filter(ReceivingSession.id == session_id).first()
    if not s:
        raise HTTPException(404, "Receiving session олдсонгүй")
    if body.notes is not None:
        s.notes = body.notes.strip()
    if body.date is not None:
        s.date = body.date
    db.commit()
    return _serialize_session(s, db, include_lines=False)


@router.patch("/{session_id}/status")
def set_status(
    session_id: int,
    body: StatusIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "manager", "supervisor", "accountant")),
):
    s = db.query(ReceivingSession).filter(ReceivingSession.id == session_id).first()
    if not s:
        raise HTTPException(404, "Receiving session олдсонгүй")
    if body.status not in STATUS_SEQUENCE:
        raise HTTPException(400, "Буруу статус")
    s.status = body.status
    db.commit()
    return _serialize_session(s, db, include_lines=False)


@router.patch("/{session_id}/archive")
def archive_session(
    session_id: int,
    archived: bool = Query(True),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "manager", "supervisor")),
):
    s = db.query(ReceivingSession).filter(ReceivingSession.id == session_id).first()
    if not s:
        raise HTTPException(404, "Receiving session олдсонгүй")
    s.is_archived = bool(archived)
    db.commit()
    return {"ok": True, "is_archived": s.is_archived}


@router.delete("/{session_id}")
def delete_session(
    session_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "manager", "supervisor")),
):
    s = db.query(ReceivingSession).filter(ReceivingSession.id == session_id).first()
    if not s:
        raise HTTPException(404, "Receiving session олдсонгүй")
    db.delete(s); db.commit()
    return {"ok": True}


# ── Line endpoints ────────────────────────────────────────────────────────────

@router.post("/{session_id}/lines")
def add_line(
    session_id: int,
    body: LineIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "manager", "supervisor", "warehouse_clerk", "accountant")),
):
    s = db.query(ReceivingSession).filter(ReceivingSession.id == session_id).first()
    if not s:
        raise HTTPException(404, "Receiving session олдсонгүй")
    p = db.query(Product).filter(Product.id == body.product_id).first()
    if not p:
        raise HTTPException(404, "Бараа олдсонгүй")
    # Давхардсан бараа — тоог нэмэх (нэг сесс дотор нэг удаа)
    existing = db.query(ReceivingLine).filter(
        ReceivingLine.session_id == session_id,
        ReceivingLine.product_id == body.product_id,
    ).first()
    if existing:
        existing.qty_pcs += float(body.qty_pcs or 0)
        if body.unit_price and body.unit_price > 0:
            existing.unit_price = float(body.unit_price)
        if body.note:
            existing.note = body.note
        db.commit(); db.refresh(existing)
        return _serialize_line(existing, p)
    ln = ReceivingLine(
        session_id=session_id,
        product_id=body.product_id,
        qty_pcs=float(body.qty_pcs or 0),
        unit_price=float(body.unit_price or 0),
        note=body.note or "",
    )
    db.add(ln); db.commit(); db.refresh(ln)
    return _serialize_line(ln, p)


@router.patch("/{session_id}/lines/{line_id}")
def update_line(
    session_id: int,
    line_id: int,
    body: LineUpdateIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "manager", "supervisor", "warehouse_clerk", "accountant")),
):
    ln = db.query(ReceivingLine).filter(
        ReceivingLine.id == line_id,
        ReceivingLine.session_id == session_id,
    ).first()
    if not ln:
        raise HTTPException(404, "Мөр олдсонгүй")
    if body.qty_pcs is not None:
        ln.qty_pcs = float(body.qty_pcs)
    if body.unit_price is not None:
        ln.unit_price = float(body.unit_price)
    if body.note is not None:
        ln.note = body.note
    db.commit(); db.refresh(ln)
    p = db.query(Product).filter(Product.id == ln.product_id).first()
    return _serialize_line(ln, p)


@router.delete("/{session_id}/lines/{line_id}")
def delete_line(
    session_id: int,
    line_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "manager", "supervisor", "warehouse_clerk", "accountant")),
):
    ln = db.query(ReceivingLine).filter(
        ReceivingLine.id == line_id,
        ReceivingLine.session_id == session_id,
    ).first()
    if not ln:
        raise HTTPException(404, "Мөр олдсонгүй")
    db.delete(ln); db.commit()
    return {"ok": True}


# ── Brand match + receipt upload ──────────────────────────────────────────────

@router.post("/{session_id}/brands/{brand}/confirm")
async def confirm_brand(
    session_id: int,
    brand: str,
    supplier_total_pcs: float = Form(...),
    supplier_total_amount: float = Form(...),
    receipt: UploadFile = File(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "manager", "supervisor", "warehouse_clerk", "accountant")),
):
    s = db.query(ReceivingSession).filter(ReceivingSession.id == session_id).first()
    if not s:
        raise HTTPException(404, "Receiving session олдсонгүй")

    # Нийт тоог тулгах
    lines = db.query(ReceivingLine).filter(ReceivingLine.session_id == session_id).all()
    prod_ids = [l.product_id for l in lines]
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(prod_ids)).all()} if prod_ids else {}
    my_pcs = 0.0
    my_amount = 0.0
    for l in lines:
        p = products.get(l.product_id)
        if not p:
            continue
        if (p.brand or "") != brand:
            continue
        my_pcs += l.qty_pcs
        my_amount += l.qty_pcs * l.unit_price

    if abs(my_pcs - float(supplier_total_pcs)) > 0.01:
        raise HTTPException(400, f"Ширхэгийн тоо таарсангүй. Таны оруулсан: {my_pcs:.0f}ш, баримт дээр: {supplier_total_pcs:.0f}ш")
    if abs(my_amount - float(supplier_total_amount)) > 1.0:
        raise HTTPException(400, f"Нийт дүн таарсангүй. Таны оруулсан: {my_amount:.2f}₮, баримт дээр: {supplier_total_amount:.2f}₮")

    # Баримтны зураг хадгалах
    sess_dir = UPLOAD_DIR / str(session_id)
    sess_dir.mkdir(parents=True, exist_ok=True)
    safe_brand = re.sub(r"[\\/:*?\"<>|]", "_", brand)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    suffix = Path(receipt.filename or "").suffix or ".jpg"
    saved = sess_dir / f"{safe_brand}_{ts}{suffix}"
    saved.write_bytes(await receipt.read())

    bs = db.query(ReceivingBrandStatus).filter(
        ReceivingBrandStatus.session_id == session_id,
        ReceivingBrandStatus.brand == brand,
    ).first()
    if not bs:
        bs = ReceivingBrandStatus(session_id=session_id, brand=brand)
        db.add(bs)
    bs.is_matched = True
    bs.receipt_image_path = str(saved).replace("\\", "/")
    bs.supplier_total_pcs = float(supplier_total_pcs)
    bs.supplier_total_amount = float(supplier_total_amount)
    bs.matched_at = datetime.utcnow()
    db.commit()

    _auto_advance_if_all_matched(s, db)
    db.refresh(s)
    return _serialize_session(s, db, include_lines=False)


@router.post("/{session_id}/brands/{brand}/unmatch")
def unmatch_brand(
    session_id: int,
    brand: str,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "manager", "supervisor")),
):
    bs = db.query(ReceivingBrandStatus).filter(
        ReceivingBrandStatus.session_id == session_id,
        ReceivingBrandStatus.brand == brand,
    ).first()
    if not bs:
        raise HTTPException(404, "Тулгалт олдсонгүй")
    bs.is_matched = False
    bs.matched_at = None
    db.commit()
    return {"ok": True}


@router.get("/{session_id}/brands/{brand}/receipt")
def get_receipt(
    session_id: int,
    brand: str,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    bs = db.query(ReceivingBrandStatus).filter(
        ReceivingBrandStatus.session_id == session_id,
        ReceivingBrandStatus.brand == brand,
    ).first()
    if not bs or not bs.receipt_image_path:
        raise HTTPException(404, "Баримт олдсонгүй")
    p = Path(bs.receipt_image_path)
    if not p.exists():
        raise HTTPException(404, "Баримт файл байхгүй")
    return FileResponse(str(p))


# ── ERP Excel export ──────────────────────────────────────────────────────────

class ERPCfg(BaseModel):
    company: str  # "buten_orgil" | "orgil_khorum"
    date: Optional[str] = None
    document_note: str = ""
    related_account: str = ""
    account: str = ""
    warehouse_map: dict = {}
    single_location: str = ""
    brand_filter: str = ""


@router.post("/{session_id}/export-erp-excel")
def export_erp_excel(
    session_id: int,
    body: ERPCfg,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "manager", "supervisor", "accountant")),
):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
    from urllib.parse import quote

    s = db.query(ReceivingSession).filter(ReceivingSession.id == session_id).first()
    if not s:
        raise HTTPException(404, "Receiving session олдсонгүй")

    try:
        date_val = datetime.strptime(body.date, "%Y-%m-%d").date() if body.date else s.date
    except Exception:
        date_val = s.date

    lines = db.query(ReceivingLine).filter(
        ReceivingLine.session_id == session_id,
        ReceivingLine.qty_pcs > 0,
    ).all()
    prod_ids = [l.product_id for l in lines]
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(prod_ids)).all()} if prod_ids else {}

    brand_filter = (body.brand_filter or "").strip()
    valid = []
    for ln in lines:
        p = products.get(ln.product_id)
        if not p:
            continue
        brand = p.brand or ""
        if brand_filter and brand != brand_filter:
            continue
        if body.company == "orgil_khorum":
            location = body.single_location
        else:
            location = body.warehouse_map.get(p.warehouse_name, "")
        total = round(ln.qty_pcs * ln.unit_price, 2)
        valid.append((brand, p.item_code, p, ln, location, ln.qty_pcs, ln.unit_price, total, p.brand_code or ""))

    valid.sort(key=lambda x: (x[8] or "", x[0], x[1]))

    wb = Workbook()
    ws = wb.active
    ws.title = "Import"
    col_headers = [
        "Огноо", "Баримтын дугаар", "Гүйлгээний утга", "Харилцагч",
        "Харьцсан данс", "Харьцсан ялгаатай харилцагч",
        "НӨАТ тай эсэх", "НӨАТ-н үзүүлэлт", "НӨАТ автоматаар бодох эсэх", "НӨАТ-н дүн",
        "НХАТ тай эсэх", "НХАТ автоматаар бодох эсэх", "НХАТ-н дүн",
        "Данс", "Бараа материал", "Барааны байршил",
        "Тоо хэмжээ", "Нэгж үнэ", "Хувийн жин", "Нийт дүн",
        "НӨАТ тооцох эсэх", "НХАТ тооцох эсэх", "НХАТ мөр",
    ]
    hdr_fill = PatternFill("solid", fgColor="3258A0")
    hdr_font = Font(color="FFFFFF", bold=True)
    for ci, h in enumerate(col_headers, 1):
        c = ws.cell(row=1, column=ci, value=h)
        c.fill = hdr_fill
        c.font = hdr_font
        c.alignment = Alignment(horizontal="center")

    from collections import defaultdict
    groups: dict = defaultdict(list)
    for item in valid:
        groups[item[8] or ""].append(item)

    current_row = 2
    for supplier_code, items in groups.items():
        for i, (brand, item_code, p, ln, location, qty, price, total, _bc) in enumerate(items):
            is_first = (i == 0)
            row = [
                date_val if is_first else None,
                None,
                body.document_note if is_first else None,
                supplier_code if is_first else None,
                body.related_account if is_first else None, None,
                0 if is_first else None,
                None, None,
                0 if is_first else None,
                0 if is_first else None,
                None,
                0 if is_first else None,
                body.account,
                p.item_code,
                location,
                qty,
                price,
                1.0,
                total,
                0,
                0,
                None,
            ]
            for ci, val in enumerate(row, 1):
                ws.cell(row=current_row, column=ci, value=val)
            current_row += 1

    widths = [14, 16, 28, 14, 14, 20, 14, 18, 22, 12, 14, 22, 12,
              16, 18, 20, 12, 12, 12, 14, 18, 18, 12]
    for ci, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(ci)].width = w

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    date_str = s.date.strftime("%Y%m%d")
    brand_part = re.sub(r"[\\/:*?\"<>|]", "_", brand_filter) if brand_filter else "all"
    filename = f"{date_str}_RECV{s.id}_{brand_part}.xlsx"
    ascii_fallback = re.sub(r"[^\w\-.]", "_", filename.encode("ascii", "ignore").decode("ascii")) or f"RECV{s.id}.xlsx"
    utf8_quoted = quote(filename, safe="")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={ascii_fallback}; filename*=UTF-8''{utf8_quoted}"},
    )
