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

    # Bulk load all data in 4 queries (instead of thousands)
    all_shipments = db.query(POShipment).all()
    all_ship_lines = db.query(POShipmentLine).all()
    all_po_lines = db.query(PurchaseOrderLine).all()
    all_products = db.query(Product).all()
    all_pos = db.query(PurchaseOrder).all()

    # Build lookup maps
    po_line_map = {pl.id: pl for pl in all_po_lines}
    product_map = {p.id: p for p in all_products}
    po_map = {po.id: po for po in all_pos}

    # Group shipment lines by shipment_id
    ship_lines_by_sid: dict[int, list] = {}
    for sl in all_ship_lines:
        ship_lines_by_sid.setdefault(sl.shipment_id, []).append(sl)

    # Build vehicle stats
    vehicle_stats: dict[int, dict] = {}
    for sh in all_shipments:
        if not sh.vehicle_id:
            continue
        if sh.vehicle_id not in vehicle_stats:
            vehicle_stats[sh.vehicle_id] = {"trip_count": 0, "total_weight": 0.0, "shipments": []}
        if sh.status not in ("loading",):
            vehicle_stats[sh.vehicle_id]["trip_count"] += 1
        # Weight from pre-loaded data
        for sl in ship_lines_by_sid.get(sh.id, []):
            pl = po_line_map.get(sl.po_line_id)
            if pl:
                p = product_map.get(pl.product_id)
                if p:
                    vehicle_stats[sh.vehicle_id]["total_weight"] += sl.loaded_qty_box * float(p.pack_ratio or 1) * float(p.unit_weight or 0)
        po = po_map.get(sh.purchase_order_id)
        vehicle_stats[sh.vehicle_id]["shipments"].append({
            "shipment_id": sh.id,
            "po_id": sh.purchase_order_id,
            "po_date": po.order_date.isoformat() if po else "",
            "status": sh.status,
            "created_at": sh.created_at.isoformat() if sh.created_at else "",
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
