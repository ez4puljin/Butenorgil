"""Хөрвүүлэлтийн бараа — заалны барааг задлах/хөрвүүлэх урсгал.

1. Худалдагч барааг хайж тоо оруулаад «Захиалга илгээх» → erxes-д deal:
     board «Заалны хөдөлгөөн» (PaooFqJEZGo68v6JR) · pipeline DsYn2jZAqeuA4e8Ct ·
     stage «Худалдагчийн Захиалга» (sGAxy6maZ6T8Egix4) · харилцагч «Заал гурил будаа гоймон»
     (rwpvAn9pQgAtCzAHz). `dealsAdd(name, stageId, customerIds, productsData)` — 2026-10-26-нд
     аргументыг GraphQL validation-аар (deal үүсгэлгүй) тогтоосон. Энэ pipeline ebarimtConfig-д
     ороогүй тул deal Эрхэт рүү автоматаар sync хийгдэхгүй.
2. Мөр бүрт юу болгож, хэдэн ширхэг болгож хөрвүүлснийг оруулна.
3. Эрхэт рүү (хэрэглэгч баталсны дараа, НЭГ удаа):
     • «Бараа материалын хангамжын зарлага» (inv_so) — хөрвүүлсэн бараа 03-Заалаас;
     • «Бараа материалын орлого» (inv_income) — хөрвүүлэлтийн үр дүн 03-Заалд.
   Харилцагч = тохиргооны Эрхэтийн код (Эрхэтэд «Заал гурил будаа гоймон» нэртэй харилцагч алга —
   2026-10-26; анхдагч 203 «Заал-3 … гурил, будаа»), Данс* 150101, Харьцсан данс 320101
   («Урьдчилж орсон орлого»), үнэ = барааны нэгж үнэ (erxes unitPrice = Эрхэтийн «Нэгж үнэ»),
   Гүйлгээний утга «YYYY-MM-DD-ний хөрвүүлэлт #N».
"""
from __future__ import annotations

import io
import json
import secrets
from datetime import date, datetime
from pathlib import Path

SETTINGS_FILE = Path("app/data/conversion_settings.json")
DEFAULTS = {
    "board_id": "PaooFqJEZGo68v6JR",
    "pipeline_id": "DsYn2jZAqeuA4e8Ct",
    "stage_id": "sGAxy6maZ6T8Egix4",
    "customer_id": "rwpvAn9pQgAtCzAHz",
    "customer_name": "Заал гурил будаа гоймон",
    "erkhet_customer": "203",
    "account": "150101",
    "related_account": "320101",
    "location": "03",
    # «Юу болгож хөрвүүлсэн» сонгох бараа зөвхөн энэ segment-ээс (жингийн кг-ийн бараа — 2026-10-26 хэрэглэгч)
    "result_segment": "R4ZBIRFhNKzN-v1LiKiPY",
}
ERXES_WEB = "https://erxes.bto.mn"


def load_settings() -> dict:
    try:
        s = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        s = {}
    return {**DEFAULTS, **{k: v for k, v in s.items() if k in DEFAULTS and v not in (None, "")}}


def save_settings(s: dict) -> dict:
    cur = load_settings()
    cur.update({k: str(v).strip() for k, v in s.items() if k in DEFAULTS and v is not None})
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(cur, ensure_ascii=False, indent=1), encoding="utf-8")
    return cur


# ── Бараа хайх (erxes идэвхтэй бараа, 1 цагийн индекс — erkhet_stock_live-тэй дундаа) ─────────

def _norm(s) -> str:
    return " ".join(str(s or "").lower().split())


def product_index() -> dict[str, dict]:
    from app.services.erkhet_stock_live import _product_index
    return _product_index()


def search(q: str, limit: int = 30) -> list[dict]:
    q = (q or "").strip()
    if not q:
        return []
    idx = product_index()
    ql = _norm(q)
    exact, starts, contains = [], [], []
    for code, p in idx.items():
        bcs = p.get("barcodes") or []
        if code == q or q in bcs:
            exact.append(p)
        elif code.startswith(q):
            starts.append(p)
        elif all(w in _norm(p.get("name")) for w in ql.split()):
            contains.append(p)
        if len(exact) + len(starts) + len(contains) > 400:
            break
    out = (exact + sorted(starts, key=lambda p: p["code"]) + contains)[:limit]
    return [product_out(p) for p in out]


_seg_cache: dict = {"at": 0.0, "id": "", "codes": set()}
SEG_TTL = 600


def result_codes() -> set[str]:
    """Хөрвүүлэлтийн үр дүнд сонгож болох барааны кодууд (result_segment, 10 мин кэш)."""
    import time
    from app.services.erxes_client import get_client
    seg = load_settings()["result_segment"]
    if _seg_cache["codes"] and _seg_cache["id"] == seg and time.monotonic() - _seg_cache["at"] < SEG_TTL:
        return _seg_cache["codes"]
    codes, page = set(), 1
    while True:
        rows = get_client().gql('query($s:String,$p:Int){ products(segment:$s, status:"active", perPage:500, page:$p)'
                                '{ code } }', {"s": seg, "p": page}).get("products") or []
        codes |= {str(r["code"]).strip() for r in rows if r.get("code")}
        if len(rows) < 500 or page > 20:
            break
        page += 1
    _seg_cache.update(at=time.monotonic(), id=seg, codes=codes)
    return codes


