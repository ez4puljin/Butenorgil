# warehouse_report_picker.py
# Windows: ажиллуулахад файл сонгох цонх нээгдэнэ.
# pip install pandas openpyxl
# (.xls унших бол) pip install xlrd==2.0.1

import os
import re
import math
from datetime import datetime
import pandas as pd
from openpyxl import Workbook
from openpyxl.utils.dataframe import dataframe_to_rows
from openpyxl.styles import Font, Alignment, Border, Side
from openpyxl.worksheet.pagebreak import Break
from openpyxl.utils import get_column_letter

try:
    import tkinter as tk
    from tkinter import filedialog, messagebox
except Exception:
    tk = None
    filedialog = None
    messagebox = None



def to_float(x):
    try:
        if x is None:
            return float("nan")
        if isinstance(x, str):
            s = x.replace(",", "").strip()
            if s == "" or s.lower() in ("null", "none"):
                return float("nan")
            return float(s)
        if isinstance(x, (int, float)):
            return float(x)
        return float("nan")
    except Exception:
        return float("nan")


def parse_int_code(x):
    if x is None:
        return None
    if isinstance(x, str):
        s = x.strip()
        if s == "":
            return None
        # "50205.0" гэх мэтийг int болгох
        if re.fullmatch(r"\d+(\.0+)?", s):
            return int(float(s))
        if s.isdigit():
            return int(s)
        return None
    if isinstance(x, (int, float)) and not (isinstance(x, float) and math.isnan(x)):
        return int(float(x))
    return None


def is_numeric(x):
    try:
        if x is None:
            return False
        if isinstance(x, str):
            s = x.strip()
            if s == "":
                return False
            float(s.replace(",", ""))
            return True
        if isinstance(x, (int, float)) and not (isinstance(x, float) and math.isnan(x)):
            return True
        return False
    except Exception:
        return False


def detect_warehouse_header_row(row):
    # A: 1..99, B: агуулахын нэр (string), C: тоон утгатай байх
    a = parse_int_code(row[0]) if len(row) > 0 else None
    b = row[1] if len(row) > 1 else None
    c = row[2] if len(row) > 2 else None
    return (
        a is not None
        and 0 < a < 100
        and isinstance(b, str) and b.strip() != ""
        and is_numeric(c)
    )


def detect_item_row(row):
    # A: барааны код 100000+, B: нэр, мөн C..K дотор дор хаяж 1 утга байна
    a = parse_int_code(row[0]) if len(row) > 0 else None
    b = row[1] if len(row) > 1 else None
    if a is None or a < 100000:
        return False
    if not isinstance(b, str) or b.strip() == "":
        return False

    has_any = False
    for j in range(2, min(len(row), 11)):  # C..K
        v = row[j]
        if v is None:
            continue
        if isinstance(v, float) and math.isnan(v):
            continue
        if isinstance(v, str) and v.strip() == "":
            continue
        has_any = True
        break
    return has_any


def read_excel_any(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".xls":
        # Excel 97-2003: xlrd шаардлагатай
        return pd.read_excel(path, header=None, engine="xlrd")
    return pd.read_excel(path, header=None)


_THIN = Side(style="thin", color="000000")
_ALL_BORDER = Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)


def _print_setup(ws, landscape=False, footer_center=""):
    """Хэвлэх тохиргоо: бүх баганыг нэг хуудсанд багтаана, толгойн мөр хуудас
    бүрд давтагдана, header зүүн — огноо/цаг; footer: гол — нэр, баруун — «хуудас / нийт»."""
    ws.page_setup.orientation = "landscape" if landscape else "portrait"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0          # өндрөөр хязгаарлахгүй — олон хуудас болно
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_title_rows = "1:1"
    ws.print_options.horizontalCentered = True
    ws.page_margins.left = ws.page_margins.right = 0.4
    ws.page_margins.top = 0.9
    ws.page_margins.header = 0.3
    ws.page_margins.bottom = 0.7
    ws.page_margins.footer = 0.3
    ws.oddHeader.left.text = "&D &T"          # огноо/цаг — толгойд
    ws.oddFooter.center.text = footer_center
    ws.oddFooter.right.text = "Хуудас &P / &N"


