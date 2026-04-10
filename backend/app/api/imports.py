from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
from pathlib import Path
from datetime import datetime
from typing import List
import json
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_role
from app.models.user import User
from app.services.import_runner import run_script_import
from app.services.master_refresh import refresh_products_from_master
from app.services.price_refresh import refresh_prices_from_file
from app.services.refresh_stock_from_balance import refresh_stock_from_balance_report
from app.models.import_log import ImportLog

router = APIRouter(prefix="/imports", tags=["imports"])

UPLOAD_DIR = Path("app/data/uploads")
OUTPUT_DIR = Path("app/data/outputs")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

IMPORT_MAP = {
    "erxes_sales":          {"module": "erxes_sales",          "refresh_master": False, "folder": "Эрксэс бараа"},
    "erkhet_stock":         {"module": "erkhet_stock",         "refresh_master": False, "folder": "Эрхэт бараа"},
    "master_merge":         {"module": "master_merge",         "refresh_master": True,  "folder": "Мастер нэгтгэл"},
    "returns":              {"module": "returns_merge",        "refresh_master": False, "folder": "Орлого тайлан"},
    "purchase_inbound":     {"module": "purchase_inbound",     "refresh_master": False, "folder": "Хөдөлгөөний тайлан"},
    "sales_plan":           {"module": "sales_plan",           "refresh_master": False, "folder": "Борлуулалт тайлан"},
    "transfer_order":       {"module": "transfer_order",       "refresh_master": False, "folder": "Үлдэгдэл тайлан"},
    "inventory_adjustment": {"module": "inventory_adjustment", "refresh_master": False, "folder": "Дарагдсан барааны тайлан"},
    "accounts_receivable":  {"module": "accounts_receivable",  "refresh_master": False, "folder": "Авлага өглөгө тайлан"},
    "customer_info":        {"module": "customer_info",        "refresh_master": False, "folder": "Харилцагчдын мэдээлэл"},
    "purchase_prices":      {"module": "purchase_prices",      "refresh_master": False, "refresh_prices": True, "folder": "Үнийн тайлан"},
}

for v in IMPORT_MAP.values():
    (UPLOAD_DIR / v["folder"]).mkdir(parents=True, exist_ok=True)

INSTRUCTIONS_FILE = Path("app/data/instructions.json")
INSTRUCTIONS_FILE.parent.mkdir(parents=True, exist_ok=True)

DEFAULT_INSTRUCTIONS: dict[str, list[str]] = {
    "erkhet_stock":         ["Эрхэт системээс үлдэгдлийн тайланг Эксел файлаар экспортлоно.", "Агуулах болон огнооны нөхцөлийг тохируулна.", "Гарсан файлыг энд оруулна."],
    "erxes_sales":          ["Эрксэс системээс борлуулалтын тайланг Эксел файлаар экспортлоно.", "Огнооны муж сонгоод файл үүсгэнэ.", "Гарсан файлыг энд оруулна."],
    "master_merge":         ["Эрхэт болон Эрксэс бараа хоёуланг нь импортолсон байх ёстой.", "Нэгтгэх товч дарахад хамгийн сүүлийн файлуудыг ашиглан мастер шинэчлэгдэнэ.", "Захиалгын модуль хамгийн сүүлийн нэгтгэлийг ашиглана."],
    "returns":              ["Орлогын тайланг Эксел файлаар экспортлоно.", "Оруулсны дараа тайлан нэгтгэх скрипт ажиллана."],
    "purchase_inbound":     ["Эрхэт системээс хөдөлгөөний тайланг Эксел файлаар экспортлоно.", "Гарсан файлыг энд оруулна."],
    "sales_plan":           ["Эрхэт системээс борлуулалтын тайланг Эксел файлаар экспортлоно.", "Огнооны муж сонгоод файл үүсгэнэ.", "Гарсан файлыг энд оруулна."],
    "transfer_order":       ["Эрхэт системээс үлдэгдлийн тайланг Эксел файлаар экспортлоно.", "Агуулах болон огнооны нөхцөлийг тохируулна.", "Гарсан файлыг энд оруулна."],
    "inventory_adjustment": ["Эрксэс системээс дарагдсан барааны тайланг Эксел файлаар экспортлоно.", "Гарсан файлыг энд оруулна."],
    "accounts_receivable":  ["Эрхэт системээс авлага өглөгийн тайланг Эксел файлаар экспортлоно.", "Гарсан файлыг энд оруулна."],
    "customer_info":        ["Эрхэт системээс харилцагчдын мэдээллийг Эксел файлаар экспортлоно.", "Гарсан файлыг энд оруулна."],
    "purchase_prices":      [
        "ERP-ээс орлого авсан тайланг Excel (.xlsx) форматаар экспортлоно.",
        "Файлыг дараах 4 баганатай болго: A=Код, B=Нэр (лавлах), C=Огноо, D=Нэгж үнэ.",
        "Нэг бараа олон мөр байвал хамгийн сүүлийн огноотой мөрийн үнийг хадгална.",
        "Зөвхөн системийн барааны код (item_code) тохирох бараанууд шинэчлэгдэнэ.",
    ],
}