def search_results(q: str, limit: int = 60) -> list[dict]:
    """Үр дүнгийн бараа — зөвхөн segment-ийн бараа; q хоосон бол бүгдийг (цөөн) буцаана."""
    idx = product_index()
    allowed = [idx[c] for c in sorted(result_codes()) if c in idx]
    q = (q or "").strip()
    if q:
        ql = _norm(q)
        allowed = [p for p in allowed if p["code"] == q or q in (p.get("barcodes") or []) or p["code"].startswith(q)
                   or all(w in _norm(p.get("name")) for w in ql.split())]
    return [product_out(p) for p in allowed[:limit]]


def product_out(p: dict) -> dict:
    return {"id": p.get("_id"), "code": p.get("code") or "", "name": p.get("name") or "",
            "price": float(p.get("unitPrice") or 0), "uom": p.get("uom") or "",
            "barcodes": p.get("barcodes") or [], "category": (p.get("category") or {}).get("name") or ""}


def product_by_code(code: str) -> dict | None:
    p = product_index().get((code or "").strip())
    return product_out(p) if p else None


# ── erxes deal ─────────────────────────────────────────────────────────────────

def create_deal(order, lines) -> tuple[str, str]:
    """erxes-д deal үүсгэнэ. → (_id, number)."""
    from app.services.erxes_client import get_client
    s = load_settings()
    products = []
    for l in lines:
        products.append({
            "_id": secrets.token_urlsafe(15)[:21], "productId": l.erxes_id, "uom": l.uom or "PC",
            "currency": "MNT", "quantity": l.qty, "unitPrice": l.unit_price, "amount": round(l.qty * l.unit_price, 2),
            "maxQuantity": 0, "taxPercent": 0, "tax": 0, "discountPercent": 0, "discount": 0, "tickUsed": True,
        })
    name = f"Хөрвүүлэлт #{order.id} · {order.conv_date:%m/%d}" + (f" · {order.created_by}" if order.created_by else "")
    c = get_client()
    d = c.gql('mutation($n:String,$s:String,$c:[String],$p:JSON,$d:String){ dealsAdd(name:$n, stageId:$s, '
              'customerIds:$c, productsData:$p, description:$d){ _id } }',
              {"n": name, "s": s["stage_id"], "c": [s["customer_id"]], "p": products,
               "d": order.note or ""}).get("dealsAdd") or {}
    did = d.get("_id") or ""
    number = ""
    if did:
        try:
            number = (c.gql('query($id:String!){ dealDetail(_id:$id){ number } }', {"id": did})
                      .get("dealDetail") or {}).get("number") or ""
        except Exception:
            pass
    return did, number


def deal_products(deal_id: str) -> list[dict]:
    """erxes deal-ийн одоогийн бараа (tickUsed) → [{code, qty, erxes_id}] — агуулах үлдэгдэл хүрээгүйгээс
    deal-ийн тоог өөрчилсөн бол ERP-ийн мөрийг түүгээр шинэчлэхэд."""
    from app.services.erxes_client import get_client
    d = get_client().gql('query($id:String!){ dealDetail(_id:$id){ productsData } }', {"id": deal_id}).get("dealDetail") or {}
    pdata = d.get("productsData") or []
    if isinstance(pdata, str):
        pdata = json.loads(pdata or "[]")
    by_id = {p.get("_id"): code for code, p in product_index().items()}
    out: dict[str, dict] = {}
    for p in pdata:
        if not isinstance(p, dict) or not p.get("tickUsed"):
            continue
        code = by_id.get(p.get("productId"))
        if not code:
            continue
        x = out.setdefault(code, {"code": code, "qty": 0.0, "erxes_id": p.get("productId")})
        x["qty"] += float(p.get("quantity") or 0)
    return list(out.values())


def deal_url(deal_id: str) -> str:
    s = load_settings()
    return f"{ERXES_WEB}/deal/board?id={s['board_id']}&pipelineId={s['pipeline_id']}&itemId={deal_id}" if deal_id else ""


# ── Эрхэтийн импорт Excel ──────────────────────────────────────────────────────

SO_HEADERS = ["Баримтын дугаар", "Огноо", "Гүйлгээний утга", "Харилцагч", "Харьцсан данс",
              "Харьцсан ялгаатай харилцагч", "Бараа материал*", "Данс*", "Барааны байршил*",
              "Тоо хэмжээ*", "Нэгж үнэ*", "Нийт дүн*"]