def add_sheet(out_wb, name, df, borders=False, landscape=False, footer_center="",
              page_break_col=None, min_widths=None):
    """DataFrame → хуудас. borders=True бол бүх нүд хүрээтэй; page_break_col
    (баганын нэр) өгвөл тэр баганын утга өөрчлөгдөх бүрд шинэ хуудас (агуулах
    тус бүр тусдаа хэвлэгдэнэ)."""
    ws = out_wb.create_sheet(title=name[:31])
    cols = list(df.columns)
    for r_idx, row in enumerate(dataframe_to_rows(df, index=False, header=True), start=1):
        ws.append(row)
        if r_idx == 1:
            for c_idx in range(1, len(row) + 1):
                cell = ws.cell(r_idx, c_idx)
                cell.font = Font(bold=True)
                cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions

    if borders and ws.max_row >= 1:
        for row in ws.iter_rows(min_row=1, max_row=ws.max_row, min_col=1, max_col=len(cols)):
            for cell in row:
                cell.border = _ALL_BORDER

    if page_break_col in cols and ws.max_row > 2:
        ci = cols.index(page_break_col) + 1
        prev = ws.cell(2, ci).value
        for r in range(3, ws.max_row + 1):
            v = ws.cell(r, ci).value
            if v != prev:
                ws.row_breaks.append(Break(id=r - 1))   # энэ мөрийн ДАРАА хуудас солино
                prev = v

    for col in ws.columns:
        max_len = 0
        col_letter = col[0].column_letter
        for cell in col[:2000]:
            if cell.value is None:
                continue
            max_len = max(max_len, len(str(cell.value)))
        w = min(max(10, max_len + 2), 60)
        if min_widths and col[0].value in min_widths:
            w = max(w, min_widths[col[0].value])
        ws.column_dimensions[col_letter].width = w

    _print_setup(ws, landscape=landscape, footer_center=footer_center)
    return ws


def _parse_records(input_path: str) -> "pd.DataFrame":
    """Read the ERP stock file and return a raw records DataFrame."""
    raw = read_excel_any(input_path)
    records = []
    current_wh = None

    for idx in range(len(raw)):
        row = raw.iloc[idx].tolist()
        if detect_warehouse_header_row(row):
            current_wh = str(row[1]).strip()
            continue
        if current_wh is None:
            continue
        if not detect_item_row(row):
            continue
        code = parse_int_code(row[0])
        name = str(row[1]).strip()
        qty = to_float(row[8]) if len(row) > 8 else float("nan")
        is_red = (not math.isnan(qty)) and qty < 0
        nonzero = (not math.isnan(qty)) and abs(qty) > 0
        records.append({
            "Warehouse": current_wh,
            "Code": code,
            "Name": name,
            "FinalQty_I": None if math.isnan(qty) else qty,
            "IsRed": is_red,
            "NonZero": nonzero,
        })

    df = pd.DataFrame(records)
    if df.empty:
        raise RuntimeError("Барааны мөрүүд олдсонгүй.")
    return df


def get_stats(input_path: str) -> dict:
    """Return dashboard-ready summary stats without writing any file."""
    df = _parse_records(input_path)

    # Per-warehouse summary
    wh_summary = (
        df.groupby("Warehouse")
        .agg(
            items=("Code", "nunique"),
            red_items=("IsRed", "sum"),
            total_qty=(
                "FinalQty_I",
                lambda s: pd.to_numeric(s, errors="coerce").fillna(0).sum(),
            ),
        )
        .reset_index()
        .sort_values("Warehouse")
    )

    # Multi-location count
    nonzero_df = df[df["NonZero"]].copy()
    wh_counts = nonzero_df.groupby("Code")["Warehouse"].nunique()
    multi_location_count = int((wh_counts > 1).sum())

    warehouses = [
        {
            "name": row["Warehouse"],
            "items": int(row["items"]),
            "red_items": int(row["red_items"]),
            "total_qty": round(float(row["total_qty"]), 2),
        }
        for _, row in wh_summary.iterrows()
    ]

    return {
        "warehouse_count": len(warehouses),
        "total_items": int(df["Code"].nunique()),
        "total_red_items": int(df["IsRed"].sum()),
        "multi_location_count": multi_location_count,
        "warehouses": warehouses,
    }


# Заалны улайлтыг мастерын «Байршил tag»-аар 4 агуулах + Бусад гэж 5 хуудас болгоно
HALL_TAG_SHEETS = [
    ("Бөөний агуулах",      "Улайлт-Бөөний агуулах"),
    ("Архи Ус ундаа пиво",  "Улайлт-Архи ус ундаа"),
    ("Жижиглэн агуулах",    "Улайлт-Жижиглэн"),
    ("Гэрээт компани",      "Улайлт-Гэрээт"),
]
HALL_OTHER_SHEET = "Улайлт-Бусад"


def _tag_bucket(tag_csv: str) -> str:
    """Мастерын tag (CSV байж болно) → 4 агуулахын аль нэг, үгүй бол ''."""
    parts = [" ".join(t.split()).strip().lower() for t in str(tag_csv or "").split(",")]
    for tag, _sheet in HALL_TAG_SHEETS:
        if tag.lower() in parts:
            return tag
    return ""


# Агуулахын үлдэгдлийн файлын хэсгийн нэр → мастерын «Байршил tag» (нэгтгэсэн тайланд)
WAREHOUSE_SECTION_TAG = {
    "бөөний агуулах": "Бөөний агуулах",
    "ус ундаа архи пиво": "Архи Ус ундаа пиво",
    "жижиглэн барааны агуулах": "Жижиглэн агуулах",
    "гэрээт компаний агуулах": "Гэрээт компани",
}
COMBINED_OTHER_HALL = "Улайлт-Заал бусад"
COMBINED_OTHER_WH = "Улайлт-Агуулах бусад"


