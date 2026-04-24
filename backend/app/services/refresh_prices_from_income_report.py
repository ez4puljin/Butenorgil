"""
Erkhet-ээс гарсан Орлого тайлан Excel-ээс бараа бүрийн хамгийн сүүлийн
нэгж үнийг уншиж Product.last_purchase_price-г шинэчилнэ.

Excel headers (header row нь эхний 20 мөрийн аль нэгэнд байна):
  - Баримтын дугаар, Огноо, Утга, Дансны дугаар, Дансны нэр,
  - Харьцсан дансд, Харилцагч код, Харилцагч нэр,
  - Бараа материал код, Бараа материал нэр,
  - Байршил код, Байршил нэр,
  - Тоо хэмжээ, Нэгж үнэ, Дебет, Кредит, Хөнгөлөлт, Хэрэглэгч

Логик:
  1. `load_excel_with_flexible_header` + `clean_and_prepare` → эрэмбэлсэн DataFrame
  2. `get_last_purchase_price` → бараа тус бүрийн хамгийн сүүлийн (огноо+мөр) үнэ
  3. `item_code` тохирох Product-ууд олж `last_purchase_price`-г шинэчилнэ
"""

from sqlalchemy.orm import Session
from app.models.product import Product
from app.scripts.last_purchase_price_report import (
    load_excel_with_flexible_header,
    clean_and_prepare,
    get_last_purchase_price,
)


def refresh_prices_from_income_report(db: Session, xlsx_path: str) -> dict:
    df = load_excel_with_flexible_header(xlsx_path)
    df = clean_and_prepare(df)
    last_df = get_last_purchase_price(df)

    if last_df.empty:
        return {"updated": 0, "not_found": 0, "total_rows": 0}

    updated = 0
    not_found = 0
    for _, row in last_df.iterrows():
        item_code = str(row["Бараа материал код"]).strip()
        if not item_code or item_code.lower() == "nan":
            continue
        try:
            price = float(row["Нэгж үнэ"])
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue

        product = db.query(Product).filter(Product.item_code == item_code).first()
        if product:
            product.last_purchase_price = price
            updated += 1
        else:
            not_found += 1

    db.commit()
    return {"updated": updated, "not_found": not_found, "total_rows": int(len(last_df))}
