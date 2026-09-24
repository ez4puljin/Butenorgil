"""Поддон хураалт — API.

  GET    /pallets/templates                 — загварууд
  POST   /pallets/templates                 — шинэ загвар
  PUT    /pallets/templates/{id}            — засах
  DELETE /pallets/templates/{id}            — устгах (ашиглагдаж байвал 400)
  GET    /pallets/lookup?q=                 — баркод/код → бараа + одоогийн тохиргоо + дүн
  GET    /pallets/products?q=&template_id=  — тохиргоотой бараануудын жагсаалт (дүнтэй)
  PUT    /pallets/products/{item_code}      — тохиргоо хадгалах (upsert)
  DELETE /pallets/products/{item_code}
  GET    /pallets/copy-candidates?source=&q= — хуулах бараа (брэндийн бусад / хайлт)
  POST   /pallets/products/{item_code}/copy — ижил хэмжээтэй өөр бараанд хуулах
  GET    /pallets/export                    — Excel

Дүнгийн томьёо (calc):
  boxes_per_pallet = boxes_per_layer × layers
  pcs_per_box      = override > 0 ? override : Product.pack_ratio
  pcs_per_pallet   = boxes_per_pallet × pcs_per_box
  unit_weight_kg   = override > 0 ? override : Product.unit_weight   (ширхгийн хувийн жин)
  box_weight_kg    = override > 0 ? override : unit_weight_kg × pcs_per_box
  pallet_weight_kg = boxes_per_pallet × box_weight_kg   (+ поддоны жин орохгүй)
  total_height_cm  = template.height_cm + layers × box_height_cm   (шалнаас дээд хайрцаг)
  footprint        = template.length × width; нэг үеийн талбай = boxes_per_layer × box_L × box_W
  fit warnings     — үеийн талбай > поддоны талбай, өндөр/даац хэтэрсэн
Эрх: харах/хайх — нэвтэрсэн хэн ч; засах — admin/supervisor/manager/warehouse_clerk.
"""
from __future__ import annotations

import io
import re
from datetime import datetime
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, require_role
from app.core.audit import audit
from app.models.pallet import PalletTemplate, ProductPallet
from app.models.product import Product
from app.models.user import User

router = APIRouter(prefix="/pallets", tags=["pallets"])
EDIT_ROLES = ("admin", "supervisor", "manager", "warehouse_clerk")


def _iso(d):
    return d.isoformat() if d else None


def _tpl_dict(t: PalletTemplate, used: int = 0) -> dict:
    return {"id": t.id, "name": t.name, "length_cm": t.length_cm, "width_cm": t.width_cm,
            "height_cm": t.height_cm, "max_weight_kg": t.max_weight_kg, "max_height_cm": t.max_height_cm,
            "note": t.note or "", "created_at": _iso(t.created_at), "used_by": used}


def _product_dict(p: Product) -> dict:
    return {"item_code": p.item_code, "name": p.name or "", "brand": p.brand or "",
            "warehouse_name": p.warehouse_name or "", "barcode": p.barcode or "",
            "pack_ratio": float(p.pack_ratio or 0), "unit_weight": float(p.unit_weight or 0),
            "box_weight_kg": round(float(p.unit_weight or 0) * float(p.pack_ratio or 0), 3)}