def _write_combined_sheet(out_wb, name, wh_rows, hall_rows, wh_label, hall_label):
    """Нэг хуудас: АГУУЛАХЫН улайлт (дээр), доор нь ЗААЛНЫ улайлт (тагаар).
    Бүх нүд хүрээтэй, хэсэг бүр тодруулсан толгойн мөртэй; хэвлэх тохиргоотой."""
    from openpyxl.styles import PatternFill
    ws = out_wb.create_sheet(name[:31])
    cols = ["Хэсэг", "Байршил", "Code", "Name", "FinalQty_I", "Байршил tag", "Үлдэгдэл", "Тайлбар"]
    widths = [9, 24, 10, 44, 11, 18, 14, 30]
    for ci, h in enumerate(cols, 1):
        c = ws.cell(1, ci, h)
        c.font = Font(bold=True)
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        c.border = _ALL_BORDER
    for ci, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(ci)].width = w
    sec_fill = PatternFill("solid", fgColor="D9E1F2")
    r = 2

    def section(title, rows, kind):
        nonlocal r
        c = ws.cell(r, 1, title)
        c.font = Font(bold=True)
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=len(cols))
        for ci in range(1, len(cols) + 1):
            ws.cell(r, ci).fill = sec_fill
            ws.cell(r, ci).border = _ALL_BORDER
        r += 1
        if not rows:
            ws.cell(r, 1, "— улайсан бараа алга —").font = Font(italic=True, color="7F8C8D")
            for ci in range(1, len(cols) + 1):
                ws.cell(r, ci).border = _ALL_BORDER
            r += 1
            return
        for row in rows:
            vals = [kind, row["Warehouse"], row["Code"], row["Name"], row["FinalQty_I"], row.get("tag", ""), None, None]
            for ci, v in enumerate(vals, 1):
                ws.cell(r, ci, v).border = _ALL_BORDER
            r += 1

    if wh_label != "—":
        section(f"АГУУЛАХ — {wh_label} ({len(wh_rows)} мөр)", wh_rows, "Агуулах")
    if hall_label != "—":
        section(f"ЗААЛ — {hall_label} ({len(hall_rows)} мөр)", hall_rows, "Заал")
    ws.freeze_panes = "A2"
    _print_setup(ws, landscape=False, footer_center=name.replace("Улайлт-", "Улайлт — "))
    return ws


