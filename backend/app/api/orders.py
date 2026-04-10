from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.api.deps import get_db, get_current_user, require_role, parse_tag_ids
from app.models.order import Order, OrderLine, BrandWeightOverride
from app.models.product import Product
from app.schemas.order import OrderCreateIn, OrderLineIn, OrderSubmitIn, SupervisorOverrideIn
from app.models.supplier import BrandSupplierMap

router = APIRouter(prefix="/orders", tags=["orders"])

# Roles that act as "order owners" — see only their own orders
_OWNER_ROLES = {"manager", "warehouse_clerk"}


def _eff(u) -> str:
    """Return the effective system role (base_role takes precedence over role)."""
    return (u.base_role or u.role or "").strip()


def _is_owner_role(u) -> bool:
    return _eff(u) in _OWNER_ROLES


def _assert_own_draft(o: Order, u) -> None:
    """Raise 403 if user doesn't own the order, or 400 if not draft."""
    if o.created_by_user_id != u.id:
        raise HTTPException(403, "Энэ захиалга таны биш байна")
    if o.status != "draft":
        raise HTTPException(400, "Захиалга ноорог биш тул засах боломжгүй")


# ── Create ────────────────────────────────────────────────────────────────────

@router.post("/create")
def create_order(payload: OrderCreateIn, db: Session = Depends(get_db), u=Depends(get_current_user)):
    # manager & warehouse_clerk: зөвхөн оноогдсон tag_ids-ийн агуулахад л үүсгэнэ
    if _is_owner_role(u):
        allowed = parse_tag_ids(u.tag_ids)
        if allowed and payload.warehouse_tag_id not in allowed:
            raise HTTPException(403, "Энэ агуулахад захиалга үүсгэх эрх байхгүй")

    # Хэрэв тухайн хэрэглэгчийн нэг ижил warehouse+brand draft аль хэдийн байвал дахин үүсгэхгүй
    existing = (
        db.query(Order)
        .filter(
            Order.created_by_user_id == u.id,
            Order.warehouse_tag_id == payload.warehouse_tag_id,
            Order.brand == payload.brand,
            Order.status == "draft",
        )
        .order_by(Order.id.desc())
        .first()
    )
    if existing:
        return {"order_id": existing.id}

    o = Order(
        created_by_user_id=u.id,
        warehouse_tag_id=payload.warehouse_tag_id,
        brand=payload.brand,
        status="draft",
    )
    db.add(o)
    db.commit()
    db.refresh(o)
    return {"order_id": o.id}


# ── My draft (device-independent draft lookup) ────────────────────────────────

@router.get("/my-draft")
def get_my_draft(
    warehouse_tag_id: int,
    brand: str,
    db: Session = Depends(get_db),
    u=Depends(require_role("manager", "admin", "supervisor", "warehouse_clerk")),
):
    """
    Тухайн хэрэглэгчийн warehouse+brand-д хамаарах хамгийн сүүлийн
    draft захиалгыг буцаана. Байхгүй бол order_id=null.
    Ямар ч device дээр нэвтэрсэн ч хуучин draft-аа server-ээс авна.
    """
    o = (
        db.query(Order)
        .filter(
            Order.created_by_user_id == u.id,
            Order.warehouse_tag_id == warehouse_tag_id,
            Order.brand == brand,
            Order.status == "draft",
        )
        .order_by(Order.id.desc())
        .first()
    )
    return {"order_id": o.id if o else None}


# ── Set lines ─────────────────────────────────────────────────────────────────

