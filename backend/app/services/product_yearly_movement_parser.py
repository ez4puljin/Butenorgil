"""Жилийн хөдөлгөөний Excel файлыг product_yearly_movement-руу хадгална.

Файлын формат (хатуу биш):
  A багана = item_code (Эрхэт дотоод код, тоо эсвэл string)
  B багана = qty (хөдөлгөөний тоо)
  Хэрэв 1-р мөр нь header бол (qty багана нь тоо биш) автомат алгасна.

Баганын байршил тохиргооноос ирнэ (code_col / qty_col, 0-based).

Нэг файлд нэг item_code олон удаа гарвал нийт qty-г SUM хийнэ.

Upsert логик:
  - (item_code, year)-аар олох
  - kind=main   → qty_main баганыг шинэчилнэ (qty_liquor-ыг хөндөхгүй)
  - kind=liquor → qty_liquor баганыг шинэчилнэ (qty_main-ыг хөндөхгүй)
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

from app.models.product_yearly_movement import (
    ProductYearlyMovement,
    PYM_KIND_MAIN,
    PYM_KIND_LIQUOR,
    PYM_KINDS,
)


Kind = Literal["main", "liquor"]


def _safe_float(val, default: float = 0.0) -> float:
    try:
        v = float(str(val).replace(",", "")) if isinstance(val, str) else float(val)
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
    .xlsx → openpyxl, .xls → xlrd. Алдвал нөгөө engine-ээ оролдоно."""
    name = str(file_path).lower()
    order = ["xlrd", "openpyxl"] if name.endswith(".xls") else ["openpyxl", "xlrd"]
    last_err: Exception | None = None
    for eng in order:
        try:
            return pd.read_excel(file_path, header=None, dtype=str, engine=eng)
        except Exception as e:
            last_err = e
    try:
        return pd.read_excel(file_path, header=None, dtype=str)
    except Exception:
        raise last_err if last_err else RuntimeError("Excel унших боломжгүй")


def parse_and_upsert(
    file_path: str | Path,
    year: int,
    kind: Kind,
    db: Session,
    code_col: int = 0,
    qty_col: int = 1,
) -> dict:
    """Excel файлыг уншиж product_yearly_movement-руу upsert хийнэ.

    Буцаах утга: {"parsed": <тоо>, "upserted": <тоо>, "skipped": <тоо>, "examples": [...]}
    """
    if kind not in PYM_KINDS:
        raise ValueError(f"Invalid kind: {kind!r}. Must be one of {PYM_KINDS}.")
    if year < 2000 or year > 2100:
        raise ValueError(f"Invalid year: {year}")

    code_col = max(0, int(code_col))
    qty_col = max(0, int(qty_col))

    df = _read_excel_any(file_path)
    need_cols = max(code_col, qty_col) + 1
    if df.empty or df.shape[1] < need_cols:
        return {"parsed": 0, "upserted": 0, "skipped": 0, "examples": []}

    # Header автомат таних: 1-р мөрийн qty багана нь тоо биш бол header гэж үзнэ
    first_qty = df.iloc[0, qty_col] if len(df) > 0 else None
    try:
        float(str(first_qty).replace(",", ""))
        start_row = 0
    except (TypeError, ValueError):
        start_row = 1

    # Item_code-оор group-лэж SUM хийнэ
    aggregated: dict[str, float] = defaultdict(float)
    skipped = 0
    parsed = 0
    for i in range(start_row, len(df)):
        code = _safe_code(df.iloc[i, code_col])
        qty = _safe_float(df.iloc[i, qty_col])
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

    qty_field = "qty_main" if kind == PYM_KIND_MAIN else "qty_liquor"
    other_field = "qty_liquor" if kind == PYM_KIND_MAIN else "qty_main"
    now = datetime.utcnow()

    rows = [
        {
            "item_code": code,
            "year": year,
            qty_field: qty,
            other_field: 0.0,
            "created_at": now,
            "updated_at": now,
        }
        for code, qty in aggregated.items()
    ]

    # ── BATCH-аар оруулна — SQLite-ийн "too many SQL variables" (999) хязгаараас
    #    зайлсхийнэ. Мөр бүр 6 багана тул 100 мөр = 600 хувьсагч (аюулгүй). ──
    BATCH = 100
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        stmt = sqlite_insert(ProductYearlyMovement).values(chunk)
        stmt = stmt.on_conflict_do_update(
            index_elements=["item_code", "year"],
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
