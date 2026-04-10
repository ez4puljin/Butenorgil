"""
Барааны сүүлийн орлогоны үнийн тайлан
Орлого тайлан (type=3) Excel файлаас бараа бүрийн хамгийн сүүлийн орлогоны үнийг гаргана.
"""
import pandas as pd
from pathlib import Path

REQUIRED_COLUMNS = [
    "Огноо",
    "Бараа материал код",
    "Бараа материал нэр",
    "Нэгж үнэ",
]

OPTIONAL_COLUMNS = [
    "Баримтын дугаар",
    "Байршил код",
    "Байршил нэр",
    "Тоо хэмжээ",
    "Дебет",
    "Кредит",
    "Хэрэглэгч",
]


def find_header_row(df_preview):
    for i in range(min(20, len(df_preview))):
        row_values = [str(x).strip() for x in df_preview.iloc[i].tolist()]
        if all(col in row_values for col in REQUIRED_COLUMNS):
            return i
    return None


def load_excel_with_flexible_header(file_path: str):
    preview = pd.read_excel(file_path, header=None)
    header_row = find_header_row(preview)
    if header_row is None:
        raise ValueError(
            "Header мөр олдсонгүй. Дараах баганууд Excel-д заавал байх ёстой:\n"
            + ", ".join(REQUIRED_COLUMNS)
        )
    df = pd.read_excel(file_path, header=header_row)
    df.columns = [str(c).strip() for c in df.columns]
    return df


def clean_and_prepare(df):
    missing = [col for col in REQUIRED_COLUMNS if col not in df.columns]
    if missing:
        raise ValueError(f"Дараах шаардлагатай баганууд алга: {', '.join(missing)}")

    keep_cols = [c for c in REQUIRED_COLUMNS + OPTIONAL_COLUMNS if c in df.columns]
    df = df[keep_cols].copy()

    df["Бараа материал код"] = df["Бараа материал код"].astype(str).str.strip()
    df["Бараа материал нэр"] = df["Бараа материал нэр"].astype(str).str.strip()
    df = df[df["Бараа материал код"].notna()]
    df = df[df["Бараа материал код"] != ""]
    df = df[df["Бараа материал код"].str.lower() != "nan"]

    df["Огноо"] = pd.to_datetime(df["Огноо"], errors="coerce")
    df["Нэгж үнэ"] = pd.to_numeric(df["Нэгж үнэ"], errors="coerce")
    df = df[df["Огноо"].notna()]
    df = df[df["Нэгж үнэ"].notna()]
    return df


def get_last_purchase_price(df):
    df = df.reset_index(drop=False).rename(columns={"index": "__row_no__"})
    df = df.sort_values(["Бараа материал код", "Огноо", "__row_no__"])
    last_df = df.groupby("Бараа материал код", as_index=False).tail(1).copy()

    output_cols = ["Бараа материал код", "Бараа материал нэр", "Огноо", "Нэгж үнэ"]
    for col in ["Баримтын дугаар", "Байршил код", "Байршил нэр", "Тоо хэмжээ", "Хэрэглэгч"]:
        if col in last_df.columns:
            output_cols.append(col)

    last_df = last_df[output_cols].sort_values("Бараа материал код").reset_index(drop=True)
    return last_df


def build_report(input_path: str, output_path: str):
    df = load_excel_with_flexible_header(input_path)
    df = clean_and_prepare(df)
    result_df = get_last_purchase_price(df)

    with pd.ExcelWriter(output_path, engine="openpyxl") as writer:
        result_df.to_excel(writer, index=False, sheet_name="LastPurchasePrice")
        ws = writer.sheets["LastPurchasePrice"]
        for col in ws.columns:
            max_len = max((len(str(cell.value)) if cell.value is not None else 0) for cell in col)
            ws.column_dimensions[col[0].column_letter].width = min(max_len + 2, 40)
