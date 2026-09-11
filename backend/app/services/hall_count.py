"""Заалны тооллогын логик — файл задлах, session sync, дүн, Excel гаргалт.

API давхарга (app/api/hall_count.py) энд байгаа функцуудыг дуудна; энд
FastAPI-ийн юу ч байхгүй тул скриптээс шууд туршиж болно.
"""
from __future__ import annotations

import io
import re
from collections import defaultdict
from datetime import datetime, date as date_cls
from pathlib import Path
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.hall_count import (
    HallCountItem,
    HallCountScan,
    HallCountSession,
    HC_STATUS_CONFIRMED,
    HC_STATUS_OPEN,
)
from app.models.product import Product

EPS = 1e-6


# ── Excel задлах ─────────────────────────────────────────────────────────────

def _norm_code(raw) -> str:
    """Excel-ийн код → цэвэр string ('123.0' → '123', зай арилгана)."""
    if raw is None:
        return ""
    s = str(raw).strip()
    if not s or s.lower() == "nan":
        return ""
    s = re.sub(r"\.0+$", "", s)
    return re.sub(r"\s+", "", s)


def _f(raw) -> float:
    try:
        import math
        v = float(raw)
        return 0.0 if math.isnan(v) else v
    except (TypeError, ValueError):
        return 0.0


def _is_nan(v) -> bool:
    try:
        import math
        return v is None or (isinstance(v, float) and math.isnan(v))
    except Exception:
        return v is None


# Барааны код: 6+ цифр (жирийн) эсвэл үсэг/доогуур зураастай угтвартай 5+ цифр
# (жишээ 'td_206120'). '01', '150101 Бэлэн бүтээгдэхүүн' зэрэг бүлгийн мөрийг
# нэгж өртгийн багана хоосон эсэхээр ялгана.
_CODE_RE = re.compile(r"^(?:[A-Za-z_\-]{1,6})?\d{5,}$")


def parse_hall_balance_file(path: Path) -> list[dict]:
    """Эрхэтийн «Үлдэгдлийн тайлан» Excel → мөрүүд.

    Багана (бусад үлдэгдлийн файлтай ижил): A=Код, B=Нэр, I=Эцсийн үлдэгдэл (тоо),
    J=Дүн, K=Нэгж өртөг. Эхний 2 мөр толгой. Бүлгийн/нийлбэрийн мөр (нэгж өртөг
    хоосон) орохгүй. Давхардсан код → тоо нийлнэ (эхний нэр/өртөг үлдэнэ).
    Буцаах: [{code, name, qty, cost}] файлын дарааллаар.
    """
    import pandas as pd

    p = str(path)
    eng = "xlrd" if p.lower().endswith(".xls") else "openpyxl"
    df = pd.read_excel(p, sheet_name=0, header=None, engine=eng)
    if df.shape[1] < 9 or len(df) <= 2:
        return []
    has_cost = df.shape[1] >= 11

    # Толгойн мөрийг олно: A баганад "Код" гэсэн мөр (ихэвчлэн 0-р мөр)
    start = 2
    for i in range(min(6, len(df))):
        if str(df.iat[i, 0]).strip().lower() == "код":
            start = i + 2      # дараагийн "Тоо/Дүн" дэд толгойг алгасна
            break

    by_code: dict[str, dict] = {}
    order: list[str] = []
    for i in range(start, len(df)):
        code = _norm_code(df.iat[i, 0])
        if not code or not _CODE_RE.match(code):
            continue
        cost_raw = df.iat[i, 10] if has_cost else 0.0
        if has_cost and _is_nan(cost_raw):
            # Нэгж өртөггүй → бүлэг/дэд нийлбэрийн мөр ('150101 Бэлэн бүтээгдэхүүн')
            continue
        name_raw = df.iat[i, 1]
        name = "" if _is_nan(name_raw) else str(name_raw).strip()
        if name.lower() == "nan":
            name = ""
        qty = _f(df.iat[i, 8])
        cost = max(_f(cost_raw), 0.0)      # сөрөг өртөг = мэдэгдэхгүй гэж үзнэ
        if code in by_code:
            by_code[code]["qty"] += qty
            if not by_code[code]["name"] and name:
                by_code[code]["name"] = name
            if by_code[code]["cost"] <= 0 < cost:
                by_code[code]["cost"] = cost
        else:
            by_code[code] = {"code": code, "name": name, "qty": qty, "cost": cost}
            order.append(code)
    return [by_code[c] for c in order]


