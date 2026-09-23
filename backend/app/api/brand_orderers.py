"""Бренд → Захиалагч тохиргоо.

  GET  /brand-orderers              — {names: [...], map: {brand: orderer}}
  PUT  /brand-orderers              — {brand, orderer}  (orderer "" = бүртгэлээс хасах)
  PUT  /brand-orderers/bulk         — {brands: [...], orderer}
  PUT  /brand-orderers/names        — {names: [...]} захиалагчдын жагсаалт (дараалал)
Эрх: харах — нэвтэрсэн хэн ч; засах — admin/supervisor/manager.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, require_role
from app.core.audit import audit
from app.models.brand_orderer import BrandOrderer
from app.models.user import User

router = APIRouter(prefix="/brand-orderers", tags=["brand-orderers"])
EDIT_ROLES = ("admin", "supervisor", "manager")
NAMES_FILE = Path("app/data/orderers.json")
DEFAULT_NAMES = ["Бямбасүрэн", "Нарантуяа"]
UNASSIGNED = "Захиалагч бүртгэлгүй"


def orderer_names(db: Session | None = None) -> list[str]:
    """Тохируулсан дараалал + бүртгэлд байгаа боловч жагсаалтад ороогүй нэрс."""
    names: list[str] = []
    try:
        if NAMES_FILE.exists():
            v = json.loads(NAMES_FILE.read_text(encoding="utf-8"))
            if isinstance(v, list):
                names = [str(x).strip() for x in v if str(x).strip()]
    except Exception:
        names = []
    if not names and not NAMES_FILE.exists():
        names = list(DEFAULT_NAMES)
    if db is not None:
        for (o,) in db.query(BrandOrderer.orderer).distinct().all():
            if o and o not in names:
                names.append(o)
    return names


def orderer_map(db: Session) -> dict[str, str]:
    return {r.brand: r.orderer for r in db.query(BrandOrderer).all() if r.orderer}


def _who(u: User) -> str:
    return (getattr(u, "nickname", "") or u.username or "").strip()


@router.get("")
def get_all(db: Session = Depends(get_db), _=Depends(get_current_user)):
    return {"names": orderer_names(db), "map": orderer_map(db), "unassigned_label": UNASSIGNED}


class SetIn(BaseModel):
    brand: str
    orderer: str = ""


def _set(db: Session, brand: str, orderer: str, by: str) -> None:
    brand, orderer = brand.strip(), orderer.strip()
    if not brand:
        raise HTTPException(400, "Бренд хоосон байна")
    r = db.query(BrandOrderer).filter(BrandOrderer.brand == brand).first()
    if not orderer:
        if r:
            db.delete(r)
        return
    if r is None:
        r = BrandOrderer(brand=brand)
        db.add(r)
    r.orderer = orderer[:100]
    r.updated_by = by
    r.updated_at = datetime.utcnow()


def _remember_name(db: Session, name: str) -> None:
    name = name.strip()
    if name and name not in orderer_names(None):
        names = orderer_names(db)
        if name not in names:
            names.append(name)
        NAMES_FILE.parent.mkdir(parents=True, exist_ok=True)
        NAMES_FILE.write_text(json.dumps(names, ensure_ascii=False, indent=2), encoding="utf-8")


@router.put("")
def set_one(body: SetIn, request: Request, db: Session = Depends(get_db), u: User = Depends(require_role(*EDIT_ROLES))):
    before = db.query(BrandOrderer).filter(BrandOrderer.brand == body.brand.strip()).first()
    old = before.orderer if before else ""
    _set(db, body.brand, body.orderer, _who(u))
    db.commit()
    _remember_name(db, body.orderer)
    audit(db, request, u, action="brand_orderer_set", entity_type="brand_orderer", entity_id=0,
          before={"brand": body.brand, "orderer": old}, after={"brand": body.brand, "orderer": body.orderer.strip()}, autocommit=True)
    return {"ok": True, "map": orderer_map(db), "names": orderer_names(db)}


class BulkIn(BaseModel):
    brands: list[str]
    orderer: str = ""


@router.put("/bulk")
def set_bulk(body: BulkIn, request: Request, db: Session = Depends(get_db), u: User = Depends(require_role(*EDIT_ROLES))):
    brands = [b for b in dict.fromkeys(x.strip() for x in body.brands) if b]
    if not brands:
        raise HTTPException(400, "Бренд сонгоогүй байна")
    for b in brands:
        _set(db, b, body.orderer, _who(u))
    db.commit()
    _remember_name(db, body.orderer)
    audit(db, request, u, action="brand_orderer_bulk", entity_type="brand_orderer", entity_id=0,
          extra={"brands": brands[:100], "count": len(brands), "orderer": body.orderer.strip()}, autocommit=True)
    return {"ok": True, "map": orderer_map(db), "names": orderer_names(db)}


class NamesIn(BaseModel):
    names: list[str]


@router.put("/names")
def set_names(body: NamesIn, db: Session = Depends(get_db), _=Depends(require_role(*EDIT_ROLES))):
    names = [n for n in dict.fromkeys(x.strip() for x in body.names) if n]
    NAMES_FILE.parent.mkdir(parents=True, exist_ok=True)
    NAMES_FILE.write_text(json.dumps(names, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"names": orderer_names(db)}
