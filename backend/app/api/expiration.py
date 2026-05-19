"""
Хугацааны хяналт API — Барааны дуусах хугацааны бүртгэл, шүүлт, хариуцлага
оноох болон архивлах endpoint-үүд.

Бүх ажилчид хандах боломжтой (read + write) — UI permission key:
`expiration_tracking`-р gating хийгдэнэ.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_
from datetime import date as date_type, datetime, timedelta
from typing import Optional, List
from pydantic import BaseModel, field_validator

from app.api.deps import get_db, get_current_user
from app.models.expiration_item import ExpirationItem, EXPIRATION_STATUSES, LIABILITY_TYPES
from app.models.product import Product
from app.models.user import User
from app.models.role import Role

router = APIRouter(prefix="/expiration", tags=["expiration"])


# ── Schemas ──────────────────────────────────────────────────────────────────

class ItemCreateIn(BaseModel):
    product_id: int
    expiration_date: date_type
    qty_floor: float = 0.0
    qty_warehouse: float = 0.0
    status: str = "review"
    notes: str = ""

    @field_validator("status")
    @classmethod
    def _validate_status(cls, v: str) -> str:
        if v not in EXPIRATION_STATUSES:
            raise ValueError(f"status буруу: {v}")
        return v


class ItemUpdateIn(BaseModel):
    expiration_date: Optional[date_type] = None
    qty_floor: Optional[float] = None
    qty_warehouse: Optional[float] = None
    status: Optional[str] = None
    liability_type: Optional[str] = None
    liability_role_ids: Optional[str] = None     # comma-separated
    liability_user_ids: Optional[str] = None     # comma-separated
    liability_note: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("status")
    @classmethod
    def _v_status(cls, v):
        if v is not None and v not in EXPIRATION_STATUSES:
            raise ValueError(f"status буруу: {v}")
        return v

    @field_validator("liability_type")
    @classmethod
    def _v_liability(cls, v):
        if v is not None and v not in LIABILITY_TYPES:
            raise ValueError(f"liability_type буруу: {v}")
        return v


# ── Helpers ──────────────────────────────────────────────────────────────────

def _serialize(it: ExpirationItem, db: Session) -> dict:
    p = db.query(Product).filter(Product.id == it.product_id).first()
    creator = db.query(User).filter(User.id == it.created_by_id).first() if it.created_by_id else None
    archiver = db.query(User).filter(User.id == it.archived_by_id).first() if it.archived_by_id else None
    today = date_type.today()
    days_left = (it.expiration_date - today).days if it.expiration_date else 0
    total_qty = (it.qty_floor or 0) + (it.qty_warehouse or 0)
    return {
        "id": it.id,
        "product_id": it.product_id,
        "product_name": p.name if p else "",
        "product_code": p.item_code if p else "",
        "product_brand": p.brand if p else "",
        "product_barcode": p.barcode if p else "",
        "expiration_date": it.expiration_date.isoformat() if it.expiration_date else None,
        "days_left": days_left,
        "is_expired": days_left < 0,
        "is_expiring_soon": 0 <= days_left <= 30,
        "qty_floor": float(it.qty_floor or 0),
        "qty_warehouse": float(it.qty_warehouse or 0),
        "qty_total": total_qty,
        "status": it.status or "review",
        "liability_type": it.liability_type or "none",
        "liability_role_ids": [r for r in (it.liability_role_ids or "").split(",") if r.strip()],
        "liability_user_ids": [int(u) for u in (it.liability_user_ids or "").split(",") if u.strip().isdigit()],
        "liability_note": it.liability_note or "",
        "notes": it.notes or "",
        "archived_at": it.archived_at.isoformat() if it.archived_at else None,
        "archived_by_username": archiver.username if archiver else "",
        "created_at": it.created_at.isoformat() if it.created_at else None,
        "created_by_username": creator.username if creator else "",
        "updated_at": it.updated_at.isoformat() if it.updated_at else None,
    }


def _join_csv(values) -> str:
    """List[str|int] эсвэл comma-separated string → cleaned csv."""
    if values is None:
        return ""
    if isinstance(values, str):
        parts = [v.strip() for v in values.split(",")]
    else:
        parts = [str(v).strip() for v in values]
    return ",".join(p for p in parts if p)


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/items")
def list_items(
    status: Optional[str] = None,
    filter_type: Optional[str] = Query(None, description="expired|expiring_soon|active|archived"),
    search: Optional[str] = None,
    include_archived: bool = False,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Хугацааны бүртгэлийн жагсаалт.

    Шүүлтүүр:
      • status        — review | city_return | internal_sale | archived
      • filter_type   — expired (өнгөрсөн) | expiring_soon (30 хоног) | active (одоо ажиллаж буй)
      • search        — Бараа нэр/код/баркодоор хайх
      • include_archived — Архивлагдсаныг бас оруулах эсэх (default false)
    """
    q = db.query(ExpirationItem)

    if status:
        if status not in EXPIRATION_STATUSES:
            raise HTTPException(400, f"status буруу: {status}")
        q = q.filter(ExpirationItem.status == status)
    elif not include_archived:
        q = q.filter(ExpirationItem.status != "archived")

    today = date_type.today()
    if filter_type == "expired":
        q = q.filter(ExpirationItem.expiration_date < today)
    elif filter_type == "expiring_soon":
        q = q.filter(
            ExpirationItem.expiration_date >= today,
            ExpirationItem.expiration_date <= today + timedelta(days=30),
        )
    elif filter_type == "active":
        # has stock + not archived (default include_archived=False already does that)
        pass
    elif filter_type == "archived":
        q = q.filter(ExpirationItem.status == "archived")

    if search:
        s = f"%{search.strip()}%"
        # Бараа JOIN
        q = q.join(Product, Product.id == ExpirationItem.product_id).filter(
            or_(
                Product.name.ilike(s),
                Product.item_code.ilike(s),
                Product.barcode.ilike(s),
                Product.brand.ilike(s),
            )
        )

    items = q.order_by(ExpirationItem.expiration_date.asc(), ExpirationItem.id.desc()).all()
    return [_serialize(it, db) for it in items]