# ── Session ──────────────────────────────────────────────────────────────────

def open_session(db: Session) -> Optional[HallCountSession]:
    return (db.query(HallCountSession)
              .filter(HallCountSession.status == HC_STATUS_OPEN)
              .order_by(HallCountSession.id.desc())
              .first())


def sync_session_from_rows(db: Session, rows: list[dict], *, filename: str,
                           user_id: int, user_name: str) -> HallCountSession:
    """Үлдэгдлийн файлын мөрүүдийг нээлттэй session-д ачаална.

    Нээлттэй session байхгүй → шинээр үүсгэнэ.
    Байвал → үлдэгдэл/нэр/өртгийг шинэчилж, шинэ кодыг нэмнэ; СКÁНУУДЫГ ХАДГАЛНА
    (тооллогын дундуур үлдэгдлийг дахин оруулах боломжтой). Файлаас алга болсон
    код скáнтай бол in_list=False болж үлдэнэ, скáнгүй бол устна.
    """
    now = datetime.utcnow()
    sess = open_session(db)
    if not sess:
        sess = HallCountSession(
            status=HC_STATUS_OPEN, created_at=now,
            created_by_id=user_id, created_by_name=user_name,
        )
        db.add(sess)
        db.flush()

    existing = {it.code: it for it in db.query(HallCountItem)
                .filter(HallCountItem.session_id == sess.id).all()}
    seen: set[str] = set()
    for r in rows:
        code = r["code"]
        seen.add(code)
        it = existing.get(code)
        if it:
            it.name = r["name"] or it.name
            it.balance_qty = float(r["qty"])
            if r["cost"] > 0 or it.unit_cost <= 0:
                it.unit_cost = float(r["cost"])
            it.in_list = True
        else:
            db.add(HallCountItem(
                session_id=sess.id, code=code, name=r["name"],
                balance_qty=float(r["qty"]), unit_cost=float(r["cost"]),
                in_list=True,
            ))
    # Файлаас алга болсон мөрүүд
    for code, it in existing.items():
        if code in seen:
            continue
        if it.scan_count > 0:
            it.in_list = False
            it.balance_qty = 0.0
        else:
            db.delete(it)

    sess.source_filename = filename
    sess.balance_uploaded_at = now
    sess.item_count = len(rows)
    db.flush()
    return sess


def sync_session_from_file(db: Session, path: Path, *, filename: str,
                           user_id: int, user_name: str) -> HallCountSession:
    rows = parse_hall_balance_file(path)
    return sync_session_from_rows(db, rows, filename=filename,
                                  user_id=user_id, user_name=user_name)


def recount_item(db: Session, item: HallCountItem) -> None:
    """Скáнуудаас денормал талбаруудыг дахин тооцно."""
    row = (db.query(func.coalesce(func.sum(HallCountScan.qty), 0.0),
                    func.count(HallCountScan.id),
                    func.count(func.distinct(HallCountScan.device_id)),
                    func.max(HallCountScan.created_at))
             .filter(HallCountScan.item_id == item.id).one())
    item.counted_qty = float(row[0] or 0.0)
    item.scan_count = int(row[1] or 0)
    item.device_count = int(row[2] or 0)
    item.last_scanned_at = row[3]


def device_breakdown(db: Session, session_id: int, item_ids: Optional[list[int]] = None) -> dict[int, list[dict]]:
    """item_id → [{device_id, device_label, username, qty, scans}] (тоо буурахаар)."""
    q = (db.query(HallCountScan.item_id, HallCountScan.device_id,
                  func.max(HallCountScan.device_label), func.max(HallCountScan.username),
                  func.sum(HallCountScan.qty), func.count(HallCountScan.id))
           .filter(HallCountScan.session_id == session_id)
           .group_by(HallCountScan.item_id, HallCountScan.device_id))
    if item_ids is not None:
        if not item_ids:
            return {}
        q = q.filter(HallCountScan.item_id.in_(item_ids))
    out: dict[int, list[dict]] = defaultdict(list)
    for item_id, dev, label, uname, qty, n in q.all():
        out[item_id].append({
            "device_id": dev or "", "device_label": label or "",
            "username": uname or "", "qty": float(qty or 0), "scans": int(n or 0),
        })
    for lst in out.values():
        lst.sort(key=lambda d: -d["qty"])
    return out


