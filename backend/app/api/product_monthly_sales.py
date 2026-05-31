"""Сарын борлуулалтын тоо ширхэгийн API.

4 endpoint:
  POST /product-monthly-sales/import   — multipart upload (year, month, kind, file)
  POST /product-monthly-sales/stats    — JSON: { item_codes, anchor_year, anchor_month }
  GET  /product-monthly-sales/list     — query: year, month — verify-д
  DELETE /product-monthly-sales/{year}/{month}/{kind} — admin only

Stats response формат:
  {
    "ITEM_CODE": {
      "avg_12m": float,
      "avg_3m":  float,
      "last_month": float,
      "same_month_prev_year": float,
      "data_months_12m": int  // 12-аас хичнээн сард data байсан
    }
  }
"""
from __future__ import annotations

import os
import shutil
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_, tuple_
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, require_role
from app.core.audit import audit
from app.models.user import User
from app.models.product_monthly_sales import (
    ProductMonthlySales,
    PMS_KIND_WAREHOUSE,
    PMS_KIND_SHOWROOM,
    PMS_KINDS,
)
from app.services.product_monthly_sales_parser import parse_and_upsert


router = APIRouter(prefix="/product-monthly-sales", tags=["product-monthly-sales"])

UPLOAD_DIR = Path("app/data/uploads/monthly_sales")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ── Баганын тохиргоо (Excel-ийн аль багана код/тоо вэ) ──────────────────────
_CONFIG_FILE = Path("app/data/monthly_sales_config.json")
_DEFAULT_CONFIG = {"code_col": 0, "qty_col": 1}   # A=код, B=тоо (0-based)


def get_ms_config() -> dict:
    """Excel баганын тохиргоо: {"code_col": int, "qty_col": int} (0-based)."""
    import json
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


def set_ms_config(code_col: int, qty_col: int) -> dict:
    import json
    cfg = {"code_col": max(0, int(code_col)), "qty_col": max(0, int(qty_col))}
    _CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    _CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg


# ── Helpers ─────────────────────────────────────────────────────────────────

def _shift_month(year: int, month: int, delta: int) -> tuple[int, int]:
    """(year, month) дээр delta сар нэмж/хасч буцаана."""
    total = year * 12 + (month - 1) + delta
    return total // 12, (total % 12) + 1


def _compute_needed_months(anchor_y: int, anchor_m: int) -> list[tuple[int, int]]:
    """Stats тооцоход хэрэгтэй бүх (year, month) хослолуудыг буцаана.

    - 12 сарын window: anchor-аас 1..12 сар өмнө
    - 3 сарын window нь 12 сарын window-д багтана
    - last_month нь 1 сар өмнө = 12 сарын window-д багтана
    - same_month_prev_year = (anchor_y - 1, anchor_m) — энэ нь 12 сарын window-д
      багтаагүй бол нэмэлтээр хийнэ (anchor нь 1-р сар бол багтаагүй)
    """
    months: set[tuple[int, int]] = set()
    for i in range(1, 13):
        months.add(_shift_month(anchor_y, anchor_m, -i))
    # Өмнөх оны энэ сар
    months.add((anchor_y - 1, anchor_m))
    return sorted(months)


# ── Schemas ─────────────────────────────────────────────────────────────────

class StatsRequest(BaseModel):
    item_codes: list[str] = Field(..., max_length=2000)
    anchor_year: int
    anchor_month: int


class StatsResult(BaseModel):
    avg_12m: float
    avg_3m: float
    last_month: float
    same_month_prev_year: float
    data_months_12m: int


# ── Endpoints ───────────────────────────────────────────────────────────────

