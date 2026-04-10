"""
ERP орлого тайланаас барааны сүүлийн худалдан авалтын үнийг уншиж
Product.last_purchase_price-г шинэчлэнэ.

Excel формат:
  A: Код (item_code)
  B: Нэр (лавлах)
  C: Огноо
  D: Нэгж үнэ
"""

from sqlalchemy.orm import Session
from app.models.product import Product


def refresh_prices_from_file(db: Session, xlsx_path: str) -> dict:
    import openpyxl
    from datetime import datetime

    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    ws = wb.active

    # Collect rows: {item_code: [(date, price), ...]}
    rows: dict[str, list] = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row or row[0] is None:
            continue
        item_code = str(row[0]).strip()
        if not item_code or item_code.lower() == "nan":
            continue

        # Parse date (column C, index 2)
        raw_date = row[2] if len(row) > 2 else None
        parsed_date = None
        if raw_date:
            if isinstance(raw_date, datetime):
                parsed_date = raw_date
            else:
                try:
                    parsed_date = datetime.fromisoformat(str(raw_date).strip())
                except ValueError:
                    try:
                        for fmt in ("%Y/%m/%d", "%Y-%m-%d", "%d/%m/%Y", "%d.%m.%Y"):
                            try:
                                parsed_date = datetime.strptime(str(raw_date).strip(), fmt)
                                break
                            except ValueError:
                                continue
                    except Exception:
                        pass

        # Parse unit price (column D, index 3)
        raw_price = row[3] if len(row) > 3 else None
        try:
            price = float(raw_price) if raw_price is not None else 0.0
        except (TypeError, ValueError):
            price = 0.0

        if price <= 0:
            continue

        rows.setdefault(item_code, []).append((parsed_date, price))

    # For each item_code, pick the row with the latest date (None dates go last)
    best_price: dict[str, float] = {}
    for item_code, entries in rows.items():
        dated = [(d, p) for d, p in entries if d is not None]
        undated = [(d, p) for d, p in entries if d is None]
        if dated:
            dated.sort(key=lambda x: x[0], reverse=True)
            best_price[item_code] = dated[0][1]
        elif undated:
            # Take last undated entry as "most recent"
            best_price[item_code] = undated[-1][1]

    if not best_price:
        return {"updated": 0, "not_found": 0}

    updated = 0
    not_found = 0
    for item_code, price in best_price.items():
        product = db.query(Product).filter(Product.item_code == item_code).first()
        if product:
            product.last_purchase_price = price
            updated += 1
        else:
            not_found += 1

    db.commit()
    return {"updated": updated, "not_found": not_found}
