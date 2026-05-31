"""Барааны жилийн хөдөлгөөний API.

Endpoint-ууд:
  POST   /product-yearly-movement/import          — multipart upload (year, kind, file)
  GET    /product-yearly-movement/slots           — бүх жилийн товч төлөв (grid-д)
  GET    /product-yearly-movement/list?year=      — тухайн жилийн бараа + qty жагсаалт
  GET    /product-yearly-movement/config          — Excel баганын тохиргоо
  PUT    /product-yearly-movement/config          — баганын тохиргоо хадгалах
  DELETE /product-yearly-movement/{year}/{kind}   — admin only

ЗӨВХӨН ОНООР — сар бүрийн задаргаа байхгүй.
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, require_role
from app.core.audit import audit
from app.models.user import User
from app.models.product_yearly_movement import (
    ProductYearlyMovement,
    PYM_KIND_MAIN,
    PYM_KIND_LIQUOR,
    PYM_KINDS,
)
from app.services.product_yearly_movement_parser import parse_and_upsert


router = APIRouter(prefix="/product-yearly-movement", tags=["product-yearly-movement"])

UPLOAD_DIR = Path("app/data/uploads/yearly_movement")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ── Баганын тохиргоо (Excel-ийн аль багана код/тоо вэ) ──────────────────────
_CONFIG_FILE = Path("app/data/movement_config.json")
_DEFAULT_CONFIG = {"code_col": 0, "qty_col": 1}   # A=код, B=тоо (0-based)


def get_mv_config() -> dict:
    """Excel баганын тохиргоо: {"code_col": int, "qty_col": int} (0-based)."""
    try:
        if _CONFIG_FILE.exists():
            d = json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
            return {
                "code_col": max(0, int(d.get("code_col", 0))),
                "qty_col": max(0, int(d.get("qty_col", 1))),
            }
    except Exception:
        pass
    return dict(_DEFAULT_CONFIG)


def set_mv_config(code_col: int, qty_col: int) -> dict:
    cfg = {"code_col": max(0, int(code_col)), "qty_col": max(0, int(qty_col))}
    _CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    _CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg


# ── Endpoints ───────────────────────────────────────────────────────────────

@router.post("/import")
def import_excel(
    request: Request,
    year: int = Form(...),
    kind: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Excel файлыг (item_code + qty) парс хийгээд upsert хийнэ."""
    if kind not in PYM_KINDS:
        raise HTTPException(400, f"kind нь '{PYM_KIND_MAIN}' эсвэл '{PYM_KIND_LIQUOR}' байх ёстой.")
    if year < 2000 or year > 2100:
        raise HTTPException(400, "year буруу байна.")
    if not (file.filename or "").lower().endswith((".xlsx", ".xls")):
        raise HTTPException(400, "Зөвхөн Excel (.xlsx, .xls) файл хүлээн авна.")

    # Файлыг хадгална (audit-д ашиглах)
    slot_dir = UPLOAD_DIR / kind / str(year)
    slot_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    safe_name = (file.filename or "upload.xlsx").replace("\\", "_").replace("/", "_")
    saved_path = slot_dir / f"{ts}_{safe_name}"
    try:
        with open(saved_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    finally:
        try:
            file.file.close()
        except Exception:
            pass

    cfg = get_mv_config()
    try:
        result = parse_and_upsert(saved_path, year=year, kind=kind, db=db,
                                  code_col=cfg["code_col"], qty_col=cfg["qty_col"])
    except Exception as e:
        raise HTTPException(400, f"Файлыг боловсруулахад алдаа гарлаа: {e}")

    audit(
        db, request, u,
        action="product_yearly_movement_import",
        entity_type="product_yearly_movement",
        extra={
            "year": year, "kind": kind,
            "filename": file.filename, "rows_parsed": result["parsed"],
            "rows_upserted": result["upserted"], "rows_skipped": result["skipped"],
        },
        autocommit=True,
    )

    return {
        "ok": True,
        "year": year,
        "kind": kind,
        "rows_parsed": result["parsed"],
        "rows_upserted": result["upserted"],
        "rows_skipped": result["skipped"],
        "examples": result["examples"],
    }


@router.get("/slots")
def list_slots(
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Бүх жилийн товчилсон төлөв — UI-ийн grid-д хэрэглэнэ."""
    rows = db.query(
        ProductYearlyMovement.year,
        ProductYearlyMovement.qty_main,
        ProductYearlyMovement.qty_liquor,
    ).all()

    by_year: dict[int, dict] = {}
    for y, qm, ql in rows:
        info = by_year.setdefault(y, {"count": 0, "has_main": False, "has_liquor": False})
        info["count"] += 1
        if (qm or 0.0) > 0:
            info["has_main"] = True
        if (ql or 0.0) > 0:
            info["has_liquor"] = True

    return [
        {"year": y, "count": info["count"], "has_main": info["has_main"], "has_liquor": info["has_liquor"]}
        for y, info in sorted(by_year.items(), reverse=True)
    ]


@router.get("/list")
def list_year(
    year: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Тухайн жилийн бүх бараа + qty жагсаалт."""
    rows = db.query(
        ProductYearlyMovement.item_code,
        ProductYearlyMovement.qty_main,
        ProductYearlyMovement.qty_liquor,
        ProductYearlyMovement.updated_at,
    ).filter(
        ProductYearlyMovement.year == year,
    ).order_by(ProductYearlyMovement.item_code).all()

    return {
        "year": year,
        "count": len(rows),
        "items": [
            {
                "item_code": code,
                "qty_main": qm or 0.0,
                "qty_liquor": ql or 0.0,
                "qty_total": (qm or 0.0) + (ql or 0.0),
                "updated_at": (updated.isoformat() if updated else None),
            }
            for code, qm, ql, updated in rows
        ],
    }


class ConfigIn(BaseModel):
    code_col: int = 0
    qty_col: int = 1


@router.get("/config")
def get_config(u: User = Depends(require_role("admin", "supervisor", "manager"))):
    """Excel баганын тохиргоо (код/тоо багана)."""
    return get_mv_config()


@router.put("/config")
def put_config(
    body: ConfigIn,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    cfg = set_mv_config(body.code_col, body.qty_col)
    audit(db, request, u, action="product_yearly_movement_config",
          entity_type="product_yearly_movement", extra=cfg, autocommit=True)
    return cfg


@router.delete("/{year}/{kind}")
def delete_slot(
    year: int,
    kind: str,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    """Тухайн жилийн kind талын qty-г 0 болгоно. Хэрэв нөгөө тал нь ч 0 бол мөрийг устгана."""
    if kind not in PYM_KINDS:
        raise HTTPException(400, "kind буруу.")

    rows = db.query(ProductYearlyMovement).filter(
        ProductYearlyMovement.year == year,
    ).all()

    affected = 0
    removed = 0
    for r in rows:
        if kind == PYM_KIND_MAIN:
            if (r.qty_main or 0.0) <= 0:
                continue
            r.qty_main = 0.0
        else:
            if (r.qty_liquor or 0.0) <= 0:
                continue
            r.qty_liquor = 0.0
        affected += 1
        if (r.qty_main or 0.0) <= 0 and (r.qty_liquor or 0.0) <= 0:
            db.delete(r)
            removed += 1
    db.commit()

    audit(
        db, request, u,
        action="product_yearly_movement_delete",
        entity_type="product_yearly_movement",
        extra={"year": year, "kind": kind, "affected": affected, "removed": removed},
        autocommit=True,
    )

    return {"ok": True, "affected": affected, "removed": removed}
