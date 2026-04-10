"""
refresh_stock_from_balance.py

"Үлдэгдлийн тайлан" Excel файлын I баганаас (индекс 8)
Эцсийн үлдэгдэл тоог уншиж Product.stock_qty-г шинэчилнэ.

Excel файлын бүтэц:
  Row 0 : Код | Нэр | Эхний үлдэгдэл | ... | Эцсийн үлдэгдэл | ...
  Row 1 : sub-headers  (Тоо / Дүн гэх мэт)
  Row 2+: дата мөрүүд
         col[0] = Код  (бараа код / агуулахын дугаар / ангилалын нийлбэр)
         col[8] = Эцсийн үлдэгдэл / Тоо  ← I багана
"""

from __future__ import annotations

import re
import pandas as pd
from sqlalchemy.orm import Session

from app.models.product import Product


def _normalize_code(raw) -> str:
    """Excel-ийн кодыг item_code форматруу хувиргана (trailing .0 хасна)."""
    if pd.isna(raw):
        return ""
    s = re.sub(r"\.0$", "", str(raw).strip())
    return re.sub(r"\s+", "", s)


def _safe_float(raw) -> float:
    try:
        v = float(raw)
        return 0.0 if pd.isna(v) else v
    except (TypeError, ValueError):
        return 0.0


def refresh_stock_from_balance_report(db: Session, file_path: str) -> dict:
    """
    Үлдэгдлийн тайлан файлыг уншиж Product.stock_qty шинэчилнэ.

    Returns:
        {"mapped_codes": int, "updated": int}
    """
    p = str(file_path)
    engine = "xlrd" if p.lower().endswith(".xls") else "openpyxl"
    df = pd.read_excel(p, sheet_name=0, header=None, engine=engine)

    if df.shape[1] < 9:
        raise ValueError(
            f"Файлд хангалттай багана байхгүй ({df.shape[1]} багана, хамгийн багадаа 9 хэрэгтэй)"
        )

    # ── Файлаас код → stock_qty map үүсгэнэ ──────────────────────────────────
    # Хэрэв ижил код олон агуулахын хэсэгт байвал нийлбэрийг авна
    stock_map: dict[str, float] = {}

    for _, row in df.iloc[2:].iterrows():          # 0,1-р мөр — header
        code = _normalize_code(row.iloc[0])
        if not code:
            continue

        qty = _safe_float(row.iloc[8])             # I багана (индекс 8)

        # Нийт болон агуулахын нийлбэр мөрүүдийг алгасна:
        #   150101 гэх мэт — ангилалын нийт
        #   01, 02, 11, 12 гэх мэт — агуулахын дэд нийт
        # → Зөвхөн 6 оронтой тоо бол бараа мөр гэж үзнэ
        if not re.match(r"^\d{6,}$", code):
            continue

        # Ижил код дахин гарвал нэмнэ (олон агуулахад хувааригдсан бараа)
        stock_map[code] = stock_map.get(code, 0.0) + qty

    if not stock_map:
        return {"mapped_codes": 0, "updated": 0}

    # ── DB-д тохирох бараануудыг шинэчилнэ ───────────────────────────────────
    updated = 0
    # Batch query: зөвхөн map-т байгаа код бүхий бараануудыг татна
    products = (
        db.query(Product)
        .filter(Product.item_code.in_(list(stock_map.keys())))
        .all()
    )
    for prod in products:
        new_qty = stock_map.get(prod.item_code, 0.0)
        if prod.stock_qty != new_qty:
            prod.stock_qty = new_qty
            updated += 1

    db.commit()

    return {"mapped_codes": len(stock_map), "updated": updated}
