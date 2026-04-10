import pandas as pd
from sqlalchemy.orm import Session
from app.models.product import Product

def _safe_str(val, default: str = "") -> str:
    try:
        if pd.isna(val):
            return default
    except (TypeError, ValueError):
        pass
    s = str(val).strip() if val is not None else default
    return s if s.lower() != "nan" else default

def _safe_float(val, default: float = 0.0) -> float:
    try:
        v = float(val)
        return default if pd.isna(v) else v
    except (TypeError, ValueError):
        return default

def _safe_int(val, default: int = 0) -> int:
    try:
        v = float(val)
        return default if pd.isna(v) else int(v)
    except (TypeError, ValueError):
        return default

def refresh_products_from_master(db: Session, master_xlsx_path: str):
    df = pd.read_excel(master_xlsx_path)
    df.columns = [c.strip().lower() for c in df.columns]

    # expected columns (lowercase):
    # item_code, name, brand, unit_weight, stock_qty, sales_qty, warehouse_tag_id, pack_ratio
    required = {"item_code", "name", "brand"}
    if not required.issubset(set(df.columns)):
        raise RuntimeError(f"Master багана дутуу. required={required}")

    # ── UPSERT: item_code-аар match → update, шинэ бол insert ─────────────
    # Product.id тогтвортой үлдэнэ → PO lines хүчинтэй хэвээр байна
    existing_map: dict[str, Product] = {
        p.item_code: p
        for p in db.query(Product).all()
    }
    seen_codes: set[str] = set()

    updated = 0
    inserted = 0
    for _, r in df.iterrows():
        code = str(r.get("item_code", "")).strip()
        if not code:
            continue
        seen_codes.add(code)

        name         = _safe_str(r.get("name"), "")
        brand        = _safe_str(r.get("brand"), "")
        unit_weight  = _safe_float(r.get("unit_weight"), 0.0)
        stock_qty    = _safe_float(r.get("stock_qty"), 0.0)
        sales_qty    = _safe_float(r.get("sales_qty"), 0.0)
        wh_tag_id    = _safe_int(r.get("warehouse_tag_id"), 0)
        wh_name      = _safe_str(r.get("байршил tag"), "")
        pack_ratio   = _safe_float(r.get("pack_ratio"), 1.0)
        brand_code_v = _safe_int(r.get("брэнд код"), 0)
        brand_code   = str(brand_code_v) if brand_code_v != 0 else ""

        if code in existing_map:
            # UPDATE — ID хэвээр, зөвхөн field шинэчлэнэ
            p = existing_map[code]
            p.name = name
            p.brand = brand
            p.unit_weight = unit_weight
            p.stock_qty = stock_qty
            p.sales_qty = sales_qty
            p.warehouse_tag_id = wh_tag_id
            p.warehouse_name = wh_name
            p.pack_ratio = pack_ratio
            p.brand_code = brand_code
            updated += 1
        else:
            # INSERT — шинэ бараа
            db.add(Product(
                item_code=code,
                name=name,
                brand=brand,
                unit_weight=unit_weight,
                stock_qty=stock_qty,
                sales_qty=sales_qty,
                warehouse_tag_id=wh_tag_id,
                warehouse_name=wh_name,
                pack_ratio=pack_ratio,
                brand_code=brand_code,
            ))
            inserted += 1

    # Master-д байхгүй хуучин бараа → устгахгүй (PO line reference хадгална)
    # Хэрэв устгах шаардлагатай бол тусдаа cleanup хийнэ

    db.commit()
    return {"updated": updated, "inserted": inserted, "total_in_master": len(seen_codes)}
