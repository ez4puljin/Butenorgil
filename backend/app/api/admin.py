import re
import pandas as pd
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.api.deps import get_db, parse_tag_ids, require_role
from app.core.security import hash_password, verify_password
from app.models.user import User
from app.models.role import Role
from app.schemas.user import UserCreate
from app.services.master_refresh import refresh_products_from_master
from app.models.min_stock_rule import MinStockRule
from app.models.product import Product
from app.services.min_stock_check import find_rule_for_product, _tags_set, stock_breakdown

MASTER_FILE = Path("app/data/outputs/master_latest.xlsx")

# Common placeholder / blank values used by source systems
_MASTER_BLANKS = {"", "nan", "none", "NaN", "None", "-", "–", "—", "null", "n/a", "na"}

router = APIRouter(prefix="/admin", tags=["admin"])

class ChangePasswordPayload(BaseModel):
    current_password: str
    new_password: str

class ResetPasswordPayload(BaseModel):
    new_password: str

class EditUserPayload(BaseModel):
    role: str | None = None
    phone: str | None = None
    nickname: str | None = None
    tag_ids: list[int] | None = None

class RoleCreatePayload(BaseModel):
    value: str
    label: str
    color: str = "bg-gray-100 text-gray-600"
    base_role: str = "manager"
    permissions: list[str] = []

class RoleEditPayload(BaseModel):
    label: str | None = None
    color: str | None = None
    base_role: str | None = None
    permissions: list[str] | None = None

SYSTEM_ROLES = {"admin", "supervisor", "manager", "warehouse_clerk", "accountant"}


@router.get("/users", response_model=list[dict])
def list_users(db: Session = Depends(get_db), _=Depends(require_role("admin"))):
    rows = db.query(User).order_by(User.id.asc()).all()
    return [
        {
            "id": r.id,
            "username": r.username,
            "nickname": r.nickname or "",
            "phone": r.phone,
            "role": r.role,
            "is_active": r.is_active,
            "tag_ids": parse_tag_ids(r.tag_ids),
        }
        for r in rows
    ]


def _role_dict(r: Role) -> dict:
    return {
        "id": r.id, "value": r.value, "label": r.label, "color": r.color,
        "base_role": r.base_role, "permissions": r.permissions or "", "is_system": r.is_system,
    }


@router.get("/roles", response_model=list[dict])
def list_roles(db: Session = Depends(get_db), _=Depends(require_role("admin"))):
    rows = db.query(Role).order_by(Role.id.asc()).all()
    return [_role_dict(r) for r in rows]


@router.post("/roles", response_model=dict)
def create_role(payload: RoleCreatePayload, db: Session = Depends(get_db), _=Depends(require_role("admin"))):
    value = payload.value.strip().lower().replace(" ", "_")
    if not value:
        raise HTTPException(400, "Утга оруулна уу")
    if db.query(Role).filter(Role.value == value).first():
        raise HTTPException(400, "Энэ утга аль хэдийн бүртгэлтэй байна")
    if payload.base_role not in SYSTEM_ROLES:
        raise HTTPException(400, "Эрхийн түвшин буруу байна")
    r = Role(value=value, label=payload.label.strip(), color=payload.color,
             base_role=payload.base_role, permissions=",".join(payload.permissions), is_system=False)
    db.add(r)
    db.commit()
    db.refresh(r)
    return _role_dict(r)


@router.patch("/roles/{role_id}", response_model=dict)
def edit_role(role_id: int, payload: RoleEditPayload, db: Session = Depends(get_db), _=Depends(require_role("admin"))):
    r = db.query(Role).filter(Role.id == role_id).first()
    if not r:
        raise HTTPException(404, "Олдсонгүй")
    if payload.label is not None:
        r.label = payload.label.strip()
    if payload.color is not None:
        r.color = payload.color
    if payload.base_role is not None:
        if payload.base_role not in SYSTEM_ROLES:
            raise HTTPException(400, "Эрхийн түвшин буруу байна")
        if not r.is_system:
            r.base_role = payload.base_role
    if payload.permissions is not None:
        r.permissions = ",".join(payload.permissions)
    db.commit()
    db.refresh(r)
    return _role_dict(r)


