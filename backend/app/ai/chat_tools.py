"""AI туслахын ЗӨВХӨН УНШИХ tool-ууд (Claude tool use).

Зарчим: LLM-д SQL бичүүлэхгүй — урьдчилан тодорхойлсон функцүүд, read-only DB холболт дээр.
Tool бүр цэсний эрхтэй (perm: аль нэг нь байхад зөвшөөрнө, хоосон = бүгдэд). Нэг tool ≤ 100 мөр,
зөвхөн хэрэгтэй багана.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta

from sqlalchemy import func, or_

MAX_ROWS = 100
MAX_RESULT_CHARS = 24_000

# ── Кирилл ↔ латин хайлт ─────────────────────────────────────────────────────
# Барааны нэр ихэвчлэн латинаар («Coca cola»), хэрэглэгч кириллээр («Кока кола») асуудаг.
_CYR2LAT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
    "ж": "j", "з": "z", "и": "i", "й": "i", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "ө": "o", "п": "p", "р": "r", "с": "s", "т": "t",
    "у": "u", "ү": "u", "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh",
    "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def _search_terms(query: str) -> list[str]:
    q = (query or "").strip().lower()
    if not q:
        return []
    out = {q}
    if any(ch in _CYR2LAT for ch in q):
        for k_as in ("k", "c"):
            out.add("".join(k_as if ch == "к" else _CYR2LAT.get(ch, ch) for ch in q))
    return [t for t in out if t]


def _product_filter(Product, query: str):
    clauses = []
    for t in _search_terms(query):
        like = f"%{t}%"
        clauses += [Product.name.ilike(like), Product.item_code.ilike(like),
                    Product.brand.ilike(like), Product.barcode.ilike(like)]
    return or_(*clauses) if clauses else None


def _int(v, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(int(v), hi))
    except (TypeError, ValueError):
        return default


def _find_products(db, query: str):
    from app.models.product import Product
    cond = _product_filter(Product, query)
    return db.query(Product).filter(cond).limit(MAX_ROWS).all() if cond is not None else []


# ── Бараа ────────────────────────────────────────────────────────────────────

def search_products(db, a: dict, perms: set) -> dict:
    rows = _find_products(db, a.get("query", ""))
    show_cost = bool(perms & {"order", "receivings", "reports"})
    return {"count": len(rows), "products": [{
        "item_code": p.item_code, "name": p.name, "brand": p.brand, "barcode": p.barcode,
        "pack_ratio": p.pack_ratio, **({"last_purchase_price": p.last_purchase_price} if show_cost else {}),
    } for p in rows]}


def get_stock(db, a: dict, perms: set) -> dict:
    from app.services.balance_stock import get_location_stock_map
    loc = "showroom" if str(a.get("location", "")).lower().startswith("show") else "warehouse"
    smap = get_location_stock_map(db, loc)
    if not smap:
        return {"error": "Үлдэгдлийн файл оруулаагүй байна (Файл оруулалт → Үлдэгдлийн файл)."}
    prods = _find_products(db, a.get("query", ""))
    if not prods:
        return {"error": f"'{a.get('query', '')}' бараа олдсонгүй (нэр ихэвчлэн латинаар бичигдсэн)."}
    out = []
    for p in prods:
        qty = float(smap.get(str(p.item_code).strip(), 0.0))
        boxes = round(qty / p.pack_ratio, 1) if p.pack_ratio and p.pack_ratio > 0 else None
        out.append({"item_code": p.item_code, "name": p.name, "stock_pcs": qty, "stock_boxes": boxes})
    return {"location": loc, "count": len(out), "items": out}


def get_product_sales(db, a: dict, perms: set) -> dict:
    from app.models.product import Product
    from app.models.product_monthly_sales import ProductMonthlySales
    cond = _product_filter(Product, a.get("query", ""))
    codes = [c for (c,) in db.query(Product.item_code).filter(cond).limit(MAX_ROWS).all()] if cond is not None else []
    if not codes:
        return {"error": f"'{a.get('query', '')}' бараа олдсонгүй."}
    n = _int(a.get("months"), 3, 1, 24)
    rows = db.query(ProductMonthlySales).filter(ProductMonthlySales.item_code.in_(codes)).order_by(
        ProductMonthlySales.year.desc(), ProductMonthlySales.month.desc()).limit(n * len(codes)).all()
    agg: dict[tuple, dict] = {}
    for r in rows:
        m = agg.setdefault((r.year, r.month), {"year": r.year, "month": r.month,
                                               "warehouse": 0.0, "showroom": 0.0, "hall_liquor": 0.0})
        m["warehouse"] += float(r.qty_warehouse or 0)
        m["showroom"] += float(r.qty_showroom or 0)
        m["hall_liquor"] += float(r.qty_liquor or 0)
    months = sorted(agg.values(), key=lambda x: (-x["year"], -x["month"]))[:n]
    for m in months:
        m["total"] = m["warehouse"] + m["showroom"] + m["hall_liquor"]
    total = sum(m["total"] for m in months)
    return {"matched_products": len(codes), "months": months, "total_pcs": total,
            "avg_per_month": round(total / max(1, len(months)), 1)}


# ── Хугацааны хяналт ─────────────────────────────────────────────────────────

def get_expiring_items(db, a: dict, perms: set) -> dict:
    from app.models.expiration_item import ExpirationItem
    from app.models.product import Product
    d = _int(a.get("days"), 30, 1, 365)
    today = date.today()
    rows = db.query(ExpirationItem, Product).outerjoin(Product, Product.id == ExpirationItem.product_id).filter(
        ExpirationItem.expiration_date <= today + timedelta(days=d), ExpirationItem.status != "archived",
    ).order_by(ExpirationItem.expiration_date).limit(MAX_ROWS).all()
    return {"within_days": d, "count": len(rows), "items": [{
        "product": p.name if p else "", "item_code": p.item_code if p else "",
        "expiration_date": r.expiration_date.isoformat(), "days_left": (r.expiration_date - today).days,
        "qty_floor": r.qty_floor, "qty_warehouse": r.qty_warehouse, "status": r.status,
    } for r, p in rows]}


# ── Захиалга / Тулгалт ───────────────────────────────────────────────────────

def get_orders_summary(db, a: dict, perms: set) -> dict:
    from app.models.purchase_order import PurchaseOrder, PurchaseOrderLine
    d = _int(a.get("days"), 14, 1, 365)
    q = db.query(PurchaseOrder).filter(PurchaseOrder.order_date >= date.today() - timedelta(days=d),
                                       PurchaseOrder.is_archived == False)  # noqa: E712
    status = str(a.get("status") or "").strip()
    if status:
        q = q.filter(PurchaseOrder.status == status)
    orders = q.order_by(PurchaseOrder.order_date.desc()).limit(MAX_ROWS).all()
    ids = [o.id for o in orders]
    counts = dict(db.query(PurchaseOrderLine.purchase_order_id, func.count(PurchaseOrderLine.id))
                  .filter(PurchaseOrderLine.purchase_order_id.in_(ids))
                  .group_by(PurchaseOrderLine.purchase_order_id).all()) if ids else {}
    return {"count": len(orders), "orders": [{
        "id": o.id, "date": o.order_date.isoformat(), "status": o.status, "location": o.location,
        "lines": counts.get(o.id, 0), "notes": (o.notes or "")[:120],
    } for o in orders]}


def get_order_lines(db, a: dict, perms: set) -> dict:
    from app.models.product import Product
    from app.models.purchase_order import PurchaseOrder, PurchaseOrderLine
    oid = _int(a.get("order_id"), 0, 0, 10**9)
    o = db.get(PurchaseOrder, oid)
    if not o:
        return {"error": f"#{oid} захиалга олдсонгүй."}
    q = db.query(PurchaseOrderLine, Product).join(Product, Product.id == PurchaseOrderLine.product_id).filter(
        PurchaseOrderLine.purchase_order_id == oid)
    brand = str(a.get("brand") or "").strip()
    if brand:
        q = q.filter(or_(Product.brand.ilike(f"%{brand}%"), PurchaseOrderLine.override_brand.ilike(f"%{brand}%")))
    total = q.count()
    rows = q.order_by(Product.brand, Product.name).limit(MAX_ROWS).all()
    return {"order": {"id": o.id, "date": o.order_date.isoformat(), "status": o.status, "location": o.location},
            "total_lines": total, "shown": len(rows), "lines": [{
                "item_code": l.display_code or p.item_code, "name": p.name,
                "brand": l.override_brand or p.brand, "order_box": l.order_qty_box, "order_pcs": l.order_qty_pcs,
                "received_box": l.received_qty_box, "unit_price": l.unit_price,
            } for l, p in rows]}


def get_receivings_summary(db, a: dict, perms: set) -> dict:
    from app.models.receiving import ReceivingLine, ReceivingSession
    d = _int(a.get("days"), 14, 1, 365)
    rows = db.query(ReceivingSession).filter(ReceivingSession.date >= date.today() - timedelta(days=d),
                                             ReceivingSession.is_archived == False,  # noqa: E712
                                             ).order_by(ReceivingSession.date.desc()).limit(MAX_ROWS).all()
    ids = [s.id for s in rows]
    counts = dict(db.query(ReceivingLine.session_id, func.count(ReceivingLine.id))
                  .filter(ReceivingLine.session_id.in_(ids)).group_by(ReceivingLine.session_id).all()) if ids else {}
    return {"count": len(rows), "sessions": [{
        "id": s.id, "date": s.date.isoformat(), "status": s.status, "lines": counts.get(s.id, 0),
        "notes": (s.notes or "")[:120],
    } for s in rows]}


def get_receiving_lines(db, a: dict, perms: set) -> dict:
    from app.models.product import Product
    from app.models.receiving import ReceivingLine, ReceivingSession
    sid = _int(a.get("session_id"), 0, 0, 10**9)
    s = db.get(ReceivingSession, sid)
    if not s:
        return {"error": f"#{sid} тулгалт олдсонгүй."}
    q = db.query(ReceivingLine, Product).join(Product, Product.id == ReceivingLine.product_id).filter(
        ReceivingLine.session_id == sid)
    brand = str(a.get("brand") or "").strip()
    if brand:
        q = q.filter(or_(Product.brand.ilike(f"%{brand}%"), ReceivingLine.override_brand.ilike(f"%{brand}%")))
    total = q.count()
    rows = q.order_by(Product.brand, Product.name).limit(MAX_ROWS).all()
    return {"session": {"id": s.id, "date": s.date.isoformat(), "status": s.status},
            "total_lines": total, "shown": len(rows), "lines": [{
                "item_code": l.display_code or p.item_code, "name": p.name, "brand": l.override_brand or p.brand,
                "qty_pcs": l.qty_pcs, "unit_price": l.unit_price, "amount": round(l.qty_pcs * l.unit_price, 2),
            } for l, p in rows]}


# ── Ebarimt / Банк ───────────────────────────────────────────────────────────

def get_ebarimt_summary(db, a: dict, perms: set) -> dict:
    from app.api.ebarimt_report import get_report
    year, month = _int(a.get("year"), date.today().year, 2020, 2100), _int(a.get("month"), 1, 1, 12)
    try:
        rep = get_report(db, year, month)
    except Exception as e:  # noqa: BLE001
        return {"error": f"Ebarimt тайлан авахад алдаа: {e}"}
    if rep.get("error"):
        return {"error": rep["error"]}
    rows = rep.get("rows", [])
    emp = str(a.get("employee") or "").strip().lower()
    if emp:
        rows = [r for r in rows if emp in (r.get("employee", "") or "").lower()]
    missing = [r for r in rows if r["diff_orgil"] > 0.5 or r["diff_harhorin"] > 0.5]
    missing.sort(key=lambda r: -(max(r["diff_orgil"], 0) + max(r["diff_harhorin"], 0)))
    return {"year": year, "month": month, "employee": emp or "бүгд", "customers": len(rows),
            "missing_count": len(missing),
            "total_missing": round(sum(max(r["diff_orgil"], 0) + max(r["diff_harhorin"], 0) for r in missing)),
            "top_missing": [{"name": r["name"], "employee": r["employee"],
                             "missing_orgil": round(max(r["diff_orgil"], 0)),
                             "missing_harhorin": round(max(r["diff_harhorin"], 0))} for r in missing[:30]]}


def get_bank_summary(db, a: dict, perms: set) -> dict:
    from app.models.bank_statement import BankStatement
    try:
        d1 = date.fromisoformat(str(a.get("date_from", "")))
        d2 = date.fromisoformat(str(a.get("date_to"))) if str(a.get("date_to") or "").strip() else d1
    except ValueError:
        return {"error": "Огноо буруу. 'YYYY-MM-DD' хэлбэрээр."}
    day = func.coalesce(BankStatement.date_from, func.date(BankStatement.uploaded_at))
    stmts = db.query(BankStatement).filter(day >= d1.isoformat(), day <= d2.isoformat()).limit(MAX_ROWS).all()
    out = []
    for s in stmts:
        main = [t for t in s.transactions if not t.is_fee]
        out.append({"account": s.account_number, "date": s.date_from.isoformat() if s.date_from else None,
                    "credit": round(sum(t.credit for t in main)), "debit": round(sum(t.debit for t in main)),
                    "txn_count": len(main)})
    return {"from": d1.isoformat(), "to": d2.isoformat(), "statements": len(out),
            "total_credit": sum(o["credit"] for o in out), "total_debit": sum(o["debit"] for o in out),
            "accounts": out}


# ── Дата хэр шинэ вэ ─────────────────────────────────────────────────────────

def get_data_freshness(db, a: dict, perms: set) -> dict:
    from app.models.balance_file import BalanceFile
    from app.models.ebarimt_file import EbarimtFile
    from app.models.income_file import IncomeFile
    from app.models.movement_file import MovementFile
    now = datetime.utcnow()

    def age(dt) -> dict:
        if not dt:
            return {}
        return {"uploaded_at_utc": dt.isoformat(timespec="minutes"),
                "age_days": round((now - dt).total_seconds() / 86400, 1)}

    names = {"warehouse": "Бүх агуулахын үлдэгдэл", "main": "Үндсэн заалны үлдэгдэл", "liquor": "Архины заалны үлдэгдэл"}
    inc = db.query(IncomeFile).order_by(IncomeFile.year.desc(), IncomeFile.month.desc()).first()
    mv = db.query(MovementFile).order_by(MovementFile.year.desc()).first()
    eb = db.query(EbarimtFile).order_by(EbarimtFile.year.desc(), EbarimtFile.month.desc()).first()
    return {
        "balance_files": [{"kind": names.get(b.kind, b.kind), **age(b.uploaded_at)} for b in db.query(BalanceFile).all()],
        "income_file": {"year": inc.year, "month": inc.month or None, **age(inc.uploaded_at)} if inc else None,
        "movement_file": {"year": mv.year, **age(mv.uploaded_at)} if mv else None,
        "ebarimt_file": {"year": eb.year, "month": eb.month, **age(eb.uploaded_at)} if eb else None,
        "note": "Эрхэт/erxes-ээс гараар оруулсан файлууд — age_days их бол дата хуучирсан.",
    }


# ── Тодорхойлолт ─────────────────────────────────────────────────────────────

def _obj(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or []}


_S = {"type": "string"}
_I = {"type": "integer"}
_Q = {"query": {**_S, "description": "Барааны нэр, код, бренд эсвэл баркод"}}

# name: (fn, perm-ууд (аль нэг нь), хэрэглэгчид харагдах шошго, description, input_schema)
TOOLS: dict[str, tuple] = {
    "search_products": (search_products, (), "Бараа хайж байна",
                        "Барааг нэр, код, бренд, баркодоор хайна (код, нэр, бренд, хайрцагны ширхэг).",
                        _obj(_Q, ["query"])),
    "get_stock": (get_stock, ("stock_live", "order", "reports"), "Үлдэгдэл шалгаж байна",
                  "Барааны ОДООГИЙН үлдэгдэл (оруулсан үлдэгдлийн файлаас).",
                  _obj({**_Q, "location": {"type": "string", "enum": ["warehouse", "showroom"],
                                           "description": "warehouse = бүх агуулах, showroom = заал"}}, ["query"])),
    "get_product_sales": (get_product_sales, ("sales_report", "sales_analytics", "order", "reports"),
                          "Борлуулалт харж байна", "Барааны сүүлийн саруудын борлуулалт (ширхэг; агуулах+заал+архи).",
                          _obj({**_Q, "months": {**_I, "description": "Хэдэн сар (1-24)"}}, ["query"])),
    "get_expiring_items": (get_expiring_items, ("expiration_tracking",), "Хугацаа шалгаж байна",
                           "Хугацаа нь N хоногийн дотор дуусах бараа.",
                           _obj({"days": {**_I, "description": "Хоног (1-365)"}})),
    "get_orders_summary": (get_orders_summary, ("order",), "Захиалга харж байна",
                           "Сүүлийн N хоногийн захиалгууд (id, огноо, төлөв, мөрийн тоо).",
                           _obj({"days": _I, "status": {**_S, "description": "preparing|reviewing|ordered|done, хоосон=бүгд"}})),
    "get_order_lines": (get_order_lines, ("order",), "Захиалгын мөр харж байна",
                        "Нэг захиалгын бараанууд (код, нэр, бренд, хайрцаг/ширхэг, үнэ).",
                        _obj({"order_id": _I, "brand": {**_S, "description": "Брендээр шүүх (заавал биш)"}}, ["order_id"])),
    "get_receivings_summary": (get_receivings_summary, ("receivings",), "Тулгалт харж байна",
                               "Сүүлийн N хоногийн «Бараа тулгаж авах» ажлууд.", _obj({"days": _I})),
    "get_receiving_lines": (get_receiving_lines, ("receivings",), "Тулгалтын мөр харж байна",
                            "Нэг тулгалтын (receiving session) бараанууд: тоо, үнэ, дүн.",
                            _obj({"session_id": _I, "brand": _S}, ["session_id"])),
    "get_ebarimt_summary": (get_ebarimt_summary, ("ebarimt",), "Ebarimt шалгаж байна",
                            "Ebarimt дутуу шивэлт — худалдан авалт vs шивсэн дүн, ажилтнаар шүүж болно.",
                            _obj({"year": _I, "month": _I, "employee": _S}, ["year", "month"])),
    "get_bank_summary": (get_bank_summary, ("bank_statements",), "Банкны хуулга харж байна",
                         "Банкны хуулгын орлого/зарлага дансаар.",
                         _obj({"date_from": {**_S, "description": "YYYY-MM-DD"},
                               "date_to": {**_S, "description": "YYYY-MM-DD, хоосон = date_from"}}, ["date_from"])),
    "get_data_freshness": (get_data_freshness, (), "Дата шинэ эсэхийг шалгаж байна",
                           "Үлдэгдэл/борлуулалт/орлого/Ebarimt файл хэзээ сүүлд орсныг харна. Үлдэгдэл, "
                           "борлуулалтын тоо хэлэхийн өмнө дуудаж, хуучин бол сануул.", _obj({})),
}


def allowed(name: str, perms: set) -> bool:
    t = TOOLS.get(name)
    return bool(t) and (not t[1] or bool(perms & set(t[1])))


def definitions(perms: set) -> list[dict]:
    """Хэрэглэгчийн эрхэд таарсан tool-ууд (Claude-ийн tools параметр)."""
    return [{"name": n, "description": t[3], "input_schema": t[4]} for n, t in TOOLS.items() if allowed(n, perms)]


def label(name: str) -> str:
    return TOOLS[name][2] if name in TOOLS else name


def run(db, name: str, args: dict, perms: set) -> str:
    """Tool ажиллуулж JSON текст буцаана. Эрхгүй/алдаатай бол error-той JSON (Claude-д)."""
    if not allowed(name, perms):
        return json.dumps({"error": "Энэ мэдээллийг харах эрх алга."}, ensure_ascii=False)
    try:
        out = TOOLS[name][0](db, args or {}, perms)
    except Exception as e:  # noqa: BLE001
        out = {"error": f"Tool алдаа: {str(e)[:200]}"}
    s = json.dumps(out, ensure_ascii=False, default=str)
    if len(s) > MAX_RESULT_CHARS:
        s = s[:MAX_RESULT_CHARS] + ' …"(таслав — хэт урт; шүүлтүүрээ нарийсга)"'
    return s