def build_combined_report(warehouse_path, hall_paths, output_path):
    """Агуулах + Заалны улайлтыг нэгтгэсэн тайлан.

    4 агуулах бүрд нэг хуудас: дээр нь тухайн агуулахын улайлт (Бүх агуулахын
    үлдэгдлийн файлаас), доор нь мастерын тухайн агуулахын тагтай ЗААЛНЫ улайлт
    (Үндсэн/Архины заалны файлаас). 5 дахь хуудас — бусад тагтай заалны улайлт;
    агуулахын файлд 4-өөс өөр хэсэг байвал «Агуулах бусад» хуудас. MultiLocation —
    агуулахын файлаас. Хэвлэх: «Улайлт-» хуудас бүрийг тусад нь; MultiLocation тусдаа товч."""
    from app.scripts.no_movement_report import _master_tags
    tags = _master_tags()

    wh_df = _parse_records(warehouse_path)
    wh_red = wh_df[wh_df["IsRed"]].copy()
    hall_frames = [_parse_records(p) for p in hall_paths if p]
    hall_red = pd.concat([f[f["IsRed"]] for f in hall_frames]) if hall_frames else wh_red.iloc[0:0].copy()
    hall_red = hall_red.copy()
    hall_red["tag"] = hall_red["Code"].map(lambda c: tags.get(str(c), "") or "(мастерт байхгүй)")
    hall_red["_bucket"] = hall_red["Code"].map(lambda c: _tag_bucket(tags.get(str(c), "")))
    wh_red["tag"] = wh_red["Code"].map(lambda c: tags.get(str(c), "") or "")

    # Агуулахын дүн (агуулахын файл)
    wh_summary = wh_df.groupby("Warehouse").agg(
        Items=("Code", "nunique"),
        RedItems=("IsRed", "sum"),
        TotalFinalQty=("FinalQty_I", lambda s_: pd.to_numeric(s_, errors="coerce").fillna(0).sum())
    ).reset_index().sort_values("Warehouse")
    hall_summary = pd.concat(hall_frames).groupby("Warehouse").agg(
        Items=("Code", "nunique"), RedItems=("IsRed", "sum"),
        TotalFinalQty=("FinalQty_I", lambda s_: pd.to_numeric(s_, errors="coerce").fillna(0).sum())
    ).reset_index() if hall_frames else None

    # MultiLocation — агуулахын файлаас (build_report-той ижил)
    nonzero_df = wh_df[wh_df["NonZero"]].copy()
    wh_counts = nonzero_df.groupby("Code")["Warehouse"].nunique().reset_index(name="WarehouseCount")
    multi_codes = set(wh_counts[wh_counts["WarehouseCount"] > 1]["Code"].tolist())
    multi_base = nonzero_df[nonzero_df["Code"].isin(multi_codes)].copy()
    if len(multi_base):
        pivot = multi_base.pivot_table(index=["Code", "Name"], columns="Warehouse", values="FinalQty_I",
                                       aggfunc="sum", fill_value=0).reset_index().copy()
        counts_map = wh_counts.set_index("Code")["WarehouseCount"].to_dict()
        pivot["WarehouseCount"] = pivot["Code"].map(counts_map).fillna(0).astype(int)
        wcols = [c for c in pivot.columns if c not in ("Code", "Name", "WarehouseCount")]
        pivot["TotalQty"] = pivot[wcols].sum(axis=1)
        multi_report = pivot[["Code", "Name", "WarehouseCount", "TotalQty"] + wcols].sort_values(
            ["WarehouseCount", "Code"], ascending=[False, True])
    else:
        multi_report = pd.DataFrame(columns=["Code", "Name", "WarehouseCount", "TotalQty"])

    out_wb = Workbook()
    out_wb.remove(out_wb.active)
    ws_sum = add_sheet(out_wb, "Warehouse_Summary", wh_summary, borders=True, footer_center="Агуулахын дүн")

    wh_sections = {_norm_ws(w): w for w in wh_red["Warehouse"].unique()}
    used_sections = set()
    counts = []
    for tag, sheet in HALL_TAG_SHEETS:
        sec_key = next((k for k, t in WAREHOUSE_SECTION_TAG.items() if t == tag), None)
        sec_name = wh_sections.get(sec_key or "")
        w_rows = wh_red[wh_red["Warehouse"] == sec_name].sort_values("Code").to_dict("records") if sec_name else []
        if sec_name:
            used_sections.add(sec_name)
        h_rows = hall_red[hall_red["_bucket"] == tag].sort_values(["Warehouse", "Code"]).to_dict("records")
        _write_combined_sheet(out_wb, sheet, w_rows, h_rows,
                              wh_label=(sec_name or f"{tag} (агуулахын файлд хэсэг алга)"),
                              hall_label=f"{tag} тагтай")
        counts.append((sheet, len(w_rows), len(h_rows)))
    h_other = hall_red[hall_red["_bucket"] == ""].sort_values(["tag", "Warehouse", "Code"]).to_dict("records")
    _write_combined_sheet(out_wb, COMBINED_OTHER_HALL, [], h_other, wh_label="—", hall_label="бусад тагтай")
    counts.append((COMBINED_OTHER_HALL, 0, len(h_other)))
    w_other = wh_red[~wh_red["Warehouse"].isin(used_sections)].sort_values(["Warehouse", "Code"]).to_dict("records")
    if w_other:
        _write_combined_sheet(out_wb, COMBINED_OTHER_WH, w_other, [], wh_label="бусад хэсэг", hall_label="—")
        counts.append((COMBINED_OTHER_WH, len(w_other), 0))

    add_sheet(out_wb, "MultiLocation", multi_report, borders=True, landscape=True,
              footer_center="Давхар байршилтай бараа")

    r0 = ws_sum.max_row + 2
    if hall_summary is not None:
        ws_sum.cell(r0, 1, "Заалны файл:").font = Font(bold=True)
        for i, (_, hr) in enumerate(hall_summary.iterrows(), 1):
            ws_sum.cell(r0 + i, 1, hr["Warehouse"]); ws_sum.cell(r0 + i, 2, int(hr["Items"]))
            ws_sum.cell(r0 + i, 3, int(hr["RedItems"])); ws_sum.cell(r0 + i, 4, float(hr["TotalFinalQty"]))
        r0 += len(hall_summary) + 2
    ws_sum.cell(r0, 1, "Хэвлэх:").font = Font(bold=True)
    ws_sum.cell(r0 + 1, 1, "• Улайлт хэвлэх — хуудас бүр: агуулахын улайлт, доор нь тухайн тагтай заалны улайлт: " +
                ", ".join(f"{sh.replace('Улайлт-', '')} ({w}+{h})" for sh, w, h in counts) + ".")
    ws_sum.cell(r0 + 2, 1, "• Давхар байршил — агуулахын файлын MultiLocation (хэвтээ).")
    out_wb.save(output_path)
    return add_print_buttons(output_path, mode="combined")


def _norm_ws(s_: str) -> str:
    return " ".join(str(s_ or "").split()).strip().lower()


