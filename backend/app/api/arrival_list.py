"""Агуулахад буусан барааны жагсаалт — утсан дээр үзэхэд зориулсан PDF.

Сонгосон огнооны хооронд 01, 02, 11, 12 байршилд (Бөөний, Ус ундаа архи пиво, Жижиглэн,
Гэрээт компаний агуулах) орлого авсан бараанууд — Эрхэтийн орлогын файлаас (Файл оруулалт →
Орлогын файл). Код, нэр, ангилал, нэгж үнэ, зургийг барааны мастер Excel-ээс авна.

  GET /reports/arrivals?date_from=&date_to=&locations=01,02,11,12   — урьдчилсан тоо + зургийн бэлэн байдал
  GET /reports/arrivals/pdf?...                                    — PDF (iPhone 9:19.5 хуудас, ангиллаар)

Зураг: мастерын imageUrl (erxes read-file) — `&width=` параметрээр жижиг хувилбарыг татаж
app/data/image_cache-д хадгална (дахин татахгүй). warm loop сүүлийн 14 хоногийн орлогын
зургийг урьдчилан татна — PDF хурдан гарна.
"""
from __future__ import annotations

import re
import threading
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from app.api.deps import require_role
from app.services.mobile_pdf import (COMPANY, build_product_list_pdf, fmt_d, image_stats, master_products,
                                     norm_code as _norm_code, prefetch, wait_images)

router = APIRouter(prefix="/reports", tags=["arrivals"])
ROLES = ("admin", "supervisor", "manager")

DEFAULT_LOCATIONS = ("01", "02", "11", "12")
ORDER_PHONE = "85813818"
ORDER_CONTACT = "Орон нутгийн ХТ - Долгор"
TITLE = "Агуулахад буусан барааны жагсаалт"

INCOME_DIR = Path("app/data/uploads/income")


def _to_date(v) -> date | None:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if isinstance(v, (int, float)) and v > 20000:                 # Excel serial
        return date(1899, 12, 30) + timedelta(days=int(v))
    s = str(v or "").strip()[:10]
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def _loc_code(v) -> str:
    s = _norm_code(v)
    return s.zfill(2) if s.isdigit() and len(s) < 2 else s


# ── Орлогын мөрүүд (байршлын кодтой) — файл бүрийн mtime-кэш ─────────────────────

_INC: dict[str, tuple[float, list]] = {}
_INC_LOCK = threading.Lock()


def _parse_income(path: Path) -> list[tuple]:
    """→ [(date, code, name, loc_code, loc_name, qty)]"""
    from python_calamine import CalamineWorkbook
    wb = CalamineWorkbook.from_path(str(path))
    rows = wb.get_sheet_by_name(wb.sheet_names[0]).to_python()
    hi = next((i for i, r in enumerate(rows[:25]) if any(str(c).strip() == "Байршил нэр" for c in r)), -1)
    if hi < 0:
        return []
    ix = {str(c).strip(): i for i, c in enumerate(rows[hi])}
    need = ("Огноо", "Бараа материал код", "Байршил нэр")
    if any(k not in ix for k in need):
        return []
    g = lambda r, k: r[ix[k]] if k in ix and ix[k] < len(r) else None
    out = []
    for r in rows[hi + 1:]:
        d = _to_date(g(r, "Огноо"))
        code = _norm_code(g(r, "Бараа материал код"))
        if not d or not code or code.lower() == "nan":
            continue
        try:
            qty = float(g(r, "Тоо хэмжээ") or 0)
        except (TypeError, ValueError):
            qty = 0.0
        out.append((d, code, str(g(r, "Бараа материал нэр") or "").strip(), _loc_code(g(r, "Байршил код")),
                    str(g(r, "Байршил нэр") or "").strip(), qty))
    return out


