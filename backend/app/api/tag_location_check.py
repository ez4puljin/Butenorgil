"""Tag vs Байршил зөрүүтэй орлого шалгах.

Орлогын файл оруулалт (income_files, жил тус бүр нэг түүхий Excel)-ын
бүх орлогын мөрийг Master эксэлийн бараа болгоны "Байршил tag"-тай тулгана:

  - Орлогын L багана = "Байршил нэр" (орлого авагдсан байршил)
  - Master "Код" → "Байршил tag" (CSV, нэг бараа олон tag-тай байж болно)

Орлогын байршлын нэр ба мастерын tag-ийн НЭРШИЛ өөр тул (ж: "Заал" ↔
"Зааланд ирдэг", "Гэрээт компаний агуулах" ↔ "Гэрээт компани") хооронд нь
харгалзуулах тохиргоо (tag_location_map.json) ашиглана. Анхдагч харгалзааг
бодит датагийн давамгай тархалтаас (78-99%) гаргасан бөгөөд UI-аас засаж
болно. Бараа нь байршилдаа харгалзах tag-гүй бол ЗӨРҮҮТЭЙ гэж тооцно.

Гүйцэтгэл: орлогын файл (нийт ~100К мөр) болон мастерыг mtime-аар кэшилнэ —
файл солигдоогүй л бол дахин уншихгүй; startup + 60с warm loop урьдчилан
ачаална. Шалгалт өөрөө dict lookup тул <1с.
"""
from __future__ import annotations

import io
import json
import re
import threading
from datetime import date as date_type, datetime
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.api.deps import require_role

router = APIRouter(prefix="/reports", tags=["tag-location-check"])

INCOME_DIR = Path("app/data/uploads/income")
MASTER_FILE = Path("app/data/outputs/master_latest.xlsx")
CONFIG_FILE = Path("app/data/tag_location_map.json")

# Бодит датагийн давамгай тархалтаас гаргасан анхдагч харгалзаа
# (байршил бүр дээр авагдсан барааны мастер tag-ийн 78-99% нь эдгээр).
DEFAULT_CONFIG = {
    "map": {
        "Заал": ["Зааланд ирдэг"],
        "Ус ундаа архи пиво": ["Архи Ус ундаа пиво"],
        "Бөөний агуулах": ["Бөөний агуулах"],
        "Гэрээт компаний агуулах": ["Гэрээт компани"],
        "Жижиглэн барааны агуулах": ["Жижиглэн агуулах"],
        "Заалны архи": ["Архи Ус ундаа пиво", "Жижиглэн Архи"],
        "Агуулахын Хөргүүр": ["Хөргүүр (Агуулах)"],
    },
    # Эдгээр байршлын орлогыг шалгалтаас бүрэн алгасна
    "ignore_locations": ["Discrepancy Control"],
}

MAX_PREVIEW_ROWS = 3000   # JSON хариунд буцаах зөрүүтэй мөрийн дээд хязгаар


def _norm(s) -> str:
    """Нэр харьцуулахад: trim + олон зай нэгтгэх + lower."""
    return re.sub(r"\s+", " ", str(s or "").strip()).lower()


def _norm_code(v) -> str:
    s = re.sub(r"\.0$", "", str(v or "").strip())
    return re.sub(r"\s+", "", s)


# ── Тохиргоо ────────────────────────────────────────────────────────────────

def get_tagloc_config() -> dict:
    try:
        if CONFIG_FILE.exists():
            d = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            return {
                "map": {str(k): [str(t) for t in v] for k, v in (d.get("map") or {}).items()},
                "ignore_locations": [str(x) for x in (d.get("ignore_locations") or [])],
            }
    except Exception:
        pass
    return json.loads(json.dumps(DEFAULT_CONFIG))   # deep copy


def set_tagloc_config(cfg: dict) -> dict:
    out = {
        "map": {str(k).strip(): [str(t).strip() for t in v if str(t).strip()]
                for k, v in (cfg.get("map") or {}).items() if str(k).strip()},
        "ignore_locations": [str(x).strip() for x in (cfg.get("ignore_locations") or []) if str(x).strip()],
    }
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


# ── Кэштэй parser-ууд (олон хэрэглэгчид зориулсан stampede lock-той) ─────────

# path -> (mtime, rows)   rows = list[(date, doc_no, code, name, loc, qty, price, amount, user)]
_income_cache: dict[str, tuple[float, list]] = {}
# (mtime, {code: [raw tags]})
_master_cache: tuple[float, dict] | None = None
_cache_lock = threading.Lock()