def build_report(input_path, output_path, mode: str = "warehouse"):
    """mode="warehouse": RedItems нэг хуудас (агуулах бүр хуудасны хуваалттай).
    mode="hall": заалны улайлт — мастерын тагаар 5 хуудас (4 агуулах + Бусад),
    хэвлэх товч нь тэр 5 хуудсыг дараалан хэвлэнэ; MultiLocation товчгүй."""
    df = _parse_records(input_path)
    df["Row"] = 0  # Row info not tracked in _parse_records; keep column for compat

    # Warehouse_Summary: нийт бараа, улайсан тоо, эцсийн тоо
    wh_summary = df.groupby("Warehouse").agg(
        Items=("Code", "nunique"),
        RedItems=("IsRed", "sum"),
        TotalFinalQty=("FinalQty_I", lambda s: pd.to_numeric(s, errors="coerce").fillna(0).sum())
    ).reset_index().sort_values("Warehouse")

    # RedItems: зөвхөн I<0
    # Хэвлээд гараар бөглөх 2 хоосон багана: Үлдэгдэл (бодит тоолсон), Тайлбар
    red_df = df[df["IsRed"]].copy()
    red_df["Үлдэгдэл"] = None
    red_df["Тайлбар"] = None
    red_df = red_df[["Warehouse", "Code", "Name", "FinalQty_I", "Үлдэгдэл", "Тайлбар"]].sort_values(["Warehouse", "Code"])

    # MultiLocation: давхар байршил дээр үлдэгдэлтэй бараа, агуулах бүрийн үлдэгдлийг баганаар
    nonzero_df = df[df["NonZero"]].copy()
    wh_counts = nonzero_df.groupby("Code")["Warehouse"].nunique().reset_index(name="WarehouseCount")
    multi_codes = set(wh_counts[wh_counts["WarehouseCount"] > 1]["Code"].tolist())

    multi_base = nonzero_df[nonzero_df["Code"].isin(multi_codes)].copy()
    pivot = multi_base.pivot_table(
        index=["Code", "Name"],
        columns="Warehouse",
        values="FinalQty_I",
        aggfunc="sum",
        fill_value=0
    ).reset_index().copy()

    counts_map = wh_counts.set_index("Code")["WarehouseCount"].to_dict()
    pivot["WarehouseCount"] = pivot["Code"].map(counts_map).fillna(0).astype(int)

    warehouse_cols = [c for c in pivot.columns if c not in ("Code", "Name", "WarehouseCount")]
    pivot["TotalQty"] = pivot[warehouse_cols].sum(axis=1)

    multi_report = pivot[["Code", "Name", "WarehouseCount", "TotalQty"] + warehouse_cols].sort_values(
        ["WarehouseCount", "Code"], ascending=[False, True]
    )

    # Export
    out_wb = Workbook()
    out_wb.remove(out_wb.active)

    ws_sum = add_sheet(out_wb, "Warehouse_Summary", wh_summary, borders=True, footer_center="Агуулахын дүн")
    if mode == "hall":
        # Мастерын тагаар 4 агуулах + Бусад → 5 хуудас (хуудас бүр тусдаа хэвлэгдэнэ)
        from app.scripts.no_movement_report import _master_tags
        tags = _master_tags()
        red_df = red_df.copy()
        red_df["_bucket"] = red_df["Code"].map(lambda c: _tag_bucket(tags.get(str(c), "")))
        red_df["Байршил tag"] = red_df["Code"].map(lambda c: tags.get(str(c), "") or "(мастерт байхгүй)")
        cols = ["Warehouse", "Code", "Name", "FinalQty_I", "Байршил tag", "Үлдэгдэл", "Тайлбар"]
        bucket_counts = []
        for tag, sheet in HALL_TAG_SHEETS + [("", HALL_OTHER_SHEET)]:
            part = red_df[red_df["_bucket"] == tag][cols].sort_values(["Warehouse", "Code"])
            add_sheet(out_wb, sheet, part, borders=True, footer_center=sheet.replace("Улайлт-", "Улайлт — "),
                      min_widths={"Үлдэгдэл": 14, "Тайлбар": 30, "Байршил tag": 18})
            bucket_counts.append((sheet, len(part)))
    else:
        add_sheet(out_wb, "RedItems", red_df, borders=True, footer_center="Улайлт (үлдэгдэл < 0)",
                  page_break_col="Warehouse", min_widths={"Үлдэгдэл": 14, "Тайлбар": 30})
    add_sheet(out_wb, "MultiLocation", multi_report, borders=True, landscape=True,
              footer_center="Давхар байршилтай бараа")

    # Хэвлэх заавар (товч VBA-гүй үед ч ойлгомжтой байг)
    r0 = ws_sum.max_row + 2
    ws_sum.cell(r0, 1, "Хэвлэх:").font = Font(bold=True)
    if mode == "hall":
        ws_sum.cell(r0 + 1, 1, "• Улайлт 5 хуудас — мастерын «Байршил tag»-аар: " +
                    ", ".join(f"{sh.replace('Улайлт-', '')} ({n})" for sh, n in bucket_counts) + ". Хуудас бүр тусдаа хэвлэгдэнэ.")
        ws_sum.cell(r0 + 2, 1, "• Бүх багана нэг хуудсанд; толгойд огноо, хөлд хуудасны дугаар.")
    else:
        ws_sum.cell(r0 + 1, 1, "• RedItems хуудас — агуулах бүр тусдаа хуудаснаас эхэлнэ (хуудасны хуваалт тавьсан), бүх багана нэг хуудсанд багтана.")
        ws_sum.cell(r0 + 2, 1, "• MultiLocation хуудас — хэвтээ, бүх багана нэг хуудсанд. Хуудас бүрийн доод хэсэгт огноо, хуудасны дугаар байна.")

    out_wb.save(output_path)
    return add_print_buttons(output_path, mode=mode)


