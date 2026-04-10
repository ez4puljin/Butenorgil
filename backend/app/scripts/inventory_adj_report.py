# make_order_false_report_v2.py
# Usage:
#   1) python make_order_false_report_v2.py
#      → File chooser-аар эх Excel-ээ сонгоно
#   2) эсвэл: python make_order_false_report_v2.py "path/to/input.xlsx"

import sys, re
import pandas as pd
import numpy as np

# ---------- Helpers ----------
def normalize(s: str) -> str:
    return re.sub(r'[^a-z0-9]', '', str(s).lower())

def find_col(df: pd.DataFrame, options) -> str | None:
    nmap = {c: normalize(c) for c in df.columns}
    for opt in options:
        o = normalize(opt)
        for c, n in nmap.items():
            if o in n:
                return c
    return None

def is_false(v) -> bool:
    if isinstance(v, bool):
        return v is False
    if pd.isna(v):
        return False
    s = str(v).strip().lower()
    return s in {"false", "0", "no", "нет", "ложь"}

def load_input_path() -> str:
    if len(sys.argv) >= 2:
        return sys.argv[1]
    # Tkinter file chooser
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk(); root.withdraw()
        path = filedialog.askopenfilename(
            title="Захиалгын Excel-ээ сонгоно уу",
            filetypes=[("Excel files", "*.xlsx *.xls")]
        )
        if not path:
            raise SystemExit("Файл сонгосонгүй.")
        return path
    except Exception as e:
        raise SystemExit(f"Файл сонгох үед алдаа: {e}")

# ---------- Core ----------
def build_report(input_path: str) -> str:
    xls = pd.ExcelFile(input_path)
    df  = xls.parse(xls.sheet_names[0])
    df.rename(columns={c: str(c).strip() for c in df.columns}, inplace=True)

    # Columns (robust detection)
    created_col = find_col(df, ["createdAt", "created at", "date", "огноо"])
    name_col    = find_col(df, ["name"])  # customer/order name
    number_col  = find_col(df, ["number", "order number", "docnumber"])

    code_col    = find_col(df, ["productsData.code", "productsdata.code", "product code", "код"])
    pname_col   = find_col(df, ["productsData.name", "productsdata.name", "product name"])
    qty_col     = find_col(df, ["productsData.quantity", "productsdata.quantity", "qty", "quantity"])
    tick_col    = find_col(df, ["productsData.tickUsed", "productsdata.tickused", "tick used", "tickused"])

    required = {
        "createdAt": created_col, "name": name_col, "number": number_col,
        "productsData.code": code_col, "productsData.name": pname_col,
        "productsData.quantity": qty_col, "productsData.tickUsed": tick_col,
    }
    missing = [k for k, v in required.items() if v is None]
    if missing:
        raise SystemExit(f"Дараах баганууд олдсонгүй: {', '.join(missing)}")

    # Forward-fill order headers over '-' or blanks
    df[[created_col, name_col, number_col]] = (
        df[[created_col, name_col, number_col]]
        .replace({r'^\s*-\s*$': np.nan, '': np.nan}, regex=True)
        .ffill()
    )

    # Filter tickUsed == false
    mask_false = df[tick_col].map(is_false)
    detail = df.loc[mask_false, [created_col, name_col, number_col, code_col, pname_col, qty_col, tick_col]].copy()
    detail.columns = ["createdAt", "name", "number", "productsData.code", "productsData.name", "productsData.quantity", "productsData.tickUsed"]

    # Sort false_items_detail by productsData.name A→Z (and keep stable by createdAt/number)
    # createdAt may be text; use a hidden sort key for stability if parseable
    dt = pd.to_datetime(detail["createdAt"], errors="coerce")
    detail["_dt_sort"] = dt
    sort_cols = []
    if "_dt_sort" in detail.columns: sort_cols.append("_dt_sort")
    sort_cols += ["number", "name"]  # secondary keys
    # First, sort by those for stability, then sort by name A→Z
    if sort_cols:
        detail.sort_values(by=sort_cols, kind="mergesort", inplace=True)
    detail.sort_values(by=["productsData.name"], kind="mergesort", inplace=True)
    if "_dt_sort" in detail.columns: detail.drop(columns=["_dt_sort"], inplace=True)

    # Unique orders having false items
    orders = detail[["createdAt", "name", "number"]].drop_duplicates().copy()
    if "createdAt" in orders.columns:
        orders["_dt"] = pd.to_datetime(orders["createdAt"], errors="coerce")
        orders.sort_values(by=["_dt", "name", "number"], inplace=True, kind="mergesort")
        orders.drop(columns=["_dt"], inplace=True)

    # Write Excel
    out_path = re.sub(r'\.xls(x)?$', '', input_path, flags=re.I) + "_order_false_report_v2.xlsx"
    with pd.ExcelWriter(out_path, engine="xlsxwriter") as writer:
        # Sheet 1: orders_with_false
        orders.to_excel(writer, index=False, sheet_name="orders_with_false")
        ws1 = writer.sheets["orders_with_false"]
        ws1.freeze_panes(1, 0)
        ws1.autofilter(0, 0, len(orders), len(orders.columns) - 1)
        # Set decent widths
        widths1 = {"createdAt": 14, "name": 28, "number": 18}
        for i, col in enumerate(orders.columns):
            ws1.set_column(i, i, widths1.get(col, 16))

        # Sheet 2: false_items_detail (name sorted A→Z + filter ON)
        cols = ["createdAt","name","number","productsData.code","productsData.name","productsData.quantity","productsData.tickUsed"]
        detail.to_excel(writer, index=False, sheet_name="false_items_detail", columns=cols)
        ws2 = writer.sheets["false_items_detail"]
        ws2.freeze_panes(1, 0)
        ws2.autofilter(0, 0, len(detail), len(cols) - 1)
        widths2 = {
            "createdAt": 14, "name": 28, "number": 18,
            "productsData.code": 16, "productsData.name": 40,
            "productsData.quantity": 14, "productsData.tickUsed": 14
        }
        for i, col in enumerate(cols):
            ws2.set_column(i, i, widths2.get(col, 16))

    print(f"Амжилттай: {out_path}")
    return out_path

if __name__ == "__main__":
    in_path = load_input_path()
    build_report(in_path)