def _read_excel_fast(path: str, **kw):
    """calamine engine (15-20x хурдан) — байхгүй/алдвал openpyxl fallback."""
    import pandas as pd
    try:
        return pd.read_excel(path, engine="calamine", **kw)
    except Exception:
        return pd.read_excel(path, **kw)


def _parse_income_file(path: Path) -> list:
    """Орлогын Excel → мөрийн жагсаалт (calamine: 70К мөр ~6с, дараа нь кэш)."""
    import pandas as pd

    df = _read_excel_fast(str(path), header=0, dtype=object)
    if "Байршил нэр" not in df.columns:
        # Header эхний мөрөнд биш бол уян хатан хайна
        raw = _read_excel_fast(str(path), header=None, dtype=object, nrows=25)
        hdr = -1
        for i in range(len(raw)):
            if any(str(v).strip() == "Байршил нэр" for v in raw.iloc[i].tolist()):
                hdr = i
                break
        if hdr < 0:
            return []
        df = _read_excel_fast(str(path), header=hdr, dtype=object)

    def col(name):
        return df[name] if name in df.columns else pd.Series([None] * len(df))

    dates = pd.to_datetime(col("Огноо"), errors="coerce")
    codes = (col("Бараа материал код").astype(str).str.strip()
             .str.replace(r"\.0$", "", regex=True).str.replace(r"\s+", "", regex=True))
    names = col("Бараа материал нэр").astype(str).str.strip()
    locs = col("Байршил нэр").astype(str).str.strip()
    docs = col("Баримтын дугаар").astype(str).str.strip()
    qty = pd.to_numeric(col("Тоо хэмжээ"), errors="coerce").fillna(0.0)
    price = pd.to_numeric(col("Нэгж үнэ"), errors="coerce").fillna(0.0)
    debit = pd.to_numeric(col("Дебет"), errors="coerce").fillna(0.0)
    users = col("Хэрэглэгч").astype(str).str.strip()

    rows = []
    for d, doc, c, n, l, q, p, a, u in zip(dates, docs, codes, names, locs, qty, price, debit, users):
        if pd.isna(d) or not c or c.lower() == "nan":
            continue
        if not l or l.lower() == "nan":
            continue
        rows.append((d.date(), doc, c, n if n.lower() != "nan" else "", l,
                     float(q), float(p), float(a), u if u.lower() != "nan" else ""))
    return rows


def _get_income_rows() -> list:
    """Бүх орлогын файлын мөрүүд — mtime-кэштэй (файл солигдвол л дахин уншина)."""
    from app.core.db import SessionLocal
    from app.models.income_file import IncomeFile

    db = SessionLocal()
    try:
        files = db.query(IncomeFile).all()
        # Сарын файлтай онд бүтэн оны (month=0) файлыг АЛГАСНА — давхардахгүй
        monthly_years = {f.year for f in files if (f.month or 0) > 0}
        stored = [(f.year, f.month or 0, f.stored_filename) for f in files
                  if f.stored_filename and not ((f.month or 0) == 0 and f.year in monthly_years)]
    finally:
        db.close()

    all_rows: list = []
    for _year, _month, fname in sorted(stored):
        path = INCOME_DIR / fname
        if not path.exists():
            continue
        mtime = path.stat().st_mtime
        key = str(path)
        cached = _income_cache.get(key)
        if cached and cached[0] == mtime:
            all_rows.extend(cached[1])
            continue
        with _cache_lock:
            cached = _income_cache.get(key)
            if cached and cached[0] == mtime:
                all_rows.extend(cached[1])
                continue
            try:
                rows = _parse_income_file(path)
            except Exception:
                rows = []
            _income_cache[key] = (mtime, rows)
            all_rows.extend(rows)
    return all_rows


def _get_master_tags() -> dict:
    """{normalized_code: [raw tag, ...]} — mtime-кэштэй."""
    global _master_cache
    if not MASTER_FILE.exists():
        return {}
    mtime = MASTER_FILE.stat().st_mtime
    if _master_cache and _master_cache[0] == mtime:
        return _master_cache[1]
    with _cache_lock:
        if _master_cache and _master_cache[0] == mtime:
            return _master_cache[1]
        out: dict = {}
        try:
            df = _read_excel_fast(str(MASTER_FILE), sheet_name=0, dtype=object)
            cols = {str(c).strip(): c for c in df.columns}
            code_col, tag_col = cols.get("Код"), cols.get("Байршил tag")
            if code_col is not None:
                for c_raw, t_raw in zip(df[code_col], df.get(tag_col, [None] * len(df))):
                    code = _norm_code(c_raw)
                    if not code or code.lower() == "nan":
                        continue
                    tags = [t.strip() for t in str(t_raw or "").split(",")
                            if t.strip() and t.strip().lower() != "nan"]
                    out[code] = tags
        except Exception:
            out = {}
        _master_cache = (mtime, out)
        return out


def warm_tag_location_caches() -> None:
    """Startup + 60с warm loop-оос дуудна — эхний шалгалт хүлээлгүй болно."""
    try:
        _get_master_tags()
        _get_income_rows()
    except Exception:
        pass


# ── Шалгалтын цөм ───────────────────────────────────────────────────────────

def _compute(date_from: date_type, date_to: date_type) -> dict:
    cfg = get_tagloc_config()
    ignore = {_norm(x) for x in cfg["ignore_locations"]}
    # norm(байршил) -> (raw байршил, {norm(tag), ...}, [raw tags])
    mapping = {_norm(k): (k, {_norm(t) for t in v}, v) for k, v in cfg["map"].items()}

    master = _get_master_tags()
    rows = _get_income_rows()

    total = ok = mismatch_n = not_found = ignored = 0
    unmapped: dict[str, int] = {}
    loc_counts: dict[str, int] = {}
    groups: dict[str, dict] = {}
    truncated = 0

    for (d, doc, code, name, loc, q, p, a, u) in rows:
        if d < date_from or d > date_to:
            continue
        total += 1
        loc_counts[loc] = loc_counts.get(loc, 0) + 1
        nloc = _norm(loc)
        if nloc in ignore:
            ignored += 1
            continue
        m = mapping.get(nloc)
        if m is None:
            unmapped[loc] = unmapped.get(loc, 0) + 1
            continue
        tags = master.get(code)
        if tags is None:
            not_found += 1
            continue
        allowed_norm = m[1]
        if any(_norm(t) in allowed_norm for t in tags):
            ok += 1
            continue
        # ── ЗӨРҮҮТЭЙ ──
        mismatch_n += 1
        g = groups.setdefault(loc, {"location": loc, "allowed_tags": m[2], "rows": [], "count": 0, "total_amount": 0.0})
        g["count"] += 1
        g["total_amount"] += a
        if mismatch_n <= MAX_PREVIEW_ROWS:
            g["rows"].append({
                "date": d.isoformat(), "doc_no": doc, "code": code, "name": name,
                "product_tags": ", ".join(tags) if tags else "(tag-гүй)",
                "qty": q, "unit_price": p, "amount": a, "user": u,
            })
        else:
            truncated += 1

    group_list = sorted(groups.values(), key=lambda g: -g["count"])
    for g in group_list:
        g["total_amount"] = round(g["total_amount"], 2)
        g["rows"].sort(key=lambda r: (r["date"], r["doc_no"]))

    return {
        "date_from": date_from.isoformat(),
        "date_to": date_to.isoformat(),
        "summary": {
            "total_rows": total, "ok": ok, "mismatch": mismatch_n,
            "master_not_found": not_found, "ignored": ignored,
            "truncated": truncated,
        },
        "unmapped_locations": unmapped,
        "groups": group_list,
        "meta": {
            "locations_in_range": loc_counts,
            "all_tags": sorted({t for tags in master.values() for t in tags}),
            "config": cfg,
        },
    }


# ── Endpoints ───────────────────────────────────────────────────────────────