# ── Хэвлэх товч (VBA) ────────────────────────────────────────────────────────

def _vba_str(text: str) -> str:
    """Монгол/кирилл текстийг VBA-д аюулгүй илэрхийлэл болгоно.

    VBA-ийн код модуль Unicode биш (системийн ANSI кодчилол) тул кирилл
    үсгийг шууд бичвэл '???' болно. ASCII биш тэмдэгт бүрийг ChrW(код)-оор
    угсарна: "Хэвлэх" → ChrW(1061) & ChrW(1101) & ..."""
    parts: list[str] = []
    buf = ""
    for ch in text:
        if 32 <= ord(ch) < 127 and ch != '"':
            buf += ch
        else:
            if buf:
                parts.append(f'"{buf}"')
                buf = ""
            parts.append(f"ChrW({ord(ch)})")
    if buf:
        parts.append(f'"{buf}"')
    return " & ".join(parts) if parts else '""'


# VBA код — ЗӨВХӨН ASCII (тайлбар нь ч англиар). Монгол мөрүүд {placeholder}-оор
# орж, _vba_module()-д ChrW илэрхийлэл болж солигдоно.
_VBA_TEMPLATE = r"""
Option Explicit

' Ulailt report print macros (generated by ulailt_report.py).
' Text is built with ChrW() because VBA modules are not Unicode.

Private Function AskYesNo(msg As String, title As String) As Boolean
    AskYesNo = (MsgBox(msg, vbYesNo + vbQuestion, title) = vbYes)
End Function

Private Sub DoPrint(ws As Worksheet, tag As String)
    ws.PrintOut
End Sub

' Print RedItems separately for every warehouse: filter by warehouse,
' warehouse name in header, date + page numbers in footer.
Sub PrintRedItemsByWarehouse()
    Dim ws As Worksheet
    Set ws = ThisWorkbook.Worksheets("RedItems")
    Dim lastRow As Long
    lastRow = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    If lastRow < 2 Then
        MsgBox {S_NO_RED}, vbInformation
        Exit Sub
    End If

    Dim d As Object
    Set d = CreateObject("Scripting.Dictionary")
    Dim r As Long
    For r = 2 To lastRow
        If Not d.Exists(CStr(ws.Cells(r, 1).Value)) Then d.Add CStr(ws.Cells(r, 1).Value), 1
    Next r

    If Not AskYesNo(d.Count & {S_CONFIRM_RED} & vbCrLf & {S_PRINTER} & Application.ActivePrinter & ")", {S_TITLE_RED}) Then Exit Sub

    Application.ScreenUpdating = False
    On Error GoTo Done
    ' Manual page breaks (one per warehouse) would add blank pages when the
    ' sheet is filtered to a single warehouse -> remove them while printing.
    ws.ResetAllPageBreaks
    Dim k As Variant
    For Each k In d.Keys
        ws.AutoFilterMode = False
        ws.Range("A1").CurrentRegion.AutoFilter Field:=1, Criteria1:=k
        With ws.PageSetup
            .Orientation = xlPortrait
            .Zoom = False
            .FitToPagesWide = 1
            .FitToPagesTall = False
            .PrintTitleRows = "$1:$1"
            .TopMargin = Application.InchesToPoints(1)
            .HeaderMargin = Application.InchesToPoints(0.3)
            .BottomMargin = Application.InchesToPoints(0.7)
            .FooterMargin = Application.InchesToPoints(0.3)
            .CenterHeader = "&""Arial,Bold""&12" & {S_HDR_RED} & k
            .LeftHeader = "&D &T"
            .LeftFooter = ""
            .CenterFooter = k
            .RightFooter = {S_PAGE} & "&P / &N"
        End With
        DoPrint ws, CStr(k)
    Next k
Done:
    If Err.Number <> 0 Then MsgBox {S_ERR} & Err.Description, vbExclamation
    ws.AutoFilterMode = False
    ws.PageSetup.CenterHeader = ""
    ws.PageSetup.CenterFooter = {S_FOOT_RED}
    RestoreWarehouseBreaks ws, lastRow
    Application.ScreenUpdating = True
End Sub

' Re-insert one page break per warehouse (for manual Ctrl+P printing).
Private Sub RestoreWarehouseBreaks(ws As Worksheet, lastRow As Long)
    On Error Resume Next
    ws.ResetAllPageBreaks
    Dim r As Long
    For r = 3 To lastRow
        If CStr(ws.Cells(r, 1).Value) <> CStr(ws.Cells(r - 1, 1).Value) Then
            ws.HPageBreaks.Add Before:=ws.Rows(r)
        End If
    Next r
End Sub

' Hall mode: print every sheet whose name starts with the "Ulailt-" prefix
' (4 warehouse tags + Others), each as its own document, portrait, fit to width.
Sub PrintTagSheets()
    Dim pre As String
    pre = {S_TAG_PREFIX}
    Dim n As Long
    Dim ws As Worksheet
    For Each ws In ThisWorkbook.Worksheets
        If Left(ws.Name, Len(pre)) = pre Then n = n + 1
    Next ws
    If n = 0 Then
        MsgBox {S_NO_RED}, vbInformation
        Exit Sub
    End If
    If Not AskYesNo(n & {S_CONFIRM_TAG} & vbCrLf & {S_PRINTER} & Application.ActivePrinter & ")", {S_TITLE_RED}) Then Exit Sub
    Application.ScreenUpdating = False
    On Error GoTo Done
    For Each ws In ThisWorkbook.Worksheets
        If Left(ws.Name, Len(pre)) = pre Then
            If ws.Cells(ws.Rows.Count, 1).End(xlUp).Row >= 2 Then
                With ws.PageSetup
                    .Orientation = xlPortrait
                    .Zoom = False
                    .FitToPagesWide = 1
                    .FitToPagesTall = False
                    .PrintTitleRows = "$1:$1"
                    .TopMargin = Application.InchesToPoints(1)
                    .HeaderMargin = Application.InchesToPoints(0.3)
                    .BottomMargin = Application.InchesToPoints(0.7)
                    .FooterMargin = Application.InchesToPoints(0.3)
                    .CenterHeader = "&""Arial,Bold""&12" & {S_HDR_RED} & Mid(ws.Name, Len(pre) + 1)
                    .LeftHeader = "&D &T"
                    .LeftFooter = ""
                    .CenterFooter = Mid(ws.Name, Len(pre) + 1)
                    .RightFooter = {S_PAGE} & "&P / &N"
                End With
                DoPrint ws, ws.Name
            End If
        End If
    Next ws
Done:
    If Err.Number <> 0 Then MsgBox {S_ERR} & Err.Description, vbExclamation
    Application.ScreenUpdating = True
End Sub

' Print MultiLocation: landscape, all columns on one page.
Sub PrintMultiLocation()
    Dim ws As Worksheet
    Set ws = ThisWorkbook.Worksheets("MultiLocation")
    With ws.PageSetup
        .Orientation = xlLandscape
        .Zoom = False
        .FitToPagesWide = 1
        .FitToPagesTall = False
        .PrintTitleRows = "$1:$1"
        .TopMargin = Application.InchesToPoints(1)
        .HeaderMargin = Application.InchesToPoints(0.3)
        .CenterHeader = "&""Arial,Bold""&12" & {S_HDR_ML}
        .LeftHeader = "&D &T"
        .LeftFooter = ""
        .CenterFooter = "MultiLocation"
        .RightFooter = {S_PAGE} & "&P / &N"
    End With
    If AskYesNo({S_CONFIRM_ML} & vbCrLf & {S_PRINTER} & Application.ActivePrinter & ")", {S_TITLE_ML}) Then DoPrint ws, "MultiLocation"
End Sub
"""

