# -*- coding: utf-8 -*-
"""«Орлого байсан ч хөдөлгөөнгүй» тайлан.

Эх сурвалж (Файл оруулалт):
  - Орлого: income_files (2025 бүтэн он, 2026-аас сар бүрээр) — tag_location_check-ийн
    кэштэй уншигчаар (Огноо, Бараа код, Нэр, Байршил, Тоо, Нэгж үнэ, Дебет).
  - Хөдөлгөөн: movement_files (yearly_movement/{main,liquor}_{year}.xlsx) —
    «Бараа материалын гүйлгээ» загвар: Кредит > 0 мөр = бараа гарсан (борлуулалт/шилжүүлэг).
  - Үлдэгдэл: «Бүх агуулахын үлдэгдэл» файл (balance_stock) — мэдээллийн зорилгоор.

ЧУХАЛ: Хөдөлгөөний файл нь АГУУЛАХААС заал руу/бусад руу гаргасан гүйлгээ (Кредит) л
агуулдаг. Заалд ШУУД орлогоор орсон бараа (талх, хиам — «заалны автомат орлого») POS-оор
зарагддаг тул энэ файлд огт гардаггүй → тэдгээрийг «хөдөлгөөнгүй» гэж андуурахгүйн тулд
тусдаа хуудсанд («Заалд шууд орсон») гаргаж, харьцуулалтыг зөвхөн агуулахад орсон тоогоор
хийнэ.

Хуудсууд: Дүгнэлт · Хөдөлгөөнгүй (агуулахад орсон ч гараагүй) · Бага хөдөлгөөнтэй (< 20%) ·
Заалд шууд орсон · Бүх бараа.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

LOW_RATIO = 0.20     # хөдөлгөөн / орлого < 20% → «бага хөдөлгөөнтэй»


def _is_hall(loc: str) -> bool:
    """Заалны байршил (орлого шууд лангуунд орсон) эсэх: «Заал», «Хархорин заал» г.м."""
    l = (loc or "").strip().lower()
    return l.startswith("заал") or l.endswith(" заал")


class ReportInputError(RuntimeError):
    pass


def _norm_code(v) -> str:
    import re
    s = str(v if v is not None else "").strip()
    s = re.sub(r"\.0$", "", s)
    return re.sub(r"\s+", "", s)


def _read_movement(path: Path) -> list[tuple]:
    """→ [(date, code, name, qty, credit, location)] — зөвхөн огноо/кодтой мөр."""
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


def build_no_movement_report(db, year: int, out_path: str) -> dict:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    from app.api.product_yearly_movement import UPLOAD_DIR as MOV_DIR
    from app.api.tag_location_check import _get_income_rows
    from app.models.income_file import IncomeFile
    from app.models.movement_file import MovementFile
    from app.services.balance_stock import get_location_stock_map

    # ── Оролтын файлууд байгаа эсэх ──
    inc_files = db.query(IncomeFile).filter(IncomeFile.year == year).all()
    # Сарын файлтай онд бүтэн оны (month=0) файл ашиглагдахгүй — _get_income_rows-той ижил дүрэм
    if any((f.month or 0) > 0 for f in inc_files):
        inc_files = [f for f in inc_files if (f.month or 0) > 0]
    if not inc_files:
        raise ReportInputError(f"{year} оны орлогын файл оруулаагүй байна (Файл оруулалт → Орлогын файл).")
    mov_files = db.query(MovementFile).filter(MovementFile.year == year).all()
    mov_paths = [(m.kind, MOV_DIR / m.stored_filename) for m in mov_files if m.stored_filename]
    mov_paths = [(k, p) for k, p in mov_paths if p.exists()]
    if not mov_paths:
        raise ReportInputError(f"{year} оны хөдөлгөөний файл оруулаагүй байна (Файл оруулалт → Хөдөлгөөний файл: Үндсэн заал / Архи заал).")
    kinds = {k for k, _ in mov_paths}

    # ── Орлого ──
    inc = defaultdict(lambda: {"qty": 0.0, "wh_qty": 0.0, "hall_qty": 0.0, "amt": 0.0, "wh_amt": 0.0,
                               "first": None, "last": None, "docs": set(), "name": "", "locs": set()})
    inc_rows = 0
    for d, doc, code, name, loc, q, price, debit, _u in _get_income_rows():
        if d.year != year:
            continue
        inc_rows += 1
        a = inc[code]
        amt = debit if debit else q * price
        a["qty"] += q
        a["amt"] += amt
        if _is_hall(loc):
            a["hall_qty"] += q
        else:
            a["wh_qty"] += q
            a["wh_amt"] += amt
        a["first"] = d if a["first"] is None or d < a["first"] else a["first"]
        a["last"] = d if a["last"] is None or d > a["last"] else a["last"]
        a["docs"].add(doc)
        if name and not a["name"]:
            a["name"] = name
        if loc:
            a["locs"].add(loc)
    if not inc:
        raise ReportInputError(f"{year} оны орлогын файлаас мөр уншсангүй (Огноо/Бараа материал код багана шалгана уу).")

    # ── Хөдөлгөөн ──
    mov = defaultdict(lambda: {"qty": 0.0, "last": None, "rows": 0, "name": "", "locs": set()})
    mov_rows = 0
    for _kind, p in mov_paths:
        for d, code, name, q, credit, loc in _read_movement(p):
            if d.year != year:
                continue
            mov_rows += 1
            m = mov[code]
            m["qty"] += q if credit > 0 or q > 0 else 0.0
            m["rows"] += 1
            m["last"] = d if m["last"] is None or d > m["last"] else m["last"]
            if name and not m["name"]:
                m["name"] = name
            if loc:
                m["locs"].add(loc)

    stock = get_location_stock_map(db, "warehouse")

    # ── Ангилал ──
    all_rows, none_rows, low_rows, hall_rows = [], [], [], []
    for code, a in inc.items():
        m = mov.get(code)
        out_qty = m["qty"] if m else 0.0
        # Харьцуулалт зөвхөн АГУУЛАХАД орсон тоогоор (заалд шууд орсон нь энэ файлд гардаггүй)
        ratio = (out_qty / a["wh_qty"]) if a["wh_qty"] > 0 else None
        row = {
            "code": code, "name": a["name"] or (m["name"] if m else ""),
            "inc_qty": a["qty"], "wh_qty": a["wh_qty"], "hall_qty": a["hall_qty"],
            "inc_amt": a["amt"], "wh_amt": a["wh_amt"], "inc_docs": len(a["docs"]),
            "inc_first": a["first"], "inc_last": a["last"], "inc_locs": ", ".join(sorted(a["locs"])),
            "out_qty": out_qty, "out_rows": m["rows"] if m else 0, "out_last": m["last"] if m else None,
            "ratio": ratio, "stock": stock.get(code),
        }
        all_rows.append(row)
        if a["wh_qty"] <= 0:
            hall_rows.append(row)          # зөвхөн заалд шууд орсон — хөдөлгөөн бүртгэгдэхгүй
        elif out_qty <= 0:
            none_rows.append(row)
        elif ratio is not None and ratio < LOW_RATIO:
            low_rows.append(row)
    none_rows.sort(key=lambda r: -r["wh_amt"])
    low_rows.sort(key=lambda r: (r["ratio"] or 0, -r["wh_amt"]))
    hall_rows.sort(key=lambda r: -r["inc_amt"])
    all_rows.sort(key=lambda r: (r["ratio"] if r["ratio"] is not None else -1, -r["inc_amt"]))

    # ── Excel ──
    wb = Workbook()
    hdr_fill, hdr_font = PatternFill("solid", fgColor="1F4E78"), Font(color="FFFFFF", bold=True)
    bad_fill, warn_fill = PatternFill("solid", fgColor="FCE4D6"), PatternFill("solid", fgColor="FFF2CC")
    COLS = ["Код", "Нэр", "Орлого нийт (ш)", "Агуулахад орсон (ш)", "Заалд шууд (ш)", "Орлогын дүн ₮",
            "Орлогын баримт", "Эхний орлого", "Сүүлийн орлого", "Орлогын байршил",
            "Агуулахаас гарсан (ш)", "Гарсан / Агуулахад орсон", "Сүүлийн хөдөлгөөн", "Одоогийн үлдэгдэл"]
    WID = [11, 46, 12, 13, 12, 16, 10, 13, 14, 26, 14, 14, 15, 14]

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
        ws.freeze_panes = "A2"
        if not rows:
            ws.cell(2, 1, empty_msg).font = Font(italic=True, color="7F8C8D")
            return ws
        for ri, r in enumerate(rows, 2):
            vals = [r["code"], r["name"], _n(r["inc_qty"]), _n(r["wh_qty"]), _n(r["hall_qty"]),
                    round(r["inc_amt"], 2), r["inc_docs"], r["inc_first"], r["inc_last"], r["inc_locs"],
                    _n(r["out_qty"]), (round(r["ratio"], 3) if r["ratio"] is not None else None), r["out_last"],
                    (_n(r["stock"]) if r["stock"] is not None else "—")]
            for ci, v in enumerate(vals, 1):
                c = ws.cell(ri, ci, v)
                if ci in (8, 9, 13) and v:
                    c.number_format = "yyyy-mm-dd"
                if ci == 6:
                    c.number_format = "#,##0"
                if ci == 12 and v is not None:
                    c.number_format = "0%"
                if fill:
                    c.fill = fill
        last = len(rows) + 1
        ws.cell(last + 1, 1, "Нийт").font = Font(bold=True)
        for col in ("C", "D", "E", "F", "K"):
            ws[f"{col}{last + 1}"] = f"=SUM({col}2:{col}{last})"
            ws[f"{col}{last + 1}"].font = Font(bold=True)
        ws["F" + str(last + 1)].number_format = "#,##0"
        ws.auto_filter.ref = f"A1:{get_column_letter(len(COLS))}{last}"
        return ws

    ws0 = wb.active
    ws0.title = "Дүгнэлт"
    ws0.column_dimensions["A"].width = 40; ws0.column_dimensions["B"].width = 22; ws0.column_dimensions["C"].width = 70
    kind_lbl = {"main": "Үндсэн заал", "liquor": "Архи заал"}
    info = [
        (f"ОРЛОГО БАЙСАН Ч ХӨДӨЛГӨӨНГҮЙ — {year} он", "", ""),
        ("Гаргасан", datetime.now().strftime("%Y-%m-%d %H:%M"), ""),
        ("Орлогын файл", ", ".join(f.original_filename for f in sorted(inc_files, key=lambda f: (f.month or 0))),
         f"{inc_rows:,} мөр · {len(inc)} бараа"),
        ("Хөдөлгөөний файл", ", ".join(kind_lbl.get(k, k) for k in sorted(kinds)),
         f"{mov_rows:,} мөр · {len(mov)} бараа" + ("" if kinds == {"main", "liquor"} else "  ⚠ нэг л заалны файл орсон"))
        ,
        ("", "", ""),
        ("Орлого авсан бараа", len(all_rows), "Тухайн онд орлогын файлд орсон бүх бараа → «Бүх бараа»"),
        ("  Хөдөлгөөнгүй (агуулахад орсон ч огт гараагүй)", len(none_rows),
         f"{round(sum(r['wh_amt'] for r in none_rows)):,} ₮ агуулахын орлого — «Хөдөлгөөнгүй» хуудас (дүнгээр эрэмбэлсэн)"),
        (f"  Бага хөдөлгөөнтэй (< {int(LOW_RATIO * 100)}%)", len(low_rows),
         "Агуулахаас гарсан тоо нь агуулахад орсон тооны 20%-д хүрэхгүй — «Бага хөдөлгөөнтэй» хуудас"),
        ("  Заалд шууд орсон (тооцоогүй)", len(hall_rows),
         "Орлого нь бүхэлдээ заалны байршилд шууд орсон (талх, хиам г.м «заалны автомат орлого»). "
         "Ийм бараа POS-оор зарагддаг тул хөдөлгөөний файлд гардаггүй — хөдөлгөөнгүй гэж ҮЗЭХГҮЙ."),
        ("", "", ""),
        ("Тайлбар", "", "Хөдөлгөөн = хөдөлгөөний файлын Кредит > 0 мөр (агуулахаас заал/бусад руу гаргасан). "
                       "Харьцуулалт зөвхөн агуулахад орсон тоогоор. "
                       "Үлдэгдэл = сүүлд оруулсан «Бүх агуулахын үлдэгдэл» файлаас (байхгүй бол —)."),
    ]
    for ri, (k, v, n) in enumerate(info, 1):
        ws0.cell(ri, 1, k).font = Font(bold=True, size=12 if ri == 1 else 11)
        ws0.cell(ri, 2, v)
        ws0.cell(ri, 3, n).font = Font(size=9, color="7F8C8D")

    sheet("Хөдөлгөөнгүй", none_rows, fill=bad_fill)
    sheet("Бага хөдөлгөөнтэй", low_rows, fill=warn_fill)
    sheet("Заалд шууд орсон", hall_rows)
    sheet("Бүх бараа", all_rows)
    wb.save(out_path)
    return {"year": year, "income_items": len(all_rows), "no_movement": len(none_rows),
            "low_movement": len(low_rows), "hall_only": len(hall_rows),
            "income_rows": inc_rows, "movement_rows": mov_rows, "movement_kinds": sorted(kinds)}