def _load_instructions() -> dict:
    if INSTRUCTIONS_FILE.exists():
        try:
            return json.loads(INSTRUCTIONS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return dict(DEFAULT_INSTRUCTIONS)

def _save_instructions(data: dict):
    INSTRUCTIONS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

class InstructionUpdate(BaseModel):
    lines: List[str]

@router.get("/instructions")
def get_instructions(_=Depends(require_role("admin","supervisor","manager"))):
    data = _load_instructions()
    # Байхгүй key-г default-аар нөхнө
    for k, v in DEFAULT_INSTRUCTIONS.items():
        data.setdefault(k, v)
    return data

@router.put("/instructions/{import_key}")
def update_instructions(
    import_key: str,
    body: InstructionUpdate,
    _=Depends(require_role("admin"))
):
    if import_key not in IMPORT_MAP and import_key not in DEFAULT_INSTRUCTIONS:
        raise HTTPException(404, "Unknown import key")
    data = _load_instructions()
    data[import_key] = [line.strip() for line in body.lines if line.strip()]
    _save_instructions(data)
    return {"ok": True}


@router.post("/master_merge/run")
async def run_master_merge(
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin","supervisor","manager"))
):
    erkhet_dir = UPLOAD_DIR / IMPORT_MAP["erkhet_stock"]["folder"]
    erxes_dir  = UPLOAD_DIR / IMPORT_MAP["erxes_sales"]["folder"]

    erkhet_files = sorted(erkhet_dir.glob("*.xl*"), key=lambda f: f.stat().st_mtime, reverse=True)
    erxes_files  = sorted(erxes_dir.glob("*.xl*"),  key=lambda f: f.stat().st_mtime, reverse=True)

    if not erkhet_files:
        raise HTTPException(400, "Эрхэт бараа файл байхгүй байна. Эхлээд импорт хийнэ үү.")
    if not erxes_files:
        raise HTTPException(400, "Эрксэс бараа файл байхгүй байна. Эхлээд импорт хийнэ үү.")

    erkhet_path = erkhet_files[0]
    erxes_path  = erxes_files[0]
    combined_name = f"{erkhet_path.name} + {erxes_path.name}"

    log = ImportLog(import_key="master_merge", username=(u.username or "").strip() or "Тодорхойгүй", filename=combined_name, status="ok", message="")
    db.add(log); db.commit(); db.refresh(log)

    try:
        from app.scripts import master_merge as mm
        result = mm.main(str(erkhet_path), str(erxes_path), str(OUTPUT_DIR))

        master_path = result.get("master_path") or str(OUTPUT_DIR / "master_latest.xlsx")
        refresh_products_from_master(db, master_path)

        log.status = "ok"
        log.message = "done"
        db.commit()
        return {"ok": True, "erkhet": erkhet_path.name, "erxes": erxes_path.name, "result": result}
    except Exception as e:
        db.rollback()
        log.status = "fail"
        log.message = str(e)
        db.add(log)
        db.commit()
        raise HTTPException(500, f"Master merge failed: {e}")


@router.get("/logs", response_model=list[dict])
def logs(db: Session = Depends(get_db), _=Depends(require_role("admin","supervisor","manager"))):
    rows = db.query(ImportLog).order_by(ImportLog.id.desc()).limit(50).all()
    return [{
        "id": r.id, "created_at": r.created_at, "import_key": r.import_key,
        "username": (r.username or "").strip() or "Тодорхойгүй",
        "filename": r.filename, "status": r.status, "message": r.message
    } for r in rows]

@router.post("/{import_key}")
async def upload_and_run(
    import_key: str,
    f: UploadFile = File(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin","supervisor","manager"))
):
    if import_key not in IMPORT_MAP:
        raise HTTPException(404, "Unknown import type")

    suffix = Path(f.filename).suffix.lower()
    if suffix not in [".xlsx", ".xls"]:
        raise HTTPException(400, "Excel файл оруулна уу (.xlsx/.xls)")

    folder_name = IMPORT_MAP[import_key]["folder"]
    target_dir = UPLOAD_DIR / folder_name
    target_dir.mkdir(parents=True, exist_ok=True)
    date_str = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    saved_path = target_dir / f"{folder_name}_{date_str}{suffix}"
    saved_path.write_bytes(await f.read())

    log = ImportLog(import_key=import_key, username=(u.username or "").strip() or "Тодорхойгүй", filename=f.filename, status="ok", message="")
    db.add(log); db.commit(); db.refresh(log)

    try:
        meta = IMPORT_MAP[import_key]
        result = run_script_import(meta["module"], str(saved_path), str(OUTPUT_DIR))

        if meta["refresh_master"]:
            master_path = result.get("master_path") or str(OUTPUT_DIR / "master_latest.xlsx")
            refresh_products_from_master(db, master_path)

        if meta.get("refresh_prices"):
            price_result = refresh_prices_from_file(db, str(saved_path))
            result["price_update"] = price_result

        # Үлдэгдлийн тайлан → Product.stock_qty шинэчлэл
        if import_key == "transfer_order":
            try:
                stock_result = refresh_stock_from_balance_report(db, str(saved_path))
                result["stock_update"] = stock_result
            except Exception as se:
                result["stock_update"] = {"error": str(se)}

        log.status = "ok"
        log.message = "done"
        db.commit()
        return {"ok": True, "saved_path": str(saved_path), "result": result}
    except Exception as e:
        db.rollback()
        log.status = "fail"
        log.message = str(e)
        db.add(log)
        db.commit()
        raise HTTPException(500, f"Import failed: {e}")
