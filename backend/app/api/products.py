from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.api.deps import get_db, require_role
from app.models.product import Product

router = APIRouter(prefix="/products", tags=["products"])

@router.get("")
def list_products(
    warehouse_tag_id: int,
    brand: str | None = None,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin","supervisor","manager","warehouse_clerk"))
):
    q = db.query(Product).filter(Product.warehouse_tag_id == warehouse_tag_id)
    if brand and brand != "ALL":
        q = q.filter(Product.brand == brand)
    rows = q.order_by(Product.name.asc()).all()
    return [{
        "id": r.id, "item_code": r.item_code, "name": r.name, "brand": r.brand,
        "unit_weight": r.unit_weight, "stock_qty": r.stock_qty, "sales_qty": r.sales_qty,
        "warehouse_tag_id": r.warehouse_tag_id, "pack_ratio": r.pack_ratio
    } for r in rows]

@router.get("/brands")
def brands(warehouse_tag_id: int, db: Session = Depends(get_db), _=Depends(require_role("admin","supervisor","manager","warehouse_clerk"))):
    rows = db.query(Product.brand).filter(Product.warehouse_tag_id == warehouse_tag_id).distinct().all()
    brands = sorted([r[0] for r in rows if r[0]])
    return {"brands": ["ALL"] + brands}

@router.get("/search")
def search_products(
    q: str = "",
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "manager", "warehouse_clerk")),
):
    if len(q) < 2:
        return []
    term = f"%{q}%"
    rows = (
        db.query(Product)
        .filter((Product.item_code.ilike(term)) | (Product.name.ilike(term)))
        .order_by(Product.name.asc())
        .limit(30)
        .all()
    )
    return [
        {
            "id": r.id, "item_code": r.item_code, "name": r.name, "brand": r.brand,
            "unit_weight": r.unit_weight, "warehouse_tag_id": r.warehouse_tag_id,
            "warehouse_name": r.warehouse_name, "pack_ratio": r.pack_ratio,
        }
        for r in rows
    ]