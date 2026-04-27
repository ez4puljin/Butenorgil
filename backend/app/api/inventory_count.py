from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
from datetime import date, datetime
from pathlib import Path

from app.api.deps import get_db, require_role

from app.models.inventory_count import InventoryCount, InventoryCountFile
from app.models.kpi import KpiAdminDailyTask, KpiChecklistEntry

router = APIRouter(prefix="/inventory-count", tags=["inventory-count"])

UPLOAD_DIR = Path(__file__).resolve().parent.parent / "data" / "uploads" / "inventory_count"

# ── Constants ────────────────────────────────────────────────────────────────

WAREHOUSES = [
    {"key": "drink_alcohol",    "label": "Ус ундаа архи агуулах", "color": "text-blue-700",    "bg": "bg-blue-50 border-blue-200"},
    {"key": "retail",           "label": "Жижиглэн агуулах",      "color": "text-emerald-700", "bg": "bg-emerald-50 border-emerald-200"},
    {"key": "wholesale",        "label": "Бөөний агуулах",        "color": "text-violet-700",  "bg": "bg-violet-50 border-violet-200"},
    {"key": "contract",         "label": "Гэрээт агуулах",        "color": "text-amber-700",   "bg": "bg-amber-50 border-amber-200"},
    {"key": "alcohol_hall",     "label": "Архины заал",           "color": "text-rose-700",    "bg": "bg-rose-50 border-rose-200"},
    {"key": "hall",             "label": "Заал",                   "color": "text-sky-700",     "bg": "bg-sky-50 border-sky-200"},
    {"key": "kharkhorin_wh",    "label": "Хархорин агуулах",      "color": "text-orange-700",  "bg": "bg-orange-50 border-orange-200"},
    {"key": "kharkhorin_hall",  "label": "Хархорин заал",         "color": "text-teal-700",    "bg": "bg-teal-50 border-teal-200"},
]

WAREHOUSE_MAP = {w["key"]: w for w in WAREHOUSES}


# ── Schemas ──────────────────────────────────────────────────────────────────

class CountCreate(BaseModel):
    warehouse_key: str
    count_date: date
    description: str = ""
    target_employee_ids: List[int] = []
    points: float = 0.0


class CountUpdate(BaseModel):
    count_date: Optional[date] = None
    description: Optional[str] = None
    target_employee_ids: Optional[List[int]] = None
    points: Optional[float] = None


class ChecklistUpdate(BaseModel):
    check_all_synced: Optional[bool] = None
    check_no_partial: Optional[bool] = None
    check_no_wh14_sales: Optional[bool] = None
    check_balance_unchanged: Optional[bool] = None


def _build_kpi_task_name(warehouse_label: str, description: str) -> str:
    desc = (description or "").strip()
    if desc:
        return f"{warehouse_label} — {desc}"
    return warehouse_label


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/warehouses")
def list_warehouses(_=Depends(require_role("admin", "supervisor", "manager"))):
    return WAREHOUSES


