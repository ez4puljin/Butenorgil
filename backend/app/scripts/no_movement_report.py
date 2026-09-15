# -*- coding: utf-8 -*-
"""«Орлого байсан ч хөдөлгөөнгүй» тайлан — сүүлийн N хоногийн орлогоос.

Логик (хэрэглэгчийн тодорхойлолт):
  1. Сүүлийн N хоногт АГУУЛАХАД орлого авсан бараа (Орлогын файл).
     Заалд шууд орлого авсныг тооцохгүй — хөдөлгөөний файл нь агуулахаас заал руу
     гаргасан гүйлгээ тул заалд шууд орсон (талх, хиам — «заалны автомат орлого»)
     бараа тэнд гардаггүй; тэдгээрийг хөдөлгөөнгүй гэж ҮЗЭХГҮЙ.
  2. Тэр хугацаанд хөдөлгөөний файлд (Кредит > 0) ОГТ гараагүй бараа → «Хөдөлгөөнгүй».
  3. Зөвхөн барааны мастер (master_latest.xlsx, «Байршил tag») дээр АГУУЛАХЫН тагтай
     бараа: Бөөний агуулах · Архи Ус ундаа пиво · Жижиглэн агуулах · Гэрээт компани.
     Бусад таг (Зааланд ирдэг, Жижиглэн Архи, Тоглоом, тагийн мэдээлэлгүй) → хасагдана.

Эх сурвалж: income_files (сарын/бүтэн оны), movement_files (Үндсэн заал + Архи заал),
master_latest.xlsx (таг), Бүх агуулахын үлдэгдэл (мэдээлэл).
Хуудсууд: Дүгнэлт · Хөдөлгөөнгүй · Хөдөлгөөнтэй · Тагаар хасагдсан.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

# Мастерын «Байршил tag» — зөвхөн эдгээр агуулахын тагтай бараа тайланд орно
WAREHOUSE_TAGS = ("Бөөний агуулах", "Архи Ус ундаа пиво", "Жижиглэн агуулах", "Гэрээт компани")
MASTER_PATH = Path("app/data/outputs/master_latest.xlsx")


class ReportInputError(RuntimeError):
    pass


def _norm_code(v) -> str:
    import re
    s = str(v if v is not None else "").strip()
    s = re.sub(r"\.0$", "", s)
    return re.sub(r"\s+", "", s)


def _is_hall(loc: str) -> bool:
    """Заалны байршил (орлого шууд лангуунд орсон): «Заал», «Хархорин заал» г.м."""
    l = (loc or "").strip().lower()
    return l.startswith("заал") or l.endswith(" заал")


def _norm_tag(t: str) -> str:
    return " ".join((t or "").split()).strip().lower()


_WH_TAGS_N = {_norm_tag(t): t for t in WAREHOUSE_TAGS}


def _master_tags() -> dict[str, str]:
    """{code: «Байршил tag»} — master_latest.xlsx-ээс (файл байхгүй бол хоосон)."""
    if not MASTER_PATH.exists():
        return {}
    try:
        import pandas as pd
        from app.api.tag_location_check import _read_excel_fast
        df = _read_excel_fast(str(MASTER_PATH), sheet_name=0, dtype=object)
        cols = {str(c).strip(): c for c in df.columns}
        code_col, tag_col = cols.get("Код"), cols.get("Байршил tag")
        if code_col is None or tag_col is None:
            return {}
        out = {}
        for code, tag in zip(df[code_col], df[tag_col]):
            c = _norm_code(code)
            if c and c.lower() != "nan":
                t = "" if tag is None or (isinstance(tag, float) and pd.isna(tag)) else str(tag).strip()
                out[c] = t
        return out
    except Exception:
        return {}


def _read_movement(path: Path) -> list[tuple]:
    """→ [(date, code, name, qty, credit, location)]"""
    import pandas as pd
    from app.api.tag_location_check import _read_excel_fast

    df = _read_excel_fast(str(path), header=0, dtype=object)
    if "Бараа материал код" not in df.columns:
        raw = _read_excel_fast(str(path), header=None, dtype=object, nrows=25)
        hdr = next((i for i in range(len(raw))
                    if any(str(v).strip() == "Бараа материал код" for v in raw.iloc[i].tolist())), -1)
        if hdr < 0:
            return []
        df = _read_excel_fast(str(path), header=hdr, dtype=object)

    def col(name):
        return df[name] if name in df.columns else pd.Series([None] * len(df))

    dates = pd.to_datetime(col("Огноо"), errors="coerce")
    codes = col("Бараа материал код").map(_norm_code)
    names = col("Бараа материал нэр").astype(str).str.strip()
    locs = col("Байршил нэр").astype(str).str.strip()
    qty = pd.to_numeric(col("Тоо хэмжээ"), errors="coerce").fillna(0.0)
    credit = pd.to_numeric(col("Кредит"), errors="coerce").fillna(0.0)
    out = []
    for d, c, n, l, q, cr in zip(dates, codes, names, locs, qty, credit):
        if pd.isna(d) or not c or c.lower() == "nan":
            continue
        out.append((d.date(), c, "" if n.lower() == "nan" else n, float(q), float(cr),
                    "" if l.lower() == "nan" else l))
    return out


def build_no_movement_report(db, days: int, out_path: str, end: date | None = None) -> dict:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    from app.api.product_yearly_movement import UPLOAD_DIR as MOV_DIR
    from app.api.tag_location_check import _get_income_rows
    from app.models.income_file import IncomeFile
    from app.models.movement_file import MovementFile
    from app.services.balance_stock import get_location_stock_map

    days = max(1, min(int(days), 365))
    end = end or date.today()
    start = end - timedelta(days=days - 1)
    years = sorted({start.year, end.year})

    # ── Оролтын файлууд ──
    inc_files = db.query(IncomeFile).filter(IncomeFile.year.in_(years)).all()
    monthly_years = {f.year for f in inc_files if (f.month or 0) > 0}
    inc_files = [f for f in inc_files if not ((f.month or 0) == 0 and f.year in monthly_years)]
    if not inc_files:
        raise ReportInputError(f"{'/'.join(map(str, years))} оны орлогын файл оруулаагүй байна (Файл оруулалт → Орлогын файл).")
    mov_files = db.query(MovementFile).filter(MovementFile.year.in_(years)).all()
    mov_paths = [(m.year, m.kind, MOV_DIR / m.stored_filename) for m in mov_files if m.stored_filename]
    mov_paths = [(y, k, p) for y, k, p in mov_paths if p.exists()]
    if not mov_paths:
        raise ReportInputError(f"{'/'.join(map(str, years))} оны хөдөлгөөний файл оруулаагүй байна (Файл оруулалт → Хөдөлгөөний файл: Үндсэн заал / Архи заал).")
    kinds = {k for _y, k, _p in mov_paths}
    tags = _master_tags()

    # ── Орлого (цонхон доторх, АГУУЛАХАД орсон) ──
    inc = defaultdict(lambda: {"qty": 0.0, "amt": 0.0, "first": None, "last": None, "docs": set(),
                               "name": "", "locs": set(), "hall_qty": 0.0})
    inc_rows_window = 0
    hall_only_codes: set[str] = set()
    for d, doc, code, name, loc, q, price, debit, _u in _get_income_rows():
        if d < start or d > end:
            continue
        inc_rows_window += 1
        a = inc[code]
        if name and not a["name"]:
            a["name"] = name
        if _is_hall(loc):
            a["hall_qty"] += q
            continue
        a["qty"] += q
        a["amt"] += debit if debit else q * price
        a["first"] = d if a["first"] is None or d < a["first"] else a["first"]
        a["last"] = d if a["last"] is None or d > a["last"] else a["last"]
        a["docs"].add(doc)
        if loc:
            a["locs"].add(loc)
    for code, a in list(inc.items()):
        if a["qty"] <= 0:
            hall_only_codes.add(code)
            del inc[code]
    if inc_rows_window == 0:
        raise ReportInputError(f"{start} – {end} хооронд орлогын мөр олдсонгүй. Орлогын файл тэр хугацааг хамарсан эсэхийг шалгана уу.")

    # ── Хөдөлгөөн (цонхон доторх, Кредит > 0) ──
    mov = defaultdict(lambda: {"qty": 0.0, "rows": 0, "first": None, "last": None, "locs": set()})
    mov_rows_window = 0
    for _y, _k, p in mov_paths:
        for d, code, _n, q, credit, loc in _read_movement(p):
            if d < start or d > end or credit <= 0:
                continue
            mov_rows_window += 1
            m = mov[code]
            m["qty"] += q
            m["rows"] += 1
            m["first"] = d if m["first"] is None or d < m["first"] else m["first"]
            m["last"] = d if m["last"] is None or d > m["last"] else m["last"]
            if loc:
                m["locs"].add(loc)

    stock = get_location_stock_map(db, "warehouse")

    # ── Ангилал ──
    none_rows, moved_rows, excluded_rows = [], [], []
    for code, a in inc.items():
        tag = tags.get(code, "")
        wh_tag = _WH_TAGS_N.get(_norm_tag(tag))
        m = mov.get(code)
        row = {
            "code": code, "name": a["name"], "tag": tag or "(мастерт байхгүй)",
            "inc_qty": a["qty"], "inc_amt": a["amt"], "inc_docs": len(a["docs"]),
            "inc_first": a["first"], "inc_last": a["last"], "inc_locs": ", ".join(sorted(a["locs"])),
            "hall_qty": a["hall_qty"],
            "out_qty": m["qty"] if m else 0.0, "out_rows": m["rows"] if m else 0,
            "out_first": m["first"] if m else None, "out_last": m["last"] if m else None,
            "out_locs": ", ".join(sorted(m["locs"])) if m else "",
            "stock": stock.get(code),
        }
        if not wh_tag:
            excluded_rows.append(row)
        elif not m:
            none_rows.append(row)
        else:
            moved_rows.append(row)
    none_rows.sort(key=lambda r: (-r["inc_amt"], r["code"]))
    moved_rows.sort(key=lambda r: (r["out_qty"] / r["inc_qty"] if r["inc_qty"] else 0, -r["inc_amt"]))
    excluded_rows.sort(key=lambda r: (r["tag"], -r["inc_amt"]))

    # ── Excel ──
    wb = Workbook()
    hdr_fill, hdr_font = PatternFill("solid", fgColor="1F4E78"), Font(color="FFFFFF", bold=True)
    bad_fill = PatternFill("solid", fgColor="FCE4D6")
    COLS = ["Код", "Нэр", "Байршил tag", "Агуулахад орсон (ш)", "Орлогын дүн ₮", "Баримт",
            "Эхний орлого", "Сүүлийн орлого", "Орлогын байршил", "Заалд шууд (ш)",
            "Гарсан (ш)", "Гарсан мөр", "Эхний хөдөлгөөн", "Сүүлийн хөдөлгөөн", "Гарсан байршил", "Одоогийн үлдэгдэл"]
    WID = [11, 44, 18, 13, 15, 8, 13, 13, 26, 12, 11, 9, 14, 15, 24, 14]

    def _n(v):
        if v is None:
            return None
        return int(v) if abs(v - round(v)) < 1e-9 else round(v, 3)

    def sheet(title, rows, fill=None, empty_msg="✓ Энэ ангилалд бараа алга"):
        ws = wb.create_sheet(title)
        for ci, h in enumerate(COLS, 1):
            c = ws.cell(1, ci, h); c.fill = hdr_fill; c.font = hdr_font
            c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        for ci, w in enumerate(WID, 1):
            ws.column_dimensions[get_column_letter(ci)].width = w
        ws.freeze_panes = "C2"
        if not rows:
            ws.cell(2, 1, empty_msg).font = Font(italic=True, color="7F8C8D")
            return ws
        for ri, r in enumerate(rows, 2):
            vals = [r["code"], r["name"], r["tag"], _n(r["inc_qty"]), round(r["inc_amt"], 2), r["inc_docs"],
                    r["inc_first"], r["inc_last"], r["inc_locs"], _n(r["hall_qty"]) or None,
                    _n(r["out_qty"]) if r["out_rows"] else 0, r["out_rows"], r["out_first"], r["out_last"],
                    r["out_locs"], (_n(r["stock"]) if r["stock"] is not None else "—")]
            for ci, v in enumerate(vals, 1):
                c = ws.cell(ri, ci, v)
                if ci in (7, 8, 13, 14) and v:
                    c.number_format = "yyyy-mm-dd"
                if ci == 5:
                    c.number_format = "#,##0"
                if fill:
                    c.fill = fill
        last = len(rows) + 1
        ws.cell(last + 1, 1, "Нийт").font = Font(bold=True)
        for col in ("D", "E", "K"):
            ws[f"{col}{last + 1}"] = f"=SUM({col}2:{col}{last})"
            ws[f"{col}{last + 1}"].font = Font(bold=True)
        ws[f"E{last + 1}"].number_format = "#,##0"
        ws.auto_filter.ref = f"A1:{get_column_letter(len(COLS))}{last}"
        return ws

    ws0 = wb.active
    ws0.title = "Дүгнэлт"
    ws0.column_dimensions["A"].width = 44; ws0.column_dimensions["B"].width = 26; ws0.column_dimensions["C"].width = 72
    kind_lbl = {"main": "Үндсэн заал", "liquor": "Архи заал"}
    by_tag = defaultdict(int)
    for r in none_rows:
        by_tag[r["tag"]] += 1
    info = [
        ("ОРЛОГО БАЙСАН Ч ХӨДӨЛГӨӨНГҮЙ", f"сүүлийн {days} хоног", f"{start} – {end}"),
        ("Гаргасан", datetime.now().strftime("%Y-%m-%d %H:%M"), ""),
        ("Орлогын файл", ", ".join(f.original_filename for f in sorted(inc_files, key=lambda f: (f.year, f.month or 0))),
         f"цонхон дотор {inc_rows_window:,} мөр"),
        ("Хөдөлгөөний файл", ", ".join(f"{y} {kind_lbl.get(k, k)}" for y, k, _p in sorted(mov_paths)),
         f"цонхон дотор {mov_rows_window:,} мөр (Кредит > 0)" + ("" if kinds == {"main", "liquor"} else "  ⚠ нэг л заалны файл орсон")),
        ("Барааны мастер (таг)", MASTER_PATH.name if tags else "⚠ олдсонгүй — таг шүүлт хийгдээгүй", f"{len(tags):,} бараа"),
        ("", "", ""),
        ("Агуулахад орлого авсан бараа (цонх)", len(inc), "Заалд шууд орсон орлогыг тооцоогүй"),
        ("  ✗ ХӨДӨЛГӨӨНГҮЙ (агуулахын тагтай, огт гараагүй)", len(none_rows),
         f"{round(sum(r['inc_amt'] for r in none_rows)):,} ₮ орлого — «Хөдөлгөөнгүй» хуудас, дүнгээр эрэмбэлсэн"),
        ("  ✓ Хөдөлгөөнтэй", len(moved_rows), "Цонхон дотор ядаж нэг удаа гарсан — «Хөдөлгөөнтэй» хуудас"),
        ("  Тагаар хасагдсан", len(excluded_rows),
         "Мастерын «Байршил tag» нь 4 агуулахын аль нь ч биш (Зааланд ирдэг, Жижиглэн Архи, Тоглоом, тагийн мэдээлэлгүй)"),
        ("Зөвхөн заалд шууд орсон (тооцоогүй)", len(hall_only_codes),
         "Орлого нь бүхэлдээ заалны байршилд — хөдөлгөөний файлд гардаггүй тул тайланд ороогүй"),
        ("", "", ""),
        ("Хөдөлгөөнгүй — тагаар", "", ""),
    ] + [(f"  {t}", n, "") for t, n in sorted(by_tag.items(), key=lambda x: -x[1])] + [
        ("", "", ""),
        ("Тайлбар", "", "Хөдөлгөөн = хөдөлгөөний файлын Кредит > 0 мөр (агуулахаас заал/бусад руу гаргасан). "
                       "Агуулахын таг = " + ", ".join(WAREHOUSE_TAGS) + ". "
                       "Үлдэгдэл = сүүлд оруулсан «Бүх агуулахын үлдэгдэл» файлаас (байхгүй бол —)."),
    ]
    for ri, (k, v, n) in enumerate(info, 1):
        ws0.cell(ri, 1, k).font = Font(bold=True, size=12 if ri == 1 else 11)
        ws0.cell(ri, 2, v)
        ws0.cell(ri, 3, n).font = Font(size=9, color="7F8C8D")

    sheet("Хөдөлгөөнгүй", none_rows, fill=bad_fill)
    sheet("Хөдөлгөөнтэй", moved_rows)
    sheet("Тагаар хасагдсан", excluded_rows)
    wb.save(out_path)
    return {"days": days, "start": start.isoformat(), "end": end.isoformat(),
            "income_items": len(inc), "no_movement": len(none_rows), "moved": len(moved_rows),
            "excluded_by_tag": len(excluded_rows), "hall_only": len(hall_only_codes),
            "income_rows": inc_rows_window, "movement_rows": mov_rows_window,
            "movement_kinds": sorted(kinds), "master_tags": len(tags)}