# ── Ангилал / дүн ────────────────────────────────────────────────────────────

def item_diff(it: HallCountItem, uncounted_as_zero: bool) -> Optional[float]:
    """Зөрүү (тоолсон − үлдэгдэл). Тоолоогүй бараанд uncounted_as_zero=False бол None."""
    if it.scan_count > 0:
        return float(it.counted_qty) - float(it.balance_qty)
    if uncounted_as_zero and it.in_list:
        return -float(it.balance_qty)
    return None


def classify(it: HallCountItem) -> str:
    """matched | diff | uncounted | not_in_list (not_in_list нь diff-ийн дэд төрөл)."""
    if not it.in_list:
        return "not_in_list"
    if it.scan_count <= 0:
        return "uncounted"
    return "matched" if abs(it.counted_qty - it.balance_qty) < EPS else "diff"


def session_summary(db: Session, sess: HallCountSession) -> dict:
    items = db.query(HallCountItem).filter(HallCountItem.session_id == sess.id).all()
    n = {"total": 0, "in_list": 0, "counted": 0, "matched": 0, "diff": 0,
         "uncounted": 0, "multi_device": 0, "not_in_list": 0}
    surplus_amt = shortage_amt = 0.0
    uncounted_balance = 0.0
    uncounted_amt = 0.0
    for it in items:
        n["total"] += 1
        c = classify(it)
        if it.in_list:
            n["in_list"] += 1
        if it.scan_count > 0:
            n["counted"] += 1
        if c == "matched":
            n["matched"] += 1
        elif c == "diff" or c == "not_in_list":
            n["diff"] += 1
            d = it.counted_qty - it.balance_qty
            if d > 0:
                surplus_amt += d * (it.unit_cost or 0)
            else:
                shortage_amt += -d * (it.unit_cost or 0)
        if c == "not_in_list":
            n["not_in_list"] += 1
        if c == "uncounted":
            n["uncounted"] += 1
            uncounted_balance += it.balance_qty
            uncounted_amt += it.balance_qty * (it.unit_cost or 0)
        if it.device_count >= 2:
            n["multi_device"] += 1
    scans = (db.query(func.count(HallCountScan.id), func.count(func.distinct(HallCountScan.device_id)),
                      func.max(HallCountScan.created_at))
               .filter(HallCountScan.session_id == sess.id).one())
    return {
        "counts": n,
        "surplus_amount": round(surplus_amt, 2),
        "shortage_amount": round(shortage_amt, 2),
        "uncounted_balance_qty": round(uncounted_balance, 3),
        "uncounted_amount": round(uncounted_amt, 2),
        "scan_total": int(scans[0] or 0),
        "device_total": int(scans[1] or 0),
        "last_scan_at": scans[2].isoformat() if scans[2] else None,
    }


def session_devices(db: Session, session_id: int) -> list[dict]:
    q = (db.query(HallCountScan.device_id, func.max(HallCountScan.device_label),
                  func.max(HallCountScan.username), func.count(HallCountScan.id),
                  func.count(func.distinct(HallCountScan.item_id)),
                  func.max(HallCountScan.created_at))
           .filter(HallCountScan.session_id == session_id)
           .group_by(HallCountScan.device_id)
           .order_by(func.max(HallCountScan.created_at).desc()))
    return [{
        "device_id": d or "", "device_label": lbl or "", "username": u or "",
        "scans": int(n or 0), "items": int(ni or 0),
        "last_at": last.isoformat() if last else None,
    } for d, lbl, u, n, ni, last in q.all()]


# ── Бараа хайх (баркод → код) ────────────────────────────────────────────────

def _barcode_variants(q: str) -> list[str]:
    """UPC-A (12) ↔ EAN-13 (0 угтвар), EAN-8 хувилбарууд."""
    v = [q]
    if q.isdigit():
        if len(q) == 12:
            v.append("0" + q)
        elif len(q) == 13 and q.startswith("0"):
            v.append(q[1:])
        elif len(q) == 14 and q.startswith("0"):
            v.append(q[1:])
    return v


