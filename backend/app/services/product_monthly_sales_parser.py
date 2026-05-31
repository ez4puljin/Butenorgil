"""Сарын борлуулалтын Excel файлыг task-чилж product_monthly_sales-руу хадгална.

Файлын формат (хатуу биш):
  A багана = item_code (Эрхэт дотоод код, тоо эсвэл string)
  B багана = qty (тоо ширхэг)
  Хэрэв 1-р мөр нь header бол (B багана нь тоо биш) автомат алгасна.

Нэг файлд нэг item_code олон удаа гарвал нийт qty-г SUM хийнэ.

Upsert логик:
  - (item_code, year, month)-аар олох
  - kind=warehouse → qty_warehouse баганыг шинэчилнэ (qty_showroom-ыг хөндөхгүй)
  - kind=showroom  → qty_showroom баганыг шинэчилнэ (qty_warehouse-ийг хөндөхгүй)
  - Хэрвээ мөр байхгүй бол шинээр үүсгэнэ
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Literal

import pandas as pd
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.models.product_monthly_sales import (
    ProductMonthlySales,
    PMS_KIND_WAREHOUSE,
    PMS_KIND_SHOWROOM,
    PMS_KINDS,
)


Kind = Literal["warehouse", "showroom"]


def _safe_float(val, default: float = 0.0) -> float:
    try:
        v = float(val)
        return default if math.isnan(v) else v
    except (TypeError, ValueError):
        return default


def _safe_code(val) -> str:
    """item_code-ыг цэвэрлэнэ. Тоонууд `123.0` → `123` болгоно."""
    if val is None:
        return ""
    s = str(val).strip()
    if not s or s.lower() == "nan":
        return ""
    # Pandas-ийн float конверт хийсэн item_code-ыг хамгаална: `12345.0` → `12345`
    if s.endswith(".0"):
        try:
            f = float(s)
            if f.is_integer():
                s = str(int(f))
        except ValueError:
            pass
    return s


def _read_excel_any(file_path) -> "pd.DataFrame":
    """Excel-ийг өргөтгөлөөс хамааруулж зөв engine-ээр уншина.
    .xlsx → openpyxl, .xls → xlrd. Алдвал нөгөө engine-ээ оролдоно
    (зарим систем буруу өргөтгөлтэй экспортолдог)."""
    name = str(file_path).lower()
    if name.endswith(".xls"):
        order = ["xlrd", "openpyxl"]
    else:
        order = ["openpyxl", "xlrd"]
    last_err: Exception | None = None
    for eng in order:
        try:
            return pd.read_excel(file_path, header=None, dtype=str, engine=eng)
        except Exception as e:
            last_err = e
    # Эцсийн оролдлого — pandas өөрөө engine сонгоё
    try:
        return pd.read_excel(file_path, header=None, dtype=str)
    except Exception:
        raise last_err if last_err else RuntimeError("Excel унших боломжгүй")


def parse_and_upsert(
    file_path: str | Path,
    year: int,
    month: int,
    kind: Kind,
    db: Session,
    code_col: int = 0,
    qty_col: int = 1,
) -> dict:
    """Excel файлыг уншиж product_monthly_sales-руу upsert хийнэ.

    code_col / qty_col — барааны код ба борлуулалтын тооны багана (0-based индекс).
    Тохиргооноос ирнэ (default A=0, B=1).

    Буцаах утга: {"parsed": <тоо>, "upserted": <тоо>, "skipped": <тоо>, "examples": [...]}
    """
    if kind not in PMS_KINDS:
        raise ValueError(f"Invalid kind: {kind!r}. Must be one of {PMS_KINDS}.")
    if not (1 <= month <= 12):
        raise ValueError(f"Invalid month: {month}")
    if year < 2000 or year > 2100:
        raise ValueError(f"Invalid year: {year}")

    code_col = max(0, int(code_col))
    qty_col = max(0, int(qty_col))

    # Header-гүй уншина — өргөтгөлөөс хамаарч engine сонгоно:
    #   .xlsx → openpyxl, .xls (97-2003) → xlrd. Аль нэг нь алдвал нөгөөг оролдоно.
    df = _read_excel_any(file_path)
    need_cols = max(code_col, qty_col) + 1
    if df.empty or df.shape[1] < need_cols:
        return {"parsed": 0, "upserted": 0, "skipped": 0, "examples": []}

    # Header автомат таних: 1-р мөрийн qty багана нь тоо биш бол header гэж үзнэ
    first_qty = df.iloc[0, qty_col] if len(df) > 0 else None
    try:
        float(str(first_qty).replace(",", ""))
        start_row = 0   # эхний мөр тоо — header байхгүй
    except (TypeError, ValueError):
        start_row = 1   # эхний мөр header — алгасна

    # Item_code-оор group-лэж SUM хийнэ (файл дотор давхарласан мөрүүдийг нэгтгэнэ)
    aggregated: dict[str, float] = defaultdict(float)
    skipped = 0
    parsed = 0
    for i in range(start_row, len(df)):
        code_raw = df.iloc[i, code_col]
        qty_raw  = df.iloc[i, qty_col]
        code = _safe_code(code_raw)
        qty  = _safe_float(qty_raw)
        if not code:
            skipped += 1
            continue
        if qty <= 0:
            skipped += 1
            continue
        aggregated[code] += qty
        parsed += 1

    if not aggregated:
        return {"parsed": parsed, "upserted": 0, "skipped": skipped, "examples": []}

    # SQLite upsert — нэг batch-аар оруулна
    qty_field = "qty_warehouse" if kind == PMS_KIND_WAREHOUSE else "qty_showroom"
    other_field = "qty_showroom" if kind == PMS_KIND_WAREHOUSE else "qty_warehouse"
    now = datetime.utcnow()

    rows = [
        {
            "item_code": code,
            "year": year,
            "month": month,
            qty_field: qty,
            other_field: 0.0,
            "created_at": now,
            "updated_at": now,
        }
        for code, qty in aggregated.items()
    ]

    # ON CONFLICT (item_code, year, month) DO UPDATE — kind-ийн талын баганыг л шинэчилнэ
    stmt = sqlite_insert(ProductMonthlySales).values(rows)
    stmt = stmt.on_conflict_do_update(
        index_elements=["item_code", "year", "month"],
        set_={
            qty_field: getattr(stmt.excluded, qty_field),
            "updated_at": now,
        },
    )
    db.execute(stmt)
    db.commit()

    examples = list(aggregated.items())[:3]
    return {
        "parsed": parsed,
        "upserted": len(aggregated),
        "skipped": skipped,
        "examples": [{"item_code": c, "qty": q} for c, q in examples],
    }
