"""Бренд → Захиалагч — эх сурвалж нь «Нэмэлт талбар → Харилцагч → Захиалагч».

Бренд нь Эрхэтийн «Брэнд код»-оор харилцагчтай холбогдоно (Product.brand_code ==
харилцагчийн Код; олдохгүй бол нэрээр). Захиалгын dashboard-аас захиалагч сонгоход
тэр харилцагчийн Нэмэлт талбар шууд засагдана, Нэмэлт талбар цэснээс засвал dashboard
дээр шууд тусна — нэг л газар хадгалагдана.

  GET  /brand-orderers            — {names, field_label, unassigned_label}
  PUT  /brand-orderers            — {brand, orderer}  (orderer "" = хоослох)
  PUT  /brand-orderers/bulk       — {brands: [...], orderer}
  PUT  /brand-orderers/names      — {names: [...]} захиалагчдын сонголт (талбарын options)
Эрх: харах — нэвтэрсэн хэн ч; засах — admin/supervisor/manager.
"""
from __future__ import annotations

import json
from collections import Counter

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, require_role
from app.core.audit import audit
from app.models.brand_orderer import BrandOrderer
from app.models.custom_master import CustomField
from app.models.product import Product
from app.models.user import User
from app.services import custom_master as cm

router = APIRouter(prefix="/brand-orderers", tags=["brand-orderers"])
EDIT_ROLES = ("admin", "supervisor", "manager")
UNASSIGNED = "Захиалагч бүртгэлгүй"
FIELD_LABEL = "Захиалагч"
FIELD_KEYS = ("zakhialagch", "orderer")
DEFAULT_NAMES = ["Бямбасүрэн", "Нарантуяа"]
SUPPLIER_GROUP = "Нийлүүлэгч"


# ── Нэмэлт талбарын «Захиалагч» ──────────────────────────────────────────────
def orderer_field(db: Session, create: bool = False) -> CustomField | None:
    fs = db.query(CustomField).filter(CustomField.entity == "customer").all()
    f = next((x for x in fs if x.key in FIELD_KEYS), None) \
        or next((x for x in fs if cm.norm_text(x.label) == cm.norm_text(FIELD_LABEL)), None)
    if f is None and create:
        grp = next((x for x in fs if x.key == cm.GROUP_KEY), None)
        gf = SUPPLIER_GROUP if grp is not None and SUPPLIER_GROUP in cm.field_options(grp) else ""
        f = CustomField(entity="customer", key=FIELD_KEYS[0], label=FIELD_LABEL, ftype="select",
                        options=json.dumps(DEFAULT_NAMES, ensure_ascii=False), group_filter=gf,
                        sort_order=max([x.sort_order for x in fs] or [0]) + 1, is_active=True)
        db.add(f)
        db.commit()
        db.refresh(f)
    return f


def orderer_names(db: Session) -> list[str]:
    f = orderer_field(db)
    return cm.field_options(f) if f is not None and f.is_active else []


def brand_customer_codes(db: Session, brands) -> dict[str, str]:
    """{brand: харилцагчийн код}. Брэнд код (хамгийн олон бараанд байгаа) → харилцагчийн
    жагсаалтад байвал түүнийг; үгүй бол нэрээр (давхцалгүй) тулгана."""
    brands = [b for b in set(brands) if b]
    if not brands:
        return {}
    rows = cm.current_rows("customer")
    codes = {r["code"] for r in rows}
    name_count = Counter(r["anchors"].get("name", "") for r in rows)
    by_name = {r["anchors"]["name"]: r["code"] for r in rows if r["anchors"].get("name") and name_count[r["anchors"]["name"]] == 1}
    cnt: dict[str, Counter] = {}
    for brand, bc in db.query(Product.brand, Product.brand_code).filter(Product.brand.in_(brands)).all():
        if bc:
            cnt.setdefault(brand, Counter())[str(bc).strip()] += 1
    out: dict[str, str] = {}
    for b in brands:
        code = next((c for c, _ in cnt.get(b, Counter()).most_common() if c in codes), None)
        if code is None:
            code = by_name.get(cm.norm_text(b))
        if code:
            out[b] = code
    return out


def brand_orderer_info(db: Session, brands) -> tuple[dict[str, str], dict[str, str]]:
    """({brand: захиалагч}, {brand: харилцагчийн код}). Нэмэлт талбар цэсэнд харагдах
    ёсоор (талбар «зөвхөн бүлэгт» бол тэр бүлгийн харилцагчийнх) уншина."""
    bcodes = brand_customer_codes(db, brands)
    f = orderer_field(db)
    if f is None or not f.is_active or not bcodes:
        return {}, bcodes
    vals = cm.values_map(db, "customer", bcodes.values())
    out: dict[str, str] = {}
    for b, code in bcodes.items():
        v = vals.get(code) or {}
        if f.group_filter and str(v.get(cm.GROUP_KEY, "")) != f.group_filter:
            continue
        o = str(v.get(f.key) or "").strip()
        if o:
            out[b] = o
    return out, bcodes


