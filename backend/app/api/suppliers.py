from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from app.api.deps import get_db, require_role
from app.models.supplier import Supplier, BrandSupplierMap
from app.models.product import Product

router = APIRouter(prefix="/suppliers", tags=["suppliers"])


class SupplierIn(BaseModel):
    name: str
    phone: str = ""
    viber: str = ""
    email: str = ""
    notes: str = ""
    is_active: bool = True


class BrandMapIn(BaseModel):
    brand: str
    supplier_id: int


# ── Supplier CRUD ─────────────────────────────────────────────────────────────

@router.get("")
def list_suppliers(db: Session = Depends(get_db), _=Depends(require_role("admin", "supervisor", "manager"))):
    rows = db.query(Supplier).order_by(Supplier.name).all()
    return [
        {
            "id": s.id,
            "name": s.name,
            "phone": s.phone,
            "viber": s.viber,
            "email": s.email,
            "notes": s.notes,
            "is_active": s.is_active,
        }
        for s in rows
    ]


@router.post("")
def create_supplier(
    body: SupplierIn,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    if db.query(Supplier).filter(Supplier.name == body.name).first():
        raise HTTPException(400, "Нийлүүлэгч аль хэдийн байна")
    s = Supplier(**body.model_dump())
    db.add(s)
    db.commit()
    db.refresh(s)
    return {"id": s.id, "name": s.name}


@router.put("/{supplier_id}")
def update_supplier(
    supplier_id: int,
    body: SupplierIn,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    s = db.query(Supplier).filter(Supplier.id == supplier_id).first()
    if not s:
        raise HTTPException(404, "Нийлүүлэгч олдсонгүй")
    # Нэр давхарлагдах шалгалт (өөрийгөө оруулахгүйгээр)
    if body.name != s.name:
        if db.query(Supplier).filter(Supplier.name == body.name, Supplier.id != supplier_id).first():
            raise HTTPException(400, "Ижил нэртэй нийлүүлэгч аль хэдийн байна")
    for k, v in body.model_dump().items():
        setattr(s, k, v)
    db.commit()
    return {"ok": True}


@router.delete("/{supplier_id}")
def delete_supplier(
    supplier_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    s = db.query(Supplier).filter(Supplier.id == supplier_id).first()
    if not s:
        raise HTTPException(404, "Нийлүүлэгч олдсонгүй")
    # Брэнд холбоос байгаа эсэхийг шалгана
    brand_count = db.query(BrandSupplierMap).filter(BrandSupplierMap.supplier_id == supplier_id).count()
    if brand_count > 0:
        raise HTTPException(
            400,
            f"Энэ нийлүүлэгчтэй {brand_count} брэнд холбоотой байна. "
            "Устгахын өмнө брэндийн холбоосыг арилгана уу."
        )
    db.delete(s)
    db.commit()
    return {"ok": True}


# ── Brand map ─────────────────────────────────────────────────────────────────

@router.get("/all-brands")
def all_brands(db: Session = Depends(get_db), _=Depends(require_role("admin", "supervisor", "manager"))):
    brands = (
        db.query(Product.brand)
        .filter(Product.brand != "")
        .distinct()
        .order_by(Product.brand)
        .all()
    )
    return [b[0] for b in brands]


@router.get("/brand-map")
def get_brand_map(db: Session = Depends(get_db), _=Depends(require_role("admin", "supervisor", "manager"))):
    maps = db.query(BrandSupplierMap).all()
    return [
        {
            "brand": m.brand,
            "supplier_id": m.supplier_id,
            "supplier_name": m.supplier.name if m.supplier else None,
        }
        for m in maps
    ]


@router.post("/brand-map")
def set_brand_map(
    body: BrandMapIn,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    existing = db.query(BrandSupplierMap).filter(BrandSupplierMap.brand == body.brand).first()
    if existing:
        existing.supplier_id = body.supplier_id
    else:
        db.add(BrandSupplierMap(brand=body.brand, supplier_id=body.supplier_id))
    db.commit()
    return {"ok": True}


@router.delete("/brand-map/{brand}")
def delete_brand_map(
    brand: str,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    m = db.query(BrandSupplierMap).filter(BrandSupplierMap.brand == brand).first()
    if m:
        db.delete(m)
        db.commit()
    return {"ok": True}