def calc(cfg: ProductPallet, tpl: Optional[PalletTemplate], p: Optional[Product]) -> dict:
    pcs_per_box = cfg.pcs_per_box_override if cfg.pcs_per_box_override > 0 else float((p.pack_ratio if p else 0) or 0)
    unit_w = cfg.unit_weight_kg_override if cfg.unit_weight_kg_override > 0 else float((p.unit_weight if p else 0) or 0)
    box_w = cfg.box_weight_kg_override if cfg.box_weight_kg_override > 0 else unit_w * pcs_per_box
    boxes = int(cfg.boxes_per_layer or 0) * int(cfg.layers or 0)
    th = (tpl.height_cm if tpl else 0.0) + (cfg.layers or 0) * (cfg.box_height_cm or 0)
    layer_area = (cfg.boxes_per_layer or 0) * (cfg.box_length_cm or 0) * (cfg.box_width_cm or 0)
    pallet_area = (tpl.length_cm * tpl.width_cm) if tpl else 0.0
    warnings = []
    if tpl and pallet_area > 0 and layer_area > pallet_area * 1.0001:
        warnings.append(f"Нэг үеийн хайрцгийн талбай ({layer_area:.0f} см²) поддоны талбайгаас ({pallet_area:.0f} см²) их байна")
    if tpl and tpl.max_height_cm > 0 and th > tpl.max_height_cm:
        warnings.append(f"Нийт өндөр {th:.0f} см > зөвшөөрөгдөх {tpl.max_height_cm:.0f} см")
    weight = boxes * box_w
    if tpl and tpl.max_weight_kg > 0 and weight > tpl.max_weight_kg:
        warnings.append(f"Жин {weight:.0f} кг > даац {tpl.max_weight_kg:.0f} кг")
    if pcs_per_box <= 0:
        warnings.append("Хайрцаг дахь ширхэг мэдэгдэхгүй (мастерт 0) — гараар оруулна уу")
    if box_w <= 0:
        warnings.append("Хайрцагны жин мэдэгдэхгүй (мастерт жин 0) — гараар оруулна уу")
    return {
        "boxes_per_pallet": boxes, "pcs_per_box": pcs_per_box, "pcs_per_pallet": round(boxes * pcs_per_box, 3),
        "unit_weight_kg": round(unit_w, 4), "box_weight_kg": round(box_w, 3), "pallet_weight_kg": round(weight, 2),
        "total_height_cm": round(th, 1), "stack_height_cm": round((cfg.layers or 0) * (cfg.box_height_cm or 0), 1),
        "pallet_length_cm": tpl.length_cm if tpl else 0, "pallet_width_cm": tpl.width_cm if tpl else 0,
        "layer_area_cm2": round(layer_area, 1), "pallet_area_cm2": round(pallet_area, 1),
        "area_fill_pct": round(layer_area / pallet_area * 100, 1) if pallet_area > 0 else None,
        "warnings": warnings,
    }


def _cfg_dict(cfg: ProductPallet, tpl: Optional[PalletTemplate], p: Optional[Product]) -> dict:
    return {
        "item_code": cfg.item_code, "template_id": cfg.template_id, "template_name": tpl.name if tpl else "",
        "box_length_cm": cfg.box_length_cm, "box_width_cm": cfg.box_width_cm, "box_height_cm": cfg.box_height_cm,
        "boxes_per_layer": cfg.boxes_per_layer, "layers": cfg.layers,
        "pcs_per_box_override": cfg.pcs_per_box_override, "unit_weight_kg_override": cfg.unit_weight_kg_override,
        "box_weight_kg_override": cfg.box_weight_kg_override,
        "note": cfg.note or "", "updated_by": cfg.updated_by or "", "updated_at": _iso(cfg.updated_at),
        "product": _product_dict(p) if p else {"item_code": cfg.item_code, "name": "", "pack_ratio": 0, "unit_weight": 0},
        "calc": calc(cfg, tpl, p),
    }


# ── Загвар ───────────────────────────────────────────────────────────────────

class TemplateIn(BaseModel):
    name: str
    length_cm: float = 120
    width_cm: float = 80
    height_cm: float = 15
    max_weight_kg: float = 0
    max_height_cm: float = 0
    note: str = ""


