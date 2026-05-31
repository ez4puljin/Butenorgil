"""Хөдөлгөөний файлын API — он жил + төрлөөр нь ТҮҮХИЙ файл хадгална.

⚠️ ЯМАР Ч ШАЛГУУРГҮЙ: оруулсан файлыг боловсруулахгүй, шүүхгүй, хэвээр нь
хадгална. (year, kind) тус бүрд хамгийн сүүлд оруулсан файл хадгалагдана.
Файлыг хэрхэн ашиглахыг хожим тусдаа зааврын дагуу нэмнэ.

Endpoint-ууд:
  POST   /product-yearly-movement/import          — multipart upload (year, kind, file)
  GET    /product-yearly-movement/slots           — бүх жилийн төлөв (grid-д)
  GET    /product-yearly-movement/download         — ?year=&kind= → хадгалсан файлыг татах
  DELETE /product-yearly-movement/{year}/{kind}   — admin only
"""
from __future__ import annotations

import os
import shutil
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_role
from app.core.audit import audit
from app.models.user import User
from app.models.movement_file import (
    MovementFile,
    PYM_KIND_MAIN,
    PYM_KIND_LIQUOR,
    PYM_KINDS,
)


router = APIRouter(prefix="/product-yearly-movement", tags=["product-yearly-movement"])

UPLOAD_DIR = Path("app/data/uploads/yearly_movement")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _safe_row_count(path: Path) -> int:
    """Файлын мөрийн тоог best-effort-оор тоолно. Алдвал 0 буцаана —
    импортыг ХЭЗЭЭ Ч зогсоохгүй (зөвхөн мэдээллийн зорилгоор)."""
    try:
        import pandas as pd
        name = str(path).lower()
        order = ["xlrd", "openpyxl"] if name.endswith(".xls") else ["openpyxl", "xlrd"]
        for eng in order:
            try:
                df = pd.read_excel(path, header=None, dtype=str, engine=eng)
                return int(len(df))
            except Exception:
                continue
    except Exception:
        pass
    return 0


@router.post("/import")
def import_file(
    request: Request,
    year: int = Form(...),
    kind: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Файлыг ямар ч шалгуургүйгээр хэвээр нь хадгална. (year, kind) хослолд
    өмнө нь файл байсан бол солино."""
    if kind not in PYM_KINDS:
        raise HTTPException(400, f"kind нь '{PYM_KIND_MAIN}' эсвэл '{PYM_KIND_LIQUOR}' байх ёстой.")
    year = int(year)

    # Өргөтгөлийг хадгална (буцааж татахад зөв нээгдэхийн тулд) — гэхдээ ШААРДАХГҮЙ
    orig_name = (file.filename or "upload").replace("\\", "_").replace("/", "_")
    ext = os.path.splitext(orig_name)[1] or ".xlsx"
    stored_name = f"{kind}_{year}{ext}"
    saved_path = UPLOAD_DIR / stored_name

    # Хуучин файлыг (өөр өргөтгөлтэй байсан бол) цэвэрлэнэ
    prev = db.query(MovementFile).filter(
        MovementFile.year == year, MovementFile.kind == kind
    ).first()
    if prev and prev.stored_filename and prev.stored_filename != stored_name:
        try:
            (UPLOAD_DIR / prev.stored_filename).unlink(missing_ok=True)
        except Exception:
            pass

    # Файлыг хадгална
    try:
        with open(saved_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    finally:
        try:
            file.file.close()
        except Exception:
            pass

    size_bytes = saved_path.stat().st_size if saved_path.exists() else 0
    row_count = _safe_row_count(saved_path)
    now = datetime.utcnow()

    if prev:
        prev.original_filename = orig_name
        prev.stored_filename = stored_name
        prev.size_bytes = size_bytes
        prev.row_count = row_count
        prev.uploaded_by_id = int(getattr(u, "id", 0) or 0)
        prev.uploaded_by_name = str(getattr(u, "username", "") or "")
        prev.uploaded_at = now
    else:
        db.add(MovementFile(
            year=year, kind=kind,
            original_filename=orig_name, stored_filename=stored_name,
            size_bytes=size_bytes, row_count=row_count,
            uploaded_by_id=int(getattr(u, "id", 0) or 0),
            uploaded_by_name=str(getattr(u, "username", "") or ""),
            uploaded_at=now,
        ))
    db.commit()

    audit(
        db, request, u,
        action="product_yearly_movement_import",
        entity_type="movement_file",
        extra={"year": year, "kind": kind, "filename": orig_name,
               "size_bytes": size_bytes, "row_count": row_count},
        autocommit=True,
    )

    return {
        "ok": True, "year": year, "kind": kind,
        "filename": orig_name, "size_bytes": size_bytes, "row_count": row_count,
    }


def _file_info(r: MovementFile) -> dict:
    return {
        "filename": r.original_filename,
        "size_bytes": r.size_bytes or 0,
        "row_count": r.row_count or 0,
        "uploaded_at": (r.uploaded_at.isoformat() if r.uploaded_at else None),
        "uploaded_by": r.uploaded_by_name or "",
    }


@router.get("/slots")
def list_slots(
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Бүх жилийн төлөв — UI-ийн grid-д хэрэглэнэ."""
    rows = db.query(MovementFile).all()
    by_year: dict[int, dict] = {}
    for r in rows:
        y = int(r.year)
        info = by_year.setdefault(y, {"year": y, "has_main": False, "has_liquor": False,
                                       "main": None, "liquor": None})
        if r.kind == PYM_KIND_MAIN:
            info["has_main"] = True
            info["main"] = _file_info(r)
        elif r.kind == PYM_KIND_LIQUOR:
            info["has_liquor"] = True
            info["liquor"] = _file_info(r)
    return [by_year[y] for y in sorted(by_year.keys(), reverse=True)]


@router.get("/download")
def download_file(
    year: int = Query(...),
    kind: str = Query(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Тухайн (year, kind)-д хадгалсан түүхий файлыг буцааж татна."""
    if kind not in PYM_KINDS:
        raise HTTPException(400, "kind буруу.")
    r = db.query(MovementFile).filter(
        MovementFile.year == int(year), MovementFile.kind == kind
    ).first()
    if not r or not r.stored_filename:
        raise HTTPException(404, "Файл олдсонгүй.")
    path = UPLOAD_DIR / r.stored_filename
    if not path.exists():
        raise HTTPException(404, "Хадгалсан файл байхгүй байна.")
    return FileResponse(
        path=str(path),
        filename=r.original_filename or r.stored_filename,
        media_type="application/octet-stream",
    )


@router.delete("/{year}/{kind}")
def delete_slot(
    year: int,
    kind: str,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    """Тухайн (year, kind)-ийн файл + метадатаг устгана."""
    if kind not in PYM_KINDS:
        raise HTTPException(400, "kind буруу.")
    r = db.query(MovementFile).filter(
        MovementFile.year == int(year), MovementFile.kind == kind
    ).first()
    if not r:
        return {"ok": True, "removed": 0}
    if r.stored_filename:
        try:
            (UPLOAD_DIR / r.stored_filename).unlink(missing_ok=True)
        except Exception:
            pass
    db.delete(r)
    db.commit()
    audit(
        db, request, u,
        action="product_yearly_movement_delete",
        entity_type="movement_file",
        extra={"year": int(year), "kind": kind},
        autocommit=True,
    )
    return {"ok": True, "removed": 1}
