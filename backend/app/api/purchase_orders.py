from pathlib import Path
from datetime import date as date_type, datetime
from typing import Optional, List
import io
import re

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.api.deps import get_db, get_current_user, require_role, parse_tag_ids
from app.core.audit import audit
from app.core import dashboard_cache
from app.models.purchase_order import (
    PurchaseOrder, PurchaseOrderLine, PurchaseOrderBrandVehicle,
    PurchaseOrderBrandStatus, OrderExtraLine, POShipment, POShipmentLine, POShipmentBrand,
    ErkhetImportLog,
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


def _detail_response(data: dict) -> JSONResponse:
    """Захиалгын дэлгэрэнгүйг FastAPI-ийн jsonable_encoder-ыг АЛГАСААД буцаана.

    Яагаад: энгийн dict буцаавал FastAPI автоматаар `jsonable_encoder`-оор
    гүйлгэдэг. 22,283 мөртэй захиалга дээр энэ нь 2.34 СЕКУНД иддэг (хэмжсэн) —
    serializer-ээс ч удаан. `_serialize_order_detail` нь аль хэдийн зөвхөн
    анхдагч төрөл (str/int/float/bool/None/list/dict) буцаадаг тул хөрвүүлэх
    зүйл байхгүй. Response объект буцаавал FastAPI хөндөхгүй өнгөрөөнө.
    Хатуу json.dumps-аар (default=str-гүй) шалгаж баталгаажуулсан.
    """
    return JSONResponse(content=data)


def _serialize_order_detail(
    o: PurchaseOrder,
    db: Session,
    filter_tag_ids: Optional[List[int]] = None,
    all_lines_at_preparing: bool = True,
    brand: Optional[str] = None,
) -> dict:
    """Full detail including product info for each line.
    If filter_tag_ids is provided, only lines whose product belongs to those warehouses are returned.
    Uses SQL queries instead of lazy-loading 10K+ lines into memory.
    """
    # Use SQL aggregate for base stats (don't lazy-load o.lines for summary)
    agg = db.query(
        func.count(PurchaseOrderLine.id),
        func.sum(PurchaseOrderLine.order_qty_box),
        func.sum(PurchaseOrderLine.computed_weight),
    ).filter(PurchaseOrderLine.purchase_order_id == o.id).first()

    creator = db.query(User).filter(User.id == o.created_by_user_id).first()
    vehicle = db.query(Vehicle).filter(Vehicle.id == o.vehicle_id).first() if o.vehicle_id else None

    base = {
        "id": o.id,
        "order_date": o.order_date.isoformat(),
        "status": o.status,
        "status_label": STATUS_LABEL.get(o.status, o.status),
        "created_by_username": creator.username if creator else "",
        "line_count": agg[0] or 0,
        "total_boxes": round(float(agg[1] or 0), 2),
        "total_weight": round(float(agg[2] or 0), 2),
        "created_at": o.created_at.isoformat() if o.created_at else None,
        "vehicle_id": o.vehicle_id,
        "vehicle_name": f"{vehicle.name} ({vehicle.plate})" if vehicle else None,
        "notes": o.notes or "",
        "is_archived": bool(o.is_archived),
        "location": o.location or "warehouse",
        "stat_month": o.stat_month,
    }

    # Load lines via explicit query (NOT lazy o.lines which loads ALL 10K+ rows)
    # For preparing stage: load all lines (user needs to enter quantities for any product)
    # For other stages: only load lines with order_qty_box > 0 (or supplier_qty > 0 for cancelled tracking)
    # preparing статуст БҮХ мөрийг (тоо=0 ч гэсэн) илгээдэг — учир нь нярав
    # дурын бараанд тоо оруулах ёстой. Гэхдээ БУСАД хэрэглэгчийн UI нь
    # тоо=0 мөрийг ямар ч байсан нуудаг (baseLines шүүлт) тул тэдэнд илгээх нь
    # цэвэр дэмий: захиалга #106 дээр 22,283 мөр илгээгээд 171 нь л
    # харагддаг. Тиймээс зөвхөн шаардлагатай үед нь бүгдийг илгээнэ.
    # Ороогүй барааг харах бол /unordered зам бий.
    lines_q = db.query(PurchaseOrderLine).filter(PurchaseOrderLine.purchase_order_id == o.id)
    if o.status not in ("preparing",) or not all_lines_at_preparing:
        lines_q = lines_q.filter(
            (PurchaseOrderLine.order_qty_box > 0) | (PurchaseOrderLine.supplier_qty_box > 0)
        )
    if brand is not None:
        # Брендийн дэлгэрэнгүй: 22 мянган мөрийг бүгдийг боловсруулаад дараа нь хаяхын
        # оронд SQL-д шүүнэ (үр дүнгийн бренд = override_brand, эс бол Product.brand).
        _ovr = func.coalesce(func.trim(PurchaseOrderLine.override_brand), "")
        lines_q = lines_q.join(Product, Product.id == PurchaseOrderLine.product_id).filter(
            (_ovr == brand.strip()) | ((_ovr == "") & (Product.brand == brand))
        )
    all_lines = lines_q.all()

    # Bulk load products.
    # IN (...) биш JOIN ашиглана: 22,283 мөртэй захиалганд IN нь 22,283 bind
    # параметр үүсгэдэг байсан — SQLite-ийн 32,766 хязгаарын 2/3. ~33 мянган
    # мөртэй захиалга дээр хүсэлт бүтэлгүйтэх байв. JOIN нь хязгааргүй бөгөөд
    # хурдан ч.
    prod_q = (
        db.query(Product)
        .join(PurchaseOrderLine, PurchaseOrderLine.product_id == Product.id)
        .filter(PurchaseOrderLine.purchase_order_id == o.id)
    )
    # all_lines-тэй ЯГ ижил шүүлт — эс тэгвээс бусад статуст хэрэггүй бараа татна.
    if o.status not in ("preparing",):
        prod_q = prod_q.filter(
            (PurchaseOrderLine.order_qty_box > 0) | (PurchaseOrderLine.supplier_qty_box > 0)
        )
    if brand is not None:
        _pids = list({l.product_id for l in all_lines})
        products = db.query(Product).filter(Product.id.in_(_pids)).all() if _pids else []
    else:
        products = prod_q.distinct().all() if all_lines else []
    product_map = {p.id: p for p in products}

    # Min-stock rules (нэг удаа ачаалаад бараа бүрт match хийнэ)
    from app.models.min_stock_rule import MinStockRule
    from app.services.min_stock_check import build_rule_matcher, compute_needs_reorder, stock_breakdown
    _ms_rules = db.query(MinStockRule).filter(MinStockRule.is_active == True).all()
    # Мөр бүрт бүх дүрмийг гүйхийн оронд кэштэй тааруулагч (22k мөрд ~0.5 сек хэмнэнэ)
    _match_rule = build_rule_matcher(_ms_rules)

    # Bulk load shipment line totals: po_line_id → total loaded (sum across shipments)
    line_ids = [l.id for l in all_lines]
    shipped_loaded: dict[int, float] = {}
    shipped_received: dict[int, float] = {}
    if line_ids:
        from sqlalchemy import func as _func
        # Мөн адил: IN (22k id) биш JOIN — параметрийн хязгаарт хүрэхгүй.
        rows = (
            db.query(
                POShipmentLine.po_line_id,
                _func.sum(POShipmentLine.loaded_qty_box),
                _func.sum(POShipmentLine.received_qty_box),
            )
            .join(PurchaseOrderLine, PurchaseOrderLine.id == POShipmentLine.po_line_id)
            .filter(PurchaseOrderLine.purchase_order_id == o.id)
            .group_by(POShipmentLine.po_line_id)
            .all()
        )
        for row in rows:
            shipped_loaded[row[0]] = float(row[1] or 0)
            shipped_received[row[0]] = float(row[2] or 0)

    # ── Нөөц багана — захиалгын байршлаас хамаарч үлдэгдлийн файлаас тооцно:
    #    warehouse → Бүх агуулах; showroom → Үндсэн заал + Архины заал.
    #    Өмнө нь зөвхөн preparing/reviewing статуст ачаалдаг байсан (тэр үед л
    #    багана харагддаг байсан учир). Одоо багана бүх статуст харагдана тул
    #    ҮРГЭЛЖ ачаална — эс тэгвээс нэг багана дунд замдаа Product.stock_qty
    #    руу чимээгүй сольж, утга нь өөрчлөгдөнө. get_location_stock_map нь
    #    кэштэй бөгөөд урьдчилан дулаацуулсан тул нэмэлт зардал бага. ──
    from app.services.balance_stock import get_location_stock_map
    balance_map = get_location_stock_map(db, o.location or "warehouse")

    lines_out = []
    for l in all_lines:
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

        # Prefer shipment-aggregated loaded/received values if shipments exist
        loaded_effective = shipped_loaded.get(l.id, float(l.loaded_qty_box or 0))
        if loaded_effective == 0 and (l.loaded_qty_box or 0) > 0:
            loaded_effective = float(l.loaded_qty_box)
        received_effective = shipped_received.get(l.id, float(l.received_qty_box or 0))
        if received_effective == 0 and (l.received_qty_box or 0) > 0:
            received_effective = float(l.received_qty_box)

        # Нөөц: байршлын үлдэгдлийн файлаас (preparing/reviewing). Бусад статуст
        # системийн Product.stock_qty (тэр үед багана харагдахгүй).
        if balance_map is not None:
            s_qty = float(balance_map.get(p.item_code, 0.0))
            _pack = float(p.pack_ratio or 1) or 1.0
            s_box = int(s_qty // _pack) if _pack > 0 else 0
            s_extra = int(round(s_qty - s_box * _pack))
        else:
            _bd = stock_breakdown(p)
            s_qty = float(p.stock_qty or 0)
            s_box = _bd["stock_box"]
            s_extra = _bd["stock_extra_pcs"]
        # Дахин захиалах шалгалт — харагдаж буй нөөцтэй ижил эх сурвалжаар (хайрцгаар)
        matched_rule = _match_rule(p)
        if matched_rule:
            min_stock_box = float(matched_rule.min_qty_box or 0)
            needs_reorder = s_box < min_stock_box
        else:
            needs_reorder, min_stock_box = False, 0.0

        # Үр дүнгийн бренд: override_brand тохиргоотой бол түүнийг, эс бол product.brand
        eff_brand = (l.override_brand or "").strip() or p.brand
        lines_out.append({
            "line_id": l.id,
            "product_id": l.product_id,
            "item_code": p.item_code,
            "name": p.name,
            "brand": eff_brand,
            "original_brand": p.brand,
            "override_brand": l.override_brand or "",
            "warehouse_tag_id": p.warehouse_tag_id,
            "warehouse_name": p.warehouse_name or "",
            "price_tag": p.price_tag or "",
            "unit_weight": p.unit_weight,
            "pack_ratio": p.pack_ratio,
            "stock_qty": s_qty,
            "stock_box": s_box,
            "stock_extra_pcs": s_extra,
            "sales_qty": p.sales_qty,
            "needs_reorder": needs_reorder,
            "min_stock_box": min_stock_box,
            "order_qty_box": l.order_qty_box,
            "order_qty_pcs": l.order_qty_pcs,
            "computed_weight": l.computed_weight,
            "supplier_qty_box": l.supplier_qty_box,
            "loaded_qty_box": loaded_effective,
            "received_qty_box": received_effective,
            "received_qty_extra_pcs": float(l.received_qty_extra_pcs or 0),
            "difference": round(loaded_effective - received_effective, 2),
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
    # Bulk load vehicles for brand-vehicle assignments
    bv_vehicle_ids = {bv.vehicle_id for bv in bvs if bv.vehicle_id}
    bv_vehicles = {v.id: v for v in db.query(Vehicle).filter(Vehicle.id.in_(bv_vehicle_ids)).all()} if bv_vehicle_ids else {}
    bv_out = []
    for bv in bvs:
        vehicle = bv_vehicles.get(bv.vehicle_id)
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

    # Per-brand statuses
    bs_rows = db.query(PurchaseOrderBrandStatus).filter(
        PurchaseOrderBrandStatus.purchase_order_id == o.id
    ).all()
    base["brand_statuses"] = {bs.brand: bs.status for bs in bs_rows}

    return base


# ── Endpoints ──────────────────────────────────────────────────────────────────

class POCreateIn(BaseModel):
    order_date: date_type
    notes: str = ""
    # None эсвэл хоосон бол бүх бренд, эс бол зөвхөн сонгосон бренд-ийн барааг л оруулна.
    brands: Optional[List[str]] = None
    # Захиалгын байршил: "warehouse" (Агуулах) | "showroom" (Заал). Нөөц баганыг тодорхойлно.
    location: str = "warehouse"
    # "Өмнөх оны энэ сард" баганад харьцуулах сар (1-12). None бол order_date-ийн сар.
    stat_month: Optional[int] = None


class POLineIn(BaseModel):
    product_id: int
    # None = "энэ талбарыг бүү хөнд". Өмнө нь заавал байх шаардлагатай байсан тул
    # зөвхөн үнэ засаж байсан ч захиалгын тоо дагаж бичигдэж байв.
    order_qty_box: Optional[float] = None
    supplier_qty_box: Optional[float] = None
    loaded_qty_box: Optional[float] = None
    received_qty_box: Optional[float] = None
    received_qty_extra_pcs: Optional[float] = None
    unit_price: Optional[float] = None
    remark: Optional[str] = None
    # Хуудас нээх үеийн захиалгын тоо. Илгээвэл серверийн одоогийн утгатай тулгана:
    # зөрвөл ӨӨР ХҮН завсар нь өөрчилсөн гэж үзэж энэ мөрийг ХӨНДӨХГҮЙ, хариунд
    # conflicts-д буцаана (2026-09-22 #110: хуучирсан хуудас 13 брендийн тоог 0 болгосон).
    expected_order_qty_box: Optional[float] = None


class AddLineIn(BaseModel):
    product_id: int
    order_qty_box: float = 1.0
    # Онцгой тохиолдолд: тухайн бараа Q бренд-ээс байвал override_brand="W" бичвэл
    # W брендийн хэсэгт харагдана. Зөвхөн admin эрхтэй үед зөвшөөрнө.
    override_brand: Optional[str] = None


class POVehicleIn(BaseModel):
    vehicle_id: Optional[int] = None


# ── Ачааны төрөл (Нэмэлт талбар → Бараа → freight_class) ─────────────────────
FREIGHT_KEY = "freight_class"


def _freight_info(db: Session, item_codes: list[str]) -> tuple[list[str], dict[str, str]]:
    """(ангиллын дараалал, {item_code: ангилал}). Талбар идэвхгүй/алга бол ([], {})."""
    try:
        from app.services.custom_master import active_fields, field_options, values_map
        f = next((x for x in active_fields(db, "product") if x.key == FREIGHT_KEY), None)
        if f is None:
            return [], {}
        vals = values_map(db, "product", item_codes)
        return field_options(f), {c: str(v.get(FREIGHT_KEY) or "") for c, v in vals.items() if v.get(FREIGHT_KEY)}
    except Exception:
        return [], {}


def _freight_list(weights: dict[str, float], classes: list[str]) -> list[dict]:
    """[{class, weight}] — тохиргооны дарааллаар, тодорхойгүй ("") хамгийн сүүлд."""
    order = list(classes) + sorted(k for k in weights if k and k not in classes) + [""]
    return [{"class": k, "weight": round(weights[k], 1)} for k in order if weights.get(k, 0) > 0.05]


# ── Dashboard endpoint ────────────────────────────────────────────────────────

@router.get("/{order_id}/dashboard")
def get_order_dashboard(
    order_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Захиалгын бренд-түвшний нэгтгэсэн dashboard мэдээлэл."""
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")

    # Load only active lines (NOT lazy po.lines which loads ALL 10K+ rows)
    active_lines = db.query(PurchaseOrderLine).filter(
        PurchaseOrderLine.purchase_order_id == order_id,
        (PurchaseOrderLine.order_qty_box > 0) | (PurchaseOrderLine.supplier_qty_box > 0)
    ).all()

    # Bulk load products for active lines only
    product_ids = [l.product_id for l in active_lines]
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(product_ids)).all()} if product_ids else {}

    # All shipments + shipment lines for this PO
    shipments = db.query(POShipment).filter(POShipment.purchase_order_id == order_id).order_by(POShipment.id).all()
    all_ship_lines = (
        db.query(POShipmentLine)
        .join(POShipment, POShipment.id == POShipmentLine.shipment_id)
        .filter(POShipment.purchase_order_id == order_id)
        .all()
    )

    # assigned_map: po_line_id → total loaded across all shipments
    assigned_map: dict[int, float] = {}
    # shipment_map: po_line_id → set of shipment_ids
    shipment_line_map: dict[int, set[int]] = {}
    for sl in all_ship_lines:
        assigned_map[sl.po_line_id] = assigned_map.get(sl.po_line_id, 0) + sl.loaded_qty_box
        shipment_line_map.setdefault(sl.po_line_id, set()).add(sl.shipment_id)

    # Shipment status map
    shipment_status_map = {s.id: s.status for s in shipments}

    # ── Захиалагч (бренд → ажилтан) ба ачааны төрөл (Нэмэлт талбар: freight_class) ──
    # Захиалагч = харилцагчийн Нэмэлт талбар «Захиалагч» (бренд ↔ харилцагч брэнд кодоор)
    from app.api.brand_orderers import brand_orderer_info, orderer_names, UNASSIGNED
    _brands_here = {
        (l.override_brand or "").strip() or (products[l.product_id].brand if l.product_id in products else "") or "Брэнд байхгүй"
        for l in active_lines
    }
    brand_orderer, brand_customer = brand_orderer_info(db, _brands_here)
    freight_classes, freight_of = _freight_info(db, [p.item_code for p in products.values()])

    # ── Group lines by brand ──
    brand_data: dict[str, dict] = {}
    cancelled_lines = 0
    cancelled_brands_set: set[str] = set()

    for l in active_lines:
        p = products.get(l.product_id)
        if not p:
            continue

        is_cancelled = l.order_qty_box == 0 and (l.supplier_qty_box or 0) > 0

        brand = (l.override_brand or "").strip() or p.brand or "Брэнд байхгүй"
        if brand not in brand_data:
            brand_data[brand] = {
                "brand": brand,
                "line_count": 0,
                "total_order_boxes": 0.0,
                "total_loaded_boxes": 0.0,
                "total_received_boxes": 0.0,
                "total_weight": 0.0,
                "estimated_cost": 0.0,
                "shipment_ids": set(),
                "vehicle_ids": set(),
                "items": [],
                "has_active_lines": False,
                "all_cancelled": True,
            }
        bd = brand_data[brand]

        loaded = assigned_map.get(l.id, 0)
        remaining = max(0.0, l.order_qty_box - loaded)
        weight = l.order_qty_box * float(p.pack_ratio or 1) * float(p.unit_weight or 0)
        lpp = float(p.last_purchase_price or 0)

        if is_cancelled:
            cancelled_lines += 1
        else:
            bd["all_cancelled"] = False

        if l.order_qty_box > 0:
            bd["has_active_lines"] = True
            bd["all_cancelled"] = False

        bd["line_count"] += 1
        bd["total_order_boxes"] += l.order_qty_box
        bd["total_loaded_boxes"] += loaded
        bd["total_received_boxes"] += (l.received_qty_box or 0)
        bd["total_weight"] += weight
        bd["estimated_cost"] += lpp * l.order_qty_box

        # Track shipments/vehicles
        sids = shipment_line_map.get(l.id, set())
        bd["shipment_ids"].update(sids)
        for sid in sids:
            sh = next((s for s in shipments if s.id == sid), None)
            if sh and sh.vehicle_id:
                bd["vehicle_ids"].add(sh.vehicle_id)

        bd["items"].append({
            "item_code": p.item_code,
            "name": p.name,
            "order_qty_box": l.order_qty_box,
            "loaded_qty_box": loaded,
            "unloaded_qty": remaining,
            "received_qty_box": l.received_qty_box or 0,
            "weight": round(weight, 2),
            "is_cancelled": is_cancelled,
        })

    # Derive brand_status
    def _brand_status(bd: dict) -> str:
        if bd["all_cancelled"]:
            return "cancelled"
        if not bd["has_active_lines"]:
            return "cancelled"
        loaded = bd["total_loaded_boxes"]
        ordered = bd["total_order_boxes"]
        if ordered <= 0:
            return "cancelled"
        if loaded <= 0:
            return "unloaded"
        # Check shipment statuses for loaded lines
        statuses = {shipment_status_map.get(sid, "loading") for sid in bd["shipment_ids"]}
        if loaded < ordered:
            if statuses & {"transit", "arrived", "accounting", "confirmed", "received"}:
                return "partial"
            return "partial"
        # Fully loaded — return highest shipment status
        if "received" in statuses and len(statuses) == 1:
            return "received"
        if statuses <= {"confirmed", "received"}:
            return "confirmed"
        if statuses <= {"arrived", "accounting", "confirmed", "received"}:
            return "arrived"
        if "transit" in statuses:
            return "transit"
        return "loaded"

    # Load persisted brand statuses from DB
    persisted_bs = {
        bs.brand: bs.status
        for bs in db.query(PurchaseOrderBrandStatus).filter(
            PurchaseOrderBrandStatus.purchase_order_id == order_id
        ).all()
    }

    # Bulk load all vehicles referenced by brands
    all_vehicle_ids: set[int] = set()
    for bd in brand_data.values():
        all_vehicle_ids.update(bd["vehicle_ids"])
    for sh in shipments:
        if sh.vehicle_id:
            all_vehicle_ids.add(sh.vehicle_id)
    vehicle_map = {v.id: v for v in db.query(Vehicle).filter(Vehicle.id.in_(all_vehicle_ids)).all()} if all_vehicle_ids else {}

    # Build brands list
    brands_list = []
    for bd in sorted(brand_data.values(), key=lambda x: x["brand"]):
        vehicle_names = []
        for vid in bd["vehicle_ids"]:
            v = vehicle_map.get(vid)
            if v:
                vehicle_names.append(f"{v.name} ({v.plate})")

        brands_list.append({
            "brand": bd["brand"],
            "line_count": bd["line_count"],
            "total_order_boxes": round(bd["total_order_boxes"], 1),
            "total_loaded_boxes": round(bd["total_loaded_boxes"], 1),
            "total_unloaded_boxes": round(max(0, bd["total_order_boxes"] - bd["total_loaded_boxes"]), 1),
            "total_received_boxes": round(bd["total_received_boxes"], 1),
            "total_weight": round(bd["total_weight"], 1),
            "estimated_cost": round(bd["estimated_cost"], 2),
            "brand_status": persisted_bs.get(bd["brand"], _brand_status(bd)),
            "brand_status_label": STATUS_LABEL.get(persisted_bs.get(bd["brand"], _brand_status(bd)), ""),
            "vehicle_names": vehicle_names,
            "orderer": brand_orderer.get(bd["brand"], ""),
            "customer_code": brand_customer.get(bd["brand"]),
            "items": bd["items"],
        })

    cancelled_brands_count = sum(1 for b in brands_list if b["brand_status"] == "cancelled")

    # ── Extra lines ──
    extra_brand_map: dict[str, list] = {}
    for el in po.extra_lines:
        b = el.brand or "Нэмэлт бараа"
        extra_brand_map.setdefault(b, []).append({
            "name": el.name, "item_code": el.item_code,
            "qty_box": el.qty_box, "computed_weight": el.computed_weight,
        })
    extra_brands = [
        {
            "brand": b,
            "items": items,
            "total_boxes": sum(i["qty_box"] for i in items),
            "total_weight": round(sum(i["computed_weight"] for i in items), 2),
        }
        for b, items in sorted(extra_brand_map.items())
    ]

    # ── Машинд төлөвлөсөн брендүүд (статусаас үл хамаарна) ──
    plans = db.query(POShipmentBrand).filter(POShipmentBrand.purchase_order_id == order_id).all()
    shipment_ids = {sh.id for sh in shipments}
    plan_by_brand = {pb.brand: pb.shipment_id for pb in plans if pb.shipment_id in shipment_ids}
    status_by_brand = {b["brand"]: b["brand_status"] for b in brands_list}
    for b in brands_list:
        b["plan_shipment_id"] = plan_by_brand.get(b["brand"])

    # ── Брендийн ачигдаагүй үлдэгдэл (захиалга − бүх машинд ачигдсан) ──
    remain_by_brand: dict[str, dict] = {}
    for l in active_lines:
        if l.order_qty_box <= 0:
            continue
        remaining = l.order_qty_box - assigned_map.get(l.id, 0)
        if remaining <= 0.001:
            continue
        p = products.get(l.product_id)
        if not p:
            continue
        b = (l.override_brand or "").strip() or p.brand or "Брэнд байхгүй"
        rb = remain_by_brand.setdefault(b, {"boxes": 0.0, "weight": 0.0, "freight": {}, "items": []})
        w = remaining * float(p.pack_ratio or 1) * float(p.unit_weight or 0)
        rb["boxes"] += remaining
        rb["weight"] += w
        fc = freight_of.get(p.item_code, "")
        rb["freight"][fc] = rb["freight"].get(fc, 0.0) + w
        rb["items"].append({"item_code": p.item_code, "name": p.name,
                            "remaining_boxes": round(remaining, 1), "weight": round(w, 2)})

    # «Ачигдсан» ангилал: брендийн статус ачигдаж байна ба түүнээс хойш
    LOADED_STATUSES = {"loading", "transit", "arrived", "accounting", "confirmed", "received", "partial", "loaded"}

    # ── Shipments with per-brand breakdown ──
    active_line_by_id = {l.id: l for l in active_lines}
    shipments_out = []
    for sh in shipments:
        v = vehicle_map.get(sh.vehicle_id) if sh.vehicle_id else None
        sh_lines = [sl for sl in all_ship_lines if sl.shipment_id == sh.id]
        sh_brand_map: dict[str, dict] = {}
        sh_freight: dict[str, float] = {}
        total_weight = 0.0

        def _row(b: str) -> dict:
            if b not in sh_brand_map:
                st = status_by_brand.get(b, "")
                sh_brand_map[b] = {"brand": b, "loaded_boxes": 0.0, "received_boxes": 0.0, "weight": 0.0, "line_count": 0,
                                   "planned_boxes": 0.0, "planned": plan_by_brand.get(b) == sh.id,
                                   "brand_status": st, "brand_status_label": STATUS_LABEL.get(st, st)}
            return sh_brand_map[b]

        # Бодит ачилт (POShipmentLine)
        for sl in sh_lines:
            pl = active_line_by_id.get(sl.po_line_id)
            if not pl:
                continue
            p = products.get(pl.product_id)
            if not p:
                continue
            b = (pl.override_brand or "").strip() or p.brand or "Брэнд байхгүй"
            w = sl.loaded_qty_box * float(p.pack_ratio or 1) * float(p.unit_weight or 0)
            total_weight += w
            fc = freight_of.get(p.item_code, "")
            sh_freight[fc] = sh_freight.get(fc, 0.0) + w
            r = _row(b)
            r["loaded_boxes"] += sl.loaded_qty_box
            r["received_boxes"] += sl.received_qty_box
            r["weight"] += w
            r["line_count"] += 1

        # Төлөвлөсөн брендүүдийн ачигдаагүй үлдэгдэл
        for b, sid in plan_by_brand.items():
            if sid != sh.id or status_by_brand.get(b) == "cancelled":
                continue
            r = _row(b)
            rb = remain_by_brand.get(b)
            if rb:
                r["planned_boxes"] += rb["boxes"]
                r["weight"] += rb["weight"]
                total_weight += rb["weight"]
                for fc, w in rb["freight"].items():
                    sh_freight[fc] = sh_freight.get(fc, 0.0) + w

        loaded_w = planned_w = 0.0
        for r in sh_brand_map.values():
            r["category"] = "loaded" if (r["loaded_boxes"] > 0 or r["brand_status"] in LOADED_STATUSES) else "planned"
            r["loaded_boxes"] = round(r["loaded_boxes"], 1)
            r["planned_boxes"] = round(r["planned_boxes"], 1)
            r["weight"] = round(r["weight"], 1)
            if r["category"] == "loaded":
                loaded_w += r["weight"]
            else:
                planned_w += r["weight"]

        cap_kg = float(v.capacity_kg) if v else 0
        shipments_out.append({
            "id": sh.id,
            "vehicle_id": sh.vehicle_id,
            "vehicle_name": f"{v.name} ({v.plate})" if v else None,
            "driver_name": v.driver_name if v else None,
            "capacity_kg": cap_kg,
            "status": sh.status,
            "status_label": SHIPMENT_STATUS_LABEL.get(sh.status, sh.status),
            "brands": sorted(sh_brand_map.values(), key=lambda x: (x["category"] != "loaded", x["brand"])),
            "total_loaded_boxes": round(sum(sl.loaded_qty_box for sl in sh_lines), 1),
            "total_boxes": round(sum(r["loaded_boxes"] + r["planned_boxes"] for r in sh_brand_map.values()), 1),
            "total_weight": round(total_weight, 1),
            "loaded_weight": round(loaded_w, 1),
            "planned_weight": round(planned_w, 1),
            "capacity_pct": round(total_weight / cap_kg * 100, 1) if cap_kg > 0 else 0,
            "freight": _freight_list(sh_freight, freight_classes),
            "notes": sh.notes or "",
            "vehicle": ({"id": v.id, "name": v.name, "plate": v.plate or "", "capacity_kg": float(v.capacity_kg or 0),
                         "driver_name": v.driver_name or "", "driver_phone": v.driver_phone or "", "is_active": bool(v.is_active)} if v else None),
        })

    # ── Машинд хуваарилаагүй (төлөвлөөгүй) брендүүдийн үлдэгдэл ──
    unloaded_list = []
    pool_freight: dict[str, float] = {}
    for b, rb in sorted(remain_by_brand.items()):
        if b in plan_by_brand:
            continue
        for fc, w in rb["freight"].items():
            pool_freight[fc] = pool_freight.get(fc, 0.0) + w
        unloaded_list.append({"brand": b, "total_remaining_boxes": round(rb["boxes"], 1), "total_weight": round(rb["weight"], 1),
                              "items": rb["items"], "orderer": brand_orderer.get(b, ""), "customer_code": brand_customer.get(b)})

    active_brands = [b for b in brands_list if b["brand_status"] != "cancelled" and b["total_order_boxes"] > 0]

    return {
        "order": {
            "id": po.id,
            "order_date": po.order_date.isoformat(),
            "status": po.status,
            "status_label": STATUS_LABEL.get(po.status, po.status),
            "notes": po.notes or "",
        },
        "summary": {
            "total_brands": len(active_brands),
            "total_boxes": round(sum(b["total_order_boxes"] for b in active_brands), 1),
            "total_weight": round(sum(b["total_weight"] for b in active_brands), 1),
            "total_estimated_cost": round(sum(b["estimated_cost"] for b in active_brands), 2),
            "cancelled_lines": cancelled_lines,
            "cancelled_brands": cancelled_brands_count,
        },
        "brands": brands_list,
        "extra_brands": extra_brands,
        "shipments": shipments_out,
        "unloaded_pool": {
            "brands": unloaded_list,
            "total_remaining_boxes": round(sum(ub["total_remaining_boxes"] for ub in unloaded_list), 1),
            "total_weight": round(sum(ub["total_weight"] for ub in unloaded_list), 1),
            "freight": _freight_list(pool_freight, freight_classes),
        },
        "orderers": {"names": orderer_names(db), "unassigned_label": UNASSIGNED},
        "freight_classes": freight_classes,
        "available_vehicles": [
            {"id": v.id, "name": v.name, "plate": v.plate, "is_active": v.is_active, "capacity_kg": float(v.capacity_kg or 0),
             "driver_name": v.driver_name or "", "driver_phone": v.driver_phone or ""}
            for v in db.query(Vehicle).filter(Vehicle.is_active == True).order_by(Vehicle.name).all()
        ],
    }


# ── Per-brand status endpoints ────────────────────────────────────────────────

# ── Статусын ХУРДАН ЗАМ ───────────────────────────────────────────────────────
#
# Статус нь ЗӨВХӨН мэдээллийн шинжтэй. Түүнийг солиход клиент 133 KB-ийн бүтэн
# захиалгыг (хэмжсэнээр 779 мс, брендийн горимд 1,771 мс) дахин татах ёсгүй.
# Гэхдээ клиент таамаглах ч ёсгүй — сервер өөрөө УI-г засах бүрэн мэдээллийг
# буцаана. Дельта биш БҮТЭН зураглал буцаадаг тул хэдэн ч удаа дараалан
# дарсан клиентийн төлөв хазайх боломжгүй.


def _brand_status_map(order_id: int, db: Session) -> dict:
    """Захиалгын БҮХ брендийн статусын зураглал (~25 мөр, хэмжсэнээр 0.6 мс)."""
    rows = db.query(
        PurchaseOrderBrandStatus.brand, PurchaseOrderBrandStatus.status
    ).filter(PurchaseOrderBrandStatus.purchase_order_id == order_id).all()
    return {r[0]: r[1] for r in rows}


def _prefill_unit_prices(db: Session, order_id: int,
                         brand: Optional[str] = None, collect: bool = True) -> list:
    """arrived → accounting шилжилтэд ХООСОН нэгж үнийг сүүлийн авалтын үнээр дүүргэнэ.

    brand=None бол захиалгын БҮХ мөр (захиалгын түвшний advance_status).

    Өмнө нь энэ логик хоёр газар давхардаж, хоёулаа `po.lines`-ыг бүхэлд нь
    залхуугаар татаад (захиалга #106 дээр 22,283 мөр = хэмжсэнээр 421 мс) Python
    дотор шүүдэг байв. Дээрээс нь `Product.id.in_(22,283)` нь SQLite-ийн 32,766
    bind-параметрийн хязгаарын 68% — барааны тоо ~47% өсөхөд хүсэлт УДААШРАХ
    биш, БҮТЭЛГҮЙТЭХ байсан. Одоо шүүлт бүхэлдээ SQL талд.

    Логик нь хуучинтай ЯГ ИЖИЛ:
      · үр дүнгийн бренд = override_brand (зай хассан) байвал тэр, үгүй бол Product.brand
      · барааны бүртгэл олдоогүй мөрийг алгасана       -> INNER JOIN өөрөө хаснa
      · зөвхөн unit_price = 0 ба last_purchase_price > 0 мөрийг хөнднө
    40 захиалгын 800 (захиалга x бренд) хосыг хуучин кодтой тулгаж, зөрүүгүйг баталсан.

    Product.brand-ыг trim ХИЙХГҮЙ: `_ensure_brand_statuses` ба serializer хоёул
    түүхий Product.brand-аар түлхүүрлэдэг тул "ACME" ба "ACME " нь хууль ёсны
    хоёр өөр бренд байж болно. trim нэмбэл нэг брендийг дэвшүүлэхэд НӨГӨӨГИЙН
    мөрөнд үнэ бичих болно.

    Буцаах: [{line_id, product_id, unit_price}] — клиент захиалгыг дахин
    ТАТАХГҮЙГЭЭР өөрийн `order.lines`-ынхаа үнийг тулгах жагсаалт. Зөвхөн
    клиентэд ХАРАГДДАГ мөрийг (тоо > 0) буцаана: бичилт нь бүх мөрд хийгдэнэ
    (зан төлөв хэвээр), харин хариунд 890 мөр явуулж "890 мөрийн үнэ бөглөгдлөө"
    гэж хэлбэл хэрэглэгч 8 мөр өөрчлөгдөхийг хараад төөрөлдөнө.
    """
    eff_brand = func.coalesce(
        func.nullif(func.trim(PurchaseOrderLine.override_brand), ""), Product.brand
    )
    q = (
        db.query(PurchaseOrderLine, Product.last_purchase_price)
        .join(Product, Product.id == PurchaseOrderLine.product_id)
        .filter(
            PurchaseOrderLine.purchase_order_id == order_id,
            func.coalesce(PurchaseOrderLine.unit_price, 0) == 0,
            func.coalesce(Product.last_purchase_price, 0) > 0,
        )
    )
    if brand is not None:
        q = q.filter(eff_brand == brand)

    updates = []
    for line, last_price in q.all():
        line.unit_price = float(last_price)
        if collect and ((line.order_qty_box or 0) > 0 or (line.supplier_qty_box or 0) > 0):
            updates.append({
                "line_id": int(line.id),
                "product_id": int(line.product_id),
                "unit_price": float(last_price),
            })
    return updates


@router.patch("/{order_id}/brand-advance")
def advance_brand_status(
    order_id: int,
    request: Request,
    brand: str = Query(...),
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Тухайн брендийн статусыг дараагийн stage руу шилжүүлнэ."""

    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")

    bs = db.query(PurchaseOrderBrandStatus).filter(
        PurchaseOrderBrandStatus.purchase_order_id == order_id,
        PurchaseOrderBrandStatus.brand == brand,
    ).first()
    if not bs:
        # Мөр байхгүй бол ҮҮСГЭНЭ (өмнө нь 404 өгдөг байсан). Статусын мөр нь
        # зөвхөн захиалга өгсөн брендэд үүсдэг тул шинээр бараа нэмсэн бренд
        # мөргүй үлдэж, хэзээ ч шилжиж чадахгүй гацдаг байв.
        bs = PurchaseOrderBrandStatus(
            purchase_order_id=order_id, brand=brand, status=po.status)
        db.add(bs)
        db.flush()

    next_st = _next_status(bs.status)
    if not next_st:
        raise HTTPException(400, "Эцсийн статуст хүрсэн")

    # Эрхийн шалгалт — advance_status-тай ЯГ ижил ЗӨВШӨӨРӨХ жагсаалт.
    #
    # Өмнө нь энэ функц ХОРИГЛОХ жагсаалт ашигладаг байсан: зөвхөн
    # `u.role == "warehouse_clerk"`-ийг хориглоод бусдыг бүгдийг нь
    # зөвшөөрдөг байв. Энэ нь хоёр нүхтэй:
    #   1. Захиалгат role-ууд (driver, aguulah_tuslah — хоёулаа
    #      base_role=warehouse_clerk) шалгалтыг ДАВЖ гардаг байсан, учир нь
    #      тэдний `role` тэмдэгт мөр нь "warehouse_clerk" биш.
    #   2. Огт мэдэгдээгүй role бүр зөвшөөрөгддөг байв.
    # deps.require_role-той адилаар base_role-оор шийднэ.
    effective = _eff_role(u)
    allowed_roles = ["manager", "supervisor", "admin"]
    if bs.status in ("accounting", "confirmed"):
        allowed_roles.append("accountant")
    if effective not in allowed_roles:
        raise HTTPException(403, "Энэ үйлдлийг хийх эрх байхгүй")

    # Side effect: arrived → accounting → энэ брендийн хоосон үнийг дүүргэнэ.
    price_updates: list = []
    if bs.status == "arrived" and next_st == "accounting":
        price_updates = _prefill_unit_prices(db, order_id, brand=brand)

    old_status = bs.status
    bs.status = next_st
    audit(db, request, u,
          action="po_brand_advance",
          entity_type="purchase_order_brand_status",
          entity_id=int(bs.id),
          parent_type="purchase_order",
          parent_id=int(po.id),
          before={"brand": brand, "status": old_status},
          after={"brand": brand, "status": next_st})
    db.commit()

    _sync_po_status_from_brands(order_id, db)

    # Клиент захиалгыг ДАХИН УНШИХГҮЙГЭЭР store-оо засах бүрэн мэдээлэл.
    # brand_statuses нь дельта биш БҮТЭН зураглал — олон дарахад хазайхгүй.
    return {
        "brand": brand,
        "new_status": next_st,
        "new_status_label": STATUS_LABEL.get(next_st, next_st),
        "po_status": po.status,
        "po_status_label": STATUS_LABEL.get(po.status, po.status),
        "brand_statuses": _brand_status_map(order_id, db),
        "price_updates": price_updates,
        "price_updated_count": len(price_updates),
    }


@router.get("/{order_id}/brand-detail")
def get_brand_detail(
    order_id: int,
    brand: str = Query(...),
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Тухайн брендийн дэлгэрэнгүй мэдээлэл (filtered detail)."""

    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")

    bs = db.query(PurchaseOrderBrandStatus).filter(
        PurchaseOrderBrandStatus.purchase_order_id == order_id,
        PurchaseOrderBrandStatus.brand == brand,
    ).first()

    brand_status = bs.status if bs else po.status

    # Зөвхөн энэ брендийн мөрүүдийг serializer дотор SQL-ээр шүүнэ (өмнө нь бүх
    # 22 мянган мөрийг боловсруулаад дараа нь хаядаг байсан). Нийт дүн (тооцоолсон
    # дүн, үнэ зөрсөн тоо) нь хуудсан дээрх хайрцаг/жингийн адил БРЕНДИЙН дүн болно.
    detail = _serialize_order_detail(po, db, brand=brand)
    detail["lines"] = [l for l in detail["lines"] if l["brand"] == brand]
    detail["brand_filter"] = brand
    detail["brand_status"] = brand_status
    detail["brand_next_status"] = _next_status(brand_status)
    detail["brand_next_status_label"] = STATUS_LABEL.get(_next_status(brand_status) or "", "")

    return _detail_response(detail)


# Брэндгүй барааг нэгтгэлд эндээр нэрлэнэ (жинхэнэ бренд БИШ).
NO_BRAND_LABEL = "Брэнд байхгүй"


@router.get("/{order_id}/unordered")
def get_unordered_lines(
    order_id: int,
    brand: Optional[str] = Query(None, description="Хоосон бол брендээр НЭГТГЭСЭН тоо; өгвөл тухайн брендийн жагсаалт"),
    q: Optional[str] = Query(None, description="Код/нэрээр шүүх"),
    limit: int = Query(500, ge=1, le=2000),
    offset: int = Query(0, ge=0, description="Хуудаслалт. Эрэмбэ давхцалгүй тул алгасалт аюулгүй"),
    flat: bool = Query(False, description="True бол брендээр шүүхгүй — БҮХ брендээс хавтгай жагсаалт"),
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Захиалгад ОРООГҮЙ (тоо = 0) барааг брендээр нэгтгэж/жагсаана.

    Яагаад тусдаа зам вэ:
      · preparing-ээс бусад бүх статуст `_serialize_order_detail` тоо=0 мөрийг
        ХАЯДАГ тул үндсэн хариунаас эдгээрийг олж харах боломжгүй;
      · үндсэн хариунд нэмэх нь болохгүй — frontend-ийн `saveLines` нь
        `order.lines`-ыг бүхэлд нь буцааж илгээдэг тул хадгалалт бүр мянган
        тэг мөр бичих болно;
      · залхуу (lazy) татдаг тул 22 мянган мөртэй захиалгын ачаалалт удаашрахгүй.

    Гурван горим:
      brand=None, flat=False → {total, brands:[{brand,count}]}   — нэгтгэл
      brand="X"              → тухайн брендийн жагсаалт
      flat=True              → БҮХ брендээс хавтгай жагсаалт (мөр бүр brand-тай)

    Хавтгай горим яагаад хэрэгтэй вэ: 471 бренд байхад хэрэглэгчийн бодол
    "энэ кодыг захиалъя" болохоос "энэ брендийг нээе" биш. `base` нь аль
    хэдийн брендээс хамааралгүй тул нэмэлт зардал байхгүй — хэмжсэнээр
    хавтгай хайлт нэг брендийнхтэй ижил (0.077с).

    `total` нь ЗӨВХӨН эхний хуудсанд (offset == 0) бодогдоно — шүүлтгүй
    COUNT(*) нь 2.8 секунд иддэг тул хуудас тутамд давтах нь хэрэггүй.
    offset > 0 үед total = -1 ирнэ; клиент өмнөх утгаа хадгална.
    """
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    if po.is_archived and _eff_role(u) not in ("admin", "manager", "supervisor"):
        raise HTTPException(403, "Архивлагдсан захиалгыг харах эрхгүй")

    # Захиалгад ороогүй = тоо ч, нийлүүлэгчийн тоо ч 0 (detail-ийн шүүлттэй ижил)
    base = (
        db.query(PurchaseOrderLine, Product)
        .join(Product, Product.id == PurchaseOrderLine.product_id)
        .filter(
            PurchaseOrderLine.purchase_order_id == order_id,
            func.coalesce(PurchaseOrderLine.order_qty_box, 0) <= 0,
            func.coalesce(PurchaseOrderLine.supplier_qty_box, 0) <= 0,
        )
    )
    # warehouse_clerk зөвхөн өөрийн агуулахын бараа
    clerk_tags = parse_tag_ids(u.tag_ids) if _eff_role(u) == "warehouse_clerk" else None
    # `is not None` — `if clerk_tags:` байсан үед агуулах ОЛГООГҮЙ clerk нь
    # шүүлтгүй үлдэж БҮХ агуулахын барааг хардаг байв. Хоосон жагсаалт нь
    # "бүгд" биш "юу ч биш" гэсэн утгатай.
    if clerk_tags is not None:
        base = base.filter(
            (Product.warehouse_tag_id == 0) | (Product.warehouse_tag_id.in_(clerk_tags))
        )

    # override_brand-ыг харгалзсан ҮР ДҮНГИЙН бренд (SQL дотор — Python давталтгүй).
    # Нэгтгэл ба жагсаалт ХОЁУЛАА үүнийг хэрэглэнэ.
    eff = func.coalesce(
        func.nullif(func.trim(PurchaseOrderLine.override_brand), ""), Product.brand
    )

    if brand is None and not flat:
        # Нэгтгэл: бренд бүрийн ороогүй барааны тоо.
        # trim-ийг SQL талд хийнэ. Өмнө нь `group_by(eff)` + Python `.strip()`
        # байсан тул "A" ба "A " хоёр тусдаа бүлэг болоод клиент дээр нэг
        # түлхүүр рүү дарагдаж, нэгтгэлийн тоо жагсаалтынхтай зөрдөг байв.
        gb = func.trim(eff)
        rows = (
            base.with_entities(gb.label("brand"), func.count(PurchaseOrderLine.id))
            .group_by(gb).all()
        )
        out = [{"brand": (r[0] or "").strip() or NO_BRAND_LABEL, "count": int(r[1] or 0)} for r in rows]
        out.sort(key=lambda x: -x["count"])
        return JSONResponse(content={"total": sum(x["count"] for x in out), "brands": out})

    # ── Жагсаалт ──
    if flat:
        if brand is not None:
            raise HTTPException(400, "flat ба brand-ыг зэрэг өгөх боломжгүй")
        # Брендээр шүүхгүй. `base` нь аль хэдийн брендээс хамааралгүй.
        qry = base
    elif brand == NO_BRAND_LABEL:
        # Брэндгүй бараанд нэгтгэл нь "Брэнд байхгүй" гэсэн ЖИНХЭНЭ БУС нэр
        # өгдөг тул түүгээр шүүвэл юу ч олдохгүй — NULL/хоосон гэж тусад нь.
        qry = base.filter((eff.is_(None)) | (func.trim(eff) == ""))
    else:
        # trim: нэгтгэл нь SQL талд trim хийдэг тул жагсаалт нь ч ижил байх ёстой.
        qry = base.filter(func.trim(eff) == brand.strip())

    if q:
        like = f"%{q.strip()}%"
        qry = qry.filter((Product.item_code.ilike(like)) | (Product.name.ilike(like)))

    total = qry.count() if offset == 0 else -1

    # Хавтгай горимд эхлээд брендээр эрэмбэлнэ — эс тэгвээс 200 мөрөнд 150
    # бренд тарж, жагсаалт уншигдахгүй болно. (eff, item_code) нь давхцалгүй.
    order_cols = (func.trim(eff), Product.item_code) if flat else (Product.item_code,)
    rows = qry.order_by(*order_cols).offset(offset).limit(limit).all()

    from app.services.balance_stock import get_location_stock_map
    balance_map = get_location_stock_map(db, po.location or "warehouse")

    items = []
    for l, p in rows:
        pack = float(p.pack_ratio or 1) or 1.0
        s_qty = float(balance_map.get(p.item_code, 0.0))
        # brand     = override_brand-ыг харгалзсан ҮР ДҮНГИЙН бренд (UI бүлэглэлт)
        # raw_brand = Product.brand — `set_lines`-ийн статусын маск ҮҮГЭЭР
        #             сонгогддог (мөр ~1511). Зөвхөн нэгийг нь шалгавал
        #             override_brand-тай мөрд UI зөвшөөрч, backend чимээгүй
        #             хаяад {"ok": true} буцаана.
        _ov = (l.override_brand or "").strip()
        items.append({
            "product_id": p.id,
            "line_id": l.id,
            "item_code": p.item_code,
            "name": p.name,
            "brand": (_ov or (p.brand or "").strip()) or NO_BRAND_LABEL,
            "raw_brand": (p.brand or "").strip() or NO_BRAND_LABEL,
            "warehouse_name": p.warehouse_name or "",
            "price_tag": p.price_tag or "",
            "pack_ratio": pack,
            "unit_weight": float(p.unit_weight or 0),
            "stock_qty": s_qty,
            "stock_box": int(s_qty // pack) if pack > 0 else 0,
            "last_purchase_price": float(p.last_purchase_price or 0),
        })
    return JSONResponse(content={
        "brand": brand, "flat": flat, "total": total,
        "offset": offset, "shown": len(items), "items": items,
    })


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


def _compute_po_dashboard_stats(db: Session) -> dict:
    """Захиалгын хураангуй статистик (cache-д тооцоолох цөм)."""
    orders = db.query(PurchaseOrder).order_by(PurchaseOrder.order_date.desc()).all()

    by_status: dict[str, int] = {s: 0 for s in STATUS_SEQUENCE}
    active_weight = 0.0
    active_boxes = 0.0
    transit_weight = 0.0
    transit_boxes = 0.0
    latest_active: Optional[dict] = None

    # Захиалга бүрийн жин/хайрцгийг НЭГ SQL нэгтгэлээр урьдчилан бодно.
    # Өмнө нь давталт дотор `o.lines` lazy-load хийж 1,374,185 мөрийг ORM
    # объект болгодог байсан — хэмжихэд 45.98 СЕКУНД. Энэ функц 90 секунд
    # тутам ард ажилладаг тул бүх хүсэлтийн CPU-г идэж байв.
    _agg = {
        row[0]: (float(row[1] or 0), float(row[2] or 0))
        for row in db.query(
            PurchaseOrderLine.purchase_order_id,
            func.sum(PurchaseOrderLine.computed_weight),
            func.sum(PurchaseOrderLine.order_qty_box),
        ).group_by(PurchaseOrderLine.purchase_order_id).all()
    }

    for o in orders:
        by_status[o.status] = by_status.get(o.status, 0) + 1
        order_weight, order_boxes = _agg.get(o.id, (0.0, 0.0))
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


dashboard_cache.register("po_dashboard_stats", _compute_po_dashboard_stats)


@router.get("/dashboard-stats")
def purchase_order_dashboard_stats(
    _: User = Depends(get_current_user),
):
    """Захиалгын хураангуй статистик — cache-аас шууд (бэлэн snapshot)."""
    return dashboard_cache.cached("po_dashboard_stats")


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
    archived: Optional[str] = Query("false"),  # "false" | "true" | "only"
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    q = db.query(PurchaseOrder)

    # warehouse_clerk sees preparing and arrived orders
    if _eff_role(u) == "warehouse_clerk":
        q = q.filter(PurchaseOrder.status.in_(["preparing", "arrived"]))
    # manager/supervisor/admin see all

    # Архив filter:
    # - "false" (default): архив бус
    # - "true": бүгд (архив + бус)
    # - "only": зөвхөн архивлагдсан (admin/manager л хандана)
    arch = (archived or "false").lower()
    if arch == "only":
        if _eff_role(u) not in ("admin", "manager", "supervisor"):
            raise HTTPException(403, "Архив харах эрхгүй")
        q = q.filter(PurchaseOrder.is_archived == True)
    elif arch == "true":
        if _eff_role(u) not in ("admin", "manager", "supervisor"):
            # Admin/manager биш бол архивгүй л буцаана
            q = q.filter(PurchaseOrder.is_archived == False)
    else:
        q = q.filter(PurchaseOrder.is_archived == False)

    if status:
        q = q.filter(PurchaseOrder.status == status)
    if date_from:
        q = q.filter(PurchaseOrder.order_date >= date_from)
    if date_to:
        q = q.filter(PurchaseOrder.order_date <= date_to)

    orders = q.order_by(PurchaseOrder.order_date.desc()).all()
    if not orders:
        return []

    # SQL aggregate for line stats (avoids loading 100K+ lines into memory)
    order_ids = [o.id for o in orders]
    line_stats = {
        row[0]: {"line_count": row[1], "total_boxes": float(row[2] or 0), "total_weight": float(row[3] or 0)}
        for row in db.query(
            PurchaseOrderLine.purchase_order_id,
            func.count(PurchaseOrderLine.id),
            func.sum(PurchaseOrderLine.order_qty_box),
            func.sum(PurchaseOrderLine.computed_weight),
        ).filter(
            PurchaseOrderLine.purchase_order_id.in_(order_ids)
        ).group_by(PurchaseOrderLine.purchase_order_id).all()
    }

    # Bulk load users + vehicles
    user_ids = {o.created_by_user_id for o in orders if o.created_by_user_id}
    vehicle_ids = {o.vehicle_id for o in orders if o.vehicle_id}
    user_map = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    vehicle_map = {v.id: v for v in db.query(Vehicle).filter(Vehicle.id.in_(vehicle_ids)).all()} if vehicle_ids else {}

    result = []
    for o in orders:
        creator = user_map.get(o.created_by_user_id)
        vehicle = vehicle_map.get(o.vehicle_id)
        stats = line_stats.get(o.id, {"line_count": 0, "total_boxes": 0, "total_weight": 0})
        result.append({
            "id": o.id,
            "order_date": o.order_date.isoformat(),
            "status": o.status,
            "status_label": STATUS_LABEL.get(o.status, o.status),
            "created_by_username": creator.username if creator else "",
            "line_count": stats["line_count"],
            "total_boxes": round(stats["total_boxes"], 2),
            "total_weight": round(stats["total_weight"], 2),
            "created_at": o.created_at.isoformat() if o.created_at else None,
            "vehicle_id": o.vehicle_id,
            "vehicle_name": f"{vehicle.name} ({vehicle.plate})" if vehicle else None,
            "notes": o.notes or "",
            "is_archived": bool(o.is_archived),
        })
    return result


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

    # Note: Нэг өдөр олон захиалга зөвшөөрөгдсөн (duplicate date check устгасан)

    # Create order
    po = PurchaseOrder(
        order_date=body.order_date,
        status="preparing",
        created_by_user_id=u.id,
        notes=body.notes,
        location=("showroom" if body.location == "showroom" else "warehouse"),
        stat_month=(body.stat_month if (body.stat_month and 1 <= body.stat_month <= 12) else None),
    )
    db.add(po)
    db.flush()

    # Load products. Brand filter байвал зөвхөн тэдгээр брендийн бараа л.
    tag_ids = parse_tag_ids(u.tag_ids)
    q = db.query(Product)
    if tag_ids:
        q = q.filter(Product.warehouse_tag_id.in_(tag_ids + [0]))
    selected_brands = [b.strip() for b in (body.brands or []) if b and b.strip()]
    if selected_brands:
        q = q.filter(Product.brand.in_(selected_brands))
    products = q.order_by(Product.brand, Product.item_code).all()

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
    if _eff_role(u) == "warehouse_clerk" and status != "arrived":
        return []

    shipments = (
        db.query(POShipment)
        .filter(POShipment.status == status)
        .order_by(POShipment.created_at.desc())
        .all()
    )

    # Bulk load POs and Vehicles to avoid N+1
    po_ids = {sh.purchase_order_id for sh in shipments}
    vehicle_ids = {sh.vehicle_id for sh in shipments if sh.vehicle_id}
    po_map = {po.id: po for po in db.query(PurchaseOrder).filter(PurchaseOrder.id.in_(po_ids)).all()} if po_ids else {}
    vehicle_bulk = {v.id: v for v in db.query(Vehicle).filter(Vehicle.id.in_(vehicle_ids)).all()} if vehicle_ids else {}

    # Vehicle-аар групплэх
    vehicle_groups: dict[int | None, list] = {}
    for sh in shipments:
        po = po_map.get(sh.purchase_order_id)
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
        vehicle = vehicle_bulk.get(vid) if vid else None
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

    # Архивлагдсан захиалгыг зөвхөн admin/manager/supervisor л харна
    if po.is_archived and _eff_role(u) not in ("admin", "manager", "supervisor"):
        raise HTTPException(403, "Архивлагдсан захиалгыг харах эрхгүй")

    # warehouse_clerk can only see preparing and arrived orders
    if _eff_role(u) == "warehouse_clerk" and po.status not in ("preparing", "arrived"):
        raise HTTPException(403, "Энэ захиалгыг харах эрх байхгүй")

    # warehouse_clerk sees only products from their assigned warehouses
    _eff = _eff_role(u)
    filter_tag_ids = parse_tag_ids(u.tag_ids) if _eff == "warehouse_clerk" else None
    # Тоо оруулах горим (нярав + preparing) дээр л бүх мөрийг илгээнэ.
    need_all = (_eff == "warehouse_clerk" and po.status == "preparing")
    return _detail_response(_serialize_order_detail(
        po, db, filter_tag_ids=filter_tag_ids, all_lines_at_preparing=need_all))


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
    if _eff_role(u) not in allowed_roles:
        raise HTTPException(403, "Энэ үйлдлийг хийх эрх байхгүй")

    # arrived → accounting: хоосон нэгж үнийг сүүлийн авалтын үнээр дүүргэнэ.
    # Өмнө нь энд бас `Product.id.in_(бүх мөрийн id)` байсан — SQLite-ийн 32,766
    # bind-параметрийн хязгаарт ойрхон (одоо 22,283 = 68%). collect=False —
    # захиалгын түвшний зам буцаах жагсаалтыг ашигладаггүй тул мянга мянган
    # dict үүсгэх шаардлагагүй.
    po_price_updates: list = []
    if po.status == "arrived" and next_st == "accounting":
        po_price_updates = _prefill_unit_prices(db, order_id, brand=None)

    po.status = next_st

    # Batch advance all brand statuses that are at the old PO status
    old_st = STATUS_SEQUENCE[STATUS_SEQUENCE.index(next_st) - 1]
    brand_rows = db.query(PurchaseOrderBrandStatus).filter(
        PurchaseOrderBrandStatus.purchase_order_id == order_id,
        PurchaseOrderBrandStatus.status == old_st,
    ).all()
    for bs in brand_rows:
        bs.status = next_st

    db.commit()
    # Клиент захиалгыг дахин уншихгүйгээр store-оо засах бүрэн мэдээлэл
    return {
        "ok": True,
        "new_status": next_st,
        "new_status_label": STATUS_LABEL.get(next_st, next_st),
        "po_status": po.status,
        "po_status_label": STATUS_LABEL.get(po.status, po.status),
        "brand_statuses": _brand_status_map(order_id, db),
        "price_updates": po_price_updates,
        "price_updated_count": len(po_price_updates),
    }


class ForceStatusIn(BaseModel):
    status: str


class ArchiveIn(BaseModel):
    archived: bool = True


@router.patch("/{order_id}/archive")
def archive_order(
    order_id: int,
    body: ArchiveIn,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "manager", "supervisor")),
):
    """Захиалгыг архивлах / архиваас буцаах. Admin, manager, supervisor."""
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    old_archived = bool(po.is_archived)
    new_archived = bool(body.archived)
    po.is_archived = new_archived
    if old_archived != new_archived:
        audit(db, request, u,
              action="po_archive" if new_archived else "po_unarchive",
              entity_type="purchase_order",
              entity_id=int(po.id),
              parent_type="purchase_order",
              parent_id=int(po.id),
              before={"is_archived": old_archived},
              after={"is_archived": new_archived})
    db.commit()
    return {"ok": True, "is_archived": po.is_archived}

@router.patch("/{order_id}/force-status")
def force_status(
    order_id: int,
    body: ForceStatusIn,
    request: Request,
    brand: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    """
    Статус албадан өөрчлөх.
    - brand параметргүй: бүх бренд + PO status шинэчилнэ.
    - brand='X': зөвхөн тухайн брендийн статус өөрчилнэ, PO status нь brand-уудын минимумаас тооцоологдоно.
    """
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    if body.status not in STATUS_SEQUENCE:
        raise HTTPException(400, "Буруу статус")

    if brand:
        bs = db.query(PurchaseOrderBrandStatus).filter(
            PurchaseOrderBrandStatus.purchase_order_id == order_id,
            PurchaseOrderBrandStatus.brand == brand,
        ).first()
        if not bs:
            # Мөн адил: байхгүй бол үүсгэнэ, 404 өгөхгүй.
            bs = PurchaseOrderBrandStatus(
                purchase_order_id=order_id, brand=brand, status=po.status)
            db.add(bs)
            db.flush()
        old_status = bs.status
        bs.status = body.status
        audit(db, request, u,
              action="po_force_status_brand",
              entity_type="purchase_order_brand_status",
              entity_id=int(bs.id),
              parent_type="purchase_order",
              parent_id=int(po.id),
              before={"brand": brand, "status": old_status},
              after={"brand": brand, "status": body.status})
        db.commit()
        _sync_po_status_from_brands(order_id, db)
        return {
            "ok": True,
            "brand": brand,
            "new_status": body.status,
            "new_status_label": STATUS_LABEL.get(body.status, body.status),
            "po_status": po.status,
            "po_status_label": STATUS_LABEL.get(po.status, po.status),
            # Бүтэн зураглал — клиент захиалгыг дахин уншихгүйгээр store-оо засна
            "brand_statuses": _brand_status_map(order_id, db),
            "price_updates": [],
            "price_updated_count": 0,
        }

    # Бүх бренд + PO status нэг утгад шилжүүлэх
    old_po_status = po.status
    po.status = body.status
    brand_changes = []
    for bs in db.query(PurchaseOrderBrandStatus).filter(
        PurchaseOrderBrandStatus.purchase_order_id == order_id
    ).all():
        brand_changes.append({"brand": bs.brand, "from": bs.status, "to": body.status})
        bs.status = body.status
    audit(db, request, u,
          action="po_force_status_all",
          entity_type="purchase_order",
          entity_id=int(po.id),
          parent_type="purchase_order",
          parent_id=int(po.id),
          before={"status": old_po_status},
          after={"status": body.status},
          extra={"brand_changes": brand_changes})
    db.commit()
    return {
        "ok": True,
        "new_status": po.status,
        "new_status_label": STATUS_LABEL.get(po.status, po.status),
        "po_status": po.status,
        "po_status_label": STATUS_LABEL.get(po.status, po.status),
        "brand_statuses": _brand_status_map(order_id, db),
        "price_updates": [],
        "price_updated_count": 0,
    }


@router.post("/{order_id}/set-lines")
def set_lines(
    order_id: int,
    lines: List[POLineIn],
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    # warehouse_clerk — preparing + arrived; accountant — accounting; admin — all editable;
    # manager/supervisor — preparing, reviewing, loading + accounting (for unit_price editing)
    _eff = _eff_role(u)
    if _eff == "warehouse_clerk":
        allowed_statuses = ["preparing", "arrived"]
    elif _eff == "accountant":
        allowed_statuses = ["accounting"]
    elif _eff == "admin":
        allowed_statuses = ["preparing", "reviewing", "loading", "arrived", "accounting"]
    else:
        allowed_statuses = ["preparing", "reviewing", "loading", "accounting"]
    # Per-brand status lookup
    brand_status_map: dict[str, str] = {}
    for bs in db.query(PurchaseOrderBrandStatus).filter(
        PurchaseOrderBrandStatus.purchase_order_id == order_id
    ).all():
        brand_status_map[bs.brand] = bs.status

    # Админ бүх статуст засварлана — статус солигдоход ажил гацахгүй байх
    # шаардлага (хэрэглэгчийн хүсэлт). base_role-ыг ч шалгана: захиалгат
    # нэртэй role (жишээ "Ерөнхий админ") admin суурьтай байж болно.
    is_admin = _eff_role(u) == "admin"

    # PO-level check (fallback for backward compat)
    if not is_admin and po.status not in allowed_statuses:
        # Per-brand: any brand in an allowed status?
        has_allowed_brand = any(s in allowed_statuses for s in brand_status_map.values())
        if not has_allowed_brand:
            raise HTTPException(400, "Энэ статуст тоо өөрчлөх боломжгүй")

    # Permission check
    if _eff_role(u) not in ("manager", "warehouse_clerk", "admin", "supervisor", "accountant"):
        raise HTTPException(403, "Энэ үйлдлийг хийх эрх байхгүй")

    # warehouse_clerk restricted to their assigned warehouses
    clerk_tag_ids = parse_tag_ids(u.tag_ids) if _eff_role(u) == "warehouse_clerk" else None

    # Build lookup map for existing lines
    line_map = {l.product_id: l for l in po.lines}

    # ── Брэнд тус бүрийн захиалгын нийт тоог (өмнө) хадгална — "брэнд 0 болгосон"
    #    үйлдлийг илрүүлж audit-д бичихэд ашиглана ──
    _line_prod = {
        p.id: p for p in db.query(Product).filter(
            Product.id.in_([l.product_id for l in po.lines])
        ).all()
    } if po.lines else {}

    def _brand_totals() -> dict[str, list]:
        """{brand: [нийт_qty_box, мөрийн_тоо]}"""
        out: dict[str, list] = {}
        for l in po.lines:
            pr = _line_prod.get(l.product_id)
            br = (pr.brand if pr else "") or "(брэндгүй)"
            agg = out.setdefault(br, [0.0, 0])
            agg[0] += float(l.order_qty_box or 0)
            agg[1] += 1
        return out

    brand_before = _brand_totals()

    # Audit log хадгалах: өөрчлөгдсөн line бүрт өмнөх ба шинэ snapshot
    audit_entries: list[dict] = []
    # Хуучирсан хуудаснаас ирсэн (өөр хүн завсар нь өөрчилсөн) мөрүүд — хөндөхгүй
    conflicts: list[dict] = []

    def _snapshot(ln: PurchaseOrderLine) -> dict:
        """Audit-д хадгалах гол талбаруудыг dict болгож буцаана."""
        return {
            "order_qty_box": float(ln.order_qty_box or 0),
            "order_qty_pcs": float(ln.order_qty_pcs or 0),
            "supplier_qty_box": float(ln.supplier_qty_box or 0),
            "loaded_qty_box": float(ln.loaded_qty_box or 0),
            "received_qty_box": float(ln.received_qty_box or 0),
            "received_qty_extra_pcs": float(ln.received_qty_extra_pcs or 0),
            "unit_price": float(ln.unit_price or 0),
            "line_remark": ln.line_remark or "",
        }

    for li in lines:
        if li.product_id not in line_map:
            continue
        p = db.query(Product).filter(Product.id == li.product_id).first()
        if not p:
            continue
        # Clerk cannot update products outside their warehouses.
        if clerk_tag_ids and p.warehouse_tag_id != 0 and p.warehouse_tag_id not in clerk_tag_ids:
            continue
        line = line_map[li.product_id]

        # Use per-brand status if available, fallback to PO status
        effective_st = brand_status_map.get(p.brand, po.status)

        if (li.expected_order_qty_box is not None and li.order_qty_box is not None
                and abs(float(line.order_qty_box or 0) - float(li.expected_order_qty_box)) > 1e-9
                and abs(float(line.order_qty_box or 0) - float(li.order_qty_box)) > 1e-9):
            conflicts.append({"product_id": int(p.id), "product_name": p.name, "brand": p.brand or "",
                              "server_qty_box": float(line.order_qty_box or 0),
                              "your_qty_box": float(li.order_qty_box), "expected_qty_box": float(li.expected_order_qty_box)})
            continue

        before_snap = _snapshot(line)

        if is_admin:
            # Админ: статусаас үл хамааран ИЛГЭЭСЭН талбарыг бүгдийг бичнэ.
            # Илгээгээгүй (None) талбарыг хөндөхгүй — доорх статусын маск шиг
            # чимээгүй хаяхгүй. Ингэснээр захиалга ямар ч үе шатанд байхад
            # админ засвар хийж чадна.
            if li.order_qty_box is not None:
                qty_box = float(li.order_qty_box)
                line.order_qty_box = qty_box
                line.order_qty_pcs = qty_box * float(p.pack_ratio or 1)
                line.computed_weight = line.order_qty_pcs * float(p.unit_weight or 0)
            if li.supplier_qty_box is not None:
                line.supplier_qty_box = float(li.supplier_qty_box)
            if li.loaded_qty_box is not None:
                new_loaded = float(li.loaded_qty_box)
                line.loaded_qty_box = new_loaded
                sh_lines = db.query(POShipmentLine).filter(
                    POShipmentLine.po_line_id == line.id
                ).all()
                if len(sh_lines) == 1:
                    sh_lines[0].loaded_qty_box = new_loaded
            if li.received_qty_box is not None:
                line.received_qty_box = float(li.received_qty_box)
            if li.received_qty_extra_pcs is not None:
                line.received_qty_extra_pcs = float(li.received_qty_extra_pcs)
            if li.unit_price is not None:
                line.unit_price = float(li.unit_price)
            if li.remark is not None:
                line.line_remark = li.remark
        elif effective_st == "arrived":
            if li.received_qty_box is not None:
                line.received_qty_box = float(li.received_qty_box)
            if li.received_qty_extra_pcs is not None:
                line.received_qty_extra_pcs = float(li.received_qty_extra_pcs)
            if li.remark is not None:
                line.line_remark = li.remark
        elif effective_st == "accounting":
            if li.unit_price is not None:
                line.unit_price = float(li.unit_price)
            if li.received_qty_box is not None:
                line.received_qty_box = float(li.received_qty_box)
            if li.received_qty_extra_pcs is not None:
                line.received_qty_extra_pcs = float(li.received_qty_extra_pcs)
            if li.remark is not None:
                line.line_remark = li.remark
        else:
            # preparing / reviewing / loading — update order qty + derived fields
            # order_qty_box одоо сонголттой: илгээгээгүй бол хуучин утга хэвээр.
            if li.order_qty_box is not None:
                qty_box = float(li.order_qty_box)
                qty_pcs = qty_box * float(p.pack_ratio or 1)
                line.order_qty_box = qty_box
                line.order_qty_pcs = qty_pcs
                line.computed_weight = qty_pcs * float(p.unit_weight or 0)
            if effective_st == "loading":
                if li.supplier_qty_box is not None:
                    line.supplier_qty_box = float(li.supplier_qty_box)
                if li.loaded_qty_box is not None:
                    new_loaded = float(li.loaded_qty_box)
                    line.loaded_qty_box = new_loaded
                    # Хэрэв энэ PO line нь ЯГ НЭГ shipment line дээр байвал тэр дээр ч хадгална
                    # (харин олон хуваагдсан бол shipment detail UI ашиглана)
                    sh_lines = db.query(POShipmentLine).filter(
                        POShipmentLine.po_line_id == line.id
                    ).all()
                    if len(sh_lines) == 1:
                        sh_lines[0].loaded_qty_box = new_loaded

        after_snap = _snapshot(line)
        # Зөвхөн утга нь үнэхээр өөрчлөгдсөн line-уудыг audit-д бичнэ
        if before_snap != after_snap:
            audit_entries.append({
                "action": "po_set_lines",
                "entity_type": "purchase_order_line",
                "entity_id": int(line.id),
                "parent_type": "purchase_order",
                "parent_id": int(po.id),
                "before": before_snap,
                "after": after_snap,
                "extra": {
                    "product_id": int(p.id),
                    "product_name": p.name,
                    "brand": p.brand or "",
                    "effective_status": effective_st,
                },
            })

    # ── Брэнд 0 болгосон эсэхийг илрүүлж audit-д бичих ──
    # Тухайн брэндийн захиалгын нийт тоо >0 байснаа 0 болсон бол (бүх барааны
    # тоог тэглэсэн) тусдаа "po_brand_zeroed" бүртгэл үүсгэнэ.
    brand_after = _brand_totals()
    for br, (before_qty, n_lines) in brand_before.items():
        after_qty = brand_after.get(br, [0.0, 0])[0]
        if before_qty > 0 and after_qty == 0:
            audit_entries.append({
                "action": "po_brand_zeroed",
                "entity_type": "purchase_order",
                "entity_id": int(po.id),
                "parent_type": "purchase_order",
                "parent_id": int(po.id),
                "before": {"brand": br, "total_order_qty_box": round(before_qty, 2), "line_count": n_lines},
                "after":  {"brand": br, "total_order_qty_box": 0.0, "line_count": n_lines},
                "extra":  {"brand": br, "order_date": str(po.order_date) if po.order_date else ""},
            })

    # Audit row-уудыг үндсэн commit-ийн өмнө нэмнэ — ингэснээр transaction
    # нэгдмэл байх ба audit алдагдвал бодит өөрчлөлт ч rollback болно.
    for e in audit_entries:
        audit(db, request, u, **e)

    db.commit()

    # Ensure brand status records exist for any new brands
    _ensure_brand_statuses(order_id, db)
    db.commit()

    if conflicts:
        audit(db, request, u, action="po_set_lines_conflict", entity_type="purchase_order", entity_id=int(po.id),
              parent_type="purchase_order", parent_id=int(po.id), extra={"count": len(conflicts), "items": conflicts[:50]}, autocommit=True)
    return {"ok": True, "conflicts": conflicts, "applied": len(audit_entries)}


@router.delete("/{order_id}")
def delete_order(
    order_id: int,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    # AUDIT — PO өөрийг устгахын өмнө snapshot
    line_count = db.query(PurchaseOrderLine).filter(
        PurchaseOrderLine.purchase_order_id == order_id
    ).count()
    audit(db, request, u,
          action="po_delete",
          entity_type="purchase_order",
          entity_id=int(po.id),
          parent_type="purchase_order",
          parent_id=int(po.id),
          before={
              "id": po.id,
              "order_date": str(po.order_date) if po.order_date else "",
              "status": po.status,
              "notes": po.notes or "",
              "is_archived": bool(po.is_archived),
              "line_count": line_count,
          },
          after=None)
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
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("manager", "admin", "supervisor", "warehouse_clerk")),
):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")

    line = db.query(PurchaseOrderLine).filter(
        PurchaseOrderLine.id == line_id,
        PurchaseOrderLine.purchase_order_id == order_id,
    ).first()
    if not line:
        raise HTTPException(404, "Мөр олдсонгүй")

    # Эрх шалгах: тухайн line-ий brand status-г харгалзана
    product = db.query(Product).filter(Product.id == line.product_id).first()
    brand = product.brand if product else None
    bs = None
    if brand:
        bs = db.query(PurchaseOrderBrandStatus).filter(
            PurchaseOrderBrandStatus.purchase_order_id == order_id,
            PurchaseOrderBrandStatus.brand == brand,
        ).first()
    effective_st = bs.status if bs else po.status

    # warehouse_clerk-д зөвхөн arrived (Ачаа ирсэн) status-д устгах эрх
    # бусад role-д зөвхөн loading status-д устгах эрх
    _is_admin = _eff_role(u) == "admin"
    if _is_admin:
        pass                      # админ бүх статуст устгана
    elif _eff_role(u) == "warehouse_clerk":
        if effective_st != "arrived":
            raise HTTPException(400, "Нярав зөвхөн 'Ачаа ирсэн' статуст мөр устгана")
    else:
        if effective_st not in ("loading", "arrived"):
            raise HTTPException(400, "Зөвхөн 'Ачигдаж байна' болон 'Ачаа ирсэн' статуст мөр устгана")

    # AUDIT — line устгахын өмнө snapshot
    audit(db, request, u,
          action="po_delete_line",
          entity_type="purchase_order_line",
          entity_id=int(line.id),
          parent_type="purchase_order",
          parent_id=int(po.id),
          before={
              "product_id": line.product_id,
              "product_name": product.name if product else "",
              "brand": brand or "",
              "order_qty_box": float(line.order_qty_box or 0),
              "order_qty_pcs": float(line.order_qty_pcs or 0),
              "supplier_qty_box": float(line.supplier_qty_box or 0),
              "loaded_qty_box": float(line.loaded_qty_box or 0),
              "received_qty_box": float(line.received_qty_box or 0),
              "unit_price": float(line.unit_price or 0),
              "effective_status": effective_st,
          },
          after=None)

    # Холбоотой shipment line-уудыг эхлээд устгах (FK clean)
    db.query(POShipmentLine).filter(POShipmentLine.po_line_id == line_id).delete()
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
    # Админ бүх статуст бараа нэмнэ (статусаар гацахгүй байх шаардлага).
    _is_admin = _eff_role(u) == "admin"
    if not _is_admin and po.status not in ("preparing", "loading"):
        raise HTTPException(400, "Энэ статуст бараа нэмэх боломжгүй")
    p = db.query(Product).filter(Product.id == body.product_id).first()
    if not p:
        raise HTTPException(404, "Бараа олдсонгүй")
    existing = next((l for l in po.lines if l.product_id == body.product_id), None)
    # override_brand шалгалт: зөвхөн admin
    override_brand = (body.override_brand or "").strip()
    if override_brand and _eff_role(u) != "admin":
        raise HTTPException(403, "Бусад брендийн бараа нэмэх эрх зөвхөн админ эрхтэй")
    # override тохиолдолд барааны оригинал бренд override_brand-тэй адил байвал утгагүй
    if override_brand and (p.brand or "") == override_brand:
        override_brand = ""
    if existing:
        # Override-той бол давхар мөр зөвшөөрөх боломжтой (нэг бараа давхар брендэд)
        if not override_brand and not (existing.override_brand or ""):
            raise HTTPException(400, "Бараа аль хэдийн нэмэгдсэн байна")
        if override_brand and (existing.override_brand or "") == override_brand:
            raise HTTPException(400, f"Бараа {override_brand} брендэд аль хэдийн нэмэгдсэн байна")
    qty_box = float(body.order_qty_box or 0)
    qty_pcs = qty_box * float(p.pack_ratio or 1)
    weight = qty_pcs * float(p.unit_weight or 0)
    line = PurchaseOrderLine(
        purchase_order_id=order_id,
        product_id=body.product_id,
        order_qty_box=qty_box,
        order_qty_pcs=qty_pcs,
        computed_weight=weight,
        override_brand=override_brand,
    )
    db.add(line)
    db.commit()
    # Override бренд нэмсэн бол тухайн брендэд brand_status үүсгэнэ
    if override_brand:
        _ensure_brand_statuses(order_id, db)
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
    # Клиент захиалгыг дахин уншихгүйгээр store-оо засах бүрэн мэдээлэл
    return {
        "ok": True,
        "new_status": "arrived",
        "new_status_label": STATUS_LABEL["arrived"],
        "po_status": po.status,
        "po_status_label": STATUS_LABEL.get(po.status, po.status),
        "brand_statuses": _brand_status_map(order_id, db),
        "price_updates": [],
        "price_updated_count": 0,
    }


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

    # Load only lines with order_qty > 0 (NOT lazy po.lines)
    export_lines = db.query(PurchaseOrderLine).filter(
        PurchaseOrderLine.purchase_order_id == po.id,
        PurchaseOrderLine.order_qty_box > 0,
    ).all()
    product_ids = [l.product_id for l in export_lines]
    products = db.query(Product).filter(Product.id.in_(product_ids)).all() if product_ids else []
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
    for l in export_lines:
        p = product_map.get(l.product_id)
        if not p:
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
#
# ТООНЫ ЭХ СУРВАЛЖ. Өмнө нь энэ экспорт зөвхөн `ачигдсан > 0` эсвэл `ирсэн > 0`
# мөрийг авдаг байсан. Ачаа хараахан ирээгүй үе шатанд тэдгээр нь бүгд тэг тул
# ЗӨВХӨН ТОЛГОЙ мөртэй хоосон файл татагдаж, хэрэглэгчид ямар ч шалтгаан
# хэлдэггүй байв (хэмжсэн: сүүлийн 12 захиалгын 8 нь ийм байдалтай).
#
# Одоо хэрэглэгч тооны эх сурвалжаа СОНГОНО. Гурван түвшин нь ХООРОНДОО
# ОГТЛОЛЦОХГҮЙ: мөр бүр ганцхан түвшинд харьяалагдана —
#   received — ирсэн тоо бүртгэгдсэн мөр
#   loaded   — ирээгүй ч ачигдсан тоо бүртгэгдсэн мөр
#   ordered  — аль нь ч бүртгэгдээгүй, зөвхөн захиалсан тоотой мөр
# Ингэснээр «ordered» гэж татсан файл дараа нь «received» гэж татсан файлтай
# ДАВХАРДАХГҮЙ. (Шаталсан/floor хувилбар нь ordered ⊃ loaded ⊃ received болж,
# нэг мөрийг Эрхэт рүү хоёр удаа бичих эрсдэлтэй байсан.)

ERP_QTY_SOURCES = ("received", "loaded", "ordered")
ERP_QTY_SOURCE_LABEL = {
    "received": "Ирсэн тоо",
    "loaded": "Ачигдсан тоо",
    "ordered": "Захиалсан тоо",
}
ERP_QTY_SOURCE_SLUG = {"received": "irsen", "loaded": "achigdsan", "ordered": "zahialsan"}


def _erp_line_level(line, agg: dict) -> str:
    """Мөр аль түвшинд харьяалагдахыг тодорхойлно (огтлолцохгүй).

    Дэлгэц дээрх `_serialize_order_detail`-тай ижил дараалал: shipment-ийн
    нийлбэрийг түрүүнд, дараа нь PO мөрийн утгыг харна.
    """
    if (float(agg.get("received", 0)) > 0
            or float(line.received_qty_box or 0) > 0
            or float(line.received_qty_extra_pcs or 0) > 0):
        return "received"
    if float(agg.get("loaded", 0)) > 0 or float(line.loaded_qty_box or 0) > 0:
        return "loaded"
    return "ordered"


def _erp_line_boxes(line, agg: dict, level: str) -> tuple:
    """(хайрцаг, задгай ширхэг) — тухайн түвшний тоо."""
    if level == "received":
        box = float(agg.get("received", 0)) or float(line.received_qty_box or 0)
        return box, float(line.received_qty_extra_pcs or 0)
    if level == "loaded":
        return (float(agg.get("loaded", 0)) or float(line.loaded_qty_box or 0)), 0.0
    # ordered — нийлүүлэгчийн бэлдсэн тоо байвал түүнийг, эс бол захиалсан тоо.
    # ЗӨВХӨН order_qty_box > 0 мөрийг авна: order=0 & supplier>0 нь энэ апп дээр
    # ЦУЦЛАГДСАН мөрийн тэмдэг (get_order_dashboard), түүнийг бичих ёсгүй.
    return float(line.order_qty_box or 0), 0.0


def _erp_price(line, product) -> tuple:
    """(ширхэгийн үнэ, эх сурвалж). unit_price → last_purchase_price → 0."""
    up = float(line.unit_price or 0)
    if up > 0:
        return up, "line"
    lpp = float(getattr(product, "last_purchase_price", 0) or 0)
    if lpp > 0:
        return lpp, "last"
    return 0.0, "zero"


def _erp_collect(po, db: Session, brand_filter: str = "") -> list:
    """Захиалгын мөрүүдийг ERP-д бэлдэж, түвшин/тоо/үнийг тооцоолно.

    Excel экспорт БА урьдчилан харах хоёул ЯГ энэ функцийг дуудна — өмнө нь
    backend ба ERPExcelModal.tsx хоёр өөр өөр шүүлт бичсэнээс болж «цонх хоосон,
    файл мөртэй» төрлийн зөрүү гардаг байв.
    """
    from sqlalchemy import func as _func

    sh_agg = dict(
        (row[0], {"loaded": float(row[1] or 0), "received": float(row[2] or 0)})
        for row in db.query(
            POShipmentLine.po_line_id,
            _func.sum(POShipmentLine.loaded_qty_box),
            _func.sum(POShipmentLine.received_qty_box),
        )
        .join(PurchaseOrderLine, PurchaseOrderLine.id == POShipmentLine.po_line_id)
        .filter(PurchaseOrderLine.purchase_order_id == po.id)
        .group_by(POShipmentLine.po_line_id)
        .all()
    )

    bf = (brand_filter or "").strip()
    rows = (
        db.query(PurchaseOrderLine, Product)
        .join(Product, Product.id == PurchaseOrderLine.product_id)
        .filter(PurchaseOrderLine.purchase_order_id == po.id,
                PurchaseOrderLine.order_qty_box > 0)
        .all()
    )

    out = []
    for line, p in rows:
        eff_brand = (line.override_brand or "").strip() or (p.brand or "")
        if bf and eff_brand != bf:
            continue
        agg = sh_agg.get(line.id, {})
        level = _erp_line_level(line, agg)
        box, extra = _erp_line_boxes(line, agg, level)
        pack = float(p.pack_ratio or 0)
        qty = box * (pack if pack > 0 else 1.0) + extra
        if qty <= 0:
            continue
        price, price_src = _erp_price(line, p)
        # Override брендтэй бол тухайн брендийн brand_code-ыг ашиглана
        if (line.override_brand or "").strip():
            ref = db.query(Product).filter(
                Product.brand == eff_brand, Product.brand_code != None).first()
            brand_code = (ref.brand_code if ref else (p.brand_code or "")) or ""
        else:
            brand_code = p.brand_code or ""
        out.append({
            "line": line, "product": p, "brand": eff_brand, "brand_code": brand_code,
            "level": level, "qty": qty, "price": price, "price_src": price_src,
            "bad_pack": pack <= 0,
        })
    return out


def _erp_summary(cands: list) -> dict:
    """Эх сурвалж тус бүрийн мөр/ширхэг/дүн + хасагдах мөрийн тоо."""
    src = {}
    for s in ERP_QTY_SOURCES:
        sel = [c for c in cands if c["level"] == s]
        ok = [c for c in sel if c["price"] > 0]
        src[s] = {
            "label": ERP_QTY_SOURCE_LABEL[s],
            "rows": len(ok),
            "pieces": round(sum(c["qty"] for c in ok), 3),
            "amount": round(sum(round(c["qty"] * c["price"], 2) for c in ok), 2),
            # Үнэгүй мөрийг файлд ОРУУЛАХГҮЙ: Эрхэт дээр 0 өртгөөр орлого авбал
            # тухайн барааны жигнэсэн дундаж өртөг бүрмөсөн эвдэрч, дараагийн
            # борлуулалт бүрийн ӨӨрТӨГ буруу болно.
            "skipped_no_price": len(sel) - len(ok),
            "estimated_price_rows": len([c for c in ok if c["price_src"] == "last"]),
            "bad_pack_rows": len([c for c in ok if c["bad_pack"]]),
        }
    return src


class ERPExcelConfigIn(BaseModel):
    company: str                     # "buten_orgil" | "orgil_khorum"
    date: str                        # "YYYY-MM-DD"
    document_note: str = ""          # Гүйлгээний утга
    related_account: str = ""        # Харьцсан данс (e.g. 310101)
    account: str = ""                # Данс (e.g. 150101)
    warehouse_map: dict = {}         # buten_orgil: {warehouse_name: erp_location_code}
    single_location: str = ""        # orgil_khorum: single location code
    brand_filter: str = ""           # Тодорхой бренд шүүх (хоосон = бүгд)
    qty_source: str = "received"     # "received" | "loaded" | "ordered"
    confirm_estimate: bool = False   # ирээгүй тоогоор гаргахыг баталсан эсэх


@router.get("/{order_id}/erp-preview")
def erp_preview(
    order_id: int,
    brand: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "manager", "accountant", "supervisor")),
):
    """Татахын ӨМНӨ эх сурвалж тус бүрд хэдэн мөр гарахыг харуулна.

    Хоосон файл чимээгүй татагдахаас сэргийлэх гол хэрэгсэл: хэрэглэгч
    «Ирсэн 0 · Ачигдсан 0 · Захиалсан 191» гэдгийг ТАТАХААС ӨМНӨ хардаг.
    """
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    cands = _erp_collect(po, db, brand or "")
    summary = _erp_summary(cands)
    # Анхдагч: бодит хэмжилттэй хамгийн дэвшилтэт түвшин
    default_src = "ordered"
    for s in ("received", "loaded"):
        if summary[s]["rows"] > 0:
            default_src = s
            break
    warehouses = sorted({(c["product"].warehouse_name or "") for c in cands if c["price"] > 0} - {""})
    return JSONResponse(content={
        "order_id": order_id,
        "po_status": po.status,
        "brand_filter": brand or "",
        "active_lines": len(cands),
        "sources": summary,
        "default_source": default_src,
        "warehouses": warehouses,
    })


@router.post("/{order_id}/export-erp-excel")
def export_erp_excel(
    order_id: int,
    body: ERPExcelConfigIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "manager", "accountant", "supervisor")),
):
    """ERP-д импортлох Excel файл үүсгэх (confirmed статус)."""
    try:
        return _export_erp_excel_impl(order_id, body, db)
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"[export_erp_excel] ERROR: {e}\n{tb}", flush=True)
        raise HTTPException(500, f"Excel үүсгэхэд алдаа: {type(e).__name__}: {e}")


def _export_erp_excel_impl(order_id: int, body: "ERPExcelConfigIn", db: Session, as_bytes: bool = False):
    """as_bytes=True → (xlsx bytes, файлын нэр, мөрийн тоо) буцаана (Эрхэт рүү шууд импортлоход)."""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
    from datetime import datetime as dt_cls

    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")

    brand_filter = (body.brand_filter or "").strip()
    src = (body.qty_source or "received").strip()
    if src not in ERP_QTY_SOURCES:
        raise HTTPException(400, f"Тооны эх сурвалж буруу: {src}")

    # Урьдчилан харах цонхтой ЯГ ижил тооцоолол (ганц эх сурвалж).
    cands = _erp_collect(po, db, brand_filter)
    summary = _erp_summary(cands)
    picked = [c for c in cands if c["level"] == src and c["price"] > 0]

    # Хоосон файл ЧИМЭЭГҮЙ татагдахаас сэргийлнэ — шалтгааныг нь хэлнэ.
    if not picked:
        avail = ", ".join(
            f"{summary[s]['label']} {summary[s]['rows']}"
            for s in ERP_QTY_SOURCES if summary[s]["rows"] > 0
        )
        no_price = summary[src]["skipped_no_price"]
        why = f"«{ERP_QTY_SOURCE_LABEL[src]}»-оор гаргах мөр алга."
        if no_price:
            why += (f" {no_price} мөр үнэгүй тул хасагдав "
                    f"(нэгж үнэ ч, сүүлийн авсан үнэ ч бүртгэгдээгүй).")
        if avail:
            why += f" Боломжтой: {avail}."
        elif not cands:
            why += " Энэ захиалгад захиалсан тоо бүхий мөр байхгүй байна."
        raise HTTPException(400, why)

    # Ирээгүй тоогоор гаргах нь Эрхэт дээр БОДИТ орлого болж бүртгэгдэнэ —
    # хэрэглэгч заавал баталгаажуулна.
    if src != "received" and not body.confirm_estimate:
        raise HTTPException(400,
            f"«{ERP_QTY_SOURCE_LABEL[src]}» нь ирсэн тоо БИШ. "
            "Эрхэт рүү орлогоор бүртгэгдэхийг баталгаажуулна уу.")

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
    # Мөрүүд аль хэдийн `_erp_collect` дээр шүүгдсэн (түвшин, тоо, үнэ, бренд).
    valid = []
    for c in picked:
        p = c["product"]
        if body.company == "orgil_khorum":
            location = body.single_location
        else:
            location = body.warehouse_map.get(p.warehouse_name, "")
        total = round(c["qty"] * c["price"], 2)
        valid.append((c["brand"], p.item_code, p, c["line"], location,
                      c["qty"], c["price"], total, c["brand_code"]))

    # Sort by brand_code then item_code so same-supplier items are grouped
    valid.sort(key=lambda x: (x[8] or "", x[0], x[1]))

    # ── Group by brand_code — one ERP document block per supplier ──
    from collections import defaultdict
    groups: dict = defaultdict(list)
    for item in valid:
        groups[item[8] or ""].append(item)

    current_row = 2
    for supplier_code, items in groups.items():
        for i, (brand, item_code, p, line, location, qty, price, total, _eff_bc) in enumerate(items):
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

    # "Огноо" (A) баганыг Эрхэтийн танидаг built-in Short Date болгоно — Бараа
    # тулгаж авах (receivings)-ын нэгтгэсэн ERP экспорттой ижил засвар. Эс бөгөөс
    # openpyxl-ийн формат Эрхэтийн импортод «огноо биш» гэж алдаа өгдөг.
    from app.services.erkhet_xlsx import apply_date_format, finalize_erkhet_xlsx
    if current_row > 2:
        apply_date_format(ws, "A", 2, current_row - 1)

    # ── "Тайлбар" хуудас ──
    # Эрхэтийн импортлогч зөвхөн "Import" хуудсыг уншдаг тул энэ хуудас
    # импортод нөлөөлөхгүй. Гэхдээ нягтлан файлыг нээхэд ЯМАР ТООГООР
    # гаргасныг шууд харна — ирээгүй тоогоор гаргасан файлыг ирсэн тоотой
    # андуурч бүртгэх эрсдэлийг бууруулна.
    ws2 = wb.create_sheet("Тайлбар")
    ws2.column_dimensions["A"].width = 34
    ws2.column_dimensions["B"].width = 26
    ws2.column_dimensions["C"].width = 62
    _info = [
        ("Захиалга", "#%d · %s" % (po.id, po.order_date), ""),
        ("Захиалгын статус", STATUS_LABEL.get(po.status, po.status), ""),
        ("Бренд шүүлт", brand_filter or "(бүгд)", ""),
        ("ТООНЫ ЭХ СУРВАЛЖ", ERP_QTY_SOURCE_LABEL[src],
         "Ирсэн тоо — агуулахад бүртгэгдсэн бодит тоо. "
         "Ачигдсан/Захиалсан — бараа хараахан ирээгүй, ТООЦООЛСОН тоо."),
        ("Мөрийн тоо", len(picked), ""),
        ("Нийт ширхэг", round(sum(c["qty"] for c in picked), 3), ""),
        ("Нийт дүн", round(sum(round(c["qty"] * c["price"], 2) for c in picked), 2), ""),
        ("Сүүлийн авсан үнээр бодсон мөр", summary[src]["estimated_price_rows"],
         "Нэгж үнэ бүртгэгдээгүй тул барааны сүүлийн авсан үнийг ашигласан."),
        ("Үнэгүй тул ХАСАГДСАН мөр", summary[src]["skipped_no_price"],
         "Нэгж үнэ ч, сүүлийн авсан үнэ ч байхгүй. 0 өртгөөр орлого авбал барааны "
         "жигнэсэн дундаж өртөг эвдэрч, дараагийн борлуулалтын өртөг буруу болно."),
        ("Хайрцаг/ширхэг харьцаа буруу мөр", summary[src]["bad_pack_rows"],
         "pack_ratio = 0 тул 1 гэж тооцов — барааны картыг шалгана уу."),
    ]
    if src != "received":
        _info.append(("⚠ АНХААРУУЛГА", "Давхар бүртгэлээс сэргийлнэ үү",
                      "Энэ файл ирээгүй тоогоор үүссэн. Бараа ирсний дараа «Ирсэн тоо»-гоор "
                      "дахин экспортлож импортловол ижил бараа Эрхэт дээр ХОЁР УДАА орлогод орно."))
    for _ri, (_k, _v, _note) in enumerate(_info, 1):
        ws2.cell(_ri, 1, _k).font = Font(bold=True)
        ws2.cell(_ri, 2, _v)
        ws2.cell(_ri, 3, _note).font = Font(size=9, color="7F8C8D")
    if src != "received":
        for _c in (1, 2, 3):
            ws2.cell(len(_info), _c).fill = PatternFill("solid", fgColor="FDEBD0")

    buf = io.BytesIO()
    wb.save(buf)
    # Эрхэт рүү ШУУД импортлогддог болгож эцэслэнэ (applyNumberFormat нөхөж,
    # серверийн Excel-ээр Огноо баганыг Short Date болгож дахин хадгална)
    buf = io.BytesIO(finalize_erkhet_xlsx(buf.getvalue()))
    import re
    from urllib.parse import quote
    date_str = po.order_date.strftime("%Y%m%d")
    brand_part = re.sub(r'[\\/:*?"<>|]', '_', brand_filter) if brand_filter else "all"
    # Файлын нэрэнд эх сурвалжийг ОРУУЛНА — нягтлан татсан файлуудаа андуурахгүй
    filename = f"{date_str}_PO{po.id}_{brand_part}_{ERP_QTY_SOURCE_SLUG[src]}.xlsx"
    # RFC 5987: ASCII fallback + UTF-8 encoded filename* (Cyrillic-д зориулж)
    # ASCII fallback нь зай/тусгай тэмдэггүй учир хашилт хэрэггүй
    if as_bytes:
        return buf.getvalue(), filename, len(picked)
    ascii_fallback = re.sub(r"[^\w\-.]", "_", filename.encode("ascii", "ignore").decode("ascii")) or f"PO{po.id}.xlsx"
    utf8_quoted = quote(filename, safe="")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": (
                f"attachment; filename={ascii_fallback}; filename*=UTF-8''{utf8_quoted}"
            )
        },
    )