def resolve_product(db: Session, q: str, session_codes: Optional[set[str]] = None) -> Optional[Product]:
    """Баркод / код → Product. Олон бараа таарвал тооллогын жагсаалтад байгааг эрхэмлэнэ."""
    q = _norm_code(q)
    if not q:
        return None
    p = db.query(Product).filter(Product.item_code == q).first()
    if p:
        return p
    hits: list[Product] = []
    for cand in _barcode_variants(q):
        rows = db.query(Product).filter(Product.barcode.like(f"%{cand}%")).limit(20).all()
        for r in rows:
            toks = {t.strip() for t in (r.barcode or "").split(",")}
            if cand in toks and r not in hits:
                hits.append(r)
    if hits:
        if session_codes:
            for h in hits:
                if h.item_code in session_codes:
                    return h
        return hits[0]
    # POS-ын локал бааз (баркод products-д бүртгэгдээгүй байж болно)
    try:
        from app.services import pos_price
        if pos_price.enabled():
            r = pos_price.lookup(q)
            code = ((r or {}).get("product") or {}).get("code") or ""
            code = _norm_code(code)
            if code:
                p = db.query(Product).filter(Product.item_code == code).first()
                if p:
                    return p
                # products-д байхгүй ч POS-д байгаа бараа — түр Product объект
                # (DB-д нэмэхгүй) буцаана: нэр/код мэдэгдэнэ.
                tmp = Product(item_code=code, name=(r["product"].get("name") or ""),
                              barcode=q, last_purchase_price=0.0)
                return tmp
    except Exception:
        pass
    return None


# ── Excel гаргалт ────────────────────────────────────────────────────────────

ERP_HEADERS = [
    "Огноо", "Баримтын дугаар", "Гүйлгээний утга", "Харилцагч",
    "Харьцсан данс", "Харьцсан ялгаатай харилцагч",
    "НӨАТ тай эсэх", "НӨАТ-н үзүүлэлт", "НӨАТ автоматаар бодох эсэх", "НӨАТ-н дүн",
    "НХАТ тай эсэх", "НХАТ автоматаар бодох эсэх", "НХАТ-н дүн",
    "Данс", "Бараа материал", "Барааны байршил",
    "Тоо хэмжээ", "Нэгж үнэ", "Хувийн жин", "Нийт дүн",
    "НӨАТ тооцох эсэх", "НХАТ тооцох эсэх", "НХАТ мөр",
]
ERP_WIDTHS = [14, 16, 28, 14, 14, 20, 14, 18, 22, 12, 14, 22, 12,
              16, 18, 20, 12, 12, 12, 14, 18, 18, 12]

EXPORT_KIND_LABEL = {"income": "Орлого (илүүдэл)", "expense": "Зарлага (дутагдал)"}
EXPORT_KIND_SLUG = {"income": "orlogo", "expense": "zarlaga"}