@router.post("/items")
def create_item(
    body: ItemCreateIn,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    # Бараа байгаа эсэхийг шалгана
    p = db.query(Product).filter(Product.id == body.product_id).first()
    if not p:
        raise HTTPException(404, "Бараа олдсонгүй")

    if body.qty_floor < 0 or body.qty_warehouse < 0:
        raise HTTPException(400, "Үлдэгдэл сөрөг байж болохгүй")

    it = ExpirationItem(
        product_id=body.product_id,
        expiration_date=body.expiration_date,
        qty_floor=float(body.qty_floor),
        qty_warehouse=float(body.qty_warehouse),
        status=body.status or "review",
        notes=(body.notes or "").strip(),
        created_by_id=u.id,
    )
    db.add(it)
    db.commit()
    db.refresh(it)
    return _serialize(it, db)


@router.patch("/items/{item_id}")
def update_item(
    item_id: int,
    body: ItemUpdateIn,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    it = db.query(ExpirationItem).filter(ExpirationItem.id == item_id).first()
    if not it:
        raise HTTPException(404, "Бүртгэл олдсонгүй")

    if body.expiration_date is not None:
        it.expiration_date = body.expiration_date
    if body.qty_floor is not None:
        if body.qty_floor < 0:
            raise HTTPException(400, "Заалны үлдэгдэл сөрөг байж болохгүй")
        it.qty_floor = float(body.qty_floor)
    if body.qty_warehouse is not None:
        if body.qty_warehouse < 0:
            raise HTTPException(400, "Агуулахын үлдэгдэл сөрөг байж болохгүй")
        it.qty_warehouse = float(body.qty_warehouse)
    if body.status is not None:
        it.status = body.status
        if body.status == "archived" and not it.archived_at:
            it.archived_at = datetime.utcnow()
            it.archived_by_id = u.id
        elif body.status != "archived":
            it.archived_at = None
            it.archived_by_id = None
    if body.liability_type is not None:
        it.liability_type = body.liability_type
    if body.liability_role_ids is not None:
        it.liability_role_ids = _join_csv(body.liability_role_ids)
    if body.liability_user_ids is not None:
        it.liability_user_ids = _join_csv(body.liability_user_ids)
    if body.liability_note is not None:
        it.liability_note = body.liability_note.strip()
    if body.notes is not None:
        it.notes = body.notes.strip()

    db.commit()
    db.refresh(it)
    return _serialize(it, db)


@router.delete("/items/{item_id}")
def delete_item(
    item_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    it = db.query(ExpirationItem).filter(ExpirationItem.id == item_id).first()
    if not it:
        raise HTTPException(404, "Бүртгэл олдсонгүй")
    # Зөвхөн үүсгэгч эсвэл admin/supervisor устгана
    if u.id != it.created_by_id and u.role not in ("admin", "supervisor"):
        raise HTTPException(403, "Зөвхөн үүсгэгч эсвэл админ устгана")
    db.delete(it)
    db.commit()
    return {"ok": True}


@router.post("/items/{item_id}/archive")
def archive_item(
    item_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Зарагдаж дууссан item-ийг архивлах. qty_floor + qty_warehouse > 0 байх
    тохиолдолд анхааруулга — гэхдээ архивлахыг хатуу хориглодоггүй (manual
    дуудлагаар сонгох боломжтой)."""
    it = db.query(ExpirationItem).filter(ExpirationItem.id == item_id).first()
    if not it:
        raise HTTPException(404, "Бүртгэл олдсонгүй")
    if it.status == "archived":
        return _serialize(it, db)
    it.status = "archived"
    it.archived_at = datetime.utcnow()
    it.archived_by_id = u.id
    db.commit()
    db.refresh(it)
    return _serialize(it, db)


@router.post("/items/{item_id}/unarchive")
def unarchive_item(
    item_id: int,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Архиваас гарга — буцаагаад review status болгоно."""
    it = db.query(ExpirationItem).filter(ExpirationItem.id == item_id).first()
    if not it:
        raise HTTPException(404, "Бүртгэл олдсонгүй")
    if it.status != "archived":
        return _serialize(it, db)
    it.status = "review"
    it.archived_at = None
    it.archived_by_id = None
    db.commit()
    db.refresh(it)
    return _serialize(it, db)


@router.get("/lookup/roles")
def list_roles_for_liability(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Хариуцлага оноох role-уудын жагсаалт (бүх ажилчинд харагдана)."""
    rows = db.query(Role).filter(Role.value != "admin").order_by(Role.id.asc()).all()
    return [{"value": r.value, "label": r.label, "color": r.color or ""} for r in rows]


@router.get("/lookup/users")
def list_users_for_liability(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Хариуцлага оноох ажилчдын жагсаалт (бүх ажилчинд харагдана)."""
    rows = db.query(User).filter(User.is_active == True, User.role != "admin").order_by(User.username.asc()).all()
    return [{"id": r.id, "username": r.username, "nickname": r.nickname or "", "role": r.role} for r in rows]


@router.get("/lookup/products")
def search_products_for_expiration(
    q: str = "",
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Бараа хайх (бүх ажилчинд харагдана) — нэр/код/баркодоор хайна."""
    if len(q) < 2:
        return []
    term = f"%{q.strip()}%"
    rows = (
        db.query(Product)
        .filter(
            (Product.item_code.ilike(term))
            | (Product.name.ilike(term))
            | (Product.barcode.ilike(term))
        )
        .order_by(Product.name.asc())
        .limit(30)
        .all()
    )
    # Exact barcode match эхэнд
    exact = [r for r in rows if r.barcode == q.strip()]
    partial = [r for r in rows if r.barcode != q.strip()]
    return [
        {
            "id": r.id, "item_code": r.item_code, "name": r.name, "brand": r.brand,
            "barcode": r.barcode or "", "stock_qty": float(r.stock_qty or 0),
        }
        for r in (exact + partial)
    ]


@router.get("/stats")
def get_stats(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Top-level статистик — header card-д хэрэглэхэд."""
    today = date_type.today()
    soon_end = today + timedelta(days=30)
    all_items = db.query(ExpirationItem).filter(ExpirationItem.status != "archived").all()
    expired = sum(1 for i in all_items if i.expiration_date and i.expiration_date < today)
    expiring_soon = sum(
        1 for i in all_items
        if i.expiration_date and today <= i.expiration_date <= soon_end
    )
    by_status = {}
    for s in ("review", "city_return", "internal_sale"):
        by_status[s] = sum(1 for i in all_items if i.status == s)
    archived_count = db.query(ExpirationItem).filter(ExpirationItem.status == "archived").count()
    return {
        "total_active": len(all_items),
        "expired": expired,
        "expiring_soon": expiring_soon,
        "by_status": by_status,
        "archived": archived_count,
    }