@router.post("/{order_id}/set-lines")
def set_lines(
    order_id: int,
    lines: list[OrderLineIn],
    db: Session = Depends(get_db),
    u=Depends(get_current_user),
):
    o = db.query(Order).filter(Order.id == order_id).first()
    if not o:
        raise HTTPException(404, "Захиалга олдсонгүй")

    # manager болон warehouse_clerk нь зөвхөн өөрийн draft-ийг засна
    if _is_owner_role(u):
        _assert_own_draft(o, u)

    # Нэг атомар transaction: DELETE + INSERT
    db.query(OrderLine).filter(OrderLine.order_id == order_id).delete(
        synchronize_session=False
    )

    product_ids = [li.product_id for li in lines]
    products_map = {
        p.id: p
        for p in db.query(Product).filter(Product.id.in_(product_ids)).all()
    }
    new_lines = []
    for li in lines:
        p = products_map.get(li.product_id)
        if not p:
            continue
        qty_box = float(li.order_qty_box or 0)
        qty_pcs = qty_box * float(p.pack_ratio or 1)
        computed_weight = qty_pcs * float(p.unit_weight or 0)
        new_lines.append(
            OrderLine(
                order_id=order_id,
                product_id=p.id,
                order_qty_box=qty_box,
                order_qty_pcs=qty_pcs,
                computed_weight=computed_weight,
                # Захиалга хадгалах үеийн нөөцийн тоо (Үлдэгдлийн тайланаас)
                stock_qty_snapshot=float(p.stock_qty or 0),
            )
        )
    db.add_all(new_lines)
    db.commit()
    return {"ok": True, "line_count": len(new_lines)}


# ── Submit ────────────────────────────────────────────────────────────────────

@router.post("/submit")
def submit(
    payload: OrderSubmitIn,
    db: Session = Depends(get_db),
    u=Depends(get_current_user),
):
    o = db.query(Order).filter(Order.id == payload.order_id).first()
    if not o:
        raise HTTPException(404, "Захиалга олдсонгүй")

    # manager болон warehouse_clerk нь зөвхөн өөрийнхийг илгээнэ
    if _is_owner_role(u) and o.created_by_user_id != u.id:
        raise HTTPException(403, "Энэ захиалга таны биш байна")

    o.status = "submitted"
    db.commit()
    return {"ok": True}


# ── My orders (history) ───────────────────────────────────────────────────────

@router.get("/manager/my")
def my_orders(
    db: Session = Depends(get_db),
    u=Depends(require_role("manager", "admin", "supervisor", "warehouse_clerk")),
):
    q = db.query(Order)
    # manager болон warehouse_clerk нь зөвхөн өөрийнхийг харна
    if _is_owner_role(u):
        q = q.filter(Order.created_by_user_id == u.id)
    rows = q.order_by(Order.id.desc()).limit(50).all()
    return [
        {
            "id": r.id,
            "created_at": r.created_at,
            "status": r.status,
            "warehouse_tag_id": r.warehouse_tag_id,
            "brand": r.brand,
        }
        for r in rows
    ]


# ── Supervisor consolidated view ──────────────────────────────────────────────

@router.get("/supervisor")
def supervisor_consolidated(
    status: str = "submitted",
    db: Session = Depends(get_db),
    _=Depends(require_role("supervisor", "admin")),
):
    orders = db.query(Order).filter(Order.status == status).order_by(Order.id.asc()).all()
    if not orders:
        return {"lines": [], "orders": []}

    lines_out = []
    for o in orders:
        for l in db.query(OrderLine).filter(OrderLine.order_id == o.id).all():
            p = db.query(Product).filter(Product.id == l.product_id).first()
            if not p:
                continue
            lines_out.append(
                {
                    "orderId": o.id,
                    "warehouseTagId": o.warehouse_tag_id,
                    "brand": o.brand,
                    "itemCode": p.item_code,
                    "name": p.name,
                    "unitWeight": p.unit_weight,
                    "orderQtyBox": l.order_qty_box,
                    "orderQtyPcs": l.order_qty_pcs,
                    "computedWeight": l.computed_weight,
                }
            )

    return {
        "orders": [
            {"id": o.id, "warehouse_tag_id": o.warehouse_tag_id, "brand": o.brand}
            for o in orders
        ],
        "lines": lines_out,
    }


# ── Overrides ─────────────────────────────────────────────────────────────────