# ── Эрхэт рүү ШУУД импортлох ─────────────────────────────────────────────────
# «Файл импортлох» (/import/create/) формыг гараар бөглөхтэй ижил:
#   Гарчиг = ERP Excel-ийн нэр, Төрөл = Бараа материалын орлого (inv_income), Файл = ERP Excel
ERKHET_IMPORT_ROLES = ("admin", "accountant", "supervisor")
ERKHET_IMPORT_KIND = "inv_income"
ERKHET_IMPORT_COMPANY = "buten_orgil"      # Эрхэтийн нэвтрэх эрх нь Бүтэн-Оргил ХХК-ийнх


class ErkhetImportIn(ERPExcelConfigIn):
    force: bool = False                    # өмнө импортолсон ч дахин импортлох


def _erkhet_log_dict(r: ErkhetImportLog) -> dict:
    return {"id": r.id, "brand": r.brand, "qty_source": r.qty_source, "title": r.title, "status": r.status,
            "erkhet_import_id": r.erkhet_import_id or None, "erkhet_status": r.erkhet_status, "doc_count": r.doc_count,
            "row_count": r.row_count, "message": r.message, "username": r.username,
            "created_at": (r.created_at.isoformat() + "Z") if r.created_at else None}


@router.get("/{order_id}/erkhet-imports")
def list_erkhet_imports(
    order_id: int,
    brand: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    q = db.query(ErkhetImportLog).filter(ErkhetImportLog.purchase_order_id == order_id)
    if brand is not None:
        q = q.filter(ErkhetImportLog.brand == brand.strip())
    return [_erkhet_log_dict(r) for r in q.order_by(ErkhetImportLog.id.desc()).limit(50).all()]


@router.post("/{order_id}/erkhet-import")
def erkhet_import(
    order_id: int,
    body: ErkhetImportIn,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role(*ERKHET_IMPORT_ROLES)),
):
    """ERP Excel-ийг үүсгээд Эрхэтийн «Бараа материалын орлого» импорт руу шууд илгээнэ."""
    from pathlib import Path as _P
    from app.services.erkhet_client import ErkhetError, get_client

    if (body.company or "") != ERKHET_IMPORT_COMPANY:
        raise HTTPException(400, "Эрхэт рүү шууд импорт зөвхөн Бүтэн-Оргил ХХК-д тохируулагдсан. "
                                 "Оргил-Хорумын файлыг Excel-ээр татаж гараар импортлоно уу.")
    brand = (body.brand_filter or "").strip()
    src = (body.qty_source or "received").strip()

    # Давхар орлогоос сэргийлэх: энэ захиалга+брендийг өмнө импортолсон (эсвэл үр дүн тодорхойгүй) бол
    prev = (db.query(ErkhetImportLog)
            .filter(ErkhetImportLog.purchase_order_id == order_id, ErkhetImportLog.brand == brand,
                    ErkhetImportLog.status.in_(("ok", "unknown")))
            .order_by(ErkhetImportLog.id.desc()).all())
    if prev and not body.force:
        return JSONResponse(status_code=409, content={
            "detail": "Энэ захиалга/брендийг Эрхэт рүү өмнө импортолсон байна — дахин импортлобол орлого ДАВХАР бүртгэгдэнэ.",
            "previous": [_erkhet_log_dict(r) for r in prev[:5]],
        })

    try:
        data, filename, nrows = _export_erp_excel_impl(order_id, body, db, as_bytes=True)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Excel үүсгэхэд алдаа: {type(e).__name__}: {e}")
    title = filename[:-5] if filename.lower().endswith(".xlsx") else filename

    # Илгээсэн файлыг хадгална (аудит/дахин шалгахад)
    store_dir = _P("app/data/erkhet_imports")
    store_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    stored = store_dir / f"{stamp}_PO{order_id}_{re.sub(r'[^0-9A-Za-z_.-]', '_', filename)}"
    stored.write_bytes(data)

    log = ErkhetImportLog(purchase_order_id=order_id, brand=brand, qty_source=src, company=body.company,
                          title=title, filename=filename, stored_path=str(stored), row_count=nrows,
                          username=(u.username or ""), status="unknown")
    db.add(log)
    db.commit()
    db.refresh(log)

    try:
        res = get_client().import_file(title, ERKHET_IMPORT_KIND, filename, data)
    except ErkhetError as e:
        res = {"ok": False, "errors": [str(e)]}
    except Exception as e:
        res = {"ok": None, "errors": [f"{type(e).__name__}: {e}"]}

    log.status = "ok" if res.get("ok") is True else ("fail" if res.get("ok") is False else "unknown")
    log.erkhet_import_id = int(res.get("import_id") or 0)
    log.erkhet_status = (res.get("status") or "")[:100]
    log.doc_count = int(res.get("count") or 0)
    log.message = "; ".join(res.get("errors") or [])[:2000]
    db.commit()
    audit(db, request, u, action="po_erkhet_import", entity_type="erkhet_import", entity_id=log.id,
          parent_type="purchase_order", parent_id=order_id,
          after={"brand": brand, "title": title, "status": log.status, "erkhet_import_id": log.erkhet_import_id,
                 "doc_count": log.doc_count, "rows": nrows, "qty_source": src},
          extra={"message": log.message[:500]} if log.message else None, autocommit=True)
    return {**_erkhet_log_dict(log), "ok": res.get("ok"), "errors": res.get("errors") or [], "erkhet_url": res.get("url")}


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

    # Gather lines with qty > 0, grouped by brand (SQL filter instead of lazy load)
    active_lines = db.query(PurchaseOrderLine).filter(
        PurchaseOrderLine.purchase_order_id == po.id,
        PurchaseOrderLine.order_qty_box > 0,
    ).all()
    product_ids = [l.product_id for l in active_lines]
    products = db.query(Product).filter(Product.id.in_(product_ids)).all() if product_ids else []
    product_map = {p.id: p for p in products}

    grouped: dict[str, list[dict]] = {}
    total_boxes = 0.0
    total_weight = 0.0
    brand_filter = (body.brand_filter or "").strip()
    for l in active_lines:
        if l.order_qty_box <= 0:
            continue
        p = product_map.get(l.product_id)
        if not p:
            continue
        brand_override = (l.override_brand or "").strip()
        brand_raw = brand_override or (p.brand or "").strip()
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