@router.delete("/roles/{role_id}", response_model=dict)
def delete_role(role_id: int, db: Session = Depends(get_db), _=Depends(require_role("admin"))):
    r = db.query(Role).filter(Role.id == role_id).first()
    if not r:
        raise HTTPException(404, "Олдсонгүй")
    if r.is_system:
        raise HTTPException(400, "Системийн үндсэн тушаалыг устгах боломжгүй")
    user_count = db.query(User).filter(User.role == r.value).count()
    if user_count > 0:
        raise HTTPException(400, f"Энэ тушаалтай {user_count} хэрэглэгч байна. Эхлээд хэрэглэгчдийн тушаалыг өөрчилнэ үү.")
    db.delete(r)
    db.commit()
    return {"ok": True, "id": role_id}


@router.post("/users", response_model=dict)
def create_user(payload: UserCreate, db: Session = Depends(get_db), _=Depends(require_role("admin"))):
    username = (payload.username or "").strip()
    if not username:
        raise HTTPException(400, "Хэрэглэгчийн нэр оруулна уу")
    if len(username) < 3 or len(username) > 50:
        raise HTTPException(400, "Хэрэглэгчийн нэр 3–50 тэмдэгт байх ёстой")
    import re as _re
    if not _re.match(r'^[a-zA-Z0-9._\-]+$', username):
        raise HTTPException(400, "Хэрэглэгчийн нэр зөвхөн латин үсэг, тоо, '.', '_', '-' агуулж болно")
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(400, "Хэрэглэгчийн нэр аль хэдийн бүртгэлтэй байна")
    role_obj = db.query(Role).filter(Role.value == payload.role).first()
    if not role_obj:
        raise HTTPException(400, "Тушаал олдсонгүй")
    if len(payload.password) < 8:
        raise HTTPException(400, "Нууц үг хамгийн багадаа 8 тэмдэгт байх ёстой")

    tag_ids = sorted(set([int(x) for x in (payload.tag_ids or [])]))
    phone = (payload.phone or "").strip()

    u = User(
        username=username,
        nickname=(payload.nickname or "").strip(),
        password_hash=hash_password(payload.password),
        role=payload.role,
        base_role=role_obj.base_role,
        is_active=True,
        tag_ids=",".join(str(x) for x in tag_ids),
        phone=phone,
    )
    db.add(u)
    db.commit()
    db.refresh(u)

    return {
        "id": u.id,
        "username": u.username,
        "nickname": u.nickname or "",
        "phone": u.phone,
        "role": u.role,
        "is_active": u.is_active,
        "tag_ids": tag_ids,
    }


@router.post("/users/{user_id}/toggle", response_model=dict)
def toggle_user(user_id: int, db: Session = Depends(get_db), _=Depends(require_role("admin"))):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404, "User not found")
    if u.username == "admin":
        raise HTTPException(400, "Cannot deactivate admin")

    u.is_active = not u.is_active
    db.commit()

    return {"ok": True, "id": u.id, "is_active": u.is_active}


@router.patch("/users/{user_id}", response_model=dict)
def edit_user(
    user_id: int,
    payload: EditUserPayload,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin")),
):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404, "User not found")
    if payload.role is not None:
        role_obj = db.query(Role).filter(Role.value == payload.role).first()
        if not role_obj:
            raise HTTPException(400, "Тушаал олдсонгүй")
        u.role = payload.role
        u.base_role = role_obj.base_role
    if payload.phone is not None:
        u.phone = payload.phone.strip()
    if payload.nickname is not None:
        u.nickname = payload.nickname.strip()
    if payload.tag_ids is not None:
        tag_ids = sorted(set(payload.tag_ids))
        u.tag_ids = ",".join(str(x) for x in tag_ids)
    db.commit()
    db.refresh(u)
    return {
        "id": u.id,
        "username": u.username,
        "nickname": u.nickname or "",
        "phone": u.phone,
        "role": u.role,
        "is_active": u.is_active,
        "tag_ids": parse_tag_ids(u.tag_ids),
    }