@router.get("/counts")
def list_counts(
    warehouse: Optional[str] = None,
    year: Optional[int] = None,
    month: Optional[int] = None,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    from sqlalchemy import extract

    q = db.query(InventoryCount).order_by(InventoryCount.count_date.desc())
    if warehouse:
        q = q.filter(InventoryCount.warehouse_key == warehouse)
    if year:
        q = q.filter(extract("year", InventoryCount.count_date) == year)
    if month:
        q = q.filter(extract("month", InventoryCount.count_date) == month)

    rows = q.all()
    result = []
    for r in rows:
        wh = WAREHOUSE_MAP.get(r.warehouse_key, {})
        kpi_points = None
        kpi_target_ids: list[int] = []
        kpi_active = None
        if r.kpi_admin_task_id:
            kt = db.query(KpiAdminDailyTask).filter(
                KpiAdminDailyTask.id == r.kpi_admin_task_id
            ).first()
            if kt:
                kpi_points = kt.monetary_value
                kpi_target_ids = [
                    int(x) for x in (kt.target_employee_ids or "").split(",") if x.strip()
                ]
                kpi_active = kt.is_active
        result.append({
            "id": r.id,
            "warehouse_key": r.warehouse_key,
            "warehouse_label": wh.get("label", r.warehouse_key),
            "count_date": r.count_date.isoformat(),
            "description": r.description,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "created_by": r.created_by,
            "file_count": len(r.files),
            "files": [
                {
                    "id": f.id,
                    "file_type": f.file_type,
                    "original_filename": f.original_filename,
                    "uploaded_at": f.uploaded_at.isoformat() if f.uploaded_at else None,
                }
                for f in r.files
            ],
            "kpi_admin_task_id": r.kpi_admin_task_id,
            "kpi_points": kpi_points,
            "kpi_target_employee_ids": kpi_target_ids,
            "kpi_task_active": kpi_active,
            # Checklist
            "check_all_synced": bool(getattr(r, "check_all_synced", False)),
            "check_no_partial": bool(getattr(r, "check_no_partial", False)),
            "check_no_wh14_sales": bool(getattr(r, "check_no_wh14_sales", False)),
            "check_balance_unchanged": bool(getattr(r, "check_balance_unchanged", False)),
        })
    return result


@router.post("/counts")
def create_count(
    body: CountCreate,
    db: Session = Depends(get_db),
    u=Depends(require_role("admin", "supervisor", "manager")),
):
    if body.warehouse_key not in WAREHOUSE_MAP:
        raise HTTPException(400, "Агуулах олдсонгүй")
    wh_label = WAREHOUSE_MAP[body.warehouse_key]["label"]

    c = InventoryCount(
        warehouse_key=body.warehouse_key,
        count_date=body.count_date,
        description=body.description,
        created_by=u.username if hasattr(u, "username") else "",
    )
    db.add(c)
    db.flush()

    # KPI admin task үүсгэх (ажилтан сонгосон бол)
    kpi_task_id = None
    if body.target_employee_ids:
        task_name = _build_kpi_task_name(wh_label, body.description)
        target_ids_str = ",".join(str(x) for x in body.target_employee_ids)
        kpi_task = KpiAdminDailyTask(
            task_name=task_name,
            monetary_value=body.points,
            task_category="inventory",
            date=body.count_date,
            approver_id=u.id,
            created_by=u.id,
            is_active=True,
            target_employee_ids=target_ids_str,
        )
        db.add(kpi_task)
        db.flush()
        c.kpi_admin_task_id = kpi_task.id
        kpi_task_id = kpi_task.id

    db.commit()
    db.refresh(c)
    return {"id": c.id, "ok": True, "kpi_admin_task_id": kpi_task_id}


@router.put("/counts/{count_id}")
def update_count(
    count_id: int,
    body: CountUpdate,
    db: Session = Depends(get_db),
    u=Depends(require_role("admin")),
):
    c = db.query(InventoryCount).filter(InventoryCount.id == count_id).first()
    if not c:
        raise HTTPException(404, "Тооллого олдсонгүй")

    if body.count_date is not None:
        c.count_date = body.count_date
    if body.description is not None:
        c.description = body.description

    # Sync KPI admin task
    wh_label = WAREHOUSE_MAP.get(c.warehouse_key, {}).get("label", c.warehouse_key)
    kpi_task = None
    if c.kpi_admin_task_id:
        kpi_task = db.query(KpiAdminDailyTask).filter(
            KpiAdminDailyTask.id == c.kpi_admin_task_id
        ).first()

    if kpi_task:
        kpi_task.task_name = _build_kpi_task_name(wh_label, c.description)
        kpi_task.date = c.count_date
        if body.points is not None:
            kpi_task.monetary_value = body.points
        if body.target_employee_ids is not None:
            kpi_task.target_employee_ids = ",".join(str(x) for x in body.target_employee_ids)
    else:
        # KPI task байхгүй — шинээр target/points орж ирсэн бол үүсгэнэ
        if body.target_employee_ids:
            new_task = KpiAdminDailyTask(
                task_name=_build_kpi_task_name(wh_label, c.description),
                monetary_value=body.points or 0.0,
                task_category="inventory",
                date=c.count_date,
                approver_id=u.id,
                created_by=u.id,
                is_active=True,
                target_employee_ids=",".join(str(x) for x in body.target_employee_ids),
            )
            db.add(new_task)
            db.flush()
            c.kpi_admin_task_id = new_task.id

    db.commit()
    return {"ok": True}


@router.delete("/counts/{count_id}")
def delete_count(
    count_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin")),
):
    c = db.query(InventoryCount).filter(InventoryCount.id == count_id).first()
    if not c:
        raise HTTPException(404, "Тооллого олдсонгүй")

    # Deactivate or delete linked KPI admin task
    kpi_task_id = c.kpi_admin_task_id
    if kpi_task_id:
        kpi_task = db.query(KpiAdminDailyTask).filter(
            KpiAdminDailyTask.id == kpi_task_id
        ).first()
        if kpi_task:
            has_refs = db.query(KpiChecklistEntry).filter(
                KpiChecklistEntry.admin_task_id == kpi_task_id
            ).first()
            if has_refs:
                kpi_task.is_active = False
            else:
                # Линкийг эхлээд салгаж дараа нь устгах (FK constraint-аас сэргийлж)
                c.kpi_admin_task_id = None
                db.flush()
                db.delete(kpi_task)

    # Delete files from disk
    for f in c.files:
        p = Path(f.saved_path)
        if p.exists():
            p.unlink()
    db.delete(c)
    db.commit()
    return {"ok": True}


@router.patch("/counts/{count_id}/checklist")
def update_checklist(
    count_id: int,
    body: ChecklistUpdate,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    """Тооллогын урьдчилсан шалгалтын checkbox-уудыг toggle хийх."""
    c = db.query(InventoryCount).filter(InventoryCount.id == count_id).first()
    if not c:
        raise HTTPException(404, "Тооллого олдсонгүй")
    if body.check_all_synced is not None:
        c.check_all_synced = bool(body.check_all_synced)
    if body.check_no_partial is not None:
        c.check_no_partial = bool(body.check_no_partial)
    if body.check_no_wh14_sales is not None:
        c.check_no_wh14_sales = bool(body.check_no_wh14_sales)
    if body.check_balance_unchanged is not None:
        c.check_balance_unchanged = bool(body.check_balance_unchanged)
    db.commit()
    return {
        "ok": True,
        "check_all_synced": bool(c.check_all_synced),
        "check_no_partial": bool(c.check_no_partial),
        "check_no_wh14_sales": bool(c.check_no_wh14_sales),
        "check_balance_unchanged": bool(c.check_balance_unchanged),
    }


@router.delete("/files/{file_id}")
def delete_file(
    file_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin")),
):
    """Зөвхөн админ — тооллогын нэмэлт файл (TXT/Excel)-ыг устгах."""
    f = db.query(InventoryCountFile).filter(InventoryCountFile.id == file_id).first()
    if not f:
        raise HTTPException(404, "Файл олдсонгүй")
    p = Path(f.saved_path)
    try:
        if p.exists():
            p.unlink()
    except Exception:
        pass  # Disk-н алдаа хэвийн зүйл биш ч DB record-ыг үргэлжлүүлэн устгана
    db.delete(f)
    db.commit()
    return {"ok": True}


@router.post("/counts/{count_id}/upload-txt")
async def upload_txt_files(
    count_id: int,
    files: List[UploadFile] = File(...),
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    c = db.query(InventoryCount).filter(InventoryCount.id == count_id).first()
    if not c:
        raise HTTPException(404, "Тооллого олдсонгүй")

    target_dir = UPLOAD_DIR / c.warehouse_key / c.count_date.isoformat()
    target_dir.mkdir(parents=True, exist_ok=True)

    saved = []
    for f in files:
        suffix = Path(f.filename or "file.txt").suffix.lower()
        if suffix not in (".txt", ".text"):
            continue
        ts = datetime.now().strftime("%H%M%S")
        safe_name = f"{ts}_{f.filename}"
        dest = target_dir / safe_name
        dest.write_bytes(await f.read())

        rec = InventoryCountFile(
            inventory_count_id=c.id,
            file_type="txt",
            original_filename=f.filename or "",
            saved_path=str(dest),
        )
        db.add(rec)
        saved.append(f.filename)

    db.commit()
    return {"ok": True, "saved": saved, "count": len(saved)}


@router.post("/counts/{count_id}/upload-excel")
async def upload_excel_file(
    count_id: int,
    f: UploadFile = File(...),
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    c = db.query(InventoryCount).filter(InventoryCount.id == count_id).first()
    if not c:
        raise HTTPException(404, "Тооллого олдсонгүй")

    suffix = Path(f.filename or "file.xlsx").suffix.lower()
    if suffix not in (".xlsx", ".xls"):
        raise HTTPException(400, "Excel файл оруулна уу (.xlsx, .xls)")

    target_dir = UPLOAD_DIR / c.warehouse_key / c.count_date.isoformat()
    target_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now().strftime("%H%M%S")
    safe_name = f"{ts}_{f.filename}"
    dest = target_dir / safe_name
    dest.write_bytes(await f.read())

    rec = InventoryCountFile(
        inventory_count_id=c.id,
        file_type="excel",
        original_filename=f.filename or "",
        saved_path=str(dest),
    )
    db.add(rec)
    db.commit()
    return {"ok": True, "filename": f.filename}


@router.get("/counts/{count_id}/files")
def list_files(
    count_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    c = db.query(InventoryCount).filter(InventoryCount.id == count_id).first()
    if not c:
        raise HTTPException(404, "Тооллого олдсонгүй")
    return [
        {
            "id": f.id,
            "file_type": f.file_type,
            "original_filename": f.original_filename,
            "uploaded_at": f.uploaded_at.isoformat() if f.uploaded_at else None,
        }
        for f in c.files
    ]


@router.get("/files/{file_id}/download")
def download_file(
    file_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    f = db.query(InventoryCountFile).filter(InventoryCountFile.id == file_id).first()
    if not f:
        raise HTTPException(404, "Файл олдсонгүй")
    p = Path(f.saved_path)
    if not p.exists():
        raise HTTPException(404, "Файл дискнээс олдсонгүй")
    return FileResponse(
        path=str(p),
        filename=f.original_filename,
        media_type="application/octet-stream",
    )


@router.get("/calendar")
def calendar_data(
    year: int,
    month: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    from sqlalchemy import extract

    rows = (
        db.query(InventoryCount)
        .filter(
            extract("year", InventoryCount.count_date) == year,
            extract("month", InventoryCount.count_date) == month,
        )
        .order_by(InventoryCount.count_date)
        .all()
    )

    # Group by day
    day_map: dict[int, list] = {}
    for r in rows:
        day = r.count_date.day
        wh = WAREHOUSE_MAP.get(r.warehouse_key, {})
        entry = {
            "id": r.id,
            "warehouse_key": r.warehouse_key,
            "warehouse_label": wh.get("label", r.warehouse_key),
            "color": wh.get("color", "text-gray-700"),
            "bg": wh.get("bg", "bg-gray-50"),
            "description": r.description,
            "file_count": len(r.files),
        }
        day_map.setdefault(day, []).append(entry)

    return {"year": year, "month": month, "days": day_map}