def _income_rows(d1: date, d2: date) -> list[tuple]:
    """[d1, d2]-тэй давхцах орлогын файлуудын мөрүүд (сарын файлтай онд бүтэн оны файлыг алгасна)."""
    from app.core.db import SessionLocal
    from app.models.income_file import IncomeFile
    db = SessionLocal()
    try:
        files = db.query(IncomeFile).all()
        monthly_years = {f.year for f in files if (f.month or 0) > 0}
        picked = []
        for f in files:
            m = f.month or 0
            if not f.stored_filename or (m == 0 and f.year in monthly_years):
                continue
            if m:
                start = date(f.year, m, 1)
                end = (date(f.year + (m == 12), m % 12 + 1, 1) - timedelta(days=1))
            else:
                start, end = date(f.year, 1, 1), date(f.year, 12, 31)
            if start <= d2 and end >= d1:
                picked.append(f.stored_filename)
    finally:
        db.close()
    out: list = []
    for fname in sorted(picked):
        path = INCOME_DIR / fname
        if not path.exists():
            continue
        mtime = path.stat().st_mtime
        hit = _INC.get(str(path))
        if not hit or hit[0] != mtime:
            with _INC_LOCK:
                hit = _INC.get(str(path))
                if not hit or hit[0] != mtime:
                    try:
                        hit = (mtime, _parse_income(path))
                    except Exception as e:                       # эвдэрсэн файл бусдыг саатуулахгүй
                        print(f"[arrivals] {fname} уншиж чадсангүй: {e}")
                        hit = (mtime, [])
                    _INC[str(path)] = hit
        out.extend(r for r in hit[1] if d1 <= r[0] <= d2)
    return out


NOT_IN_MASTER = "__not_in_master__"      # дотоод тэмдэглэгээ — PDF-д «Бусад» гэж гарна
OTHER_LABEL = "Бусад"


def _cat_key(cat: str) -> tuple[int, str]:
    """«905 Хятад бараа» → (905, «Хятад бараа»). «923 +Тамхи», «926 925 - Хатаасан мах» шиг
    давхар код/тэмдгийг цэвэрлэнэ. Мастерт бүртгэлгүй нь «Бусад» — хамгийн сүүлд."""
    if cat == NOT_IN_MASTER:
        return (10 ** 6, OTHER_LABEL)
    raw = (cat or "").strip()
    m = re.match(r"^(\d+)", raw)
    code = int(m.group(1)) if m else 99999
    label = re.sub(r"^(\d+\s*[-.–]?\s*)+", "", raw).lstrip("+-–. ").strip()
    return (code, label or raw or "Ангилалгүй")


def _collect(d1: date, d2: date, locations: tuple[str, ...]) -> dict:
    """Сонгосон хугацаа, байршлын орлого → бараа (давхардалгүй) ангиллаар бүлэглэсэн."""
    rows = _income_rows(d1, d2)
    master = master_products()
    locs: dict[str, dict] = {}
    items: dict[str, dict] = {}
    for d, code, name, lc, ln, qty in rows:
        li = locs.setdefault(lc, {"code": lc, "name": ln, "rows": 0})
        li["rows"] += 1
        if lc not in locations or qty <= 0:
            continue
        it = items.get(code)
        if it is None:
            m = master.get(code)
            items[code] = it = {
                "code": code, "name": (m or {}).get("name") or name, "cat": (m or {}).get("cat") or NOT_IN_MASTER,
                "price": (m or {}).get("price") or 0.0, "img": (m or {}).get("img") or "",
                "in_master": m is not None, "last": d,
            }
        elif d > it["last"]:
            it["last"] = d
    # Нэр ижил ангиллыг (жишээ 504 Саван, 508 Саван) нэг бүлэг болгоно
    groups: dict[str, list] = {}
    order: dict[str, int] = {}
    for it in items.values():
        code, label = _cat_key(it["cat"])
        groups.setdefault(label, []).append(it)
        order[label] = min(order.get(label, code), code)
    labels = sorted(groups, key=lambda lb: (order[lb], lb))
    for lb in labels:
        groups[lb].sort(key=lambda x: (x["name"].lower(), x["code"]))
    return {"groups": [(lb, lb, groups[lb]) for lb in labels],
            "count": len(items), "locations": sorted(locs.values(), key=lambda x: x["code"]),
            "data_until": max((r[0] for r in rows), default=None)}


def warm_arrival_images() -> None:
    """main-ийн warm loop-оос — сүүлийн 14 хоногийн орлогын зургийг урьдчилан татна (хүлээхгүй)."""
    try:
        today = date.today()
        data = _collect(today - timedelta(days=14), today, DEFAULT_LOCATIONS)
        prefetch([it["img"] for _, _, its in data["groups"] for it in its if it["img"]])
    except Exception as e:
        print(f"[arrivals] warm алдаа: {e}")