INCOME_HEADERS = ["Огноо", "Баримтын дугаар", "Гүйлгээний утга", "Харилцагч", "Харьцсан данс",
                  "Харьцсан ялгаатай харилцагч", "НӨАТ тай эсэх", "НӨАТ-н үзүүлэлт", "НӨАТ автоматаар бодох эсэх",
                  "НӨАТ-н дүн", "НХАТ тaй эсэх", "НХАТ автоматаар бодох эсэх", "НХАТ-н дүн", "Данс*",
                  "Бараа материал*", "Барааны байршил*", "Тоо хэмжээ*", "Нэгж үнэ*", "Хувийн жин*", "Нийт дүн*",
                  "НӨАТ тооцох эсэх*", "НХАТ тооцох эсэх", "НХАТ мөр"]


def description(order) -> str:
    return f"{order.conv_date:%Y-%m-%d}-ний хөрвүүлэлт #{order.id}"


def build_excel(order, kind: str) -> tuple[bytes, str, int]:
    """kind: "so" (зарлага — хөрвүүлсэн бараа) | "income" (орлого — үр дүн). → (bytes, filename, мөрийн тоо)."""
    from openpyxl import Workbook
    from app.services.erkhet_xlsx import apply_date_format, finalize_erkhet_xlsx
    s = load_settings()
    wb = Workbook()
    ws = wb.active
    ws.title = "Import"
    desc = description(order)
    d = datetime.combine(order.conv_date, datetime.min.time())
    if kind == "so":
        ws.append(SO_HEADERS)
        rows = [(l.code, l.qty, l.unit_price) for l in order.lines if l.qty > 0]
        for i, (code, qty, price) in enumerate(rows):
            first = i == 0
            ws.append([None, d if first else None, desc if first else None, s["erkhet_customer"] if first else None,
                       s["related_account"] if first else None, None, code, s["account"], s["location"],
                       qty, price, round(qty * price, 2)])
        if rows:
            apply_date_format(ws, "B", 2, 2)
        date_col = "B"
    else:
        ws.append(INCOME_HEADERS)
        rows = [(r.code, r.qty, r.unit_price) for l in order.lines for r in l.results if r.qty > 0]
        for i, (code, qty, price) in enumerate(rows):
            first = i == 0
            ws.append([d if first else None, None, desc if first else None, s["erkhet_customer"] if first else None,
                       s["related_account"] if first else None, None,
                       0 if first else None, None, None, 0 if first else None, 0 if first else None, None,
                       0 if first else None, s["account"], code, s["location"], qty, price, 1.0,
                       round(qty * price, 2), 0, 0, None])
        if rows:
            apply_date_format(ws, "A", 2, 2)
        date_col = "A"
    buf = io.BytesIO()
    wb.save(buf)
    data = finalize_erkhet_xlsx(buf.getvalue(), date_col=date_col)
    label = "Зарлага" if kind == "so" else "Орлого"
    return data, f"Хөрвүүлэлт_{order.id}_{order.conv_date:%Y%m%d}_{label}.xlsx", len(rows)


def to_dict(order, with_lines: bool = True) -> dict:
    lines = list(order.lines)
    done = sum(1 for l in lines if any(r.qty > 0 for r in l.results))
    out = {
        "id": order.id, "status": order.status, "conv_date": order.conv_date.isoformat(), "note": order.note,
        "deal_id": order.deal_id, "deal_number": order.deal_number, "deal_url": deal_url(order.deal_id),
        "created_by": order.created_by, "created_at": (order.created_at.isoformat() + "Z") if order.created_at else None,
        "sent_by": order.sent_by, "sent_at": (order.sent_at.isoformat() + "Z") if order.sent_at else None,
        "line_count": len(lines), "converted_count": done,
        "out_amount": round(sum(l.qty * l.unit_price for l in lines), 2),
        "in_amount": round(sum(r.qty * r.unit_price for l in lines for r in l.results), 2),
        "erkhet": json.loads(order.erkhet_result or "{}"),
        "manual": not order.deal_id, "lines_editable": lines_editable(order),
    }
    if with_lines:
        out["lines"] = [{
            "id": l.id, "code": l.code, "name": l.name, "uom": l.uom, "qty": l.qty, "unit_price": l.unit_price,
            "results": [{"id": r.id, "code": r.code, "name": r.name, "uom": r.uom, "qty": r.qty,
                         "unit_price": r.unit_price} for r in l.results],
        } for l in lines]
    return out


def lines_editable(order) -> bool:
    """Эх (задлах) барааг засаж болох эсэх — Эрхэтэд зарлага орсон/хүлээгдэж байвал болохгүй."""
    if order.status == "cancelled":
        return False
    so = (json.loads(order.erkhet_result or "{}").get("so") or {}).get("status")
    return so not in ("ok", "queued", "unknown")


def refresh_status(order) -> None:
    if order.status in ("sent", "cancelled"):
        return
    lines = list(order.lines)
    order.status = "converted" if lines and all(any(r.qty > 0 for r in l.results) for l in lines) else "ordered"


def today_ub() -> date:
    from datetime import timedelta, timezone
    return datetime.now(timezone(timedelta(hours=8))).date()
