"""Нэмэлт талбар (мастер) — API.

  GET    /custom-master/meta?entity=                 — талбарууд, тоо, файлын мэдээлэл
  GET/POST /custom-master/fields, PUT/DELETE /fields/{id}
  GET    /custom-master/records?entity=&q=&only_filled=&field=&value=&erkhet_group=&page=&size=
  GET    /custom-master/records/{entity}/{code}
  PUT    /custom-master/records/{entity}/{code}      — {values:{key:value}} (upsert)
  DELETE /custom-master/records/{entity}/{code}
  GET    /custom-master/orphans?entity=              — код алга болсон бичлэгүүд + саналууд
  POST   /custom-master/relink                       — {entity, old_code, new_code}
  POST   /custom-master/resync?entity=               — файлтай дахин тулгах (гараар)
  GET    /custom-master/values?entity=&codes=a,b     — системийн бусад хэсэгт
  GET    /custom-master/export?entity=               — Excel
Эрх: харах — нэвтэрсэн хэн ч; засах — admin/supervisor/manager.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, require_role
from app.core.audit import audit
from app.models.custom_master import ENTITIES, FIELD_TYPES, CustomField, CustomRecord
from app.models.user import User
from app.services import custom_master as cm

router = APIRouter(prefix="/custom-master", tags=["custom-master"])
EDIT_ROLES = ("admin", "supervisor", "manager")


def _entity(entity: str) -> str:
    if entity not in ENTITIES:
        raise HTTPException(400, "entity нь product эсвэл customer байна")
    return entity


def _who(u: User) -> str:
    return (getattr(u, "full_name", "") or u.username or "").strip() or u.username


# ── Мета ─────────────────────────────────────────────────────────────────────
@router.get("/meta")
def meta(entity: str = Query(...), db: Session = Depends(get_db), _=Depends(get_current_user)):
    _entity(entity)
    fields = (db.query(CustomField).filter(CustomField.entity == entity)
              .order_by(CustomField.sort_order.asc(), CustomField.id.asc()).all())
    p = cm.source_path(entity)
    rows = cm.current_rows(entity)
    n_rec = db.query(CustomRecord).filter(CustomRecord.entity == entity).count()
    n_orph = db.query(CustomRecord).filter(CustomRecord.entity == entity, CustomRecord.status == "orphan").count()
    groups: list[str] = []
    if entity == "customer":
        groups = sorted({r["info"].get("group_name", "") for r in rows if r["info"].get("group_name")})
    return {
        "entity": entity, "label": cm.ENTITY_LABEL[entity],
        "fields": [cm.field_to_dict(f) for f in fields],
        "source": {"file": p.name, "exists": p.exists(),
                   "updated_at": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds") if p.exists() else None,
                   "rows": len(rows)},
        "records": n_rec, "orphans": n_orph, "erkhet_groups": groups, "group_key": cm.GROUP_KEY,
    }


# ── Талбар ───────────────────────────────────────────────────────────────────
class FieldIn(BaseModel):
    entity: str
    key: str = ""
    label: str
    ftype: str = "text"
    options: list[str] = []
    group_filter: str = ""
    sort_order: int = 0
    is_active: bool = True


def _slug(label: str) -> str:
    tr = {"а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo", "ж": "j", "з": "z", "и": "i", "й": "i",
          "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "ө": "u", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
          "ү": "u", "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sh", "ъ": "", "ы": "y", "ь": "", "э": "e",
          "ю": "yu", "я": "ya"}
    s = "".join(tr.get(ch, ch) for ch in label.lower())
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return s[:50] or "field"


@router.get("/fields")
def list_fields(entity: str = Query(...), db: Session = Depends(get_db), _=Depends(get_current_user)):
    _entity(entity)
    fs = (db.query(CustomField).filter(CustomField.entity == entity)
          .order_by(CustomField.sort_order.asc(), CustomField.id.asc()).all())
    return [cm.field_to_dict(f) for f in fs]


def _apply_field(f: CustomField, body: FieldIn):
    if body.ftype not in FIELD_TYPES:
        raise HTTPException(400, f"Төрөл буруу ({', '.join(FIELD_TYPES)})")
    label = body.label.strip()
    if not label:
        raise HTTPException(400, "Талбарын нэр хоосон байна")
    opts = [o.strip() for o in body.options if o and o.strip()]
    if body.ftype == "select" and not opts:
        raise HTTPException(400, "Сонголттой талбарт дор хаяж нэг сонголт хэрэгтэй")
    f.label = label
    f.ftype = body.ftype
    f.options = json.dumps(opts, ensure_ascii=False)
    f.group_filter = body.group_filter.strip() if body.entity == "customer" else ""
    f.sort_order = int(body.sort_order or 0)
    f.is_active = bool(body.is_active)


@router.post("/fields")
def create_field(body: FieldIn, request: Request, db: Session = Depends(get_db), u: User = Depends(require_role(*EDIT_ROLES))):
    _entity(body.entity)
    key = re.sub(r"[^a-z0-9_]", "", body.key.strip().lower()) or _slug(body.label)
    base, i = key, 2
    while db.query(CustomField).filter(CustomField.entity == body.entity, CustomField.key == key).first():
        key = f"{base}_{i}"
        i += 1
    if db.query(CustomField).filter(CustomField.entity == body.entity, CustomField.label == body.label.strip()).first():
        raise HTTPException(400, "Ийм нэртэй талбар аль хэдийн байна")
    f = CustomField(entity=body.entity, key=key)
    _apply_field(f, body)
    db.add(f)
    db.commit()
    db.refresh(f)
    audit(db, request, u, action="custom_field_create", entity_type="custom_field", entity_id=f.id,
          extra=f"{body.entity}:{f.label}", autocommit=True)
    return cm.field_to_dict(f)


@router.put("/fields/{fid}")
def update_field(fid: int, body: FieldIn, request: Request, db: Session = Depends(get_db), u: User = Depends(require_role(*EDIT_ROLES))):
    f = db.get(CustomField, fid)
    if not f:
        raise HTTPException(404, "Талбар олдсонгүй")
    body.entity = f.entity
    dup = db.query(CustomField).filter(CustomField.entity == f.entity, CustomField.label == body.label.strip(), CustomField.id != fid).first()
    if dup:
        raise HTTPException(400, "Ийм нэртэй талбар аль хэдийн байна")
    _apply_field(f, body)
    db.commit()
    audit(db, request, u, action="custom_field_update", entity_type="custom_field", entity_id=f.id,
          extra=f"{f.entity}:{f.label}", autocommit=True)
    return cm.field_to_dict(f)


@router.delete("/fields/{fid}")
def delete_field(fid: int, request: Request, db: Session = Depends(get_db), u: User = Depends(require_role(*EDIT_ROLES))):
    f = db.get(CustomField, fid)
    if not f:
        raise HTTPException(404, "Талбар олдсонгүй")
    used = sum(1 for v in cm.values_map(db, f.entity).values() if f.key in v)
    if used:
        raise HTTPException(400, f"Энэ талбарт {used} бичлэг утгатай байна — устгахын оронд идэвхгүй болгоно уу")
    db.delete(f)
    db.commit()
    audit(db, request, u, action="custom_field_delete", entity_type="custom_field", entity_id=fid, extra=f.label, autocommit=True)
    return {"ok": True}


# ── Бичлэг ───────────────────────────────────────────────────────────────────
@router.get("/records")
def list_records(
    entity: str = Query(...), q: str = "", only_filled: bool = False,
    field: str = "", value: str = "", erkhet_group: str = "",
    page: int = Query(1, ge=1), size: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db), _=Depends(get_current_user),
):
    _entity(entity)
    rows = cm.current_rows(entity)
    recs = {r.code: r for r in db.query(CustomRecord).filter(CustomRecord.entity == entity).all()}
    qn = cm.norm_text(q)
    out = []
    for row in rows:
        rec = recs.get(row["code"])
        vals = cm._j(rec.values, {}) if rec else {}
        if only_filled and not vals:
            continue
        if erkhet_group and row["info"].get("group_name") != erkhet_group:
            continue
        if field:
            v = vals.get(field)
            if value == "__empty__":
                if v not in (None, ""):
                    continue
            elif value == "__any__":
                if v in (None, ""):
                    continue
            elif value and str(v) != value:
                continue
        if qn and qn not in row["code"].lower() and qn not in row["anchors"].get("name", "") \
                and qn not in cm.norm_text(row["info"].get("barcode", "")):
            continue
        out.append({"code": row["code"], "name": row["name"], "info": row["info"], "values": vals,
                    "status": rec.status if rec else "", "updated_by": rec.updated_by if rec else "",
                    "updated_at": rec.updated_at.isoformat(timespec="minutes") if rec and rec.updated_at else None,
                    "prev_codes": cm._j(rec.prev_codes, []) if rec else []})
    total = len(out)
    start = (page - 1) * size
    return {"total": total, "page": page, "size": size, "items": out[start:start + size]}


@router.get("/records/{entity}/{code}")
def get_record(entity: str, code: str, db: Session = Depends(get_db), _=Depends(get_current_user)):
    _entity(entity)
    row = next((x for x in cm.current_rows(entity) if x["code"] == code), None)
    rec = cm.get_record(db, entity, code)
    if row is None and rec is None:
        raise HTTPException(404, "Олдсонгүй")
    return {"code": code, "name": row["name"] if row else rec.name, "info": row["info"] if row else {},
            "in_source": row is not None, "record": cm.record_to_dict(rec) if rec else None}


class ValuesIn(BaseModel):
    values: dict


@router.put("/records/{entity}/{code}")
def put_record(entity: str, code: str, body: ValuesIn, request: Request,
               db: Session = Depends(get_db), u: User = Depends(require_role(*EDIT_ROLES))):
    _entity(entity)
    try:
        rec = cm.upsert_record(db, entity, code, body.values, by=_who(u))
    except cm.CustomMasterError as e:
        raise HTTPException(400, str(e))
    audit(db, request, u, action="custom_record_save", entity_type=f"custom_{entity}", entity_id=0,
          extra=f"{code}: {json.dumps(cm._j(rec.values, {}), ensure_ascii=False)[:300]}", autocommit=True)
    return cm.record_to_dict(rec)


@router.delete("/records/{entity}/{code}")
def delete_record(entity: str, code: str, request: Request, db: Session = Depends(get_db), u: User = Depends(require_role(*EDIT_ROLES))):
    _entity(entity)
    rec = cm.get_record(db, entity, code)
    if not rec:
        raise HTTPException(404, "Бичлэг олдсонгүй")
    db.delete(rec)
    db.commit()
    audit(db, request, u, action="custom_record_delete", entity_type=f"custom_{entity}", entity_id=0, extra=code, autocommit=True)
    return {"ok": True}


# ── Холбоос ──────────────────────────────────────────────────────────────────
@router.get("/orphans")
def orphans(entity: str = Query(...), db: Session = Depends(get_db), _=Depends(get_current_user)):
    _entity(entity)
    rows = cm.current_rows(entity)
    recs = (db.query(CustomRecord).filter(CustomRecord.entity == entity, CustomRecord.status == "orphan")
            .order_by(CustomRecord.updated_at.desc()).all())
    return [{**cm.record_to_dict(r), "suggestions": cm.suggestions(db, entity, r, rows)} for r in recs]


class RelinkIn(BaseModel):
    entity: str
    old_code: str
    new_code: str


@router.post("/relink")
def relink(body: RelinkIn, request: Request, db: Session = Depends(get_db), u: User = Depends(require_role(*EDIT_ROLES))):
    _entity(body.entity)
    try:
        rec = cm.relink(db, body.entity, body.old_code.strip(), body.new_code.strip(), by=_who(u))
    except cm.CustomMasterError as e:
        raise HTTPException(400, str(e))
    audit(db, request, u, action="custom_record_relink", entity_type=f"custom_{body.entity}", entity_id=0,
          extra=f"{body.old_code} → {body.new_code}", autocommit=True)
    try:
        cm.apply_to_excel(db, body.entity)
    except Exception:   # noqa: BLE001
        pass
    return cm.record_to_dict(rec)


@router.post("/resync")
def resync(request: Request, entity: str = Query(...), db: Session = Depends(get_db), u: User = Depends(require_role(*EDIT_ROLES))):
    _entity(entity)
    res = cm.after_import(db, entity, by=_who(u))
    audit(db, request, u, action="custom_master_resync", entity_type=f"custom_{entity}", entity_id=0,
          extra=json.dumps(res.get("sync", {}), ensure_ascii=False)[:300], autocommit=True)
    return res


@router.get("/values")
def values(entity: str = Query(...), codes: str = "", db: Session = Depends(get_db), _=Depends(get_current_user)):
    _entity(entity)
    lst = [c.strip() for c in codes.split(",") if c.strip()]
    return cm.values_map(db, entity, lst if lst else None)


@router.get("/export")
def export(entity: str = Query(...), db: Session = Depends(get_db), _=Depends(get_current_user)):
    _entity(entity)
    data = cm.build_export(db, entity)
    fname = f"{cm.ENTITY_LABEL[entity]}_нэмэлт_{datetime.now():%Y%m%d_%H%M}.xlsx"
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(fname)}"})
