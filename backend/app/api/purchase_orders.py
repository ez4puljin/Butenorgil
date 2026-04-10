from pathlib import Path
from datetime import date as date_type
from typing import Optional, List
import io

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_db, get_current_user, require_role, parse_tag_ids
from app.models.purchase_order import (
    PurchaseOrder, PurchaseOrderLine, PurchaseOrderBrandVehicle,
    OrderExtraLine, POShipment, POShipmentLine,
)
from app.models.product import Product
from app.models.user import User
from app.models.logistics import Vehicle

router = APIRouter(prefix="/purchase-orders", tags=["purchase-orders"])

# master_latest.xlsx location (same OUTPUT_DIR as imports.py)
MASTER_FILE = Path("app/data/outputs/master_latest.xlsx")

# Status transition map
STATUS_SEQUENCE = [
    "preparing",
    "reviewing",
    "sending",
    "loading",
    "transit",
    "arrived",
    "accounting",
    "confirmed",
    "received",
]

STATUS_LABEL = {
    "preparing":  "Захиалга бэлдэж байна",
    "reviewing":  "Хянаж байна",
    "sending":    "Захиалга илгээж байна",
    "loading":    "Ачигдаж байна",
    "transit":    "Замд явж байна",
    "arrived":    "Ачаа ирсэн",
    "accounting": "Нягтлан шалгаж байна",
    "confirmed":  "Нягтлан Баталгаажсан",
    "received":   "Орлого авагдсан",
}


def _next_status(current: str) -> Optional[str]:
    try:
        idx = STATUS_SEQUENCE.index(current)
        if idx + 1 < len(STATUS_SEQUENCE):
            return STATUS_SEQUENCE[idx + 1]
    except ValueError:
        pass
    return None


def _serialize_order(o: PurchaseOrder, db: Session) -> dict:
    """Compact summary for list view."""
    creator = db.query(User).filter(User.id == o.created_by_user_id).first()
    total_boxes = sum(l.order_qty_box for l in o.lines)
    total_weight = sum(l.computed_weight for l in o.lines)
    vehicle = db.query(Vehicle).filter(Vehicle.id == o.vehicle_id).first() if o.vehicle_id else None
    return {
        "id": o.id,
        "order_date": o.order_date.isoformat(),
        "status": o.status,
        "status_label": STATUS_LABEL.get(o.status, o.status),
        "created_by_username": creator.username if creator else "",
        "line_count": len(o.lines),
        "total_boxes": round(total_boxes, 2),
        "total_weight": round(total_weight, 2),
        "created_at": o.created_at.isoformat() if o.created_at else None,
        "vehicle_id": o.vehicle_id,
        "vehicle_name": f"{vehicle.name} ({vehicle.plate})" if vehicle else None,
        "notes": o.notes or "",
    }


def _serialize_order_detail(
    o: PurchaseOrder,
    db: Session,
    filter_tag_ids: Optional[List[int]] = None,
) -> dict:
    """Full detail including product info for each line.
    If filter_tag_ids is provided, only lines whose product belongs to those warehouses are returned.
    Uses a single bulk query for products to avoid N+1.
    """
    base = _serialize_order(o, db)

    # Bulk load all products for this order in one query
    product_ids = [l.product_id for l in o.lines]
    products = db.query(Product).filter(Product.id.in_(product_ids)).all()
    product_map = {p.id: p for p in products}

    lines_out = []
    for l in o.lines:
        p = product_map.get(l.product_id)
        if not p:
            continue
        # Warehouse clerk sees only their assigned warehouses.
        # Products with warehouse_tag_id=0 are shared — visible to everyone.
        if filter_tag_ids and p.warehouse_tag_id != 0 and p.warehouse_tag_id not in filter_tag_ids:
            continue
        lpp = float(p.last_purchase_price or 0)
        up = float(l.unit_price or 0)
        qty = float(l.order_qty_box or 0)
        estimated_cost = round(lpp * qty, 2)
        price_diff = round(up - lpp, 2) if up > 0 and lpp > 0 else None

        lines_out.append({
            "line_id": l.id,
            "product_id": l.product_id,
            "item_code": p.item_code,
            "name": p.name,
            "brand": p.brand,
            "warehouse_tag_id": p.warehouse_tag_id,
            "warehouse_name": p.warehouse_name or "",
            "unit_weight": p.unit_weight,
            "pack_ratio": p.pack_ratio,
            "stock_qty": p.stock_qty,
            "sales_qty": p.sales_qty,
            "order_qty_box": l.order_qty_box,
            "order_qty_pcs": l.order_qty_pcs,
            "computed_weight": l.computed_weight,
            "supplier_qty_box": l.supplier_qty_box,
            "loaded_qty_box": l.loaded_qty_box,
            "received_qty_box": l.received_qty_box,
            "difference": round((l.loaded_qty_box or 0) - (l.received_qty_box or 0), 2),
            "unit_price": up,
            "last_purchase_price": lpp,
            "estimated_cost": estimated_cost,
            "price_diff": price_diff,
            "remark": l.line_remark or "",
        })
    # Sort by brand, then item_code
    lines_out.sort(key=lambda x: (x["brand"], x["item_code"]))
    base["notes"] = o.notes
    base["lines"] = lines_out
    base["total_estimated_cost"] = round(sum(l["estimated_cost"] for l in lines_out), 2)
    base["price_diff_count"] = sum(1 for l in lines_out if l["price_diff"] is not None and abs(l["price_diff"]) > 0.01)
    base["next_status"] = _next_status(o.status)
    base["next_status_label"] = STATUS_LABEL.get(_next_status(o.status) or "", "")

    # Brand-vehicle assignments
    bvs = db.query(PurchaseOrderBrandVehicle).filter(
        PurchaseOrderBrandVehicle.purchase_order_id == o.id
    ).all()
    bv_out = []
    for bv in bvs:
        vehicle = db.query(Vehicle).filter(Vehicle.id == bv.vehicle_id).first() if bv.vehicle_id else None
        bv_out.append({
            "brand": bv.brand,
            "vehicle_id": bv.vehicle_id,
            "vehicle_name": f"{vehicle.name} ({vehicle.plate})" if vehicle else None,
        })
    base["brand_vehicles"] = bv_out

    # Extra lines (supplier-added items not in product catalog)
    base["extra_lines"] = [{
        "id": el.id,
        "brand": el.brand,
        "name": el.name,
        "item_code": el.item_code,
        "warehouse_name": el.warehouse_name,
        "unit_weight": el.unit_weight,
        "pack_ratio": el.pack_ratio,
        "qty_box": el.qty_box,
        "computed_weight": el.computed_weight,
    } for el in o.extra_lines]

    return base


# ── Endpoints ──────────────────────────────────────────────────────────────────

class POCreateIn(BaseModel):
    order_date: date_type
    notes: str = ""


class POLineIn(BaseModel):
    product_id: int
    order_qty_box: float
    supplier_qty_box: Optional[float] = None
    loaded_qty_box: Optional[float] = None
    received_qty_box: Optional[float] = None
    unit_price: Optional[float] = None
    remark: Optional[str] = None


class AddLineIn(BaseModel):
    product_id: int
    order_qty_box: float = 1.0


class POVehicleIn(BaseModel):
    vehicle_id: Optional[int] = None


@router.patch("/{order_id}/vehicle")
def set_order_vehicle(
    order_id: int,
    body: POVehicleIn,
    db: Session = Depends(get_db),
    u=Depends(require_role("admin", "manager")),
):
    o = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not o:
        raise HTTPException(404, "Order not found")
    if body.vehicle_id is not None:
        v = db.query(Vehicle).filter(Vehicle.id == body.vehicle_id, Vehicle.is_active == True).first()
        if not v:
            raise HTTPException(400, "Vehicle not found")
    o.vehicle_id = body.vehicle_id
    db.commit()
    vehicle = db.query(Vehicle).filter(Vehicle.id == o.vehicle_id).first() if o.vehicle_id else None
    return {
        "vehicle_id": o.vehicle_id,
        "vehicle_name": f"{vehicle.name} ({vehicle.plate})" if vehicle else None,
    }


