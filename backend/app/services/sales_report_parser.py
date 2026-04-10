"""Parse Erkhet sales report Excel files and cache rows into sales_cache_rows table."""
from __future__ import annotations

import math
from datetime import datetime

import pandas as pd
from sqlalchemy.orm import Session

from app.models.sales_report import SalesCacheRow
from app.models.product import Product


def _safe_float(val, default: float = 0.0) -> float:
    try:
        v = float(val)
        return default if math.isnan(v) else v
    except (TypeError, ValueError):
        return default


def _safe_str(val, default: str = "") -> str:
    if val is None:
        return default
    s = str(val).strip()
    return default if s.lower() in ("nan", "") else s


def _classify(row) -> str:
    """Classify a raw DataFrame row.

    Returns one of: 'customer' | 'account' | 'warehouse' | 'product' | 'skip'
    """
    a = _safe_str(row.iloc[0] if len(row) > 0 else None)
    d_raw = row.iloc[3] if len(row) > 3 else None
    d = _safe_float(d_raw)

    # Strip decimal artifacts (.0) and non-digit chars for length check
    digits = a.replace(".", "").replace(",", "").strip()
    if not digits.isdigit():
        return "skip"

    # Product rows: unit_price column (D) has a positive value
    # NOTE: do NOT pre-filter by code prefix — product codes can also start with 5
    # (e.g. 504044, 509086, 511xxx etc.). Accounting summary rows (510101 etc.)
    # have no unit_price, so they fall through to "skip" naturally.
    if d > 0:
        return "product"

    # Customer rows: 5-digit code (10101, 20102 etc.)
    if len(digits) == 5:
        return "customer"

    # Warehouse rows: 1-2 digit code (01, 02 etc.)
    if len(digits) in (1, 2):
        return "warehouse"

    return "skip"


def _build_brand_map(db: Session) -> dict[str, tuple[str, str]]:
    """Build {item_code: (brand, brand_code)} lookup from Product table."""
    rows = db.query(Product.item_code, Product.brand, Product.brand_code).all()
    return {r.item_code: (r.brand or "", r.brand_code or "") for r in rows}


def parse_and_store(
    filepath: str,
    region: str,
    year: int,
    month: int,
    import_log_id: int,
    db: Session,
) -> int:
    """Parse an Erkhet sales report Excel and store rows in sales_cache_rows.

    Deletes any previous rows for the same (region, year, month) before inserting
    so a re-upload always replaces stale data.

    Returns the number of product rows inserted.
    """
    # Delete stale cache for this slot
    db.query(SalesCacheRow).filter(
        SalesCacheRow.region == region,
        SalesCacheRow.year   == year,
        SalesCacheRow.month  == month,
    ).delete()
    db.commit()

    # Read as raw strings — prevents pandas from coercing codes like "01" to integers
    df = pd.read_excel(filepath, header=None, dtype=str)

    brand_map = _build_brand_map(db)

    rows_to_insert: list[SalesCacheRow] = []
    now = datetime.utcnow()
    cust_code = cust_name = wh_code = wh_name = ""

    for _, raw in df.iterrows():
        kind = _classify(raw)

        if kind == "customer":
            cust_code = _safe_str(raw.iloc[0])
            cust_name = _safe_str(raw.iloc[1] if len(raw) > 1 else None)
            wh_code = wh_name = ""

        elif kind == "warehouse":
            wh_code = _safe_str(raw.iloc[0])
            wh_name = _safe_str(raw.iloc[1] if len(raw) > 1 else None)

        elif kind == "product":
            ic = _safe_str(raw.iloc[0])
            brand_info = brand_map.get(ic, ("", ""))
            total_amount = _safe_float(raw.iloc[7]) if len(raw) > 7 else 0.0
            rows_to_insert.append(SalesCacheRow(
                region         = region,
                year           = year,
                month          = month,
                customer_code  = cust_code,
                customer_name  = cust_name,
                warehouse_code = wh_code,
                warehouse_name = wh_name,
                item_code      = ic,
                item_name      = _safe_str(raw.iloc[1] if len(raw) > 1 else None),
                qty            = _safe_float(raw.iloc[2] if len(raw) > 2 else None),
                unit_price     = _safe_float(raw.iloc[3] if len(raw) > 3 else None),
                total_amount   = total_amount,
                brand          = brand_info[0],
                brand_code     = brand_info[1],
                import_log_id  = import_log_id,
                parsed_at      = now,
            ))

        # 'account' and 'skip' rows are intentionally ignored

    db.add_all(rows_to_insert)
    db.commit()
    return len(rows_to_insert)