@router.post("/overrides/save")
def save_overrides(
    payload: SupervisorOverrideIn,
    db: Session = Depends(get_db),
    _=Depends(require_role("supervisor", "admin")),
):
    return {"ok": True, "count": len(payload.overrides)}


# ── Order lines (read) ────────────────────────────────────────────────────────

@router.get("/{order_id}/lines")
def get_order_lines(
    order_id: int,
    db: Session = Depends(get_db),
    u=Depends(get_current_user),
):
    o = db.query(Order).filter(Order.id == order_id).first()
    if not o:
        raise HTTPException(404, "Захиалга олдсонгүй")

    # manager болон warehouse_clerk нь зөвхөн өөрийнхийг харна
    if _is_owner_role(u) and o.created_by_user_id != u.id:
        raise HTTPException(403, "Энэ захиалга таны биш байна")

    lines = db.query(OrderLine).filter(OrderLine.order_id == order_id).all()
    result = []
    for l in lines:
        p = db.query(Product).filter(Product.id == l.product_id).first()
        result.append(
            {
                "product_id": l.product_id,
                "item_code": p.item_code if p else "",
                "name": p.name if p else "",
                "order_qty_box": l.order_qty_box,
                "order_qty_pcs": l.order_qty_pcs,
                "computed_weight": l.computed_weight,
                "stock_qty_snapshot": float(l.stock_qty_snapshot or 0),
            }
        )
    return result


# ── Supervisor by supplier ────────────────────────────────────────────────────

@router.get("/supervisor/by-supplier")
def supervisor_by_supplier(
    status: str = "submitted",
    db: Session = Depends(get_db),
    _=Depends(require_role("supervisor", "admin")),
):
    orders = db.query(Order).filter(Order.status == status).all()

    brand_supplier: dict = {}
    for m in db.query(BrandSupplierMap).all():
        brand_supplier[m.brand] = {
            "supplier_id": m.supplier_id,
            "supplier_name": m.supplier.name if m.supplier else "",
        }

    supplier_data: dict = {}
    unmapped_brands: dict = {}

    for o in orders:
        brand = o.brand
        tag_id = str(o.warehouse_tag_id)
        lines = db.query(OrderLine).filter(OrderLine.order_id == o.id).all()
        total_weight = sum(float(l.computed_weight or 0) for l in lines)

        if brand in brand_supplier:
            sup = brand_supplier[brand]
            sup_id = sup["supplier_id"]
            if sup_id not in supplier_data:
                supplier_data[sup_id] = {
                    "supplier_id": sup_id,
                    "supplier_name": sup["supplier_name"],
                    "brands": {},
                    "total_weight": 0.0,
                    "order_ids": set(),
                }
            if brand not in supplier_data[sup_id]["brands"]:
                supplier_data[sup_id]["brands"][brand] = {
                    "weight": 0.0,
                    "warehouses": {},
                }
            supplier_data[sup_id]["brands"][brand]["weight"] += total_weight
            supplier_data[sup_id]["total_weight"] += total_weight
            supplier_data[sup_id]["order_ids"].add(o.id)
            wh = supplier_data[sup_id]["brands"][brand]["warehouses"]
            wh[tag_id] = wh.get(tag_id, 0.0) + total_weight
        else:
            if brand not in unmapped_brands:
                unmapped_brands[brand] = {
                    "brand": brand,
                    "weight": 0.0,
                    "order_count": 0,
                }
            unmapped_brands[brand]["weight"] += total_weight
            unmapped_brands[brand]["order_count"] += 1

    suppliers_out = []
    for sup_id, data in supplier_data.items():
        brands_list = [
            {"brand": b, "weight": v["weight"], "warehouses": v["warehouses"]}
            for b, v in data["brands"].items()
        ]
        suppliers_out.append(
            {
                "supplier_id": sup_id,
                "supplier_name": data["supplier_name"],
                "brands": brands_list,
                "total_weight": data["total_weight"],
                "order_count": len(data["order_ids"]),
            }
        )

    return {
        "suppliers": suppliers_out,
        "unmapped_brands": list(unmapped_brands.values()),
    }
