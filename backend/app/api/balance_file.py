"""Үлдэгдлийн файлын API — төрлөөр нь ТҮҮХИЙ файл хадгална (он хэмжээсгүй).

⚠️ ЯМАР Ч ШАЛГУУРГҮЙ: оруулсан файлыг боловсруулахгүй, шүүхгүй, хэвээр нь
хадгална. Төрөл тус бүрд хамгийн сүүлд оруулсан файл хадгалагдана (өдөр бүр
шинэчилж оруулна). Файлыг хэрхэн ашиглахыг хожим тусдаа зааврын дагуу нэмнэ.

3 төрөл: warehouse (Бүх агуулах), main (Үндсэн заал), liquor (Архины заал).

Endpoint-ууд:
  POST   /balance-files/import          — multipart upload (kind, file)
  GET    /balance-files/slots           — 3 төрлийн төлөв (UI-д)
  GET    /balance-files/download         — ?kind= → хадгалсан файлыг татах
  DELETE /balance-files/{kind}          — admin only
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
from app.models.balance_file import (
    BalanceFile,
    BAL_KIND_WAREHOUSE,
    BAL_KIND_MAIN,
    BAL_KIND_LIQUOR,
    BAL_KINDS,
)


router = APIRouter(prefix="/balance-files", tags=["balance-files"])

UPLOAD_DIR = Path("app/data/uploads/balance")
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
    kind: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Файлыг ямар ч шалгуургүйгээр хэвээр нь хадгална. Тухайн төрөлд өмнө нь
    файл байсан бол солино (өдөр бүр шинэчилж оруулна)."""
    if kind not in BAL_KINDS:
        raise HTTPException(400, f"kind нь '{BAL_KIND_WAREHOUSE}', '{BAL_KIND_MAIN}' эсвэл '{BAL_KIND_LIQUOR}' байх ёстой.")

    orig_name = (file.filename or "upload").replace("\\", "_").replace("/", "_")
    ext = os.path.splitext(orig_name)[1] or ".xlsx"
    stored_name = f"{kind}{ext}"
    saved_path = UPLOAD_DIR / stored_name

    prev = db.query(BalanceFile).filter(BalanceFile.kind == kind).first()
    if prev and prev.stored_filename and prev.stored_filename != stored_name:
        try:
            (UPLOAD_DIR / prev.stored_filename).unlink(missing_ok=True)
        except Exception:
            pass

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
        db.add(BalanceFile(
            kind=kind,
            original_filename=orig_name, stored_filename=stored_name,
            size_bytes=size_bytes, row_count=row_count,
            uploaded_by_id=int(getattr(u, "id", 0) or 0),
            uploaded_by_name=str(getattr(u, "username", "") or ""),
            uploaded_at=now,
        ))
    db.commit()

    audit(
        db, request, u,
        action="balance_file_import",
        entity_type="balance_file",
        extra={"kind": kind, "filename": orig_name,
               "size_bytes": size_bytes, "row_count": row_count},
        autocommit=True,
    )

    return {"ok": True, "kind": kind,
            "filename": orig_name, "size_bytes": size_bytes, "row_count": row_count}


def _file_info(r: BalanceFile) -> dict:
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
    """3 төрлийн төлөв — UI-д хэрэглэнэ. {warehouse, main, liquor}: FileInfo|null."""
    rows = db.query(BalanceFile).all()
    out: dict[str, dict | None] = {BAL_KIND_WAREHOUSE: None, BAL_KIND_MAIN: None, BAL_KIND_LIQUOR: None}
    for r in rows:
        if r.kind in out:
            out[r.kind] = _file_info(r)
    return out


@router.get("/download")
def download_file(
    kind: str = Query(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Тухайн төрөлд хадгалсан түүхий файлыг буцааж татна."""
    if kind not in BAL_KINDS:
        raise HTTPException(400, "kind буруу.")
    r = db.query(BalanceFile).filter(BalanceFile.kind == kind).first()
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


@router.delete("/{kind}")
def delete_slot(
    kind: str,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    """Тухайн төрлийн файл + метадатаг устгана."""
    if kind not in BAL_KINDS:
        raise HTTPException(400, "kind буруу.")
    r = db.query(BalanceFile).filter(BalanceFile.kind == kind).first()
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
        action="balance_file_delete",
        entity_type="balance_file",
        extra={"kind": kind},
        autocommit=True,
    )
    return {"ok": True, "removed": 1}