@router.delete("/users/{user_id}", response_model=dict)
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin")),
):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404, "User not found")
    if u.username == "admin":
        raise HTTPException(400, "Админ хэрэглэгчийг устгах боломжгүй")

    # Cascade шалгалт — холбоост мэдээлэл байгаа эсэхийг шалгана
    from app.models.order import Order
    from app.models.purchase_order import PurchaseOrder
    order_count = db.query(Order).filter(Order.created_by_user_id == user_id).count()
    po_count = db.query(PurchaseOrder).filter(PurchaseOrder.created_by_user_id == user_id).count()
    if order_count + po_count > 0:
        raise HTTPException(
            400,
            f"Энэ хэрэглэгчтэй холбоотой {order_count + po_count} захиалга байна. "
            "Устгахын өмнө эхлээд идэвхгүй болгоно уу."
        )

    db.delete(u)
    db.commit()
    return {"ok": True, "id": user_id}


@router.post("/users/{user_id}/reset-password", response_model=dict)
def reset_user_password(
    user_id: int,
    payload: ResetPasswordPayload,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin")),
):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404, "User not found")
    if len(payload.new_password) < 8:
        raise HTTPException(400, "Нууц үг хамгийн багадаа 8 тэмдэгт байх ёстой")
    u.password_hash = hash_password(payload.new_password)
    db.commit()
    return {"ok": True}


@router.post("/refresh-products", response_model=dict)
def refresh_products(db: Session = Depends(get_db), _=Depends(require_role("admin"))):
    """Re-populate products table from master_latest.xlsx."""
    if not MASTER_FILE.exists():
        raise HTTPException(400, "Master Excel файл байхгүй байна. Эхлээд Мастер нэгтгэл хийнэ үү.")
    from app.models.product import Product
    before = db.query(Product).count()
    try:
        refresh_products_from_master(db, str(MASTER_FILE))
    except Exception as e:
        raise HTTPException(500, f"Шинэчлэлт амжилтгүй: {e}")
    after = db.query(Product).count()
    return {"ok": True, "before": before, "after": after}