def _num(v):
    """Бүхэл бол int — Excel-д '24.0' биш '24'."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return v
    return int(f) if abs(f - round(f)) < EPS else round(f, 3)


def diff_rows(db: Session, sess: HallCountSession) -> list[dict]:
    """Зөрүүтэй мөрүүд (батлах үеийн uncounted_as_zero дүрмээр).
    price: файлын нэгж өртөг → байхгүй бол барааны сүүлийн авсан үнэ → 0."""
    items = (db.query(HallCountItem).filter(HallCountItem.session_id == sess.id)
               .order_by(HallCountItem.code).all())
    codes = [it.code for it in items]
    lpp: dict[str, float] = {}
    for i in range(0, len(codes), 900):
        chunk = codes[i:i + 900]
        for code, price in (db.query(Product.item_code, Product.last_purchase_price)
                              .filter(Product.item_code.in_(chunk)).all()):
            lpp[code] = float(price or 0)
    out = []
    for it in items:
        d = item_diff(it, bool(sess.uncounted_as_zero))
        if d is None or abs(d) < EPS:
            continue
        price_src = "file"
        price = float(it.unit_cost or 0)
        if price <= 0:
            price = lpp.get(it.code, 0.0)
            price_src = "last" if price > 0 else "none"
        out.append({
            "item": it, "code": it.code, "name": it.name,
            "balance": float(it.balance_qty), "counted": float(it.counted_qty),
            "diff": d, "price": price, "price_src": price_src,
            "counted_flag": it.scan_count > 0, "in_list": bool(it.in_list),
        })
    return out


def export_preview(db: Session, sess: HallCountSession) -> dict:
    rows = diff_rows(db, sess)
    inc = [r for r in rows if r["diff"] > 0]
    exp = [r for r in rows if r["diff"] < 0]
    inc_ok = [r for r in inc if r["price"] > 0]
    return {
        "income": {
            "rows": len(inc_ok), "pieces": _num(sum(r["diff"] for r in inc_ok)),
            "amount": round(sum(r["diff"] * r["price"] for r in inc_ok), 2),
            "skipped_no_price": len(inc) - len(inc_ok),
            "estimated_price_rows": len([r for r in inc_ok if r["price_src"] == "last"]),
        },
        "expense": {
            "rows": len(exp), "pieces": _num(sum(-r["diff"] for r in exp)),
            "amount": round(sum(-r["diff"] * r["price"] for r in exp), 2),
            "no_price_rows": len([r for r in exp if r["price"] <= 0]),
            "estimated_price_rows": len([r for r in exp if r["price_src"] == "last"]),
            "uncounted_rows": len([r for r in exp if not r["counted_flag"]]),
        },
    }


def build_erp_xlsx(db: Session, sess: HallCountSession, *, kind: str, doc_date: date_cls,
                   note: str, account: str, related_account: str, location: str) -> tuple[bytes, str, dict]:
    """Эрхэтийн импорт Excel (орлого эсвэл зарлага). Буцаах: (bytes, filename, stats)."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    rows = diff_rows(db, sess)
    if kind == "income":
        sel = [r for r in rows if r["diff"] > 0]
        picked = [r for r in sel if r["price"] > 0]
        skipped = [r for r in sel if r["price"] <= 0]
        qty_of = lambda r: r["diff"]  # noqa: E731
    else:
        sel = [r for r in rows if r["diff"] < 0]
        picked = sel
        skipped = []
        qty_of = lambda r: -r["diff"]  # noqa: E731

    wb = Workbook()
    ws = wb.active
    ws.title = "Import"
    hdr_fill = PatternFill("solid", fgColor="3258A0")
    hdr_font = Font(color="FFFFFF", bold=True)
    for ci, h in enumerate(ERP_HEADERS, 1):
        c = ws.cell(row=1, column=ci, value=h)
        c.fill = hdr_fill
        c.font = hdr_font
        c.alignment = Alignment(horizontal="center")
    for ci, w in enumerate(ERP_WIDTHS, 1):
        ws.column_dimensions[get_column_letter(ci)].width = w

    r_i = 2
    for i, r in enumerate(picked):
        first = i == 0
        qty = qty_of(r)
        total = round(qty * r["price"], 2)
        row = [
            doc_date if first else None,            # Огноо
            None,                                   # Баримтын дугаар
            note if first else None,                # Гүйлгээний утга
            None,                                   # Харилцагч (тооллогын зөрүүд харилцагч байхгүй)
            related_account if first else None, None,
            0 if first else None,                   # НӨАТ тай эсэх
            None, None,
            0 if first else None,                   # НӨАТ-н дүн
            0 if first else None,                   # НХАТ тай эсэх
            None,
            0 if first else None,                   # НХАТ-н дүн
            account,                                # Данс
            r["code"],                              # Бараа материал
            location,                               # Барааны байршил
            _num(qty),                              # Тоо хэмжээ
            _num(r["price"]),                       # Нэгж үнэ
            1.0,                                    # Хувийн жин
            _num(total),                            # Нийт дүн
            0, 0, None,
        ]
        for ci, val in enumerate(row, 1):
            ws.cell(row=r_i, column=ci, value=val)
        r_i += 1

    # ── Тайлбар ──
    ws2 = wb.create_sheet("Тайлбар")
    ws2.column_dimensions["A"].width = 34
    ws2.column_dimensions["B"].width = 26
    ws2.column_dimensions["C"].width = 70
    info = [
        ("Тооллого", f"#{sess.id} · {(sess.confirmed_at or sess.created_at):%Y-%m-%d %H:%M}", ""),
        ("Төрөл", EXPORT_KIND_LABEL[kind],
         "Орлого = тоолсон > үлдэгдэл (илүүдэл). Зарлага = тоолсон < үлдэгдэл (дутагдал)."),
        ("Үлдэгдлийн файл", sess.source_filename or "", ""),
        ("Тоолоогүй барааг 0 гэж тооцсон", "Тийм" if sess.uncounted_as_zero else "Үгүй",
         "Тийм бол уншуулаагүй барааны үлдэгдэл бүхэлдээ дутагдал (зарлага) болно."),
        ("Мөрийн тоо", len(picked), ""),
        ("Нийт ширхэг", _num(sum(qty_of(r) for r in picked)), ""),
        ("Нийт дүн", round(sum(qty_of(r) * r["price"] for r in picked), 2), ""),
        ("Сүүлийн авсан үнээр бодсон мөр", len([r for r in picked if r["price_src"] == "last"]),
         "Үлдэгдлийн файлд нэгж өртөг байгаагүй тул барааны сүүлийн авсан үнийг ашиглав."),
    ]
    if kind == "income":
        info.append(("Үнэгүй тул ХАСАГДСАН мөр", len(skipped),
                     "Нэгж өртөг ч, сүүлийн авсан үнэ ч байхгүй. 0 өртгөөр орлого авбал барааны "
                     "жигнэсэн дундаж өртөг эвдэрнэ — эдгээрийг доор жагсаав, гараар оруулна уу."))
    else:
        info.append(("Үнэгүй (0) мөр", len([r for r in picked if r["price"] <= 0]),
                     "Зарлагад Эрхэт өөрийн дундаж өртгөөр бодно; энд 0 гэж бичсэн."))
        info.append(("Тоолоогүй → дутагдал болсон мөр", len([r for r in picked if not r["counted_flag"]]),
                     "Тооллогод огт уншуулаагүй бараа; үлдэгдэл бүхэлдээ зарлага болно."))
    info.append(("⚠ АНХААРУУЛГА", "Давхар бүртгэлээс сэргийлнэ үү",
                 "Энэ файлыг Эрхэт рүү НЭГ л удаа импортлоно. Дахин татаж импортловол зөрүү 2 удаа бүртгэгдэнэ."))
    for ri, (k, v, n) in enumerate(info, 1):
        ws2.cell(ri, 1, k).font = Font(bold=True)
        ws2.cell(ri, 2, v)
        ws2.cell(ri, 3, n).font = Font(size=9, color="7F8C8D")
    for c in (1, 2, 3):
        ws2.cell(len(info), c).fill = PatternFill("solid", fgColor="FDEBD0")
    if kind == "income" and skipped:
        ri = len(info) + 2
        ws2.cell(ri, 1, "ХАСАГДСАН (үнэгүй) мөрүүд").font = Font(bold=True, color="C0392B")
        ri += 1
        for h_i, h in enumerate(["Код", "Нэр", "Илүүдэл ширхэг"], 1):
            ws2.cell(ri, h_i, h).font = Font(bold=True)
        for r in skipped:
            ri += 1
            ws2.cell(ri, 1, r["code"])
            ws2.cell(ri, 2, r["name"])
            ws2.cell(ri, 3, _num(r["diff"]))

    # "Огноо" (A) баганыг Эрхэтийн танидаг built-in Short Date болгоно, дараа нь
    # Excel-ээр дахин хадгална (receivings-ийн ERP экспорттой ижил арга).
    from app.services.erkhet_xlsx import apply_date_format, finalize_erkhet_xlsx
    if r_i > 2:
        apply_date_format(ws, "A", 2, r_i - 1)
    buf = io.BytesIO()
    wb.save(buf)
    data = finalize_erkhet_xlsx(buf.getvalue()) if picked else buf.getvalue()
    fname = f"{doc_date:%Y%m%d}_zaal_toollogo{sess.id}_{EXPORT_KIND_SLUG[kind]}.xlsx"
    stats = {"rows": len(picked), "skipped": len(skipped),
             "pieces": _num(sum(qty_of(r) for r in picked)),
             "amount": round(sum(qty_of(r) * r["price"] for r in picked), 2)}
    return data, fname, stats