# ── Захиалгын байршил (Нөөц баганын эх сурвалж) ────────────────────────────────

class POLocationIn(BaseModel):
    location: str = "warehouse"


@router.put("/{order_id}/location")
def set_order_location(
    order_id: int,
    body: POLocationIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("manager", "admin", "supervisor")),
):
    """Захиалгын байршлыг (warehouse/showroom) солино. Нөөц багана аль
    үлдэгдлийн файлаас тооцогдохыг тодорхойлно."""
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    po.location = "showroom" if body.location == "showroom" else "warehouse"
    db.commit()
    return {"ok": True, "location": po.location}


class POStatMonthIn(BaseModel):
    stat_month: Optional[int] = None


@router.put("/{order_id}/stat-month")
def set_order_stat_month(
    order_id: int,
    body: POStatMonthIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("manager", "admin", "supervisor")),
):
    """"Өмнөх оны энэ сард" баганад харьцуулах сарыг (1-12) солино. None бол
    order_date-ийн сараар."""
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        raise HTTPException(404, "Захиалга олдсонгүй")
    sm = body.stat_month
    po.stat_month = sm if (sm and 1 <= sm <= 12) else None
    db.commit()
    return {"ok": True, "stat_month": po.stat_month}


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
    _is_admin = _eff_role(u) == "admin"
    if not _is_admin and po.status != "loading":
        raise HTTPException(400, "Зөвхөн 'Ачигдаж байна' статуст нэмэлт мөр засах боломжтой")
    if _eff_role(u) not in ("manager", "admin", "supervisor"):
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
    # po.lines (22 мянган мөр) + мөр бүрт Product query хийхийн оронд зөвхөн тоотой мөрийг
    # бараатай нь нэг JOIN-оор авна.
    ordered = (
        db.query(PurchaseOrderLine, Product)
        .outerjoin(Product, Product.id == PurchaseOrderLine.product_id)
        .filter(PurchaseOrderLine.purchase_order_id == order_id, PurchaseOrderLine.order_qty_box > 0)
        .order_by(PurchaseOrderLine.id)
        .all()
    )
    for pl, p in ordered:
        assigned = assigned_map.get(pl.id, 0)
        remaining = pl.order_qty_box - assigned
        if remaining > 0:
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
        # Per-brand: ядаж 1 бренд "loading" статуст байвал зөвшөөрнө
        has_loading_brand = db.query(PurchaseOrderBrandStatus).filter(
            PurchaseOrderBrandStatus.purchase_order_id == order_id,
            PurchaseOrderBrandStatus.status == "loading",
        ).first()
        if not has_loading_brand:
            raise HTTPException(400, "Ачилт үүсгэхэд loading статустай бренд байхгүй")

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