@router.get("/tag-location-check")
def tag_location_check(
    date_from: date_type = Query(...),
    date_to: date_type = Query(...),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    """Сонгосон огнооны мужид орлого авагдсан байршил нь мастерын Байршил
    tag-тай зөрсөн орлогын мөрүүдийг буцаана (preview-д)."""
    if date_from > date_to:
        raise HTTPException(400, "Эхлэх огноо дуусах огнооноос хойш байна.")
    if not MASTER_FILE.exists():
        raise HTTPException(400, "Master эксэл байхгүй — эхлээд Мастер нэгтгэл хийнэ үү.")
    return _compute(date_from, date_to)


class TagLocConfigIn(BaseModel):
    map: dict[str, list[str]] = {}
    ignore_locations: list[str] = []


@router.get("/tag-location-check/config")
def get_config(_=Depends(require_role("admin", "supervisor", "manager"))):
    return get_tagloc_config()


@router.put("/tag-location-check/config")
def put_config(
    body: TagLocConfigIn,
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    return set_tagloc_config({"map": body.map, "ignore_locations": body.ignore_locations})


@router.get("/tag-location-check/pdf")
def tag_location_check_pdf(
    date_from: date_type = Query(...),
    date_to: date_type = Query(...),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    """Зөрүүтэй орлогын тайланг PDF болгож татна (A4 landscape, кирилл фонт)."""
    if date_from > date_to:
        raise HTTPException(400, "Эхлэх огноо дуусах огнооноос хойш байна.")
    data = _compute(date_from, date_to)

    from fpdf import FPDF

    pdf = FPDF(orientation="L", format="A4")
    pdf.set_auto_page_break(auto=True, margin=12)
    pdf.add_font("Arial", fname="C:/Windows/Fonts/arial.ttf")
    pdf.add_font("Arial", style="B", fname="C:/Windows/Fonts/arialbd.ttf")
    pdf.add_page()

    pdf.set_font("Arial", style="B", size=14)
    pdf.cell(0, 8, "Tag vs Байршил зөрүүтэй орлого", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Arial", size=9)
    s = data["summary"]
    pdf.cell(0, 6,
             f"Огноо: {data['date_from']} — {data['date_to']}   ·   "
             f"Нийт орлогын мөр: {s['total_rows']:,}   Зөв: {s['ok']:,}   "
             f"Зөрүүтэй: {s['mismatch']:,}   Мастерт олдоогүй: {s['master_not_found']:,}",
             new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    # Багана: Огноо 22, Баримт 30, Код 18, Нэр 70, Tag 48, Тоо 16, Үнэ 22, Дүн 26, Хэрэглэгч 25
    widths = [22, 30, 18, 70, 48, 16, 22, 26, 25]
    headers = ["Огноо", "Баримт", "Код", "Бараа", "Master tag", "Тоо", "Нэгж үнэ", "Дүн", "Хэрэглэгч"]

    def table_header():
        pdf.set_font("Arial", style="B", size=7.5)
        pdf.set_fill_color(31, 78, 120)
        pdf.set_text_color(255, 255, 255)
        for w, h in zip(widths, headers):
            pdf.cell(w, 6, h, border=1, fill=True, align="C")
        pdf.ln()
        pdf.set_text_color(0, 0, 0)
        pdf.set_font("Arial", size=7.5)

    def fmt_n(v):
        f = float(v or 0)
        return f"{int(f):,}" if f == int(f) else f"{f:,.2f}"

    for g in data["groups"]:
        if pdf.get_y() > 175:
            pdf.add_page()
        pdf.set_font("Arial", style="B", size=10)
        pdf.set_fill_color(243, 232, 255)
        pdf.cell(0, 7,
                 f"{g['location']}  —  {g['count']} мөр · {fmt_n(g['total_amount'])}₮   "
                 f"(зөвшөөрөгдөх tag: {', '.join(g['allowed_tags'])})",
                 new_x="LMARGIN", new_y="NEXT", fill=True)
        table_header()
        for r in g["rows"]:
            if pdf.get_y() > 188:
                pdf.add_page()
                table_header()
            cells = [
                r["date"], str(r["doc_no"])[:18], r["code"], str(r["name"])[:42],
                str(r["product_tags"])[:30], fmt_n(r["qty"]), fmt_n(r["unit_price"]),
                fmt_n(r["amount"]), str(r["user"])[:15],
            ]
            aligns = ["C", "L", "C", "L", "L", "R", "R", "R", "L"]
            for w, v, al in zip(widths, cells, aligns):
                pdf.cell(w, 5.5, str(v), border=1, align=al)
            pdf.ln()
        pdf.ln(3)

    if s["truncated"]:
        pdf.set_font("Arial", size=8)
        pdf.cell(0, 6, f"... мөн {s['truncated']:,} мөр багтаагүй (хязгаар {MAX_PREVIEW_ROWS:,})",
                 new_x="LMARGIN", new_y="NEXT")

    buf = io.BytesIO(bytes(pdf.output()))
    fname = f"tag_bairshil_zoruu_{data['date_from']}_{data['date_to']}.pdf"
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(fname)}"},
    )