_VBA_STRINGS = {
    # MsgBox нь ANSI тул кирилл '???' болно → асуумжийн текст ЛАТИНААР.
    # Header/footer (хэвлэгдэх) нь Unicode тул кириллээр (ChrW) хэвээр.
    "S_NO_RED":      "Ulaisan (uldegdel < 0) baraa alga.",
    "S_CONFIRM_RED": " aguulakhyn ulailtyg tus tusad n' khevlekh uu? (aguulakh bur = 1 khuudas)",
    "S_PRINTER":     "(Khevlegch: ",
    "S_TITLE_RED":   "Ulailt khevlekh",
    "S_HDR_RED":     "Улайлтын тайлан — ",
    "S_PAGE":        "Хуудас ",
    "S_ERR":         "Khevlekhed aldaa: ",
    "S_FOOT_RED":    "Улайлт (үлдэгдэл < 0)",
    "S_HDR_ML":      "Давхар байршилтай бараа",
    "S_CONFIRM_ML":  "MultiLocation khuudsyg khevlekh uu?",
    "S_TAG_PREFIX":  "Улайлт-",
    "S_CONFIRM_TAG": " khuudas (4 aguulakhyn tag + Busad) tus tusad n' khevlekh uu?",
    "S_TITLE_ML":    "Khevlekh",
}