@router.get("/dashboard-stats")
def purchase_order_dashboard_stats(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Хяналтын самбарт харуулах захиалгын хураангуй статистик."""
    orders = db.query(PurchaseOrder).order_by(PurchaseOrder.order_date.desc()).all()

    by_status: dict[str, int] = {s: 0 for s in STATUS_SEQUENCE}
    active_weight = 0.0
    active_boxes = 0.0
    transit_weight = 0.0
    transit_boxes = 0.0
    latest_active: Optional[dict] = None

    for o in orders:
        by_status[o.status] = by_status.get(o.status, 0) + 1
        order_weight = sum(l.computed_weight for l in o.lines)
        order_boxes  = sum(l.order_qty_box for l in o.lines)
        if o.status != "arrived":
            active_weight += order_weight
            active_boxes  += order_boxes
        if o.status == "transit":
            transit_weight += order_weight
            transit_boxes  += order_boxes
        # Most recent non-arrived order
        if latest_active is None and o.status != "arrived":
            latest_active = {
                "id": o.id,
                "order_date": o.order_date.isoformat(),
                "status": o.status,
                "status_label": STATUS_LABEL.get(o.status, o.status),
                "total_weight": round(order_weight, 2),
                "total_boxes":  round(order_boxes, 0),
            }

    active_count = sum(v for k, v in by_status.items() if k != "arrived")

    return {
        "total":          len(orders),
        "active":         active_count,
        "arrived":        by_status.get("arrived", 0),
        "by_status":      by_status,
        "active_weight":  round(active_weight, 2),
        "active_boxes":   round(active_boxes, 0),
        "transit_weight": round(transit_weight, 2),
        "transit_boxes":  round(transit_boxes, 0),
        "latest_active":  latest_active,
    }


@router.get("/master-check")
def master_check(_=Depends(get_current_user)):
    """Check if master_latest.xlsx exists."""
    exists = MASTER_FILE.exists()
    updated_at = None
    if exists:
        import os
        ts = os.path.getmtime(MASTER_FILE)
        from datetime import datetime, timezone
        updated_at = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    return {"exists": exists, "updated_at": updated_at}


@router.get("")
def list_purchase_orders(
    status: Optional[str] = Query(None),
    date_from: Optional[date_type] = Query(None),
    date_to: Optional[date_type] = Query(None),
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    q = db.query(PurchaseOrder)

    # warehouse_clerk sees preparing and arrived orders
    if u.role == "warehouse_clerk":
        q = q.filter(PurchaseOrder.status.in_(["preparing", "arrived"]))
    # manager/supervisor/admin see all

    if status:
        q = q.filter(PurchaseOrder.status == status)
    if date_from:
        q = q.filter(PurchaseOrder.order_date >= date_from)
    if date_to:
        q = q.filter(PurchaseOrder.order_date <= date_to)

    orders = q.order_by(PurchaseOrder.order_date.desc()).all()
    return [_serialize_order(o, db) for o in orders]


@router.post("")
def create_purchase_order(
    body: POCreateIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("manager", "admin", "supervisor")),
):
    # Check master file exists
    if not MASTER_FILE.exists():
        raise HTTPException(
            400,
            "Master Excel файл байхгүй байна. Эхлээд Мастер нэгтгэл хийнэ үү."
        )

    # Check duplicate for this user on this date
    existing = db.query(PurchaseOrder).filter(
        PurchaseOrder.created_by_user_id == u.id,
        PurchaseOrder.order_date == body.order_date,
    ).first()
    if existing:
        raise HTTPException(
            400,
            f"{body.order_date} өдрийн захиалга аль хэдийн үүссэн байна (#{existing.id})."
        )

    # Create order
    po = PurchaseOrder(
        order_date=body.order_date,
        status="preparing",
        created_by_user_id=u.id,
        notes=body.notes,
    )
    db.add(po)
    db.flush()

    # Load all products for the user's warehouses.
    # Products with warehouse_tag_id=0 are treated as shared (visible to all).
    tag_ids = parse_tag_ids(u.tag_ids)
    if not tag_ids:
        # Admin/supervisor with no tag_ids — load all products
        products = db.query(Product).order_by(Product.brand, Product.item_code).all()
    else:
        products = (
            db.query(Product)
            .filter(Product.warehouse_tag_id.in_(tag_ids + [0]))
            .order_by(Product.brand, Product.item_code)
            .all()
        )

    for p in products:
        db.add(PurchaseOrderLine(
            purchase_order_id=po.id,
            product_id=p.id,
            order_qty_box=0.0,
            order_qty_pcs=0.0,
            computed_weight=0.0,
        ))

    db.commit()
    db.refresh(po)
    return {"id": po.id, "ok": True, "line_count": len(products)}


@router.get("/pdf-templates")
def get_pdf_templates_early(_=Depends(get_current_user)):
    """Alias placed before /{order_id} so the path is not consumed as an int param."""
    return PDF_TEMPLATES


@router.get("/shipments/by-status")
def list_shipments_by_status(
    status: str = Query(...),
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Бүх захиалгын shipment-уудыг shipment.status-аар шүүж, vehicle_id-аар групплэн буцаана.

    PO status биш SHIPMENT status-аар шүүдэг тул нэг захиалгын зарим машин
    замд явж байхад бусад нь ачигдсаар байж болно.
    Ижил machine дээр олон захиалгын shipment байвал нэг vehicle group дотор нэгтгэнэ.
    """
    # warehouse_clerk зөвхөн "arrived" харна
    if u.role == "warehouse_clerk" and status != "arrived":
        return []

    shipments = (
        db.query(POShipment)
        .filter(POShipment.status == status)
        .order_by(POShipment.created_at.desc())
        .all()
    )

    # Vehicle-аар групплэх
    vehicle_groups: dict[int | None, list] = {}
    for sh in shipments:
        po = db.query(PurchaseOrder).filter(PurchaseOrder.id == sh.purchase_order_id).first()
        if not po:
            continue
        data = _serialize_shipment(sh, db)
        data["order_date"] = po.order_date.isoformat() if po.order_date else None
        data["order_status"] = po.status

        vid = sh.vehicle_id
        if vid not in vehicle_groups:
            vehicle_groups[vid] = []
        vehicle_groups[vid].append(data)

    result = []
    for vid, ship_list in vehicle_groups.items():
        # Vehicle мэдээлэл
        vehicle = db.query(Vehicle).filter(Vehicle.id == vid).first() if vid else None
        all_brands: set[str] = set()
        order_ids: set[int] = set()
        total_loaded = 0.0
        total_received = 0.0
        total_weight = 0.0
        total_lines = 0
        for s in ship_list:
            total_loaded += s.get("total_loaded_box", 0)
            total_received += s.get("total_received_box", 0)
            total_weight += s.get("total_weight", 0)
            total_lines += s.get("line_count", 0)
            all_brands.update(s.get("brands", []))
            order_ids.add(s["purchase_order_id"])

        result.append({
            "vehicle_id": vid,
            "vehicle_name": f"{vehicle.name} ({vehicle.plate})" if vehicle else None,
            "driver_name": vehicle.driver_name if vehicle else None,
            "shipments": ship_list,
            "shipment_count": len(ship_list),
            "order_count": len(order_ids),
            "order_ids": sorted(order_ids),
            "total_loaded_box": round(total_loaded, 1),
            "total_received_box": round(total_received, 1),
            "total_weight": round(total_weight, 1),
            "total_lines": total_lines,
            "brands": sorted(all_brands),
        })

    # Нийт жингээр буурахаар эрэмбэлэх
    result.sort(key=lambda x: x["total_weight"], reverse=True)
    return result


@router.get("/{order_id}")
def get_purchase_order(
    order_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")

    # warehouse_clerk can only see preparing and arrived orders
    if u.role == "warehouse_clerk" and po.status not in ("preparing", "arrived"):
        raise HTTPException(403, "Энэ захиалгыг харах эрх байхгүй")

    # warehouse_clerk sees only products from their assigned warehouses
    filter_tag_ids = parse_tag_ids(u.tag_ids) if u.role == "warehouse_clerk" else None
    return _serialize_order_detail(po, db, filter_tag_ids=filter_tag_ids)


@router.patch("/{order_id}/status")
def advance_status(
    order_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")

    next_st = _next_status(po.status)
    if not next_st:
        raise HTTPException(400, "Захиалга эцсийн статуст хүрсэн байна")

    # accountant: accounting → confirmed, confirmed → received
    allowed_roles = ["manager", "supervisor", "admin"]
    if po.status in ("accounting", "confirmed"):
        allowed_roles.append("accountant")
    if u.role not in allowed_roles:
        raise HTTPException(403, "Энэ үйлдлийг хийх эрх байхгүй")

    # When advancing arrived → accounting, pre-fill unit_price from last_purchase_price
    if po.status == "arrived" and next_st == "accounting":
        product_ids = [l.product_id for l in po.lines]
        products = db.query(Product).filter(Product.id.in_(product_ids)).all()
        pmap = {p.id: p for p in products}
        for line in po.lines:
            p = pmap.get(line.product_id)
            if p and (line.unit_price or 0) == 0.0 and (p.last_purchase_price or 0) > 0:
                line.unit_price = float(p.last_purchase_price)

    po.status = next_st
    db.commit()
    return {
        "ok": True,
        "new_status": next_st,
        "new_status_label": STATUS_LABEL.get(next_st, next_st),
    }


class ForceStatusIn(BaseModel):
    status: str

@router.patch("/{order_id}/force-status")
def force_status(
    order_id: int,
    body: ForceStatusIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    if body.status not in STATUS_SEQUENCE:
        raise HTTPException(400, "Буруу статус")
    po.status = body.status
    db.commit()
    return {"ok": True, "new_status": po.status, "new_status_label": STATUS_LABEL.get(po.status, po.status)}


@router.post("/{order_id}/set-lines")
def set_lines(
    order_id: int,
    lines: List[POLineIn],
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    # warehouse_clerk — preparing + arrived; accountant — accounting; admin — all editable; manager/supervisor — preparing, reviewing, loading
    if u.role == "warehouse_clerk":
        allowed_statuses = ["preparing", "arrived"]
    elif u.role == "accountant":
        allowed_statuses = ["accounting"]
    elif u.role == "admin":
        allowed_statuses = ["preparing", "reviewing", "loading", "arrived", "accounting"]
    else:
        allowed_statuses = ["preparing", "reviewing", "loading"]
    if po.status not in allowed_statuses:
        raise HTTPException(400, "Энэ статуст тоо өөрчлөх боломжгүй")

    # Permission check
    if u.role not in ("manager", "warehouse_clerk", "admin", "supervisor", "accountant"):
        raise HTTPException(403, "Энэ үйлдлийг хийх эрх байхгүй")

    # warehouse_clerk restricted to their assigned warehouses
    clerk_tag_ids = parse_tag_ids(u.tag_ids) if u.role == "warehouse_clerk" else None

    # Build lookup map for existing lines
    line_map = {l.product_id: l for l in po.lines}

    for li in lines:
        if li.product_id not in line_map:
            continue
        p = db.query(Product).filter(Product.id == li.product_id).first()
        if not p:
            continue
        # Clerk cannot update products outside their warehouses.
        # Products with warehouse_tag_id=0 are shared — editable by anyone.
        if clerk_tag_ids and p.warehouse_tag_id != 0 and p.warehouse_tag_id not in clerk_tag_ids:
            continue
        line = line_map[li.product_id]
        if po.status == "arrived":
            # Warehouse clerk enters received qty only
            if li.received_qty_box is not None:
                line.received_qty_box = float(li.received_qty_box)
            if li.remark is not None:
                line.line_remark = li.remark
        elif po.status == "accounting":
            # Accountant edits unit_price (and may fix received qty / remark)
            if li.unit_price is not None:
                line.unit_price = float(li.unit_price)
            if li.received_qty_box is not None:
                line.received_qty_box = float(li.received_qty_box)
            if li.remark is not None:
                line.line_remark = li.remark
        else:
            # preparing / reviewing / loading — update order qty + derived fields
            qty_box = float(li.order_qty_box or 0)
            qty_pcs = qty_box * float(p.pack_ratio or 1)
            weight = qty_pcs * float(p.unit_weight or 0)
            line.order_qty_box = qty_box
            line.order_qty_pcs = qty_pcs
            line.computed_weight = weight
            if po.status == "loading":
                if li.supplier_qty_box is not None:
                    line.supplier_qty_box = float(li.supplier_qty_box)
                if li.loaded_qty_box is not None:
                    line.loaded_qty_box = float(li.loaded_qty_box)

    db.commit()
    return {"ok": True}


@router.delete("/{order_id}")
def delete_order(
    order_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    # Delete brand-vehicle assignments first (no cascade on this model)
    db.query(PurchaseOrderBrandVehicle).filter(
        PurchaseOrderBrandVehicle.purchase_order_id == order_id
    ).delete(synchronize_session=False)
    db.delete(po)
    db.commit()
    return {"ok": True}


@router.delete("/{order_id}/lines/{line_id}")
def delete_line(
    order_id: int,
    line_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("manager", "admin", "supervisor")),
):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    if po.status != "loading":
        raise HTTPException(400, "Зөвхөн 'Ачигдаж байна' статуст мөр устгах боломжтой")
    line = db.query(PurchaseOrderLine).filter(
        PurchaseOrderLine.id == line_id,
        PurchaseOrderLine.purchase_order_id == order_id,
    ).first()
    if not line:
        raise HTTPException(404, "Мөр олдсонгүй")
    db.delete(line)
    db.commit()
    return {"ok": True}


@router.post("/{order_id}/add-line")
def add_line(
    order_id: int,
    body: AddLineIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("manager", "admin", "supervisor")),
):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    if po.status not in ("preparing", "loading"):
        raise HTTPException(400, "Энэ статуст бараа нэмэх боломжгүй")
    p = db.query(Product).filter(Product.id == body.product_id).first()
    if not p:
        raise HTTPException(404, "Бараа олдсонгүй")
    existing = next((l for l in po.lines if l.product_id == body.product_id), None)
    if existing:
        raise HTTPException(400, "Бараа аль хэдийн нэмэгдсэн байна")
    qty_box = float(body.order_qty_box or 0)
    qty_pcs = qty_box * float(p.pack_ratio or 1)
    weight = qty_pcs * float(p.unit_weight or 0)
    line = PurchaseOrderLine(
        purchase_order_id=order_id,
        product_id=body.product_id,
        order_qty_box=qty_box,
        order_qty_pcs=qty_pcs,
        computed_weight=weight,
    )
    db.add(line)
    db.commit()
    return {"ok": True}


class BrandVehicleIn(BaseModel):
    brand: str
    vehicle_id: Optional[int] = None


@router.post("/{order_id}/brand-vehicles")
def set_brand_vehicles(
    order_id: int,
    items: List[BrandVehicleIn],
    db: Session = Depends(get_db),
    u: User = Depends(require_role("manager", "admin", "supervisor")),
):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")

    for item in items:
        existing = db.query(PurchaseOrderBrandVehicle).filter(
            PurchaseOrderBrandVehicle.purchase_order_id == order_id,
            PurchaseOrderBrandVehicle.brand == item.brand,
        ).first()
        if item.vehicle_id is None:
            if existing:
                db.delete(existing)
        elif existing:
            existing.vehicle_id = item.vehicle_id
        else:
            db.add(PurchaseOrderBrandVehicle(
                purchase_order_id=order_id,
                brand=item.brand,
                vehicle_id=item.vehicle_id,
            ))
    db.commit()
    return {"ok": True}


@router.post("/{order_id}/revert")
def revert_to_arrived(
    order_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("accountant", "supervisor", "admin")),
):
    """Нягтлан шалгаж байна → Ачаа ирсэн руу буцаана."""
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    if po.status != "accounting":
        raise HTTPException(400, "Зөвхөн 'Нягтлан шалгаж байна' статусаас буцаах боломжтой")
    po.status = "arrived"
    db.commit()
    return {"ok": True, "new_status": "arrived", "new_status_label": STATUS_LABEL["arrived"]}


@router.get("/{order_id}/export-excel")
def export_excel(
    order_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("accountant", "supervisor", "admin")),
):
    """Нягтлан Баталгаажсан — Excel файл татах."""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter

    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")

    product_ids = [l.product_id for l in po.lines]
    products = db.query(Product).filter(Product.id.in_(product_ids)).all()
    product_map = {p.id: p for p in products}

    wb = Workbook()
    ws = wb.active
    ws.title = f"Захиалга {po.order_date}"

    # Header row
    headers = [
        "Брэнд", "Код", "Нэр", "Агуулах",
        "Захиалах тоо", "Нийлүүлэгч бэлдсэн", "Ачигдсан тоо", "Ирсэн тоо", "Зөрүү"
    ]
    header_fill = PatternFill("solid", fgColor="3258A0")
    header_font = Font(color="FFFFFF", bold=True)
    for ci, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=ci, value=h)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center")

    # Data rows sorted by brand, item_code
    lines_data = []
    for l in po.lines:
        p = product_map.get(l.product_id)
        if not p or l.order_qty_box <= 0:
            continue
        diff = round((l.loaded_qty_box or 0) - (l.received_qty_box or 0), 2)
        lines_data.append([
            p.brand or "", p.item_code, p.name, p.warehouse_name or "",
            l.order_qty_box, l.supplier_qty_box, l.loaded_qty_box, l.received_qty_box, diff,
        ])
    lines_data.sort(key=lambda x: (x[0], x[1]))

    for ri, row in enumerate(lines_data, 2):
        for ci, val in enumerate(row, 1):
            ws.cell(row=ri, column=ci, value=val)

    # Column widths
    for ci, w in enumerate([18, 14, 35, 14, 14, 18, 14, 12, 10], 1):
        ws.column_dimensions[get_column_letter(ci)].width = w

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    filename = f"order_{po.order_date.strftime('%Y%m%d')}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ── ERP Import Excel Export ────────────────────────────────────────────────────

class ERPExcelConfigIn(BaseModel):
    company: str                     # "buten_orgil" | "orgil_khorum"
    date: str                        # "YYYY-MM-DD"
    document_note: str = ""          # Гүйлгээний утга
    related_account: str = ""        # Харьцсан данс (e.g. 310101)
    account: str = ""                # Данс (e.g. 150101)
    warehouse_map: dict = {}         # buten_orgil: {warehouse_name: erp_location_code}
    single_location: str = ""        # orgil_khorum: single location code


@router.post("/{order_id}/export-erp-excel")
def export_erp_excel(
    order_id: int,
    body: ERPExcelConfigIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "manager", "accountant", "supervisor")),
):
    """ERP-д импортлох Excel файл үүсгэх (confirmed статус)."""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
    from datetime import datetime as dt_cls

    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")

    product_ids = [l.product_id for l in po.lines]
    products = db.query(Product).filter(Product.id.in_(product_ids)).all()
    product_map = {p.id: p for p in products}

    # Parse date
    try:
        date_val = dt_cls.strptime(body.date, "%Y-%m-%d").date()
    except Exception:
        date_val = po.order_date

    wb = Workbook()
    ws = wb.active
    ws.title = "Import"

    # ── Column headers (row 1) ──
    col_headers = [
        "Огноо", "Баримтын дугаар", "Гүйлгээний утга", "Харилцагч",
        "Харьцсан данс", "Харьцсан ялгаатай харилцагч",
        "НӨАТ тай эсэх", "НӨАТ-н үзүүлэлт", "НӨАТ автоматаар бодох эсэх", "НӨАТ-н дүн",
        "НХАТ тай эсэх", "НХАТ автоматаар бодох эсэх", "НХАТ-н дүн",
        "Данс", "Бараа материал", "Барааны байршил",
        "Тоо хэмжээ", "Нэгж үнэ", "Хувийн жин", "Нийт дүн",
        "НӨАТ тооцох эсэх", "НХАТ тооцох эсэх", "НХАТ мөр",
    ]
    hdr_fill = PatternFill("solid", fgColor="3258A0")
    hdr_font = Font(color="FFFFFF", bold=True)
    for ci, h in enumerate(col_headers, 1):
        c = ws.cell(row=1, column=ci, value=h)
        c.fill = hdr_fill
        c.font = hdr_font
        c.alignment = Alignment(horizontal="center")

    # ── Build data rows ──
    # Only lines with received_qty_box > 0, sorted by brand then item_code
    valid = []
    for line in po.lines:
        if not (line.received_qty_box and line.received_qty_box > 0):
            continue
        p = product_map.get(line.product_id)
        if not p:
            continue
        if body.company == "orgil_khorum":
            location = body.single_location
        else:
            location = body.warehouse_map.get(p.warehouse_name, "")
        qty   = line.received_qty_box
        price = line.unit_price or 0.0
        total = round(qty * price, 2)
        valid.append((p.brand or "", p.item_code, p, line, location, qty, price, total))

    # Sort by brand_code then item_code so same-supplier items are grouped
    valid.sort(key=lambda x: (x[2].brand_code or "", x[0], x[1]))

    # ── Group by brand_code — one ERP document block per supplier ──
    from collections import defaultdict
    groups: dict = defaultdict(list)
    for item in valid:
        groups[item[2].brand_code or ""].append(item)

    current_row = 2
    for supplier_code, items in groups.items():
        for i, (brand, item_code, p, line, location, qty, price, total) in enumerate(items):
            is_first = (i == 0)
            row = [
                date_val if is_first else None,            # Огноо
                None,                                       # Баримтын дугаар
                body.document_note if is_first else None,  # Гүйлгээний утга
                supplier_code if is_first else None,                    # Харилцагч (brand_code-оос)
                body.related_account if is_first else None, None,      # Харьцсан данс, Харьцсан ялгаатай
                0 if is_first else None,                   # НӨАТ тай эсэх
                None, None,                                 # НӨАТ-н үзүүлэлт, автоматаар
                0 if is_first else None,                   # НӨАТ-н дүн
                0 if is_first else None,                   # НХАТ тай эсэх
                None,                                       # НХАТ автоматаар
                0 if is_first else None,                   # НХАТ-н дүн
                body.account,                               # Данс*
                p.item_code,                                # Бараа материал*
                location,                                   # Барааны байршил*
                qty,                                        # Тоо хэмжээ*
                price,                                      # Нэгж үнэ*
                1.0,                                        # Хувийн жин* (тогтмол)
                total,                                      # Нийт дүн*
                0,                                          # НӨАТ тооцох эсэх*
                0,                                          # НХАТ тооцох эсэх*
                None,                                       # НХАТ мөр
            ]
            for ci, val in enumerate(row, 1):
                ws.cell(row=current_row, column=ci, value=val)
            current_row += 1

    # ── Column widths ──
    widths = [14, 16, 28, 14, 14, 20, 14, 18, 22, 12, 14, 22, 12,
              16, 18, 20, 12, 12, 12, 14, 18, 18, 12]
    for ci, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(ci)].width = w

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    filename = f"erp_import_{po.order_date.strftime('%Y%m%d')}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ── PDF Export ─────────────────────────────────────────────────────────────────

FONT_REGULAR = "C:/Windows/Fonts/arial.ttf"
FONT_BOLD    = "C:/Windows/Fonts/arialbd.ttf"

# Default template data (user edits these in the modal)
PDF_TEMPLATES = {
    "buten_orgil": {
        "company_name": "Бүтэн-Оргил ХХК",
        "address": "Улаанбаатар хот, ...",
        "phone": "...",
        "truck_location": "",
        "driver": "",
    },
    "orgil_khorum": {
        "company_name": "Оргил-Хорум ХХК",
        "address": "Улаанбаатар хот, ...",
        "phone": "...",
        "truck_location": "",
        "driver": "",
    },
}


class PDFHeaderIn(BaseModel):
    company_name: str
    address: str = ""
    phone: str = ""
    truck_location: str = ""
    driver: str = ""
    extra_note: str = ""
    brand_filter: str = ""  # хоосон бол бүх брэнд


def _build_pdf(po: PurchaseOrder, body: PDFHeaderIn, db: Session) -> bytes:
    from fpdf import FPDF
    from datetime import datetime

    generated_at = datetime.now().strftime("%Y/%m/%d %H:%M")

    # Gather lines with qty > 0, grouped by brand
    product_ids = [l.product_id for l in po.lines]
    products = db.query(Product).filter(Product.id.in_(product_ids)).all()
    product_map = {p.id: p for p in products}

    grouped: dict[str, list[dict]] = {}
    total_boxes = 0.0
    total_weight = 0.0
    brand_filter = (body.brand_filter or "").strip()
    for l in po.lines:
        if l.order_qty_box <= 0:
            continue
        p = product_map.get(l.product_id)
        if not p:
            continue
        brand_raw = (p.brand or "").strip()
        brand = brand_raw if brand_raw and brand_raw.lower() != "nan" else "Брэнд байхгүй"
        # брэнд шүүлт хэрэглэгдсэн бол зөвхөн тухайн брэнд
        if brand_filter and brand != brand_filter:
            continue
        grouped.setdefault(brand, []).append({
            "item_code": p.item_code,
            "name": p.name,
            "warehouse_name": p.warehouse_name or "",
            "qty_box": l.order_qty_box,
            "qty_pcs": l.order_qty_pcs,
            "weight": l.computed_weight,
        })
        total_boxes += l.order_qty_box
        total_weight += l.computed_weight

    # Extra lines — same brand group as regular lines
    for el in po.extra_lines:
        if el.qty_box <= 0:
            continue
        el_brand = (el.brand or "").strip() or "Нэмэлт бараа"
        if brand_filter and el_brand != brand_filter:
            continue
        grouped.setdefault(el_brand, []).append({
            "item_code": el.item_code or "—",
            "name": f"★ {el.name}",
            "warehouse_name": el.warehouse_name,
            "qty_box": el.qty_box,
            "qty_pcs": el.qty_box * el.pack_ratio,
            "weight": el.computed_weight,
        })
        total_boxes += el.qty_box
        total_weight += el.computed_weight

    # Sort brands and lines within each brand
    sorted_brands = sorted(grouped.keys())
    for brand in sorted_brands:
        grouped[brand].sort(key=lambda x: x["item_code"])

    pdf = FPDF(orientation="P", unit="mm", format="A4")
    pdf.add_font("Arial", fname=FONT_REGULAR)
    pdf.add_font("Arial", style="B", fname=FONT_BOLD)
    pdf.set_margins(12, 12, 12)
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    # Page usable width: 210 - 24 = 186mm
    W = pdf.w - pdf.l_margin - pdf.r_margin  # ~186

    # ── Company header ──────────────────────────────────────────
    pdf.set_font("Arial", style="B", size=15)
    pdf.cell(0, 9, body.company_name, new_x="LMARGIN", new_y="NEXT", align="C")

    pdf.set_font("Arial", size=9)
    if body.address:
        pdf.cell(0, 5, f"Хаяг: {body.address}", new_x="LMARGIN", new_y="NEXT", align="C")
    if body.phone:
        pdf.cell(0, 5, f"Утас: {body.phone}", new_x="LMARGIN", new_y="NEXT", align="C")

    pdf.ln(2)
    pdf.line(pdf.l_margin, pdf.get_y(), pdf.w - pdf.r_margin, pdf.get_y())
    pdf.ln(3)

    # ── Order meta ──────────────────────────────────────────────
    pdf.set_font("Arial", style="B", size=10)
    date_str = po.order_date.strftime("%Y/%m/%d")
    pdf.cell(W / 2, 6, f"Захиалга: {date_str}", new_x="RIGHT", new_y="TOP")
    pdf.cell(W / 2, 6, f"Статус: {STATUS_LABEL.get(po.status, po.status)}", new_x="LMARGIN", new_y="NEXT", align="R")

    pdf.set_font("Arial", size=9)
    if body.truck_location:
        pdf.cell(0, 5, f"Ачигдах байршил: {body.truck_location}", new_x="LMARGIN", new_y="NEXT")
    if body.driver:
        pdf.cell(0, 5, f"Жолооч / Машин: {body.driver}", new_x="LMARGIN", new_y="NEXT")
    if body.extra_note:
        pdf.set_font("Arial", style="B", size=9)
        pdf.cell(0, 5, f"Тэмдэглэл: {body.extra_note}", new_x="LMARGIN", new_y="NEXT")

    pdf.ln(3)

    # ── Table ───────────────────────────────────────────────────
    # Column widths (total = W ~186)
    COL_CODE = 22
    COL_NAME = 68
    COL_WH   = 30
    COL_BOX  = 20
    COL_PCS  = 18
    COL_KG   = W - COL_CODE - COL_NAME - COL_WH - COL_BOX - COL_PCS  # remainder

    def tbl_header():
        pdf.set_font("Arial", style="B", size=8)
        pdf.set_fill_color(50, 90, 160)
        pdf.set_text_color(255, 255, 255)
        ROW_H = 7
        pdf.cell(COL_CODE, ROW_H, "Код",      border=0, align="C", fill=True)
        pdf.cell(COL_NAME, ROW_H, "Нэр",      border=0, align="L", fill=True)
        pdf.cell(COL_WH,   ROW_H, "Агуулах",  border=0, align="C", fill=True)
        pdf.cell(COL_BOX,  ROW_H, "Хайрцаг",  border=0, align="C", fill=True)
        pdf.cell(COL_PCS,  ROW_H, "Ш",        border=0, align="C", fill=True)
        pdf.cell(COL_KG,   ROW_H, "Жин (кг)", border=0, align="C", fill=True, new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(0, 0, 0)

    tbl_header()
    ROW_H = 6

    for bi, brand in enumerate(sorted_brands):
        lines = grouped[brand]
        # Brand row
        pdf.set_font("Arial", style="B", size=8)
        pdf.set_fill_color(220, 230, 245)
        pdf.cell(W, ROW_H, f"  {brand}", border=0, align="L", fill=True, new_x="LMARGIN", new_y="NEXT")

        # Product rows
        pdf.set_font("Arial", size=8)
        for ri, row in enumerate(lines):
            fill = (ri % 2 == 1)
            if fill:
                pdf.set_fill_color(245, 247, 252)
            else:
                pdf.set_fill_color(255, 255, 255)

            pdf.cell(COL_CODE, ROW_H, row["item_code"],             border=0, align="C", fill=True)
            pdf.cell(COL_NAME, ROW_H, row["name"],                  border=0, align="L", fill=True)
            pdf.cell(COL_WH,   ROW_H, row["warehouse_name"],        border=0, align="C", fill=True)
            pdf.cell(COL_BOX,  ROW_H, f"{row['qty_box']:.0f}",      border=0, align="C", fill=True)
            pdf.cell(COL_PCS,  ROW_H, f"{row['qty_pcs']:.0f}",      border=0, align="C", fill=True)
            pdf.cell(COL_KG,   ROW_H, f"{row['weight']:.2f}",       border=0, align="R", fill=True, new_x="LMARGIN", new_y="NEXT")

    # ── Totals row ──────────────────────────────────────────────
    pdf.ln(1)
    pdf.set_font("Arial", style="B", size=9)
    pdf.set_fill_color(50, 90, 160)
    pdf.set_text_color(255, 255, 255)
    label_w = COL_CODE + COL_NAME + COL_WH
    pdf.cell(label_w, 7, "Нийт дүн", border=0, align="R", fill=True)
    pdf.cell(COL_BOX, 7, f"{total_boxes:.0f}", border=0, align="C", fill=True)
    pdf.cell(COL_PCS, 7, "", border=0, fill=True)
    pdf.cell(COL_KG,  7, f"{total_weight:.2f}", border=0, align="R", fill=True, new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(0, 0, 0)

    # ── Timestamp footer (last line of content) ─────────────────
    pdf.ln(3)
    pdf.set_font("Arial", size=7)
    pdf.set_text_color(150, 150, 150)
    pdf.cell(0, 5, f"Бэлдсэн: {generated_at}", align="R")
    pdf.set_text_color(0, 0, 0)

    return bytes(pdf.output())


# ── Extra lines (supplier-added items not in product catalog) ──────────────────

class ExtraLineIn(BaseModel):
    brand: str = ""
    name: str
    item_code: str = ""
    warehouse_name: str = ""
    unit_weight: float = 0.0
    pack_ratio: float = 1.0
    qty_box: float = 0.0


def _extra_line_access(order_id: int, db: Session, u: User) -> PurchaseOrder:
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    if po.status != "loading":
        raise HTTPException(400, "Зөвхөн 'Ачигдаж байна' статуст нэмэлт мөр засах боломжтой")
    if u.role not in ("manager", "admin", "supervisor"):
        raise HTTPException(403, "Эрх хүрэлцэхгүй")
    return po


@router.post("/{order_id}/extra-lines")
def add_extra_line(
    order_id: int,
    body: ExtraLineIn,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    po = _extra_line_access(order_id, db, u)
    el = OrderExtraLine(
        purchase_order_id=po.id,
        brand=body.brand.strip(),
        name=body.name.strip(),
        item_code=body.item_code.strip(),
        warehouse_name=body.warehouse_name.strip(),
        unit_weight=body.unit_weight,
        pack_ratio=body.pack_ratio,
        qty_box=body.qty_box,
        computed_weight=round(body.qty_box * body.pack_ratio * body.unit_weight, 4),
    )
    db.add(el)
    db.commit()
    db.refresh(el)
    return {"id": el.id, "computed_weight": el.computed_weight}


@router.put("/{order_id}/extra-lines/{extra_id}")
def update_extra_line(
    order_id: int,
    extra_id: int,
    body: ExtraLineIn,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    po = _extra_line_access(order_id, db, u)
    el = db.query(OrderExtraLine).filter(
        OrderExtraLine.id == extra_id,
        OrderExtraLine.purchase_order_id == po.id,
    ).first()
    if not el:
        raise HTTPException(404, "Мөр олдсонгүй")
    el.brand = body.brand.strip()
    el.name = body.name.strip()
    el.item_code = body.item_code.strip()
    el.warehouse_name = body.warehouse_name.strip()
    el.unit_weight = body.unit_weight
    el.pack_ratio = body.pack_ratio
    el.qty_box = body.qty_box
    el.computed_weight = round(body.qty_box * body.pack_ratio * body.unit_weight, 4)
    db.commit()
    return {"id": el.id, "computed_weight": el.computed_weight}


@router.delete("/{order_id}/extra-lines/{extra_id}")
def delete_extra_line(
    order_id: int,
    extra_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    po = _extra_line_access(order_id, db, u)
    el = db.query(OrderExtraLine).filter(
        OrderExtraLine.id == extra_id,
        OrderExtraLine.purchase_order_id == po.id,
    ).first()
    if not el:
        raise HTTPException(404, "Мөр олдсонгүй")
    db.delete(el)
    db.commit()
    return {"ok": True}


@router.post("/{order_id}/export-pdf")
def export_pdf(
    order_id: int,
    body: PDFHeaderIn,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")

    pdf_bytes = _build_pdf(po, body, db)
    filename = f"order_{po.order_date.strftime('%Y%m%d')}.pdf"
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ══════════════════════════════════════════════════════════════════════════════
# Shipment (машинаар ачилт) endpoints
# ══════════════════════════════════════════════════════════════════════════════

SHIPMENT_STATUS_SEQ = ["loading", "transit", "arrived", "accounting", "confirmed", "received"]
SHIPMENT_STATUS_LABEL = {
    "loading":    "Ачигдаж байна",
    "transit":    "Замд явж байна",
    "arrived":    "Ачаа ирсэн",
    "accounting": "Нягтлан шалгаж байна",
    "confirmed":  "Баталгаажсан",
    "received":   "Орлого авагдсан",
}


def _serialize_shipment(sh: POShipment, db: Session) -> dict:
    vehicle = db.query(Vehicle).filter(Vehicle.id == sh.vehicle_id).first() if sh.vehicle_id else None
    lines = db.query(POShipmentLine).filter(POShipmentLine.shipment_id == sh.id).all()

    total_loaded = sum(sl.loaded_qty_box for sl in lines)
    total_received = sum(sl.received_qty_box for sl in lines)

    # Compute total weight from PO lines
    po_line_ids = [sl.po_line_id for sl in lines]
    total_weight = 0.0
    brands = set()
    if po_line_ids:
        po_lines = db.query(PurchaseOrderLine).filter(PurchaseOrderLine.id.in_(po_line_ids)).all()
        po_line_map = {pl.id: pl for pl in po_lines}
        prod_ids = [pl.product_id for pl in po_lines]
        prods = {p.id: p for p in db.query(Product).filter(Product.id.in_(prod_ids)).all()}
        for sl in lines:
            pl = po_line_map.get(sl.po_line_id)
            if not pl:
                continue
            p = prods.get(pl.product_id)
            if p:
                total_weight += sl.loaded_qty_box * float(p.pack_ratio or 1) * float(p.unit_weight or 0)
                brands.add(p.brand)

    return {
        "id": sh.id,
        "purchase_order_id": sh.purchase_order_id,
        "vehicle_id": sh.vehicle_id,
        "vehicle_name": f"{vehicle.name} ({vehicle.plate})" if vehicle else None,
        "status": sh.status,
        "status_label": SHIPMENT_STATUS_LABEL.get(sh.status, sh.status),
        "notes": sh.notes,
        "created_at": sh.created_at.isoformat() if sh.created_at else None,
        "line_count": len(lines),
        "total_loaded_box": total_loaded,
        "total_received_box": total_received,
        "total_weight": round(total_weight, 1),
        "brand_count": len(brands),
        "brands": sorted(brands),
    }


def _serialize_shipment_detail(sh: POShipment, db: Session) -> dict:
    """Shipment with full line details (for shipment detail page)."""
    base = _serialize_shipment(sh, db)
    lines = db.query(POShipmentLine).filter(POShipmentLine.shipment_id == sh.id).all()

    line_details = []
    for sl in lines:
        pl = db.query(PurchaseOrderLine).filter(PurchaseOrderLine.id == sl.po_line_id).first()
        if not pl:
            continue
        p = db.query(Product).filter(Product.id == pl.product_id).first()
        line_details.append({
            "id": sl.id,
            "po_line_id": sl.po_line_id,
            "product_id": pl.product_id,
            "item_code": p.item_code if p else "",
            "name": p.name if p else "",
            "brand": p.brand if p else "",
            "warehouse_name": p.warehouse_name if p else "",
            "unit_weight": float(p.unit_weight or 0) if p else 0,
            "pack_ratio": float(p.pack_ratio or 1) if p else 1,
            "order_qty_box": pl.order_qty_box,
            "loaded_qty_box": sl.loaded_qty_box,
            "received_qty_box": sl.received_qty_box,
            "computed_weight": round(sl.loaded_qty_box * float(p.pack_ratio or 1) * float(p.unit_weight or 0), 2) if p else 0,
        })
    base["lines"] = line_details
    return base


# ── List shipments for a PO ──────────────────────────────────────────────────

@router.get("/{order_id}/shipments")
def list_shipments(
    order_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    shipments = (
        db.query(POShipment)
        .filter(POShipment.purchase_order_id == order_id)
        .order_by(POShipment.id)
        .all()
    )

    # Also compute unassigned quantities per PO line
    # unassigned = order_qty_box - SUM(loaded_qty_box across all shipments)
    all_ship_lines = (
        db.query(POShipmentLine)
        .join(POShipment, POShipment.id == POShipmentLine.shipment_id)
        .filter(POShipment.purchase_order_id == order_id)
        .all()
    )
    assigned_map: dict[int, float] = {}  # po_line_id → total loaded
    for sl in all_ship_lines:
        assigned_map[sl.po_line_id] = assigned_map.get(sl.po_line_id, 0) + sl.loaded_qty_box

    unassigned_lines = []
    for pl in po.lines:
        if pl.order_qty_box <= 0:
            continue
        assigned = assigned_map.get(pl.id, 0)
        remaining = pl.order_qty_box - assigned
        if remaining > 0:
            p = db.query(Product).filter(Product.id == pl.product_id).first()
            unassigned_lines.append({
                "po_line_id": pl.id,
                "product_id": pl.product_id,
                "item_code": p.item_code if p else "",
                "name": p.name if p else "",
                "brand": p.brand if p else "",
                "warehouse_name": p.warehouse_name if p else "",
                "unit_weight": float(p.unit_weight or 0) if p else 0,
                "pack_ratio": float(p.pack_ratio or 1) if p else 1,
                "order_qty_box": pl.order_qty_box,
                "assigned_qty_box": assigned,
                "remaining_qty_box": remaining,
            })

    return {
        "shipments": [_serialize_shipment(s, db) for s in shipments],
        "unassigned_lines": unassigned_lines,
    }


# ── Create shipment ──────────────────────────────────────────────────────────

class CreateShipmentIn(BaseModel):
    vehicle_id: Optional[int] = None
    notes: str = ""

@router.post("/{order_id}/shipments")
def create_shipment(
    order_id: int,
    body: CreateShipmentIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    if po.status != "loading":
        raise HTTPException(400, "Зөвхөн 'Ачигдаж байна' статуст ачилт үүсгэх боломжтой")

    sh = POShipment(
        purchase_order_id=order_id,
        vehicle_id=body.vehicle_id,
        status="loading",
        notes=body.notes,
    )
    db.add(sh)
    db.commit()
    db.refresh(sh)
    return _serialize_shipment(sh, db)


# ── Get shipment detail ──────────────────────────────────────────────────────

@router.get("/{order_id}/shipments/{shipment_id}")
def get_shipment(
    order_id: int,
    shipment_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    sh = db.query(POShipment).filter(
        POShipment.id == shipment_id,
        POShipment.purchase_order_id == order_id,
    ).first()
    if not sh:
        raise HTTPException(404, "Ачилт олдсонгүй")
    return _serialize_shipment_detail(sh, db)


# ── Add/update lines to shipment (assign brands/products to truck) ────────────

class ShipmentLineIn(BaseModel):
    po_line_id: int
    loaded_qty_box: float = 0

@router.post("/{order_id}/shipments/{shipment_id}/lines")
def set_shipment_lines(
    order_id: int,
    shipment_id: int,
    lines: List[ShipmentLineIn],
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    sh = db.query(POShipment).filter(
        POShipment.id == shipment_id,
        POShipment.purchase_order_id == order_id,
    ).first()
    if not sh:
        raise HTTPException(404, "Ачилт олдсонгүй")
    if sh.status != "loading":
        raise HTTPException(400, "Зөвхөн 'Ачигдаж байна' статуст бараа нэмж болно")

    existing_map = {sl.po_line_id: sl for sl in sh.lines}

    for li in lines:
        if li.loaded_qty_box <= 0:
            # Remove if exists
            if li.po_line_id in existing_map:
                db.delete(existing_map[li.po_line_id])
            continue

        if li.po_line_id in existing_map:
            existing_map[li.po_line_id].loaded_qty_box = li.loaded_qty_box
        else:
            db.add(POShipmentLine(
                shipment_id=shipment_id,
                po_line_id=li.po_line_id,
                loaded_qty_box=li.loaded_qty_box,
            ))
    db.commit()
    return _serialize_shipment_detail(sh, db)


# ── Assign entire brand to shipment (convenience) ────────────────────────────

class AssignBrandIn(BaseModel):
    brand: str

@router.post("/{order_id}/shipments/{shipment_id}/assign-brand")
def assign_brand_to_shipment(
    order_id: int,
    shipment_id: int,
    body: AssignBrandIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Брэндийн хуваарилагдаагүй бүх бараанууд → тухайн ачилтад нэмэгдэнэ."""
    sh = db.query(POShipment).filter(
        POShipment.id == shipment_id,
        POShipment.purchase_order_id == order_id,
    ).first()
    if not sh:
        raise HTTPException(404, "Ачилт олдсонгүй")
    if sh.status != "loading":
        raise HTTPException(400, "Зөвхөн 'Ачигдаж байна' статуст бараа нэмж болно")

    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()

    # All shipment lines for this PO (to compute assigned qty)
    all_ship_lines = (
        db.query(POShipmentLine)
        .join(POShipment, POShipment.id == POShipmentLine.shipment_id)
        .filter(POShipment.purchase_order_id == order_id)
        .all()
    )
    assigned_map: dict[int, float] = {}
    for sl in all_ship_lines:
        assigned_map[sl.po_line_id] = assigned_map.get(sl.po_line_id, 0) + sl.loaded_qty_box

    existing_in_shipment = {sl.po_line_id: sl for sl in sh.lines}
    added = 0

    for pl in po.lines:
        if pl.order_qty_box <= 0:
            continue
        p = db.query(Product).filter(Product.id == pl.product_id).first()
        if not p or p.brand != body.brand:
            continue
        remaining = pl.order_qty_box - assigned_map.get(pl.id, 0)
        if remaining <= 0:
            continue
        if pl.id in existing_in_shipment:
            existing_in_shipment[pl.id].loaded_qty_box += remaining
        else:
            db.add(POShipmentLine(
                shipment_id=shipment_id,
                po_line_id=pl.id,
                loaded_qty_box=remaining,
            ))
        assigned_map[pl.id] = assigned_map.get(pl.id, 0) + remaining
        added += 1

    db.commit()
    return {"ok": True, "added": added, "shipment": _serialize_shipment(sh, db)}


# ── Advance shipment status ──────────────────────────────────────────────────

@router.patch("/{order_id}/shipments/{shipment_id}/advance")
def advance_shipment(
    order_id: int,
    shipment_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    sh = db.query(POShipment).filter(
        POShipment.id == shipment_id,
        POShipment.purchase_order_id == order_id,
    ).first()
    if not sh:
        raise HTTPException(404, "Ачилт олдсонгүй")

    try:
        idx = SHIPMENT_STATUS_SEQ.index(sh.status)
        if idx + 1 >= len(SHIPMENT_STATUS_SEQ):
            raise HTTPException(400, "Ачилт эцсийн статуст хүрсэн")
        next_st = SHIPMENT_STATUS_SEQ[idx + 1]
    except ValueError:
        raise HTTPException(400, "Буруу статус")

    # Ачилтад бараа нэмэгдсэн эсэхийг шалгах (loading → transit)
    if sh.status == "loading" and next_st == "transit":
        if not sh.lines:
            raise HTTPException(400, "Ачилтад бараа нэмэгдээгүй байна")

    sh.status = next_st
    db.commit()

    # Auto-advance PO status if all shipments advanced
    _sync_po_status(order_id, db)

    return _serialize_shipment(sh, db)


# ── Update received qty on shipment lines (arrived stage) ─────────────────────

class ShipmentReceivedIn(BaseModel):
    lines: List[dict]  # [{"shipment_line_id": int, "received_qty_box": float}]

@router.post("/{order_id}/shipments/{shipment_id}/received")
def set_shipment_received(
    order_id: int,
    shipment_id: int,
    body: ShipmentReceivedIn,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    sh = db.query(POShipment).filter(
        POShipment.id == shipment_id,
        POShipment.purchase_order_id == order_id,
    ).first()
    if not sh:
        raise HTTPException(404, "Ачилт олдсонгүй")
    if sh.status not in ("arrived", "accounting"):
        raise HTTPException(400, "Зөвхөн 'Ачаа ирсэн' статуст тоо оруулах боломжтой")

    line_map = {sl.id: sl for sl in sh.lines}
    for item in body.lines:
        sl = line_map.get(item.get("shipment_line_id"))
        if sl:
            sl.received_qty_box = float(item.get("received_qty_box", 0))
    db.commit()
    return _serialize_shipment_detail(sh, db)


# ── Delete shipment (only loading status) ─────────────────────────────────────

@router.delete("/{order_id}/shipments/{shipment_id}")
def delete_shipment(
    order_id: int,
    shipment_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor")),
):
    sh = db.query(POShipment).filter(
        POShipment.id == shipment_id,
        POShipment.purchase_order_id == order_id,
    ).first()
    if not sh:
        raise HTTPException(404, "Ачилт олдсонгүй")
    if sh.status != "loading":
        raise HTTPException(400, "Зөвхөн 'Ачигдаж байна' статустай ачилтыг устгах боломжтой")
    db.delete(sh)
    db.commit()
    return {"ok": True}


# ── Update shipment vehicle ────────────────────────────────────────────────────

class UpdateShipmentIn(BaseModel):
    vehicle_id: Optional[int] = None
    notes: Optional[str] = None

@router.patch("/{order_id}/shipments/{shipment_id}")
def update_shipment(
    order_id: int,
    shipment_id: int,
    body: UpdateShipmentIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    sh = db.query(POShipment).filter(
        POShipment.id == shipment_id,
        POShipment.purchase_order_id == order_id,
    ).first()
    if not sh:
        raise HTTPException(404, "Ачилт олдсонгүй")
    if body.vehicle_id is not None:
        sh.vehicle_id = body.vehicle_id if body.vehicle_id else None
    if body.notes is not None:
        sh.notes = body.notes
    db.commit()
    return _serialize_shipment(sh, db)


# ── Move line(s) between shipments / back to unassigned ────────────────────────

class MoveLineIn(BaseModel):
    shipment_line_id: int
    target_shipment_id: Optional[int] = None   # None = буцааж хуваарилагдаагүй болгох

@router.post("/{order_id}/shipments/move-line")
def move_shipment_line(
    order_id: int,
    body: MoveLineIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Нэг бараа (shipment_line)-г өөр ачилт руу шилжүүлэх эсвэл буцааж хуваарилагдаагүй болгох."""
    sl = db.query(POShipmentLine).filter(POShipmentLine.id == body.shipment_line_id).first()
    if not sl:
        raise HTTPException(404, "Ачилтын мөр олдсонгүй")

    src_sh = db.query(POShipment).filter(POShipment.id == sl.shipment_id).first()
    if not src_sh or src_sh.purchase_order_id != order_id:
        raise HTTPException(404, "Ачилт олдсонгүй")
    if src_sh.status != "loading":
        raise HTTPException(400, "Зөвхөн 'Ачигдаж байна' статуст шилжүүлэх боломжтой")

    if body.target_shipment_id is None:
        # Буцааж unassigned → shipment line устгана
        db.delete(sl)
        db.commit()
        return {"ok": True, "action": "unassigned"}

    # Өөр ачилт руу шилжүүлэх
    target_sh = db.query(POShipment).filter(
        POShipment.id == body.target_shipment_id,
        POShipment.purchase_order_id == order_id,
    ).first()
    if not target_sh:
        raise HTTPException(404, "Зорилтот ачилт олдсонгүй")
    if target_sh.status != "loading":
        raise HTTPException(400, "Зорилтот ачилт 'Ачигдаж байна' статуст байх ёстой")

    # Check if target already has this po_line
    existing = db.query(POShipmentLine).filter(
        POShipmentLine.shipment_id == body.target_shipment_id,
        POShipmentLine.po_line_id == sl.po_line_id,
    ).first()
    if existing:
        existing.loaded_qty_box += sl.loaded_qty_box
    else:
        db.add(POShipmentLine(
            shipment_id=body.target_shipment_id,
            po_line_id=sl.po_line_id,
            loaded_qty_box=sl.loaded_qty_box,
        ))
    db.delete(sl)
    db.commit()
    return {"ok": True, "action": "moved", "target_shipment_id": body.target_shipment_id}


# ── Sync PO status from shipment statuses ─────────────────────────────────────

def _sync_po_status(order_id: int, db: Session):
    """Бүх shipment-ийн статусаас PO-ийн статусыг автоматаар тодорхойлно."""
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po or po.status not in ("loading", "transit", "arrived", "accounting", "confirmed", "received"):
        return

    shipments = db.query(POShipment).filter(POShipment.purchase_order_id == order_id).all()
    if not shipments:
        return

    statuses = [s.status for s in shipments]

    # Бүх shipment "received" → PO = "received"
    if all(s == "received" for s in statuses):
        po.status = "received"
    # Бүх shipment "confirmed" or higher → PO = "confirmed"
    elif all(SHIPMENT_STATUS_SEQ.index(s) >= SHIPMENT_STATUS_SEQ.index("confirmed") for s in statuses):
        po.status = "confirmed"
    # Бүх shipment "accounting" or higher → PO = "accounting"
    elif all(SHIPMENT_STATUS_SEQ.index(s) >= SHIPMENT_STATUS_SEQ.index("accounting") for s in statuses):
        po.status = "accounting"
    # Бүх shipment "arrived" or higher → PO = "arrived"
    elif all(SHIPMENT_STATUS_SEQ.index(s) >= SHIPMENT_STATUS_SEQ.index("arrived") for s in statuses):
        po.status = "arrived"
    # Ядаж 1 shipment "transit" or higher → PO = "transit" (хуваарилагдаагүй бараа байсан ч)
    elif any(SHIPMENT_STATUS_SEQ.index(s) >= SHIPMENT_STATUS_SEQ.index("transit") for s in statuses):
        po.status = "transit"

    db.commit()
