"""Орлогын файлын API — он жилээр нь ТҮҮХИЙ файл хадгална (төрөлгүй).

⚠️ ЯМАР Ч ШАЛГУУРГҮЙ: оруулсан файлыг боловсруулахгүй, шүүхгүй, хэвээр нь
хадгална. Жил тус бүрд хамгийн сүүлд оруулсан "Бүх орлого" файл хадгалагдана.
Файлыг хэрхэн ашиглахыг хожим тусдаа зааврын дагуу нэмнэ.

2026 оноос САР БҮРЭЭР (month=1..12) оруулна; өмнөх онууд бүтэн он (month=0).
Сарын файлтай онд бүтэн оны файл байвал ашиглагдахгүй (давхардахгүй).

Endpoint-ууд:
  POST   /income-files/import          — multipart upload (year, month=0, file)
  GET    /income-files/slots           — бүх (он, сар)-ын төлөв (grid-д)
  GET    /income-files/download         — ?year=&month= → хадгалсан файлыг татах
  DELETE /income-files/{year}?month=   — admin only
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
from app.models.income_file import IncomeFile
from app.services.refresh_prices_from_income_report import refresh_prices_from_income_report


router = APIRouter(prefix="/income-files", tags=["income-files"])

# Энэ оноос эхлэн сар бүрээр оруулна (бүтэн оны нэг Excel хэт том болсон)
MONTHLY_FROM_YEAR = 2026

UPLOAD_DIR = Path("app/data/uploads/income")
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
    month: int = Form(0),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Файлыг ямар ч шалгуургүйгээр хэвээр нь хадгална. Тухайн (он, сар)-д өмнө нь
    файл байсан бол солино. month=0 — бүтэн он (зөвхөн MONTHLY_FROM_YEAR-аас өмнөх онд)."""
    year = int(year)
    month = int(month or 0)
    if not (0 <= month <= 12):
        raise HTTPException(400, "Сар 1..12 (эсвэл 0 = бүтэн он) байх ёстой.")
    if year >= MONTHLY_FROM_YEAR and month == 0:
        raise HTTPException(400, f"{year} оны орлогыг сар бүрээр оруулна — сараа сонгоно уу.")

    orig_name = (file.filename or "upload").replace("\\", "_").replace("/", "_")
    ext = os.path.splitext(orig_name)[1] or ".xlsx"
    stored_name = f"income_{year}_{month:02d}{ext}" if month else f"income_{year}{ext}"
    saved_path = UPLOAD_DIR / stored_name

    prev = db.query(IncomeFile).filter(IncomeFile.year == year, IncomeFile.month == month).first()
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

    # ── Урьдын адил: Орлого тайлангаас барааны сүүлийн нэгж үнийг автомат
    #    шинэчилнэ (Product.last_purchase_price). BEST-EFFORT: файл аль хэдийн
    #    хадгалагдсан тул энд алдаа гарсан ч импорт амжилттай хэвээр —
    #    "шалгуургүй шууд хадгалах" зарчмыг хадгална. ──
    # Сарын файлын хувьд: зөвхөн ХАМГИЙН СҮҮЛИЙН (он, сар)-ын файл л сүүлийн үнийг
    # шинэчилнэ — 12-р сарын дараа 1-р сарыг нөхөж оруулахад хуучин үнэ дарахгүй.
    price_update: dict = {}
    latest = (db.query(IncomeFile.year, IncomeFile.month)
                .order_by(IncomeFile.year.desc(), IncomeFile.month.desc()).first())
    is_latest = (latest is None) or ((year, month) >= (int(latest[0]), int(latest[1] or 0)))
    if is_latest:
        try:
            price_update = refresh_prices_from_income_report(db, str(saved_path)) or {}
        except Exception as e:
            price_update = {"error": str(e)}
    else:
        price_update = {"skipped": "хуучин сар — сүүлийн үнэ шинэчлээгүй"}
    price_updated = int(price_update.get("updated", 0) or 0)

    now = datetime.utcnow()
    if prev:
        prev.original_filename = orig_name
        prev.stored_filename = stored_name
        prev.size_bytes = size_bytes
        prev.row_count = row_count
        prev.price_updated = price_updated
        prev.uploaded_by_id = int(getattr(u, "id", 0) or 0)
        prev.uploaded_by_name = str(getattr(u, "username", "") or "")
        prev.uploaded_at = now
    else:
        db.add(IncomeFile(
            year=year, month=month,
            original_filename=orig_name, stored_filename=stored_name,
            size_bytes=size_bytes, row_count=row_count, price_updated=price_updated,
            uploaded_by_id=int(getattr(u, "id", 0) or 0),
            uploaded_by_name=str(getattr(u, "username", "") or ""),
            uploaded_at=now,
        ))
    db.commit()

    audit(
        db, request, u,
        action="income_file_import",
        entity_type="income_file",
        extra={"year": year, "month": month, "filename": orig_name,
               "size_bytes": size_bytes, "row_count": row_count,
               "price_update": price_update},
        autocommit=True,
    )

    return {"ok": True, "year": year, "month": month, "filename": orig_name,
            "size_bytes": size_bytes, "row_count": row_count,
            "price_update": price_update}


def _file_info(r: IncomeFile) -> dict:
    return {
        "filename": r.original_filename,
        "size_bytes": r.size_bytes or 0,
        "row_count": r.row_count or 0,
        "price_updated": r.price_updated or 0,
        "uploaded_at": (r.uploaded_at.isoformat() if r.uploaded_at else None),
        "uploaded_by": r.uploaded_by_name or "",
    }


@router.get("/slots")
def list_slots(
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Бүх (он, сар)-ын төлөв — UI-ийн grid-д хэрэглэнэ. month=0 = бүтэн он."""
    rows = db.query(IncomeFile).all()
    out = [{"year": int(r.year), "month": int(r.month or 0), "file": _file_info(r)} for r in rows]
    out.sort(key=lambda x: (x["year"], x["month"]), reverse=True)
    return {"monthly_from_year": MONTHLY_FROM_YEAR, "slots": out}


@router.get("/download")
def download_file(
    year: int = Query(...),
    month: int = Query(0),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Тухайн (он, сар)-д хадгалсан түүхий файлыг буцааж татна."""
    r = db.query(IncomeFile).filter(IncomeFile.year == int(year), IncomeFile.month == int(month or 0)).first()
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


@router.delete("/{year}")
def delete_slot(
    year: int,
    request: Request,
    month: int = Query(0),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    """Тухайн (он, сар)-ын файл + метадатаг устгана."""
    r = db.query(IncomeFile).filter(IncomeFile.year == int(year), IncomeFile.month == int(month or 0)).first()
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
        action="income_file_delete",
        entity_type="income_file",
        extra={"year": int(year), "month": int(month or 0)},
        autocommit=True,
    )
    return {"ok": True, "removed": 1}