def _set_orderer(db: Session, f: CustomField, code: str, orderer: str, by: str) -> None:
    """Харилцагчийн Нэмэлт талбарт «Захиалагч»-ийг бичнэ. Талбар «зөвхөн бүлэгт» бөгөөд
    харилцагч бүлэггүй бол (брендийн харилцагч = нийлүүлэгч) бүлгийг нь хамт онооно."""
    orderer = orderer.strip()
    patch: dict = {f.key: orderer}
    if orderer and f.group_filter:
        rec = cm.get_record(db, "customer", code)
        cur_group = str((cm._j(rec.values, {}) if rec else {}).get(cm.GROUP_KEY, "") or "")
        if not cur_group:
            patch[cm.GROUP_KEY] = f.group_filter
        elif cur_group != f.group_filter:
            raise HTTPException(400, f"Харилцагч {code} «{cur_group}» бүлэгт байна — «{FIELD_LABEL}» зөвхөн «{f.group_filter}» бүлэгт")
    try:
        res = cm.bulk_update(db, "customer", [code], patch, by=by)
    except cm.CustomMasterError as e:
        raise HTTPException(400, str(e))
    if res.get("skipped_unknown"):
        raise HTTPException(400, f"Харилцагч {code} Нэмэлт талбарын жагсаалтад олдсонгүй")


def _ensure_option(db: Session, f: CustomField, name: str) -> None:
    name = name.strip()
    opts = cm.field_options(f)
    if name and f.ftype == "select" and name not in opts:
        f.options = json.dumps(opts + [name], ensure_ascii=False)
        db.commit()


def _who(u: User) -> str:
    return (getattr(u, "nickname", "") or u.username or "").strip()


def _field_or_400(db: Session) -> CustomField:
    f = orderer_field(db, create=True)
    if not f.is_active:
        raise HTTPException(400, f"Нэмэлт талбарын «{f.label}» идэвхгүй байна")
    return f


# ── API ──────────────────────────────────────────────────────────────────────
@router.get("")
def get_all(db: Session = Depends(get_db), _=Depends(get_current_user)):
    f = orderer_field(db)
    return {"names": orderer_names(db), "field_label": f.label if f else FIELD_LABEL, "unassigned_label": UNASSIGNED}


class SetIn(BaseModel):
    brand: str
    orderer: str = ""


@router.put("")
def set_one(body: SetIn, request: Request, db: Session = Depends(get_db), u: User = Depends(require_role(*EDIT_ROLES))):
    brand = body.brand.strip()
    f = _field_or_400(db)
    code = brand_customer_codes(db, [brand]).get(brand)
    if not code:
        raise HTTPException(400, f"«{brand}» брендэд тохирох харилцагч (брэнд код/нэр) Нэмэлт талбарын харилцагчдаас олдсонгүй")
    old = brand_orderer_info(db, [brand])[0].get(brand, "")
    _ensure_option(db, f, body.orderer)
    _set_orderer(db, f, code, body.orderer, _who(u))
    audit(db, request, u, action="brand_orderer_set", entity_type="custom_customer", entity_id=0,
          before={"brand": brand, "customer": code, "orderer": old},
          after={"brand": brand, "customer": code, "orderer": body.orderer.strip()}, autocommit=True)
    return {"ok": True, "brand": brand, "customer_code": code, "orderer": body.orderer.strip(), "names": orderer_names(db)}


class BulkIn(BaseModel):
    brands: list[str]
    orderer: str = ""


@router.put("/bulk")
def set_bulk(body: BulkIn, request: Request, db: Session = Depends(get_db), u: User = Depends(require_role(*EDIT_ROLES))):
    brands = [b for b in dict.fromkeys(x.strip() for x in body.brands) if b]
    if not brands:
        raise HTTPException(400, "Бренд сонгоогүй байна")
    f = _field_or_400(db)
    _ensure_option(db, f, body.orderer)
    codes = brand_customer_codes(db, brands)
    done, missing = [], []
    for b in brands:
        if b not in codes:
            missing.append(b)
            continue
        _set_orderer(db, f, codes[b], body.orderer, _who(u))
        done.append(b)
    audit(db, request, u, action="brand_orderer_bulk", entity_type="custom_customer", entity_id=0,
          extra={"brands": done[:100], "missing": missing[:50], "orderer": body.orderer.strip()}, autocommit=True)
    return {"ok": True, "updated": done, "missing": missing, "names": orderer_names(db)}


class NamesIn(BaseModel):
    names: list[str]


@router.put("/names")
def set_names(body: NamesIn, db: Session = Depends(get_db), _=Depends(require_role(*EDIT_ROLES))):
    f = _field_or_400(db)
    f.options = json.dumps([n for n in dict.fromkeys(x.strip() for x in body.names) if n], ensure_ascii=False)
    db.commit()
    return {"names": orderer_names(db)}


# ── Нэг удаагийн шилжүүлэлт: хуучин brand_orderers хүснэгт → Нэмэлт талбар ──
def migrate_legacy_brand_orderers(db: Session) -> dict:
    """2026-09-23 хувилбарт dashboard-аас сонгосон захиалагчид brand_orderers хүснэгтэд
    хадгалагдаж байв. Харилцагчийн Нэмэлт талбарт утга байхгүй бол тэнд шилжүүлээд мөрийг
    устгана (Нэмэлт талбарын утга байвал түүнийг үнэн гэж үзнэ)."""
    rows = db.query(BrandOrderer).all()
    if not rows:
        return {"migrated": 0}
    f = orderer_field(db, create=True)
    codes = brand_customer_codes(db, [r.brand for r in rows])
    cur, _ = brand_orderer_info(db, [r.brand for r in rows])
    moved = kept = 0
    for r in rows:
        code = codes.get(r.brand)
        if code and r.orderer and not cur.get(r.brand):
            try:
                _ensure_option(db, f, r.orderer)
                _set_orderer(db, f, code, r.orderer, r.updated_by or "migrate")
                moved += 1
            except HTTPException:
                kept += 1
                continue
        if code or not r.orderer:
            db.delete(r)
        else:
            kept += 1
    db.commit()
    return {"migrated": moved, "kept": kept}