@router.get("/templates")
def list_templates(db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    used = {}
    for tid, in db.query(ProductPallet.template_id).all():
        used[tid] = used.get(tid, 0) + 1
    return [_tpl_dict(t, used.get(t.id, 0)) for t in db.query(PalletTemplate).order_by(PalletTemplate.name).all()]


@router.post("/templates")
def create_template(body: TemplateIn, request: Request, db: Session = Depends(get_db),
                    u: User = Depends(require_role(*EDIT_ROLES))):
    if not body.name.strip():
        raise HTTPException(400, "Нэр оруулна уу.")
    if body.length_cm <= 0 or body.width_cm <= 0:
        raise HTTPException(400, "Урт, өргөн 0-ээс их байх ёстой.")
    t = PalletTemplate(name=body.name.strip(), length_cm=body.length_cm, width_cm=body.width_cm,
                       height_cm=max(body.height_cm, 0), max_weight_kg=max(body.max_weight_kg, 0),
                       max_height_cm=max(body.max_height_cm, 0), note=body.note.strip()[:300])
    db.add(t); db.commit()
    audit(db, request, u, action="pallet_template_create", entity_type="pallet_template", entity_id=t.id,
          extra=body.model_dump(), autocommit=True)
    return _tpl_dict(t)


@router.put("/templates/{tid}")
def update_template(tid: int, body: TemplateIn, request: Request, db: Session = Depends(get_db),
                    u: User = Depends(require_role(*EDIT_ROLES))):
    t = db.query(PalletTemplate).filter(PalletTemplate.id == tid).first()
    if not t:
        raise HTTPException(404, "Загвар олдсонгүй.")
    if not body.name.strip() or body.length_cm <= 0 or body.width_cm <= 0:
        raise HTTPException(400, "Нэр, урт, өргөн зөв оруулна уу.")
    t.name, t.length_cm, t.width_cm = body.name.strip(), body.length_cm, body.width_cm
    t.height_cm, t.max_weight_kg, t.max_height_cm = max(body.height_cm, 0), max(body.max_weight_kg, 0), max(body.max_height_cm, 0)
    t.note = body.note.strip()[:300]
    db.commit()
    audit(db, request, u, action="pallet_template_update", entity_type="pallet_template", entity_id=t.id,
          extra=body.model_dump(), autocommit=True)
    return _tpl_dict(t)


@router.delete("/templates/{tid}")
def delete_template(tid: int, request: Request, db: Session = Depends(get_db),
                    u: User = Depends(require_role(*EDIT_ROLES))):
    t = db.query(PalletTemplate).filter(PalletTemplate.id == tid).first()
    if not t:
        return {"ok": True}
    n = db.query(ProductPallet).filter(ProductPallet.template_id == tid).count()
    if n:
        raise HTTPException(400, f"{n} бараа энэ загварыг ашиглаж байна — эхлээд тэдгээрийг өөр загварт шилжүүлнэ үү.")
    db.delete(t); db.commit()
    audit(db, request, u, action="pallet_template_delete", entity_type="pallet_template", entity_id=tid, autocommit=True)
    return {"ok": True}


# ── Бараа ────────────────────────────────────────────────────────────────────

@router.get("/lookup")
def lookup(q: str = Query(..., min_length=1, max_length=80), db: Session = Depends(get_db),
           u: User = Depends(get_current_user)):
    """Баркод / код → бараа (мастер) + одоогийн поддоны тохиргоо (байвал)."""
    from app.services.hall_count import resolve_product
    p = resolve_product(db, q)
    if not p or not p.item_code:
        return {"query": q, "found": False, "product": None, "config": None}
    cfg = db.query(ProductPallet).filter(ProductPallet.item_code == p.item_code).first()
    tpl = db.query(PalletTemplate).filter(PalletTemplate.id == cfg.template_id).first() if cfg else None
    return {"query": q, "found": True, "product": _product_dict(p),
            "config": _cfg_dict(cfg, tpl, p) if cfg else None}


@router.get("/products")
def list_products(q: str = Query("", max_length=80), template_id: Optional[int] = None,
                  db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    qry = db.query(ProductPallet)
    if template_id:
        qry = qry.filter(ProductPallet.template_id == template_id)
    cfgs = qry.order_by(ProductPallet.updated_at.desc()).all()
    codes = [c.item_code for c in cfgs]
    prods = {}
    for i in range(0, len(codes), 900):
        for p in db.query(Product).filter(Product.item_code.in_(codes[i:i + 900])).all():
            prods[p.item_code] = p
    tpls = {t.id: t for t in db.query(PalletTemplate).all()}
    out = []
    ql = q.strip().lower()
    for c in cfgs:
        p = prods.get(c.item_code)
        if ql and ql not in c.item_code.lower() and ql not in (p.name if p else "").lower():
            continue
        out.append(_cfg_dict(c, tpls.get(c.template_id), p))
    return {"total": len(out), "items": out}


class ProductPalletIn(BaseModel):
    template_id: int
    box_length_cm: float = 0
    box_width_cm: float = 0
    box_height_cm: float = 0
    boxes_per_layer: int = 0
    layers: int = 0
    pcs_per_box_override: float = 0
    unit_weight_kg_override: float = 0
    box_weight_kg_override: float = 0
    note: str = ""


@router.put("/products/{item_code}")
def upsert_product(item_code: str, body: ProductPalletIn, request: Request, db: Session = Depends(get_db),
                   u: User = Depends(require_role(*EDIT_ROLES))):
    code = re.sub(r"\s+", "", item_code.strip())
    p = db.query(Product).filter(Product.item_code == code).first()
    if not p:
        raise HTTPException(404, f"«{code}» бараа мастерт олдсонгүй.")
    tpl = db.query(PalletTemplate).filter(PalletTemplate.id == body.template_id).first()
    if not tpl:
        raise HTTPException(400, "Поддоны загвар сонгоно уу.")
    if body.boxes_per_layer <= 0 or body.layers <= 0:
        raise HTTPException(400, "Нэг үеийн хайрцаг ба үеийн тоо 0-ээс их байх ёстой.")
    if body.box_height_cm <= 0:
        raise HTTPException(400, "Хайрцагны өндөр оруулна уу (нийт өндөр бодоход хэрэгтэй).")
    cfg = db.query(ProductPallet).filter(ProductPallet.item_code == code).first()
    if not cfg:
        cfg = ProductPallet(item_code=code)
        db.add(cfg)
    cfg.template_id = tpl.id
    cfg.box_length_cm, cfg.box_width_cm, cfg.box_height_cm = max(body.box_length_cm, 0), max(body.box_width_cm, 0), body.box_height_cm
    cfg.boxes_per_layer, cfg.layers = int(body.boxes_per_layer), int(body.layers)
    cfg.pcs_per_box_override = max(body.pcs_per_box_override, 0)
    cfg.unit_weight_kg_override = max(body.unit_weight_kg_override, 0)
    cfg.box_weight_kg_override = max(body.box_weight_kg_override, 0)
    cfg.note = body.note.strip()[:300]
    cfg.updated_by = str(getattr(u, "nickname", "") or getattr(u, "username", "") or "")
    cfg.updated_at = datetime.utcnow()
    db.commit()
    audit(db, request, u, action="product_pallet_save", entity_type="product_pallet", entity_id=cfg.id,
          extra={"item_code": code, **body.model_dump()}, autocommit=True)
    return _cfg_dict(cfg, tpl, p)


@router.delete("/products/{item_code}")
def delete_product(item_code: str, request: Request, db: Session = Depends(get_db),
                   u: User = Depends(require_role(*EDIT_ROLES))):
    cfg = db.query(ProductPallet).filter(ProductPallet.item_code == item_code.strip()).first()
    if cfg:
        db.delete(cfg); db.commit()
        audit(db, request, u, action="product_pallet_delete", entity_type="product_pallet",
              extra={"item_code": item_code}, autocommit=True)
    return {"ok": True}


# ── Хуулах: ижил хэмжээтэй өөр кодтой бараанд ──────────────────────────────────

def _same(a: float, b: float) -> bool:
    a, b = float(a or 0), float(b or 0)
    return abs(a - b) <= max(abs(a), abs(b)) * 0.01 + 1e-9


_SIZE_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(мл|ml|литр|л|l|гр|gr|г|g|кг|kg)(?![a-zа-яөү])", re.I)
_SIZE_MUL = {"мл": 1, "ml": 1, "литр": 1000, "л": 1000, "l": 1000, "гр": 1, "gr": 1, "г": 1, "g": 1, "кг": 1000, "kg": 1000}


def _pack_size(name: str) -> tuple[str, float, str] | None:
    """Нэрнээс савлагааны хэмжээ: «Coca-Cola 1.5л» → ('ml', 1500, '1.5л'). Сүүлчийн таарцыг авна."""
    ms = list(_SIZE_RE.finditer(name or ""))
    if not ms:
        return None
    m = ms[-1]
    unit = m.group(2).lower()
    kind = "ml" if unit in ("мл", "ml", "литр", "л", "l") else "g"
    return kind, round(float(m.group(1).replace(",", ".")) * _SIZE_MUL[unit], 3), m.group(0).replace(" ", "")


def _layout(cfg: ProductPallet) -> tuple:
    return (cfg.template_id, cfg.box_length_cm, cfg.box_width_cm, cfg.box_height_cm, cfg.boxes_per_layer, cfg.layers)


@router.get("/copy-candidates")
def copy_candidates(source: str = Query(..., min_length=1, max_length=64), q: str = Query("", max_length=80),
                    db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    """Хуулах бараа санал болгох: q хоосон бол эх барааны брэндийн бусад бараа
    (ш/хайрцаг, жин ижил нь эхэнд), q байвал код/баркод/нэрээр хайна."""
    from difflib import SequenceMatcher
    from app.services.hall_count import resolve_product
    src = db.query(Product).filter(Product.item_code == source.strip()).first()
    if not src:
        raise HTTPException(404, "Эх бараа олдсонгүй.")
    src_cfg = db.query(ProductPallet).filter(ProductPallet.item_code == src.item_code).first()
    ql = q.strip()
    prods: list[Product] = []
    exact = ""
    if ql:
        hit = resolve_product(db, ql)
        if hit and hit.item_code and hit.id:
            prods.append(hit); exact = hit.item_code
        like = f"%{ql}%"
        prods += db.query(Product).filter(or_(Product.item_code.like(like), Product.name.ilike(like))).limit(60).all()
    elif src.brand_code or src.brand:
        col, val = (Product.brand_code, src.brand_code) if src.brand_code else (Product.brand, src.brand)
        prods = db.query(Product).filter(col == val).limit(400).all()
    seen, uniq = {src.item_code}, []
    for p in prods:
        if p.item_code and p.item_code not in seen:
            seen.add(p.item_code); uniq.append(p)
    codes = [p.item_code for p in uniq]
    cfgs = {}
    for i in range(0, len(codes), 900):
        for c in db.query(ProductPallet).filter(ProductPallet.item_code.in_(codes[i:i + 900])).all():
            cfgs[c.item_code] = c
    tpls = {t.id: t for t in db.query(PalletTemplate).all()}
    sname = (src.name or "").lower()
    ssize = _pack_size(src.name)
    out = []
    for p in uniq:
        c = cfgs.get(p.item_code)
        same_pack, same_weight = _same(p.pack_ratio, src.pack_ratio), _same(p.unit_weight, src.unit_weight)
        psize = _pack_size(p.name)
        same_size = bool(ssize and psize and ssize[:2] == psize[:2])
        # Санал болгох: нэрэн дэх савлагааны хэмжээ + ш/хайрцаг ижил (нэрэнд хэмжээгүй бол ш/хайрцаг + жин)
        match = (same_size and same_pack) if ssize else (same_pack and same_weight)
        sim = SequenceMatcher(None, sname, (p.name or "").lower()).ratio()
        out.append({
            **_product_dict(p), "exact": p.item_code == exact, "same_pack": same_pack, "same_weight": same_weight,
            "size": psize[2] if psize else "", "same_size": same_size, "match": match,
            "score": round(sim + 0.6 * same_size + 0.25 * same_pack + 0.15 * same_weight - 0.5 * (c is not None), 3),
            "similarity": round(sim, 3),
            "config": ({"template_name": tpls[c.template_id].name if c.template_id in tpls else "",
                        "box_length_cm": c.box_length_cm, "box_width_cm": c.box_width_cm, "box_height_cm": c.box_height_cm,
                        "boxes_per_layer": c.boxes_per_layer, "layers": c.layers,
                        "same_as_source": bool(src_cfg) and _layout(c) == _layout(src_cfg)} if c else None),
        })
    if not ql:
        out.sort(key=lambda x: -x["score"])
        out = out[:120]
    return {"source": {**_product_dict(src), "size": ssize[2] if ssize else ""}, "total": len(out), "items": out}


class CopyIn(BaseModel):
    targets: list[str]
    include_overrides: bool = False   # ш/хайрцаг, хувийн жин, хайрцагны жингийн засварыг мөн хуулах
    overwrite: bool = False           # тохиргоотой барааг дарж бичих


@router.post("/products/{item_code}/copy")
def copy_product(item_code: str, body: CopyIn, request: Request, db: Session = Depends(get_db),
                 u: User = Depends(require_role(*EDIT_ROLES))):
    """Эх барааны поддоны загвар, хайрцагны хэмжээ, нэг үеийн хайрцаг, үеийг бусад бараанд хуулна.
    Жин/ширхгийн засварыг include_overrides үед л хуулна — үгүй бол бараа бүр өөрийн мастер утгаар бодогдоно."""
    src_code = re.sub(r"\s+", "", item_code.strip())
    src = db.query(ProductPallet).filter(ProductPallet.item_code == src_code).first()
    if not src:
        raise HTTPException(404, "Эх барааны поддоны тохиргоо хадгалагдаагүй байна — эхлээд хадгална уу.")
    targets = []
    for t in body.targets:
        c = re.sub(r"\s+", "", str(t or ""))
        if c and c != src_code and c not in targets:
            targets.append(c)
    if not targets:
        raise HTTPException(400, "Хуулах бараа сонгоно уу.")
    if len(targets) > 300:
        raise HTTPException(400, "Нэг удаад 300 хүртэл бараа хуулна.")
    prods = {p.item_code: p for p in db.query(Product).filter(Product.item_code.in_(targets)).all()}
    have = {c.item_code: c for c in db.query(ProductPallet).filter(ProductPallet.item_code.in_(targets)).all()}
    tpl = db.query(PalletTemplate).filter(PalletTemplate.id == src.template_id).first()
    who = str(getattr(u, "nickname", "") or getattr(u, "username", "") or "")
    now = datetime.utcnow()
    copied, skipped = [], []
    for code in targets:
        p = prods.get(code)
        if not p:
            skipped.append({"item_code": code, "reason": "Мастерт олдсонгүй"}); continue
        cfg = have.get(code)
        if cfg and not body.overwrite:
            skipped.append({"item_code": code, "name": p.name or "", "reason": "Тохиргоотой (дарж бичихийг сонгоогүй)"}); continue
        if not cfg:
            cfg = ProductPallet(item_code=code, pcs_per_box_override=0.0, unit_weight_kg_override=0.0,
                                box_weight_kg_override=0.0, note="")
            db.add(cfg)
        cfg.template_id = src.template_id
        cfg.box_length_cm, cfg.box_width_cm, cfg.box_height_cm = src.box_length_cm, src.box_width_cm, src.box_height_cm
        cfg.boxes_per_layer, cfg.layers = src.boxes_per_layer, src.layers
        if body.include_overrides:
            cfg.pcs_per_box_override = src.pcs_per_box_override
            cfg.unit_weight_kg_override = src.unit_weight_kg_override
            cfg.box_weight_kg_override = src.box_weight_kg_override
        if not (cfg.note or "").strip():
            cfg.note = f"{src_code}-аас хуулсан"
        cfg.updated_by, cfg.updated_at = who, now
        copied.append((cfg, p))
    db.commit()
    if copied:
        audit(db, request, u, action="product_pallet_copy", entity_type="product_pallet", entity_id=src.id,
              extra={"source": src_code, "targets": [c.item_code for c, _ in copied], "skipped": skipped,
                     "include_overrides": body.include_overrides, "overwrite": body.overwrite}, autocommit=True)
    return {"source": src_code, "copied": [_cfg_dict(c, tpl, p) for c, p in copied], "skipped": skipped}


# ── Excel ────────────────────────────────────────────────────────────────────

@router.get("/export")
def export_xlsx(template_id: Optional[int] = None, db: Session = Depends(get_db),
                u: User = Depends(get_current_user)):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    data = list_products(q="", template_id=template_id, db=db, u=u)["items"]
    wb = Workbook()
    ws = wb.active
    ws.title = "Поддон хураалт"
    cols = ["Код", "Нэр", "Бренд", "Байршил tag", "Поддон загвар", "Поддон урт (см)", "Поддон өргөн (см)",
            "Поддон өндөр (см)", "Хайрцаг урт (см)", "Хайрцаг өргөн (см)", "Хайрцаг өндөр (см)",
            "Нэг үед (хайрцаг)", "Үе", "Нийт хайрцаг", "Ширхэг/хайрцаг", "Нийт ширхэг",
            "Хувийн жин (кг/ш)", "Хайрцагны жин (кг)", "Поддоны бараа жин (кг)", "Өрөлтийн өндөр (см)", "Шалнаас дээд хайрцаг (см)",
            "Талбайн дүүргэлт %", "Анхааруулга", "Тэмдэглэл", "Шинэчилсэн", "Хэн"]
    widths = [10, 40, 18, 18, 18, 10, 10, 10, 10, 10, 10, 10, 6, 10, 10, 10, 12, 12, 14, 12, 14, 10, 40, 30, 16, 12]
    thin = Side(style="thin", color="000000")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    hf, hfont = PatternFill("solid", fgColor="1F4E78"), Font(color="FFFFFF", bold=True)
    for ci, h in enumerate(cols, 1):
        c = ws.cell(1, ci, h); c.fill = hf; c.font = hfont; c.border = border
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    for ci, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(ci)].width = w
    ws.row_dimensions[1].height = 42
    from app.scripts.no_movement_report import _master_tags
    tags = _master_tags()
    for ri, d in enumerate(data, 2):
        p, k = d["product"], d["calc"]
        vals = [d["item_code"], p.get("name", ""), p.get("brand", ""), tags.get(d["item_code"], p.get("warehouse_name", "")),
                d["template_name"], k["pallet_length_cm"], k["pallet_width_cm"], k["total_height_cm"] - k["stack_height_cm"],
                d["box_length_cm"], d["box_width_cm"], d["box_height_cm"], d["boxes_per_layer"], d["layers"],
                k["boxes_per_pallet"], k["pcs_per_box"], k["pcs_per_pallet"], k["unit_weight_kg"], k["box_weight_kg"], k["pallet_weight_kg"],
                k["stack_height_cm"], k["total_height_cm"], k["area_fill_pct"], "; ".join(k["warnings"]), d["note"],
                (d["updated_at"] or "")[:16].replace("T", " "), d["updated_by"]]
        for ci, v in enumerate(vals, 1):
            ws.cell(ri, ci, v).border = border
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(cols))}{max(len(data) + 1, 2)}"
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_title_rows = "1:1"
    ws.oddHeader.left.text = "&D &T"; ws.oddFooter.right.text = "Хуудас &P / &N"

    ws2 = wb.create_sheet("Загварууд")
    for ci, h in enumerate(["Нэр", "Урт (см)", "Өргөн (см)", "Өндөр (см)", "Даац (кг)", "Дээд өндөр (см)", "Тэмдэглэл", "Ашигласан бараа"], 1):
        c = ws2.cell(1, ci, h); c.fill = hf; c.font = hfont; c.border = border
    for ri, t in enumerate(list_templates(db=db, u=u), 2):
        for ci, v in enumerate([t["name"], t["length_cm"], t["width_cm"], t["height_cm"], t["max_weight_kg"] or "",
                                t["max_height_cm"] or "", t["note"], t["used_by"]], 1):
            ws2.cell(ri, ci, v).border = border
    for ci, w in enumerate([24, 10, 10, 10, 10, 14, 30, 14], 1):
        ws2.column_dimensions[get_column_letter(ci)].width = w

    buf = io.BytesIO(); wb.save(buf)
    fname = f"{datetime.now():%Y%m%d}_poddon_huraalt.xlsx"
    return Response(content=buf.getvalue(),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f"attachment; filename={fname}; filename*=UTF-8''{quote(fname)}"})