# ── API ──────────────────────────────────────────────────────────────────────

def _params(date_from: str, date_to: str, locations: str) -> tuple[date, date, tuple[str, ...]]:
    d1, d2 = _to_date(date_from), _to_date(date_to)
    if not d1 or not d2:
        raise HTTPException(400, "Огноо буруу байна.")
    if d1 > d2:
        raise HTTPException(400, "Эхлэх огноо дуусах огнооноос хойш байна.")
    if (d2 - d1).days > 370:
        raise HTTPException(400, "Нэг жилээс урт хугацаа сонгох боломжгүй.")
    locs = tuple(dict.fromkeys(_loc_code(x) for x in (locations or "").split(",") if x.strip())) or DEFAULT_LOCATIONS
    return d1, d2, locs


@router.get("/arrivals")
def arrivals_preview(date_from: str = Query(...), date_to: str = Query(...),
                     locations: str = Query(",".join(DEFAULT_LOCATIONS), max_length=100),
                     _=Depends(require_role(*ROLES))):
    d1, d2, locs = _params(date_from, date_to, locations)
    data = _collect(d1, d2, locs)
    urls = [it["img"] for _, _, its in data["groups"] for it in its if it["img"]]
    prefetch(urls)                                                # PDF-ээс өмнө зургийг бэлдэж эхэлнэ
    return {
        "date_from": d1.isoformat(), "date_to": d2.isoformat(), "locations": list(locs),
        "available_locations": data["locations"], "count": data["count"],
        "categories": [{"name": label, "count": len(its)} for _, label, its in data["groups"]],
        "no_image_url": sum(1 for _, _, its in data["groups"] for it in its if not it["img"]),
        "not_in_master": sum(1 for _, _, its in data["groups"] for it in its if not it["in_master"]),
        "no_price": sum(1 for _, _, its in data["groups"] for it in its if not it["price"]),
        "images": {"total": len(urls), **image_stats(urls)},
        "data_until": data["data_until"].isoformat() if data["data_until"] else None,
        "order_phone": ORDER_PHONE, "order_contact": ORDER_CONTACT,
    }


@router.get("/arrivals/pdf")
def arrivals_pdf(date_from: str = Query(...), date_to: str = Query(...),
                 locations: str = Query(",".join(DEFAULT_LOCATIONS), max_length=100),
                 _=Depends(require_role(*ROLES))):
    d1, d2, locs = _params(date_from, date_to, locations)
    data = _collect(d1, d2, locs)
    if not data["count"]:
        raise HTTPException(404, "Сонгосон хугацаанд эдгээр байршилд орлого авсан бараа алга.")
    urls = [it["img"] for _, _, its in data["groups"] for it in its if it["img"]]
    wait_images(urls)                                             # proxy-ийн хугацаанд багтаана; үлдсэн нь дараагийн удаа
    pdf = _build_pdf(d1, d2, data)
    fname = f"Агуулахад_буусан_бараа_{d1:%Y-%m-%d}_{d2:%Y-%m-%d}.pdf"
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f"attachment; filename=arrivals_{d1:%Y%m%d}_{d2:%Y%m%d}.pdf; "
                                                    f"filename*=UTF-8''{quote(fname)}"})


# ── PDF (iPhone хэмжээ — app/services/mobile_pdf) ────────────────────────────────

def _fmt_price(p: float) -> str:
    return f"{int(round(p)):,}₮" if p and p > 0 else "—"


def _build_pdf(d1: date, d2: date, data: dict) -> bytes:
    period = fmt_d(d1) if d1 == d2 else f"{fmt_d(d1)} – {fmt_d(d2)}"
    groups = [(label, [{"img": it["img"], "name": it["name"] or it["code"], "lines": [f"Код: {it['code']}"],
                        "right": _fmt_price(it["price"]), "right_color": "green" if it["price"] else "gray"}
                       for it in its])
              for _, label, its in data["groups"]]
    return build_product_list_pdf(
        title=TITLE, period=period, groups=groups, group_noun="ангилал",
        box={"label": "Захиалгын утас", "big": ORDER_PHONE, "small": f"({ORDER_CONTACT})", "link": f"tel:{ORDER_PHONE}"},
        footer_left=f"{COMPANY} · Захиалга: {ORDER_PHONE}", footer_link=f"tel:{ORDER_PHONE}")