def build_report_xlsx(db: Session, sess: HallCountSession) -> tuple[bytes, str]:
    """Тооллогын дэлгэрэнгүй тайлан (Эрхэт импорт БИШ — хүн уншихад)."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    items = (db.query(HallCountItem).filter(HallCountItem.session_id == sess.id)
               .order_by(HallCountItem.code).all())
    dev = device_breakdown(db, sess.id)
    uz = bool(sess.uncounted_as_zero)
    summary = session_summary(db, sess)

    wb = Workbook()
    hdr_fill = PatternFill("solid", fgColor="1F4E78")
    hdr_font = Font(color="FFFFFF", bold=True)
    ok_fill = PatternFill("solid", fgColor="E2F0D9")
    bad_fill = PatternFill("solid", fgColor="FCE4D6")
    warn_fill = PatternFill("solid", fgColor="FFF2CC")

    def header(ws, cols, widths):
        for ci, h in enumerate(cols, 1):
            c = ws.cell(1, ci, h)
            c.fill = hdr_fill
            c.font = hdr_font
            c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        for ci, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(ci)].width = w
        ws.freeze_panes = "A2"

    def dev_text(it):
        return "; ".join(
            f"{(d['device_label'] or d['username'] or d['device_id'][:6])}: {_num(d['qty'])}"
            for d in dev.get(it.id, []))

    # 1. Дүгнэлт
    ws = wb.active
    ws.title = "Дүгнэлт"
    ws.column_dimensions["A"].width = 40
    ws.column_dimensions["B"].width = 24
    ws.column_dimensions["C"].width = 60
    c = summary["counts"]
    rows = [
        ("ЗААЛНЫ ТООЛЛОГО", f"#{sess.id}", ""),
        ("Төлөв", "Батлагдсан" if sess.status == HC_STATUS_CONFIRMED else "Нээлттэй", ""),
        ("Эхэлсэн", f"{sess.created_at:%Y-%m-%d %H:%M}" if sess.created_at else "", sess.created_by_name or ""),
        ("Батлагдсан", f"{sess.confirmed_at:%Y-%m-%d %H:%M}" if sess.confirmed_at else "—", sess.confirmed_by_name or ""),
        ("Үлдэгдлийн файл", sess.source_filename or "", f"{sess.balance_uploaded_at:%Y-%m-%d %H:%M}" if sess.balance_uploaded_at else ""),
        ("", "", ""),
        ("Жагсаалтын бараа", c["in_list"], "Үлдэгдлийн файлаас ирсэн мөр"),
        ("Тоологдсон", c["counted"], "Дор хаяж нэг удаа уншуулсан"),
        ("  ✓ Таарсан", c["matched"], "Тоолсон = үлдэгдэл → «Таарсан» хуудас"),
        ("  ✗ Зөрүүтэй", c["diff"], "Тоолсон ≠ үлдэгдэл → «Зөрүүтэй» хуудас (жагсаалтад байгаагүйг оруулаад)"),
        ("Тоолоогүй", c["uncounted"], ("0 гэж тооцсон → дутагдал" if uz else "Зөрүүд ОРООГҮЙ") + " → «Тоолоогүй» хуудас"),
        ("Жагсаалтад байгаагүй", c["not_in_list"], "Файлд байгаагүй ч уншуулсан бараа (үлдэгдэл 0)"),
        ("2+ төхөөрөмжөөс тоологдсон", c["multi_device"], "Өөр өөр утаснаас нэмэгдсэн — давхар тоолсон эсэхийг шалгана"),
        ("", "", ""),
        ("Илүүдлийн дүн ₮", summary["surplus_amount"], "Тоолсон > үлдэгдэл · нэгж өртгөөр"),
        ("Дутагдлын дүн ₮", summary["shortage_amount"] + (summary["uncounted_amount"] if uz else 0),
         "Тоолсон < үлдэгдэл" + (" + тоолоогүй барааны үлдэгдэл" if uz else "")),
        ("Нийт скáн", summary["scan_total"], f"{summary['device_total']} төхөөрөмж"),
    ]
    for ri, (k, v, n) in enumerate(rows, 1):
        ws.cell(ri, 1, k).font = Font(bold=True, size=12 if ri == 1 else 11)
        ws.cell(ri, 2, v)
        ws.cell(ri, 3, n).font = Font(size=9, color="7F8C8D")

    COLS = ["Код", "Нэр", "Үлдэгдэл", "Тоолсон", "Зөрүү", "Нэгж өртөг", "Зөрүүний дүн ₮",
            "Скáн", "Төхөөрөмж", "Хэн хэдийг", "Сүүлд"]
    WID = [12, 44, 11, 11, 10, 12, 16, 7, 11, 40, 17]

    def write_items(ws, its, *, sort_key=None, fill=None):
        header(ws, COLS, WID)
        if sort_key:
            its = sorted(its, key=sort_key)
        if not its:
            ws.cell(2, 1, "✓ Энэ ангилалд бараа олдсонгүй").font = Font(italic=True, color="7F8C8D")
            return
        for ri, it in enumerate(its, 2):
            d = item_diff(it, uz)
            d = 0.0 if d is None else d
            vals = [it.code, it.name, _num(it.balance_qty),
                    _num(it.counted_qty) if it.scan_count > 0 else None,
                    _num(d), _num(it.unit_cost), None, it.scan_count, it.device_count,
                    dev_text(it), f"{it.last_scanned_at:%m-%d %H:%M}" if it.last_scanned_at else ""]
            for ci, v in enumerate(vals, 1):
                ws.cell(ri, ci, v)
            ws.cell(ri, 7, f"=E{ri}*F{ri}")
            f = fill or (ok_fill if abs(d) < EPS else (warn_fill if d > 0 else bad_fill))
            for ci in range(1, len(COLS) + 1):
                ws.cell(ri, ci).fill = f
        last = len(its) + 1
        ws.cell(last + 1, 1, "Нийт").font = Font(bold=True)
        for col in ("C", "D", "E", "G"):
            ws[f"{col}{last + 1}"] = f"=SUM({col}2:{col}{last})"
            ws[f"{col}{last + 1}"].font = Font(bold=True)

    by = defaultdict(list)
    for it in items:
        by[classify(it)].append(it)
    write_items(wb.create_sheet("Зөрүүтэй"), by["diff"] + by["not_in_list"],
                sort_key=lambda it: -abs((it.counted_qty - it.balance_qty) * (it.unit_cost or 0)))
    write_items(wb.create_sheet("Таарсан"), by["matched"], fill=ok_fill)
    write_items(wb.create_sheet("Тоолоогүй"), by["uncounted"],
                sort_key=lambda it: -(it.balance_qty * (it.unit_cost or 0)), fill=bad_fill if uz else warn_fill)
    write_items(wb.create_sheet("2+ төхөөрөмж"), [it for it in items if it.device_count >= 2],
                sort_key=lambda it: -it.device_count)
    write_items(wb.create_sheet("Жагсаалтад байгаагүй"), by["not_in_list"], fill=warn_fill)

    # Скáн бүртгэл
    ws = wb.create_sheet("Скáн бүртгэл")
    header(ws, ["Огноо цаг", "Код", "Нэр", "Тоо", "Төхөөрөмж", "Хэрэглэгч", "Device ID"],
           [17, 12, 44, 9, 16, 16, 14])
    name_of = {it.id: it.name for it in items}
    scans = (db.query(HallCountScan).filter(HallCountScan.session_id == sess.id)
               .order_by(HallCountScan.created_at).all())
    for ri, s in enumerate(scans, 2):
        for ci, v in enumerate([f"{s.created_at:%Y-%m-%d %H:%M:%S}", s.code, name_of.get(s.item_id, ""),
                                _num(s.qty), s.device_label, s.username, (s.device_id or "")[:8]], 1):
            ws.cell(ri, ci, v)

    buf = io.BytesIO()
    wb.save(buf)
    when = sess.confirmed_at or sess.created_at or datetime.utcnow()
    return buf.getvalue(), f"{when:%Y%m%d}_zaal_toollogo{sess.id}_tailan.xlsx"