@router.get("/master-download")
def download_master(_=Depends(require_role("admin", "supervisor", "manager"))):
    """Download master_latest.xlsx."""
    if not MASTER_FILE.exists():
        raise HTTPException(404, "Master Excel файл байхгүй байна.")
    return FileResponse(
        path=str(MASTER_FILE),
        filename="master_latest.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@router.get("/dashboard-stats", response_model=dict)
def dashboard_stats(_=Depends(require_role("admin", "supervisor", "manager"))):
    """Master нэгтгэлийн мэдээллийн чанарын шинжилгээ."""
    if not MASTER_FILE.exists():
        return {"available": False, "rows": []}

    try:
        df = pd.read_excel(str(MASTER_FILE), sheet_name=0).copy()
        df.columns = [c.strip() for c in df.columns]
    except Exception:
        return {"available": False, "rows": []}

    def _col(name):
        return df[name] if name in df.columns else pd.Series([None] * len(df), index=df.index)

    def _is_empty(s):
        return s.isna() | s.astype(str).str.strip().isin(_MASTER_BLANKS)

    # ── Quality flags ──────────────────────────────────────────────────────────
    df["_no_image"]     = _is_empty(_col("imageUrl"))
    weight_num          = pd.to_numeric(_col("Жин"), errors="coerce")
    df["_bad_weight"]   = weight_num.isna() | (weight_num == 0) | (weight_num == 1.0)
    df["_no_brand"]     = _is_empty(_col("Брэнд нэр"))
    df["_no_price_tag"] = _is_empty(_col("Үнэ бодох tag"))
    loc_col             = _col("Байршил tag")
    df["_no_loc_tag"]   = _is_empty(loc_col)
    price_num           = pd.to_numeric(_col("Нэгж үнэ"), errors="coerce")
    df["_zero_price"]   = price_num.isna() | (price_num == 0)
    df["_no_barcode"]   = _is_empty(_col("Баркод"))
    box_qty_num         = pd.to_numeric(_col("Хайрцагны тоо"), errors="coerce")
    df["_bad_box_qty"]  = box_qty_num.isna() | (box_qty_num <= 1)

    # ── Per-row stats helper ───────────────────────────────────────────────────
    def _stats(sub):
        return {
            "total":        len(sub),
            "no_image":     int(sub["_no_image"].sum()),
            "bad_weight":   int(sub["_bad_weight"].sum()),
            "no_brand":     int(sub["_no_brand"].sum()),
            "no_price_tag": int(sub["_no_price_tag"].sum()),
            "no_loc_tag":   int(sub["_no_loc_tag"].sum()),
            "zero_price":   int(sub["_zero_price"].sum()),
            "no_barcode":   int(sub["_no_barcode"].sum()),
            "bad_box_qty":  int(sub["_bad_box_qty"].sum()),
        }

    # ── Collect unique location tags ──────────────────────────────────────────
    all_locs: set[str] = set()
    for v in loc_col.dropna():
        for t in str(v).split(","):
            t = t.strip()
            if t and t.lower() not in ("nan", "none", ""):
                all_locs.add(t)

    rows = []
    for loc in sorted(all_locs):
        mask = loc_col.astype(str).str.contains(re.escape(loc), na=False)
        s = _stats(df[mask])
        s["no_loc_tag"] = 0   # by definition they have this tag
        rows.append({"warehouse": loc, **s})

    # Items with no location tag
    no_loc_sub = df[df["_no_loc_tag"]]
    if len(no_loc_sub):
        rows.append({"warehouse": "Байршил tag байхгүй", **_stats(no_loc_sub)})

    # Grand total (unique products, not double-counted)
    rows.append({"warehouse": "__total__", **_stats(df)})

    return {
        "available": True,
        "barcode_col_exists": "Баркод" in df.columns,
        "rows": rows,
    }


@router.get("/dashboard-products", response_model=dict)
def dashboard_products(
    warehouse: str,
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    """Тухайн агуулахын мэдээлэл дутуу бараануудын дэлгэрэнгүй жагсаалт."""
    if not MASTER_FILE.exists():
        return {"available": False, "products": [], "total": 0}

    try:
        df = pd.read_excel(str(MASTER_FILE), sheet_name=0).copy()
        df.columns = [c.strip() for c in df.columns]
    except Exception:
        return {"available": False, "products": [], "total": 0}

    def _col(name):
        return df[name] if name in df.columns else pd.Series([None] * len(df), index=df.index)

    def _is_empty(s):
        return s.isna() | s.astype(str).str.strip().isin(_MASTER_BLANKS)

    # ── Quality flags ──────────────────────────────────────────────────────────
    df["_no_image"]     = _is_empty(_col("imageUrl"))
    weight_num          = pd.to_numeric(_col("Жин"), errors="coerce")
    df["_bad_weight"]   = weight_num.isna() | (weight_num == 0) | (weight_num == 1.0)
    df["_no_brand"]     = _is_empty(_col("Брэнд нэр"))
    df["_no_price_tag"] = _is_empty(_col("Үнэ бодох tag"))
    loc_col             = _col("Байршил tag")
    df["_no_loc_tag"]   = _is_empty(loc_col)
    price_num           = pd.to_numeric(_col("Нэгж үнэ"), errors="coerce")
    df["_zero_price"]   = price_num.isna() | (price_num == 0)
    df["_no_barcode"]   = _is_empty(_col("Баркод"))
    box_qty_num         = pd.to_numeric(_col("Хайрцагны тоо"), errors="coerce")
    df["_bad_box_qty"]  = box_qty_num.isna() | (box_qty_num <= 1)

    FLAG_COLS = ["_no_image", "_bad_weight", "_no_brand", "_no_price_tag",
                 "_no_loc_tag", "_zero_price", "_no_barcode", "_bad_box_qty"]

    # ── Filter rows by warehouse ───────────────────────────────────────────────
    if warehouse == "Байршил tag байхгүй":
        sub = df[df["_no_loc_tag"]].copy()
    else:
        mask = loc_col.astype(str).str.contains(re.escape(warehouse), na=False)
        sub = df[mask].copy()

    # Keep only rows that have at least one quality issue
    has_issue = sub[FLAG_COLS].any(axis=1)
    bad = sub[has_issue].copy()

    # Sort: most issues first, then alphabetically by name
    bad["_issue_count"] = bad[FLAG_COLS].sum(axis=1)
    bad = bad.sort_values(["_issue_count", "Нэр"], ascending=[False, True])

    # ── Serialize ─────────────────────────────────────────────────────────────
    def _s(v):
        try:
            if pd.isna(v):
                return ""
        except (TypeError, ValueError):
            pass
        s = str(v).strip()
        return "" if s.lower() in _MASTER_BLANKS else s

    def _f(v):
        try:
            f = float(v)
            return None if pd.isna(f) else round(f, 4)
        except (TypeError, ValueError):
            return None

    products = [
        {
            "item_code":    _s(r.get("Код")),
            "name":         _s(r.get("Нэр")),
            "brand":        _s(r.get("Брэнд нэр")),
            "unit_weight":  _f(r.get("Жин")),
            "unit_price":   _f(r.get("Нэгж үнэ")),
            "barcode":      _s(r.get("Баркод")),
            "location_tag": _s(r.get("Байршил tag")),
            "price_tag":    _s(r.get("Үнэ бодох tag")),
            "issue_count":  int(r["_issue_count"]),
            "flags": {
                "no_image":     bool(r["_no_image"]),
                "bad_weight":   bool(r["_bad_weight"]),
                "no_brand":     bool(r["_no_brand"]),
                "no_price_tag": bool(r["_no_price_tag"]),
                "no_loc_tag":   bool(r["_no_loc_tag"]),
                "zero_price":   bool(r["_zero_price"]),
                "no_barcode":   bool(r["_no_barcode"]),
                "bad_box_qty":  bool(r["_bad_box_qty"]),
            },
        }
        for _, r in bad.iterrows()
    ]

    return {"available": True, "warehouse": warehouse, "products": products, "total": len(products)}


@router.put("/change-password", response_model=dict)
def change_password(
    payload: ChangePasswordPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    if not verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(400, "Одоогийн нууц үг буруу байна")
    if len(payload.new_password) < 8:
        raise HTTPException(400, "Шинэ нууц үг хамгийн багадаа 8 тэмдэгт байх ёстой")
    current_user.password_hash = hash_password(payload.new_password)
    db.commit()
    return {"ok": True}


# ══════════════════════════════════════════════════════════════════════════════
# Min Stock Rules (доод үлдэгдлийн дүрэм)
# ══════════════════════════════════════════════════════════════════════════════

class MinStockRuleIn(BaseModel):
    name: str = ""
    product_id: int | None = None
    location_tags: list[str] = []
    price_tags: list[str] = []
    min_qty_box: float = 0.0
    is_active: bool = True
    priority: int = 0


class BulkProductRulesIn(BaseModel):
    items: list[dict]  # [{"product_id": int, "min_qty_box": float}]


def _serialize_rule(r: MinStockRule, matched_count: int | None = None, product_info: dict | None = None) -> dict:
    return {
        "id": r.id,
        "name": r.name,
        "product_id": r.product_id,
        "product": product_info,
        "location_tags": [t.strip() for t in (r.location_tags or "").split(",") if t.strip()],
        "price_tags": [t.strip() for t in (r.price_tags or "").split(",") if t.strip()],
        "min_qty_box": r.min_qty_box,
        "is_active": r.is_active,
        "priority": r.priority,
        "matched_count": matched_count,
    }


def _count_matching_products(db: Session, rule: MinStockRule) -> int:
    """Энэ rule-д тохирох барааны тоог тоолно (subset match)."""
    r_loc = _tags_set(rule.location_tags)
    r_pri = _tags_set(rule.price_tags)
    # CSV comparison-ийг SQL-ээр хийх боломжгүй (issubset), бүх бараан дээр loop хийнэ.
    # Бараа нь ~10k, rule нь цөөн тул acceptable.
    if not r_loc and not r_pri:
        return 0
    count = 0
    for p in db.query(Product).all():
        p_loc = _tags_set(p.warehouse_name)
        p_pri = _tags_set(p.price_tag)
        if r_loc and not r_loc.issubset(p_loc):
            continue
        if r_pri and not r_pri.issubset(p_pri):
            continue
        count += 1
    return count


def _product_info(db: Session, product_id: int | None) -> dict | None:
    if not product_id:
        return None
    p = db.query(Product).filter(Product.id == product_id).first()
    if not p:
        return {"id": product_id, "item_code": "", "name": "(устгагдсан)"}
    return {"id": p.id, "item_code": p.item_code, "name": p.name, "brand": p.brand, "pack_ratio": p.pack_ratio}


@router.get("/min-stock-rules")
def list_min_stock_rules(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "supervisor")),
):
    rules = db.query(MinStockRule).order_by(MinStockRule.product_id.is_(None), MinStockRule.priority.desc(), MinStockRule.id).all()
    out = []
    for r in rules:
        pinfo = _product_info(db, r.product_id)
        count = 1 if r.product_id else _count_matching_products(db, r)
        out.append(_serialize_rule(r, count, pinfo))
    return out


@router.post("/min-stock-rules")
def create_min_stock_rule(
    body: MinStockRuleIn,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    if body.min_qty_box < 0:
        raise HTTPException(400, "min_qty_box 0-ээс бага байж болохгүй")
    if body.product_id is None and not body.location_tags and not body.price_tags:
        raise HTTPException(400, "Бараа эсвэл tag сонгоно уу")

    if body.product_id is not None:
        # Давхардал шалгах — product_id-тэй rule аль хэдийн байвал update
        existing = db.query(MinStockRule).filter(MinStockRule.product_id == body.product_id).first()
        if existing:
            existing.min_qty_box = float(body.min_qty_box)
            existing.is_active = body.is_active
            existing.name = body.name.strip()
            db.commit(); db.refresh(existing)
            return _serialize_rule(existing, 1, _product_info(db, existing.product_id))

    r = MinStockRule(
        name=body.name.strip(),
        product_id=body.product_id,
        location_tags="" if body.product_id else ",".join(t.strip() for t in body.location_tags if t.strip()),
        price_tags="" if body.product_id else ",".join(t.strip() for t in body.price_tags if t.strip()),
        min_qty_box=float(body.min_qty_box),
        is_active=body.is_active,
        priority=int(body.priority or 0),
    )
    db.add(r); db.commit(); db.refresh(r)
    pinfo = _product_info(db, r.product_id)
    count = 1 if r.product_id else _count_matching_products(db, r)
    return _serialize_rule(r, count, pinfo)


@router.post("/min-stock-rules/bulk-products")
def create_bulk_product_rules(
    body: BulkProductRulesIn,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    """Олон бараанд нэгэн зэрэг min-stock rule үүсгэнэ/шинэчилнэ."""
    created = 0
    updated = 0
    for it in body.items:
        pid = it.get("product_id")
        min_q = float(it.get("min_qty_box") or 0)
        if not pid or min_q <= 0:
            continue
        existing = db.query(MinStockRule).filter(MinStockRule.product_id == pid).first()
        if existing:
            existing.min_qty_box = min_q
            existing.is_active = True
            updated += 1
        else:
            r = MinStockRule(
                name="",
                product_id=pid,
                location_tags="",
                price_tags="",
                min_qty_box=min_q,
                is_active=True,
                priority=0,
            )
            db.add(r)
            created += 1
    db.commit()
    return {"ok": True, "created": created, "updated": updated}


@router.patch("/min-stock-rules/{rule_id}")
def update_min_stock_rule(
    rule_id: int,
    body: MinStockRuleIn,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    r = db.query(MinStockRule).filter(MinStockRule.id == rule_id).first()
    if not r:
        raise HTTPException(404, "Rule олдсонгүй")
    if body.min_qty_box < 0:
        raise HTTPException(400, "min_qty_box 0-ээс бага байж болохгүй")
    r.name = body.name.strip()
    if r.product_id is None:
        # Tag-based rule — tag-уудыг зөвшөөрнө
        r.location_tags = ",".join(t.strip() for t in body.location_tags if t.strip())
        r.price_tags = ",".join(t.strip() for t in body.price_tags if t.strip())
    r.min_qty_box = float(body.min_qty_box)
    r.is_active = body.is_active
    r.priority = int(body.priority or 0)
    db.commit(); db.refresh(r)
    pinfo = _product_info(db, r.product_id)
    count = 1 if r.product_id else _count_matching_products(db, r)
    return _serialize_rule(r, count, pinfo)


@router.delete("/min-stock-rules/{rule_id}")
def delete_min_stock_rule(
    rule_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    r = db.query(MinStockRule).filter(MinStockRule.id == rule_id).first()
    if not r:
        raise HTTPException(404, "Rule олдсонгүй")
    db.delete(r); db.commit()
    return {"ok": True}


@router.get("/min-stock-rules/{rule_id}/products")
def list_rule_matching_products(
    rule_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "supervisor")),
):
    """Тухайн rule-д тохирох барааны жагсаалт + одоогийн үлдэгдэл."""
    r = db.query(MinStockRule).filter(MinStockRule.id == rule_id).first()
    if not r:
        raise HTTPException(404, "Rule олдсонгүй")

    r_loc = _tags_set(r.location_tags)
    r_pri = _tags_set(r.price_tags)
    min_q = float(r.min_qty_box or 0)

    results = []
    for p in db.query(Product).all():
        p_loc = _tags_set(p.warehouse_name)
        p_pri = _tags_set(p.price_tag)
        if r_loc and not r_loc.issubset(p_loc):
            continue
        if r_pri and not r_pri.issubset(p_pri):
            continue
        if not r_loc and not r_pri:
            continue
        bd = stock_breakdown(p)
        results.append({
            "id": p.id,
            "item_code": p.item_code,
            "name": p.name,
            "brand": p.brand,
            "warehouse_name": p.warehouse_name or "",
            "price_tag": p.price_tag or "",
            "stock_pcs": bd["stock_pcs"],
            "stock_box": bd["stock_box"],
            "stock_extra_pcs": bd["stock_extra_pcs"],
            "pack_ratio": bd["pack_ratio"],
            "needs_reorder": bd["stock_box"] < min_q,
        })
    results.sort(key=lambda x: (not x["needs_reorder"], x["brand"], x["item_code"]))
    return {
        "rule_id": r.id,
        "min_qty_box": min_q,
        "total": len(results),
        "needs_reorder_count": sum(1 for x in results if x["needs_reorder"]),
        "products": results,
    }




@router.get("/tags")
def list_distinct_tags(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "supervisor")),
):
    """Байршил + үнэ tag-уудын distinct жагсаалт (rule form-ын autocomplete-д)."""
    loc: set[str] = set()
    pri: set[str] = set()
    for (wh_name, price_t) in db.query(Product.warehouse_name, Product.price_tag).all():
        for t in _tags_set(wh_name):
            loc.add(t)
        for t in _tags_set(price_t):
            pri.add(t)
    return {
        "location_tags": sorted(loc),
        "price_tags": sorted(pri),
    }