def _vba_module() -> str:
    code = _VBA_TEMPLATE
    for k, v in _VBA_STRINGS.items():
        code = code.replace("{" + k + "}", _vba_str(v))
    assert code.isascii(), "VBA module must stay ASCII"
    return code


def add_print_buttons(xlsx_path: str, mode: str = "warehouse") -> str:
    """openpyxl-ийн үүсгэсэн .xlsx-д Excel COM-оор VBA модуль + Warehouse_Summary
    дээр 2 хэвлэх товч нэмж .xlsm болгож хадгална. Буцаах: эцсийн файлын зам.

    Excel байхгүй / «Trust access to the VBA project object model» нээгээгүй бол
    .xlsx хэвээр буцаана (хуудасны хуваалт, хэвлэх тохиргоо нь аль хэдийн байгаа)."""
    try:
        import pythoncom
        import win32com.client
    except ImportError:
        print("[ulailt] pywin32 суугаагүй — хэвлэх товчгүй .xlsx буцаана")
        return xlsx_path

    from app.services.erkhet_xlsx import _excel_resave_lock

    xlsm_path = os.path.splitext(xlsx_path)[0] + ".xlsm"
    with _excel_resave_lock:
        pythoncom.CoInitialize()
        try:
            xl = win32com.client.DispatchEx("Excel.Application")
            try:
                xl.Visible = False
                xl.DisplayAlerts = False
                wb = xl.Workbooks.Open(os.path.abspath(xlsx_path))
                try:
                    mod = wb.VBProject.VBComponents.Add(1)      # 1 = vbext_ct_StdModule
                    mod.Name = "PrintMacros"
                    mod.CodeModule.AddFromString(_vba_module())

                    ws = wb.Worksheets("Warehouse_Summary")
                    anchor = ws.Range("F2")
                    b1 = ws.Buttons().Add(anchor.Left, anchor.Top, 300, 32)
                    if mode == "hall":
                        # Заалны улайлт: 5 хуудас (тагаар) хэвлэх ганц товч; MultiLocation товчгүй
                        b1.OnAction = "PrintTagSheets"
                        b1.Caption = "Улайлт хэвлэх — 5 хуудас (агуулахын тагаар)"
                    elif mode == "combined":
                        b1.OnAction = "PrintTagSheets"
                        b1.Caption = "Улайлт хэвлэх — агуулах + заал (хуудас бүр)"
                        b2 = ws.Buttons().Add(anchor.Left, anchor.Top + 40, 300, 32)
                        b2.OnAction = "PrintMultiLocation"
                        b2.Caption = "Давхар байршил (MultiLocation) хэвлэх"
                        b2.Font.Bold = True
                    else:
                        b1.OnAction = "PrintRedItemsByWarehouse"
                        b1.Caption = "Улайлт хэвлэх — агуулах тус бүрээр"
                        b2 = ws.Buttons().Add(anchor.Left, anchor.Top + 40, 300, 32)
                        b2.OnAction = "PrintMultiLocation"
                        b2.Caption = "Давхар байршил (MultiLocation) хэвлэх"
                        b2.Font.Bold = True
                    b1.Font.Bold = True
                    ws.Columns("F").ColumnWidth = 45

                    wb.SaveAs(os.path.abspath(xlsm_path), FileFormat=52)   # xlOpenXMLWorkbookMacroEnabled
                finally:
                    wb.Close(False)
            finally:
                xl.Quit()
        except Exception as e:
            print(f"[ulailt] хэвлэх товч нэмж чадсангүй — .xlsx буцаана: {e!r}")
            try:
                if os.path.exists(xlsm_path):
                    os.remove(xlsm_path)
            except OSError:
                pass
            return xlsx_path
        finally:
            pythoncom.CoUninitialize()

    try:
        os.remove(xlsx_path)
    except OSError:
        pass
    return xlsm_path


def main():
    root = tk.Tk()
    root.withdraw()

    input_path = filedialog.askopenfilename(
        title="ERP татсан үлдэгдлийн файлаа сонго",
        filetypes=[
            ("Excel files", "*.xls *.xlsx"),
            ("Excel 97-2003", "*.xls"),
            ("Excel Workbook", "*.xlsx"),
            ("All files", "*.*"),
        ],
    )

    if not input_path:
        return

    out_dir = os.path.dirname(os.path.abspath(input_path))
    date_str = datetime.now().strftime("%Y_%m_%d")
    output_name = f"{date_str} улайлт тайлан.xlsx"
    output_path = os.path.join(out_dir, output_name)

    try:
        output_path = build_report(input_path, output_path)
        messagebox.showinfo("Амжилттай", f"Тайлан export хийгдлээ:\n{output_path}")
    except Exception as e:
        messagebox.showerror("Алдаа", str(e))


if __name__ == "__main__":
    main()
