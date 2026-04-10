from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pathlib import Path
import time

from app.api.deps import get_db, require_role
from app.models.order import Order, OrderLine
from app.models.product import Product
from app.schemas.order import SupervisorOverrideIn
from app.services.excel_export import make_consolidated_excel

router = APIRouter(prefix="/reports", tags=["reports"])

OUTPUT_DIR = Path("app/data/outputs")
UPLOAD_DIR = Path("app/data/uploads")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Upload folder type mapping (type number → folder name)
TYPE_FOLDER_MAP = {
    1: "Эрхэт бараа",
    2: "Эрксэс бараа",
    3: "Орлого тайлан",
    4: "Хөдөлгөөний тайлан",
    5: "Үлдэгдэл тайлан",
    6: "Борлуулалт тайлан",
    7: "Дарагдсан барааны тайлан",
}

@router.get("/warehouse-stats")
def warehouse_stats(_=Depends(require_role("admin", "supervisor", "manager"))):
    """Done.py-тай ижил логикоор Үлдэгдэл тайлан файлаас агуулахын хураангуй буцаана."""
    folder = UPLOAD_DIR / TYPE_FOLDER_MAP[5]  # Үлдэгдэл тайлан
    if not folder.exists():
        return {"available": False}
    files = sorted(folder.glob("*.xl*"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not files:
        return {"available": False}
    latest = files[0]
    try:
        from app.scripts.ulailt_report import get_stats
        stats = get_stats(str(latest))
        stats["available"] = True
        stats["file"] = latest.name
        import datetime as _dt
        stats["updated_at"] = _dt.datetime.fromtimestamp(latest.stat().st_mtime).isoformat()
        return stats
    except Exception as e:
        return {"available": False, "error": str(e)}


@router.get("/status")
def report_status(_=Depends(require_role("admin", "supervisor", "manager"))):
    """Return which upload file types have files available."""
    available: list[int] = []
    for type_num, folder_name in TYPE_FOLDER_MAP.items():
        folder = UPLOAD_DIR / folder_name
        if folder.exists() and any(folder.glob("*.xl*")):
            available.append(type_num)
    return {"available_types": available}

@router.post("/export")
def export_consolidated(payload: SupervisorOverrideIn, db: Session = Depends(get_db), _=Depends(require_role("supervisor","admin"))):
    orders = db.query(Order).filter(Order.status == "submitted").order_by(Order.id.asc()).all()
    if not orders:
        raise HTTPException(400, "No submitted orders")

    rows = []
    for o in orders:
        for l in db.query(OrderLine).filter(OrderLine.order_id == o.id).all():
            p = db.query(Product).filter(Product.id == l.product_id).first()
            if not p:
                continue
            rows.append({
                "warehouse_tag_id": o.warehouse_tag_id,
                "brand": o.brand,
                "item_code": p.item_code,
                "name": p.name,
                "order_qty_box": l.order_qty_box,
                "order_qty_pcs": l.order_qty_pcs,
                "unit_weight": p.unit_weight,
                "computed_weight": l.computed_weight,
            })

    filename = f"consolidated_{int(time.time())}.xlsx"
    out_path = OUTPUT_DIR / filename
    make_consolidated_excel(rows, payload.overrides or {}, str(out_path))

    return FileResponse(path=str(out_path), filename="consolidated_orders.xlsx", media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

@router.get("/files")
def list_output_files(_=Depends(require_role("admin","supervisor","manager"))):
    files = []
    for p in sorted(OUTPUT_DIR.glob("*.xlsx"), key=lambda x: x.stat().st_mtime, reverse=True):
        files.append({"name": p.name, "mtime": int(p.stat().st_mtime), "size": p.stat().st_size})
    return {"files": files}

@router.get("/download/{name}")
def download(name: str, _=Depends(require_role("admin","supervisor","manager"))):
    p = OUTPUT_DIR / name
    if not p.exists():
        raise HTTPException(404, "Not found")
    return FileResponse(path=str(p), filename=name, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


# ── Тайлан run endpoints ──────────────────────────────────────────────────────

TEMP_DIR = Path("app/data/temp")
TEMP_DIR.mkdir(parents=True, exist_ok=True)

@router.post("/run/inventory_check")
async def run_inventory_check(
    after_file: UploadFile = File(..., description="Тохируулгын дараах үлдэгдлийн тайлан (A=код, B=нэр, I=тоо)"),
    counted_file: UploadFile = File(..., description="Тооллогын тайлан (A=код, B=нэр, D=тоо)"),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    """Өмнөх тооллогоны тохируулга шалгах тайлан."""
    # Validate extensions
    allowed = {".xlsx", ".xlsm", ".xls"}
    for f in (after_file, counted_file):
        ext = Path(f.filename or "").suffix.lower()
        if ext not in allowed:
            raise HTTPException(400, f"Excel файл оруулна уу (.xlsx/.xls): {f.filename}")

    ts = int(time.time())
    after_path = TEMP_DIR / f"after_{ts}{Path(after_file.filename).suffix.lower()}"
    counted_path = TEMP_DIR / f"counted_{ts}{Path(counted_file.filename).suffix.lower()}"
    out_path = OUTPUT_DIR / f"prev_inventory_check_{ts}.xlsx"

    try:
        after_path.write_bytes(await after_file.read())
        counted_path.write_bytes(await counted_file.read())

        from app.scripts.reports_prev_inventory import build_prev_inventory_check_report
        build_prev_inventory_check_report(str(after_path), str(counted_path), str(out_path))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Тайлан гаргахад алдаа гарлаа: {e}")
    finally:
        # Temp файлуудыг устгах
        for p in (after_path, counted_path):
            try:
                p.unlink(missing_ok=True)
            except Exception:
                pass

    return FileResponse(
        path=str(out_path),
        filename=f"prev_inventory_check_{ts}.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@router.post("/run/ulailt")
def run_ulailt(
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    """Улайлт тайлан — type=5 (Үлдэгдэл тайлан) -ийн хамгийн сүүлийн файлаас гаргана."""
    folder = UPLOAD_DIR / TYPE_FOLDER_MAP[5]
    files = sorted(folder.glob("*.xl*"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not files:
        raise HTTPException(400, "Үлдэгдэл тайлан (type=5) файл байхгүй байна. Эхлээд Файл оруулалт хэсгээс оруулна уу.")

    input_path = files[0]
    ts = int(time.time())
    out_path = OUTPUT_DIR / f"ulailt_taillan_{ts}.xlsx"

    try:
        from app.scripts.ulailt_report import build_report
        build_report(str(input_path), str(out_path))
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Улайлт тайлан гаргахад алдаа гарлаа: {e}")

    return FileResponse(
        path=str(out_path),
        filename=f"ulailt_taillan_{ts}.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@router.post("/run/last_purchase_price")
def run_last_purchase_price(
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    """Барааны сүүлийн орлогоны тайлан — type=3 (Орлого тайлан) файлаас гаргана."""
    folder = UPLOAD_DIR / TYPE_FOLDER_MAP[3]
    files = sorted(folder.glob("*.xl*"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not files:
        raise HTTPException(
            400,
            "Орлого тайлан (type=3) файл байхгүй байна. Эхлээд Файл оруулалт хэсгээс оруулна уу.",
        )

    input_path = files[0]
    ts = int(time.time())
    out_path = OUTPUT_DIR / f"last_purchase_price_{ts}.xlsx"

    try:
        from app.scripts.last_purchase_price_report import build_report
        build_report(str(input_path), str(out_path))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Тайлан гаргахад алдаа гарлаа: {e}")

    return FileResponse(
        path=str(out_path),
        filename=f"last_purchase_price_{ts}.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@router.post("/run/inventory_adj")
def run_inventory_adj(
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    """Дарагдсан барааны тайлан — type=7 файлын tickUsed=False мөрүүдийг шүүнэ."""
    folder = UPLOAD_DIR / TYPE_FOLDER_MAP[7]
    files = sorted(folder.glob("*.xl*"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not files:
        raise HTTPException(
            400,
            "Дарагдсан барааны тайлан (type=7) файл байхгүй байна. "
            "Эхлээд Файл оруулалт хэсгээс оруулна уу.",
        )

    ts = int(time.time())
    # Script нь output-г input-тай ижил хавтаст хадгалдаг тул temp-д хуулна
    src = files[0]
    temp_input = TEMP_DIR / f"inv_adj_{ts}{src.suffix.lower()}"
    temp_input.write_bytes(src.read_bytes())

    try:
        from app.scripts.inventory_adj_report import build_report
        result_path = build_report(str(temp_input))   # output = temp_input_path + suffix
    except SystemExit as e:
        temp_input.unlink(missing_ok=True)
        raise HTTPException(400, str(e.code) if e.code else "Тайлан гаргахад алдаа гарлаа")
    except Exception as e:
        temp_input.unlink(missing_ok=True)
        raise HTTPException(500, f"Дарагдсан барааны тайлан гаргахад алдаа: {e}")

    # Output-г OUTPUT_DIR-д зөөх
    result_src = Path(result_path)
    out_filename = f"inventory_adj_{ts}.xlsx"
    out_path = OUTPUT_DIR / out_filename
    result_src.rename(out_path)
    temp_input.unlink(missing_ok=True)

    return FileResponse(
        path=str(out_path),
        filename=out_filename,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )