from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List, Dict

from app.api.deps import get_db, require_role
from app.models.logistics import Vehicle, Shipment, ShipmentBrandAssignment
from app.models.purchase_order import POShipment, POShipmentLine, PurchaseOrderLine, PurchaseOrder
from app.models.product import Product

router = APIRouter(prefix="/logistics", tags=["logistics"])


class VehicleIn(BaseModel):
    name: str
    plate: str = ""
    capacity_kg: float = 5000.0
    driver_name: str = ""
    driver_phone: str = ""
    is_active: bool = True


class AssignmentIn(BaseModel):
    brand: str
    allocated_weight: float
    supplier_id: Optional[int] = None


class ShipmentIn(BaseModel):
    vehicle_id: int
    notes: str = ""
    assignments: List[AssignmentIn] = []


class OptimizeIn(BaseModel):
    brand_weights: Dict[str, float]
    vehicle_ids: List[int]


# ── Vehicles ──────────────────────────────────────────────────────────────────

@router.get("/vehicles")
def list_vehicles(db: Session = Depends(get_db), _=Depends(require_role("admin", "supervisor", "manager"))):
    rows = db.query(Vehicle).order_by(Vehicle.name).all()

    # ⚠ Өмнө нь purchase_order_lines-ийг БҮХЭЛД нь (1.4 сая мөр) + бүх бараа, бүх
    # захиалгыг ORM объект болгож ачаалдаг байсан — хэмжсэнээр 42 СЕКУНД, мөн тэр
    # хугацаанд серверийн CPU/GIL-ийг эзэлж бусад бүх хүсэлтийг удаашруулж байв.
    # Захиалгын дэлгэрэнгүй хуудас (admin/manager) бүр үүнийг дууддаг. Одоо жинг
    # SQL GROUP BY-гоор, ачилтын түүхийг зөвхөн шаардлагатай баганаар авна.
    from sqlalchemy import func
    weight_expr = func.sum(
        POShipmentLine.loaded_qty_box
        * func.coalesce(func.nullif(Product.pack_ratio, 0), 1)
        * func.coalesce(Product.unit_weight, 0)
    )
    weight_by_vehicle = {
        vid: float(w or 0)
        for vid, w in db.query(POShipment.vehicle_id, weight_expr)
        .join(POShipmentLine, POShipmentLine.shipment_id == POShipment.id)
        .join(PurchaseOrderLine, PurchaseOrderLine.id == POShipmentLine.po_line_id)
        .join(Product, Product.id == PurchaseOrderLine.product_id)
        .filter(POShipment.vehicle_id.isnot(None))
        .group_by(POShipment.vehicle_id)
        .all()
    }

    vehicle_stats: dict[int, dict] = {}
    ship_rows = (
        db.query(POShipment.id, POShipment.vehicle_id, POShipment.purchase_order_id, POShipment.status,
                 POShipment.created_at, PurchaseOrder.order_date)
        .outerjoin(PurchaseOrder, PurchaseOrder.id == POShipment.purchase_order_id)
        .filter(POShipment.vehicle_id.isnot(None))
        .order_by(POShipment.id)
        .all()
    )
    for sid, vid, po_id, st, created_at, po_date in ship_rows:
        vs = vehicle_stats.setdefault(vid, {"trip_count": 0, "total_weight": weight_by_vehicle.get(vid, 0.0), "shipments": []})
        if st not in ("loading",):
            vs["trip_count"] += 1
        vs["shipments"].append({
            "shipment_id": sid,
            "po_id": po_id,
            "po_date": po_date.isoformat() if po_date else "",
            "status": st,
            "created_at": created_at.isoformat() if created_at else "",
        })

    result = []
    for v in rows:
        stats = vehicle_stats.get(v.id, {"trip_count": 0, "total_weight": 0.0, "shipments": []})
        result.append({
            "id": v.id,
            "name": v.name,
            "plate": v.plate,
            "capacity_kg": v.capacity_kg,
            "driver_name": v.driver_name,
            "driver_phone": v.driver_phone,
            "is_active": v.is_active,
            "trip_count": stats["trip_count"],
            "total_weight_kg": round(stats["total_weight"], 1),
            "total_weight_ton": round(stats["total_weight"] / 1000, 2),
            "shipment_history": stats["shipments"],
        })

    # Top rank: total_weight desc
    result.sort(key=lambda x: x["total_weight_kg"], reverse=True)
    for i, r in enumerate(result):
        r["rank"] = i + 1

    return result


@router.post("/vehicles")
def create_vehicle(
    body: VehicleIn,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    v = Vehicle(**body.dict())
    db.add(v)
    db.commit()
    db.refresh(v)
    return {"id": v.id, "name": v.name}


@router.put("/vehicles/{vehicle_id}")
def update_vehicle(
    vehicle_id: int,
    body: VehicleIn,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    v = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if not v:
        raise HTTPException(404, "Машин олдсонгүй")
    for k, val in body.dict().items():
        setattr(v, k, val)
    db.commit()
    return {"ok": True}


@router.delete("/vehicles/{vehicle_id}")
def delete_vehicle(
    vehicle_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    v = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if not v:
        raise HTTPException(404, "Машин олдсонгүй")
    db.delete(v)
    db.commit()
    return {"ok": True}


# ── Shipments ─────────────────────────────────────────────────────────────────

@router.get("/shipments")
def list_shipments(db: Session = Depends(get_db), _=Depends(require_role("admin", "supervisor", "manager"))):
    shipments = db.query(Shipment).order_by(Shipment.created_at.desc()).all()
    result = []
    for s in shipments:
        v = s.vehicle
        total_weight = sum(a.allocated_weight for a in s.assignments)
        fill_pct = (total_weight / v.capacity_kg * 100) if v and v.capacity_kg > 0 else 0
        result.append({
            "id": s.id,
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "vehicle_id": s.vehicle_id,
            "vehicle_name": v.name if v else "",
            "vehicle_plate": v.plate if v else "",
            "capacity_kg": v.capacity_kg if v else 0,
            "status": s.status,
            "notes": s.notes,
            "total_weight": round(total_weight, 2),
            "fill_pct": round(fill_pct, 1),
            "assignments": [
                {
                    "brand": a.brand,
                    "allocated_weight": a.allocated_weight,
                    "supplier_id": a.supplier_id,
                }
                for a in s.assignments
            ],
        })
    return result


@router.post("/shipments")
def create_shipment(
    body: ShipmentIn,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    v = db.query(Vehicle).filter(Vehicle.id == body.vehicle_id).first()
    if not v:
        raise HTTPException(404, "Машин олдсонгүй")
    s = Shipment(vehicle_id=body.vehicle_id, notes=body.notes)
    db.add(s)
    db.flush()
    for a in body.assignments:
        db.add(ShipmentBrandAssignment(
            shipment_id=s.id,
            brand=a.brand,
            allocated_weight=a.allocated_weight,
            supplier_id=a.supplier_id,
        ))
    db.commit()
    return {"id": s.id, "ok": True}


@router.put("/shipments/{shipment_id}")
def update_shipment(
    shipment_id: int,
    body: ShipmentIn,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    s = db.query(Shipment).filter(Shipment.id == shipment_id).first()
    if not s:
        raise HTTPException(404, "Ачаалал олдсонгүй")
    s.vehicle_id = body.vehicle_id
    s.notes = body.notes
    # Replace assignments
    db.query(ShipmentBrandAssignment).filter(ShipmentBrandAssignment.shipment_id == s.id).delete()
    db.flush()
    for a in body.assignments:
        db.add(ShipmentBrandAssignment(
            shipment_id=s.id,
            brand=a.brand,
            allocated_weight=a.allocated_weight,
            supplier_id=a.supplier_id,
        ))
    db.commit()
    return {"ok": True}


@router.delete("/shipments/{shipment_id}")
def delete_shipment(
    shipment_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    s = db.query(Shipment).filter(Shipment.id == shipment_id).first()
    if not s:
        raise HTTPException(404, "Ачаалал олдсонгүй")
    db.delete(s)
    db.commit()
    return {"ok": True}


# ── Optimization ──────────────────────────────────────────────────────────────

@router.post("/optimize")
def optimize(
    body: OptimizeIn,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    vehicles = (
        db.query(Vehicle)
        .filter(Vehicle.id.in_(body.vehicle_ids), Vehicle.is_active == True)
        .all()
    )
    if not vehicles:
        raise HTTPException(400, "Идэвхтэй машин олдсонгүй")

    # First Fit Decreasing
    brands_sorted = sorted(body.brand_weights.items(), key=lambda x: x[1], reverse=True)

    vehicle_loads: dict = {
        v.id: {"vehicle": v, "brands": [], "total_weight": 0.0}
        for v in vehicles
    }
    unassigned = []

    for brand, weight in brands_sorted:
        assigned = False
        for v in vehicles:
            remaining = v.capacity_kg - vehicle_loads[v.id]["total_weight"]
            if weight <= remaining + 0.001:  # small tolerance
                vehicle_loads[v.id]["brands"].append({"brand": brand, "weight": weight})
                vehicle_loads[v.id]["total_weight"] += weight
                assigned = True
                break
        if not assigned:
            unassigned.append({"brand": brand, "weight": weight})

    result = []
    for v in vehicles:
        load = vehicle_loads[v.id]
        fill_pct = (load["total_weight"] / v.capacity_kg * 100) if v.capacity_kg > 0 else 0
        result.append({
            "vehicle_id": v.id,
            "vehicle_name": v.name,
            "vehicle_plate": v.plate,
            "capacity_kg": v.capacity_kg,
            "brands": load["brands"],
            "total_weight": round(load["total_weight"], 2),
            "fill_pct": round(fill_pct, 1),
        })

    return {"vehicles": result, "unassigned_brands": unassigned}