def _assign_brand_lines(db: Session, order_id: int, sh: POShipment, brand: str) -> int:
    """Брендийн ачигдаагүй үлдэгдлийг тухайн ачилтад POShipmentLine болгож нэмнэ (commit хийхгүй).
    Үр дүнгийн бренд = override_brand, эс бол Product.brand. 22k мөрийг ORM-оор ачаалахгүй."""
    loaded = dict(
        db.query(POShipmentLine.po_line_id, func.sum(POShipmentLine.loaded_qty_box))
        .join(POShipment, POShipment.id == POShipmentLine.shipment_id)
        .filter(POShipment.purchase_order_id == order_id)
        .group_by(POShipmentLine.po_line_id).all()
    )
    _ovr = func.coalesce(func.trim(PurchaseOrderLine.override_brand), "")
    rows = (
        db.query(PurchaseOrderLine)
        .join(Product, Product.id == PurchaseOrderLine.product_id)
        .filter(PurchaseOrderLine.purchase_order_id == order_id, PurchaseOrderLine.order_qty_box > 0,
                (_ovr == brand.strip()) | ((_ovr == "") & (Product.brand == brand)))
        .all()
    )
    existing = {sl.po_line_id: sl for sl in db.query(POShipmentLine).filter(POShipmentLine.shipment_id == sh.id).all()}
    added = 0
    for pl in rows:
        remaining = pl.order_qty_box - float(loaded.get(pl.id) or 0)
        if remaining <= 0:
            continue
        if pl.id in existing:
            existing[pl.id].loaded_qty_box += remaining
        else:
            db.add(POShipmentLine(shipment_id=sh.id, po_line_id=pl.id, loaded_qty_box=remaining))
        added += 1
    return added