@router.post("/import")
def import_excel(
    request: Request,
    year: int = Form(...),
    month: int = Form(...),
    kind: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Excel файлыг (item_code + qty) парс хийгээд upsert хийнэ."""
    if kind not in PMS_KINDS:
        raise HTTPException(400, f"kind нь '{PMS_KIND_WAREHOUSE}' эсвэл '{PMS_KIND_SHOWROOM}' байх ёстой.")
    if not (1 <= month <= 12):
        raise HTTPException(400, "month нь 1-12 хооронд байх ёстой.")
    if year < 2000 or year > 2100:
        raise HTTPException(400, "year буруу байна.")
    if not (file.filename or "").lower().endswith((".xlsx", ".xls")):
        raise HTTPException(400, "Зөвхөн Excel (.xlsx, .xls) файл хүлээн авна.")

    # Файлыг хадгална (audit-д ашиглах)
    slot_dir = UPLOAD_DIR / kind / str(year) / f"{month:02d}"
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

    # Parse + upsert (баганын тохиргоог ашиглана)
    cfg = get_ms_config()
    try:
        result = parse_and_upsert(saved_path, year=year, month=month, kind=kind, db=db,
                                  code_col=cfg["code_col"], qty_col=cfg["qty_col"])
    except Exception as e:
        raise HTTPException(400, f"Файлыг боловсруулахад алдаа гарлаа: {e}")

    # Audit log
    audit(
        db, request, u,
        action="product_monthly_sales_import",
        entity_type="product_monthly_sales",
        extra={
            "year": year, "month": month, "kind": kind,
            "filename": file.filename, "rows_parsed": result["parsed"],
            "rows_upserted": result["upserted"], "rows_skipped": result["skipped"],
        },
        autocommit=True,
    )

    return {
        "ok": True,
        "year": year,
        "month": month,
        "kind": kind,
        "rows_parsed": result["parsed"],
        "rows_upserted": result["upserted"],
        "rows_skipped": result["skipped"],
        "examples": result["examples"],
    }


@router.post("/stats")
def get_stats(
    body: StatsRequest,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Бараа болгоны 4 metric буцаана. Captacity-цээ optim хийсэн нэг batch query."""
    if not body.item_codes:
        return {}
    if not (1 <= body.anchor_month <= 12):
        raise HTTPException(400, "anchor_month буруу.")

    anchor_y = body.anchor_year
    anchor_m = body.anchor_month
    needed = _compute_needed_months(anchor_y, anchor_m)
    if not needed:
        return {}

    last_y, last_m = _shift_month(anchor_y, anchor_m, -1)
    prev_year_y, prev_year_m = anchor_y - 1, anchor_m

    # Сүүлийн 12 сар (anchor-1 .. anchor-12)
    last_12_months = {_shift_month(anchor_y, anchor_m, -i) for i in range(1, 13)}
    last_3_months  = {_shift_month(anchor_y, anchor_m, -i) for i in range(1, 4)}

    # 500-аар batch — SQLite variable limit (~999)
    BATCH = 500
    codes = [c for c in body.item_codes if c]

    # Тухайн item_code-ийн (year, month) → total qty mapping
    by_code: dict[str, dict[tuple[int, int], float]] = defaultdict(dict)

    for i in range(0, len(codes), BATCH):
        chunk = codes[i:i + BATCH]
        rows = db.query(
            ProductMonthlySales.item_code,
            ProductMonthlySales.year,
            ProductMonthlySales.month,
            ProductMonthlySales.qty_warehouse,
            ProductMonthlySales.qty_showroom,
        ).filter(
            ProductMonthlySales.item_code.in_(chunk),
            tuple_(ProductMonthlySales.year, ProductMonthlySales.month).in_(needed),
        ).all()
        for code, y, m, qw, qs in rows:
            total = (qw or 0.0) + (qs or 0.0)
            if total > 0:
                by_code[code][(y, m)] = total

    # Метрик тооцоо
    out: dict[str, dict] = {}
    for code in codes:
        months_data = by_code.get(code, {})
        if not months_data:
            # Data байхгүй → бүх утгыг 0 (frontend "—"-р харуулна)
            out[code] = {
                "avg_12m": 0.0, "avg_3m": 0.0,
                "last_month": 0.0, "same_month_prev_year": 0.0,
                "data_months_12m": 0,
            }
            continue

        # last 12 months
        sum_12, cnt_12 = 0.0, 0
        for ym in last_12_months:
            if ym in months_data:
                sum_12 += months_data[ym]
                cnt_12 += 1
        avg_12 = (sum_12 / cnt_12) if cnt_12 > 0 else 0.0

        # last 3 months
        sum_3, cnt_3 = 0.0, 0
        for ym in last_3_months:
            if ym in months_data:
                sum_3 += months_data[ym]
                cnt_3 += 1
        avg_3 = (sum_3 / cnt_3) if cnt_3 > 0 else 0.0

        out[code] = {
            "avg_12m": round(avg_12, 1),
            "avg_3m":  round(avg_3, 1),
            "last_month": round(months_data.get((last_y, last_m), 0.0), 1),
            "same_month_prev_year": round(months_data.get((prev_year_y, prev_year_m), 0.0), 1),
            "data_months_12m": cnt_12,
        }
    return out


@router.get("/list")
def list_slot(
    year: int,
    month: int,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Тухайн (year, month)-ийн бүх бараа + qty жагсаалт."""
    if not (1 <= month <= 12):
        raise HTTPException(400, "month буруу.")

    rows = db.query(
        ProductMonthlySales.item_code,
        ProductMonthlySales.qty_warehouse,
        ProductMonthlySales.qty_showroom,
        ProductMonthlySales.updated_at,
    ).filter(
        ProductMonthlySales.year == year,
        ProductMonthlySales.month == month,
    ).order_by(ProductMonthlySales.item_code).all()

    return {
        "year": year,
        "month": month,
        "count": len(rows),
        "items": [
            {
                "item_code": code,
                "qty_warehouse": qw or 0.0,
                "qty_showroom": qs or 0.0,
                "qty_total": (qw or 0.0) + (qs or 0.0),
                "updated_at": (updated.isoformat() if updated else None),
            }
            for code, qw, qs, updated in rows
        ],
    }


@router.get("/slots")
def list_slots(
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Бүх (year, month) slot-уудын товчилсон жагсаалт — UI-ийн status grid-д хэрэглэнэ."""
    rows = db.query(
        ProductMonthlySales.year,
        ProductMonthlySales.month,
        ProductMonthlySales.qty_warehouse,
        ProductMonthlySales.qty_showroom,
    ).all()

    by_slot: dict[tuple[int, int], dict] = {}
    for y, m, qw, qs in rows:
        key = (y, m)
        if key not in by_slot:
            by_slot[key] = {"count": 0, "has_warehouse": False, "has_showroom": False}
        by_slot[key]["count"] += 1
        if (qw or 0.0) > 0:
            by_slot[key]["has_warehouse"] = True
        if (qs or 0.0) > 0:
            by_slot[key]["has_showroom"] = True

    return [
        {
            "year": y,
            "month": m,
            "count": info["count"],
            "has_warehouse": info["has_warehouse"],
            "has_showroom": info["has_showroom"],
        }
        for (y, m), info in sorted(by_slot.items(), reverse=True)
    ]


class ConfigIn(BaseModel):
    code_col: int = 0
    qty_col: int = 1


@router.get("/config")
def get_config(u: User = Depends(require_role("admin", "supervisor", "manager"))):
    """Excel баганын тохиргоо (код/тоо багана)."""
    return get_ms_config()


@router.put("/config")
def put_config(
    body: ConfigIn,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    cfg = set_ms_config(body.code_col, body.qty_col)
    audit(db, request, u, action="product_monthly_sales_config",
          entity_type="product_monthly_sales", extra=cfg, autocommit=True)
    return cfg


@router.delete("/{year}/{month}/{kind}")
def delete_slot(
    year: int,
    month: int,
    kind: str,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    """Тухайн slot-ийн kind талын qty-г 0 болгоно. Хэрэв нөгөө тал нь ч 0 бол мөрийг устгана."""
    if kind not in PMS_KINDS:
        raise HTTPException(400, "kind буруу.")
    if not (1 <= month <= 12):
        raise HTTPException(400, "month буруу.")

    rows = db.query(ProductMonthlySales).filter(
        ProductMonthlySales.year == year,
        ProductMonthlySales.month == month,
    ).all()

    affected = 0
    removed = 0
    for r in rows:
        if kind == PMS_KIND_WAREHOUSE:
            if (r.qty_warehouse or 0.0) <= 0:
                continue
            r.qty_warehouse = 0.0
        else:
            if (r.qty_showroom or 0.0) <= 0:
                continue
            r.qty_showroom = 0.0
        affected += 1
        # Хоёр тал нь 0 болсон бол мөрийг устгана
        if (r.qty_warehouse or 0.0) <= 0 and (r.qty_showroom or 0.0) <= 0:
            db.delete(r)
            removed += 1
    db.commit()

    audit(
        db, request, u,
        action="product_monthly_sales_delete",
        entity_type="product_monthly_sales",
        extra={"year": year, "month": month, "kind": kind, "affected": affected, "removed": removed},
        autocommit=True,
    )

    return {"ok": True, "affected": affected, "removed": removed}