def _set_brand_plan(db: Session, order_id: int, shipment_id: int, brand: str, by: str) -> None:
    pb = db.query(POShipmentBrand).filter(POShipmentBrand.purchase_order_id == order_id, POShipmentBrand.brand == brand).first()
    if pb is None:
        db.add(POShipmentBrand(purchase_order_id=order_id, shipment_id=shipment_id, brand=brand, created_by=by))
    else:
        pb.shipment_id = shipment_id
        pb.created_by = by
        pb.created_at = datetime.utcnow()

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

    # Brand status шалгалт
    brand_bs = db.query(PurchaseOrderBrandStatus).filter(
        PurchaseOrderBrandStatus.purchase_order_id == order_id,
        PurchaseOrderBrandStatus.brand == body.brand,
    ).first()
    if brand_bs and brand_bs.status != "loading":
        raise HTTPException(400, f"'{body.brand}' бренд 'loading' статуст байх ёстой")

    added = _assign_brand_lines(db, order_id, sh, body.brand)
    # Dashboard дээр ч энэ машинд хуваарилагдсан гэж харагдана
    _set_brand_plan(db, order_id, sh.id, body.brand, (u.username or ""))
    db.commit()
    return {"ok": True, "added": added, "shipment": _serialize_shipment(sh, db)}


# ── Брендийг машинд төлөвлөх (дурын статуст) ────────────────────────────────

@router.post("/{order_id}/shipments/{shipment_id}/plan-brand")
def plan_brand_to_shipment(
    order_id: int,
    shipment_id: int,
    body: AssignBrandIn,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Брендийг машинд оноох. Бэлдэж/хянаж/илгээж байгаа брендийг төлөвлөгөө хэлбэрээр
    («Ачигдаагүй»), ачигдаж байна статустай брендийг урьдын адил бодитоор ачна."""
    brand = body.brand.strip()
    sh = db.query(POShipment).filter(POShipment.id == shipment_id, POShipment.purchase_order_id == order_id).first()
    if not sh:
        raise HTTPException(404, "Ачилт олдсонгүй")
    if sh.status != "loading":
        raise HTTPException(400, "Зөвхөн 'Ачигдаж байна' статустай (хөдлөөгүй) машинд хуваарилна")
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    bs = db.query(PurchaseOrderBrandStatus).filter(
        PurchaseOrderBrandStatus.purchase_order_id == order_id, PurchaseOrderBrandStatus.brand == brand).first()
    brand_status = bs.status if bs else (po.status if po else "")
    if brand_status == "cancelled":
        raise HTTPException(400, "Цуцлагдсан брендийг машинд хуваарилахгүй")
    prev = db.query(POShipmentBrand).filter(POShipmentBrand.purchase_order_id == order_id, POShipmentBrand.brand == brand).first()
    prev_sid = prev.shipment_id if prev else None
    _set_brand_plan(db, order_id, shipment_id, brand, (u.username or ""))
    added = 0
    if brand_status == "loading":
        added = _assign_brand_lines(db, order_id, sh, brand)
    db.commit()
    audit(db, request, u, action="po_shipment_plan_brand", entity_type="po_shipment", entity_id=shipment_id,
          parent_type="purchase_order", parent_id=order_id,
          before={"brand": brand, "shipment_id": prev_sid}, after={"brand": brand, "shipment_id": shipment_id, "loaded_lines": added},
          autocommit=True)
    return {"ok": True, "brand": brand, "shipment_id": shipment_id, "loaded_lines": added, "brand_status": brand_status}


@router.delete("/{order_id}/shipments/{shipment_id}/plan-brand")
def unplan_brand(
    order_id: int,
    shipment_id: int,
    request: Request,
    brand: str = Query(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Төлөвлөгөөг цуцална (бодит ачилтын мөрүүдийг хөндөхгүй)."""
    pb = db.query(POShipmentBrand).filter(POShipmentBrand.purchase_order_id == order_id,
                                          POShipmentBrand.shipment_id == shipment_id,
                                          POShipmentBrand.brand == brand.strip()).first()
    if not pb:
        raise HTTPException(404, "Төлөвлөгөө олдсонгүй")
    db.delete(pb)
    db.commit()
    audit(db, request, u, action="po_shipment_unplan_brand", entity_type="po_shipment", entity_id=shipment_id,
          parent_type="purchase_order", parent_id=order_id, before={"brand": brand, "shipment_id": shipment_id}, autocommit=True)
    return {"ok": True}


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

    # Sync brand statuses based on shipment brands
    # Find which brands are in this shipment
    sh_lines = db.query(POShipmentLine).filter(POShipmentLine.shipment_id == sh.id).all()
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if po and sh_lines:
        po_line_ids = [sl.po_line_id for sl in sh_lines]
        po_lines = db.query(PurchaseOrderLine).filter(PurchaseOrderLine.id.in_(po_line_ids)).all()
        prod_ids = [pl.product_id for pl in po_lines]
        products = {p.id: p for p in db.query(Product).filter(Product.id.in_(prod_ids)).all()}
        brands_in_shipment = {products[pl.product_id].brand for pl in po_lines if pl.product_id in products and products[pl.product_id].brand}

        # Map shipment status to brand status (shipment stages start from "loading")
        shipment_to_brand = {
            "loading": "loading", "transit": "transit", "arrived": "arrived",
            "accounting": "accounting", "confirmed": "confirmed", "received": "received",
        }
        target_brand_status = shipment_to_brand.get(next_st)
        if target_brand_status:
            for brand in brands_in_shipment:
                bs = db.query(PurchaseOrderBrandStatus).filter(
                    PurchaseOrderBrandStatus.purchase_order_id == order_id,
                    PurchaseOrderBrandStatus.brand == brand,
                ).first()
                if bs:
                    bs_idx = STATUS_SEQUENCE.index(bs.status) if bs.status in STATUS_SEQUENCE else 0
                    target_idx = STATUS_SEQUENCE.index(target_brand_status)
                    if target_idx > bs_idx:
                        bs.status = target_brand_status
            db.commit()

    # Auto-advance PO status from brands
    _sync_po_status_from_brands(order_id, db)
    # Fallback to legacy shipment sync if no brand statuses
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
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    sh = db.query(POShipment).filter(
        POShipment.id == shipment_id,
        POShipment.purchase_order_id == order_id,
    ).first()
    if not sh:
        raise HTTPException(404, "Ачилт олдсонгүй")
    if sh.status != "loading":
        raise HTTPException(400, "Зөвхөн 'Ачигдаж байна' статустай ачилтыг устгах боломжтой")
    db.query(POShipmentBrand).filter(POShipmentBrand.shipment_id == sh.id).delete()
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


def _eff_role(u) -> str:
    """Хэрэглэгчийн ҮР НӨЛӨӨТЭЙ эрхийн түвшин.

    Хэрэглэгч бүр `role` (захиалгат нэр, ж: "driver") ба `base_role`
    (системийн түвшин, ж: "warehouse_clerk") хоёртой. `deps.require_role` нь
    base_role-оор шийддэг атлаа функц доторх шалгалтууд түүхий `u.role`-ийг
    харьцуулдаг байсан — тиймээс driver/aguulah_tuslah (хоёулаа
    base_role=warehouse_clerk) няравын хязгаарлалтыг ТОЙРЧ гардаг байв.
    Бүх эрхийн шалгалт үүгээр дамжина.
    """
    return (getattr(u, "base_role", None) or getattr(u, "role", "") or "")


# ── Brand status helpers ──────────────────────────────────────────────────────

def _ensure_brand_statuses(order_id: int, db: Session):
    """PO lines-аас бренд олж, brand_status record байхгүй бол үүсгэнэ."""
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        return

    # JOIN — өмнө нь бүх мөрийг татаад `Product.id.in_(бүх id)` явуулдаг байсан.
    # Энэ функцийг `set_lines` бүр дуудаг тул хадгалалт бүрд 22 мянган
    # bind-параметртэй хүсэлт үүсдэг байв (SQLite-ийн хязгаар 32,766).
    # Мөн ЗӨВХӨН тоо > 0 мөр хэрэгтэй тул шүүлтийг ч SQL талд хийнэ.
    rows = (
        db.query(PurchaseOrderLine.override_brand, Product.brand)
        .join(Product, Product.id == PurchaseOrderLine.product_id)
        .filter(
            PurchaseOrderLine.purchase_order_id == order_id,
            PurchaseOrderLine.order_qty_box > 0,
        ).all()
    )

    # Brands with order_qty > 0 (override_brand-ийг түрүүнд харгалзана)
    active_brands: set[str] = set()
    for ov, pbrand in rows:
        eff_brand = (ov or "").strip()
        if not eff_brand and pbrand and pbrand.lower() != "nan":
            eff_brand = pbrand
        if eff_brand and eff_brand.lower() != "nan":
            active_brands.add(eff_brand)

    existing = {
        bs.brand
        for bs in db.query(PurchaseOrderBrandStatus).filter(
            PurchaseOrderBrandStatus.purchase_order_id == order_id
        ).all()
    }

    for brand in active_brands - existing:
        db.add(PurchaseOrderBrandStatus(
            purchase_order_id=order_id,
            brand=brand,
            status=po.status,  # inherit current PO status
        ))

    if active_brands - existing:
        db.flush()


def _sync_po_status_from_brands(order_id: int, db: Session):
    """Бүх brand status-аас PO.status = min(brand statuses) тооцоолно."""
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not po:
        return

    brand_statuses = db.query(PurchaseOrderBrandStatus).filter(
        PurchaseOrderBrandStatus.purchase_order_id == order_id
    ).all()
    if not brand_statuses:
        return  # no brand records yet — don't touch PO status

    min_idx = min(
        STATUS_SEQUENCE.index(bs.status)
        for bs in brand_statuses
        if bs.status in STATUS_SEQUENCE
    )
    po.status = STATUS_SEQUENCE[min_idx]
    db.commit()


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
