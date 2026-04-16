"""Erkhet автоматжуулалт — тайлан татах, import хийх, Messenger илгээх."""

import subprocess
import shutil
import json
from pathlib import Path
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_role

router = APIRouter(prefix="/erkhet-auto", tags=["erkhet-auto"])

# Paths
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent  # erp-merge-order version1.0
ERKHET_DIR = PROJECT_ROOT / "erkhet-automation"
ERKHET_VENV_PYTHON = ERKHET_DIR / "venv" / "Scripts" / "python.exe"
ERKHET_DOWNLOADS = ERKHET_DIR / "downloads"
ERKHET_LOGS = ERKHET_DIR / "logs"
UPLOAD_DIR = Path(__file__).resolve().parent.parent / "data" / "uploads"
SCHEDULE_FILE = ERKHET_DIR / "schedule_config.json"

# Report type → upload folder + import key mapping
REPORT_UPLOAD_MAP = {
    "inventory_cost": {"folder": "Эрхэт бараа", "import_key": "erkhet_stock"},
    "inventory_items": {"folder": "Эрхэт бараа", "import_key": "erkhet_stock"},
    "balance_report": {"folder": "Үлдэгдэл тайлан", "import_key": "transfer_order"},
}


def _run_erkhet(report_type: str, extra_args: list[str] | None = None) -> dict:
    """Run erkhet-automation main.py with REPORT_TYPE env override."""
    if not ERKHET_VENV_PYTHON.exists():
        raise HTTPException(500, f"erkhet-automation venv олдсонгүй: {ERKHET_VENV_PYTHON}")

    env_override = {"REPORT_TYPE": report_type}
    cmd = [str(ERKHET_VENV_PYTHON), "main.py"] + (extra_args or [])

    import os
    env = {**os.environ, **env_override}

    try:
        result = subprocess.run(
            cmd,
            cwd=str(ERKHET_DIR),
            capture_output=True,
            text=True,
            timeout=600,  # 10 минут — Эрхэт удаан хариу өгөх тохиолдолд
            env=env,
        )
        return {
            "returncode": result.returncode,
            "stdout": result.stdout[-2000:] if result.stdout else "",
            "stderr": result.stderr[-2000:] if result.stderr else "",
            "ok": result.returncode == 0,
        }
    except subprocess.TimeoutExpired:
        return {"returncode": -1, "stdout": "", "stderr": "Timeout (10 мин)", "ok": False}
    except Exception as e:
        return {"returncode": -1, "stdout": "", "stderr": str(e), "ok": False}


def _copy_downloaded_to_uploads(report_type: str) -> str | None:
    """Copy latest downloaded file from erkhet-automation/downloads to uploads folder."""
    mapping = REPORT_UPLOAD_MAP.get(report_type)
    if not mapping:
        return None
    folder_name = mapping["folder"]

    # Find latest downloaded file
    if not ERKHET_DOWNLOADS.exists():
        return None

    files = sorted(ERKHET_DOWNLOADS.glob("*.xls*"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not files:
        return None

    latest = files[0]
    target_dir = UPLOAD_DIR / folder_name
    target_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    dest = target_dir / f"{folder_name}_{ts}{latest.suffix}"
    shutil.copy2(str(latest), str(dest))
    return str(dest)


def _run_import(import_key: str, file_path: str, db: Session, username: str) -> dict:
    """Trigger existing import pipeline."""
    from app.services.import_runner import run_script_import
    from app.services.master_refresh import refresh_products_from_master
    from app.services.refresh_stock_from_balance import refresh_stock_from_balance_report
    from app.models.import_log import ImportLog
    from app.api.imports import IMPORT_MAP, OUTPUT_DIR

    meta = IMPORT_MAP.get(import_key)
    if not meta:
        return {"ok": False, "error": f"Unknown import key: {import_key}"}

    log = ImportLog(
        import_key=import_key,
        username=username,
        filename=Path(file_path).name,
        status="ok",
        message="",
    )
    db.add(log)
    db.commit()
    db.refresh(log)

    try:
        result = run_script_import(meta["module"], file_path, str(OUTPUT_DIR))

        if meta.get("refresh_master"):
            master_path = result.get("master_path", str(OUTPUT_DIR / "master_latest.xlsx"))
            refresh_products_from_master(db, master_path)

        if import_key == "transfer_order":
            refresh_stock_from_balance_report(db, file_path)

        log.status = "ok"
        log.message = "erkhet-auto"
        db.commit()
        return {"ok": True, "result": result}
    except Exception as e:
        log.status = "fail"
        log.message = str(e)[:500]
        db.commit()
        return {"ok": False, "error": str(e)}


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/download-and-import")
def download_and_import(
    report_type: str = "inventory_cost",
    db: Session = Depends(get_db),
    u=Depends(require_role("admin", "supervisor")),
):
    """Erkhet-ээс тайлан татаж, import pipeline-аар шинэчлэх."""
    # 1. Download from Erkhet
    dl_result = _run_erkhet(report_type)
    if not dl_result["ok"]:
        raise HTTPException(500, f"Erkhet татахад алдаа: {dl_result['stderr'][:500]}")

    # 2. Copy to uploads
    copied_path = _copy_downloaded_to_uploads(report_type)
    if not copied_path:
        return {"ok": True, "downloaded": True, "imported": False, "message": "Татагдсан боловч upload folder олдсонгүй"}

    # 3. Run import pipeline
    mapping = REPORT_UPLOAD_MAP.get(report_type, {})
    import_key = mapping.get("import_key", "erkhet_stock") if isinstance(mapping, dict) else "erkhet_stock"
    import_result = _run_import(import_key, copied_path, db, u.username if hasattr(u, "username") else "erkhet-auto")

    return {
        "ok": True,
        "downloaded": True,
        "imported": import_result.get("ok", False),
        "file": copied_path,
        "import_result": import_result,
    }


class MessengerIn(BaseModel):
    group: str  # "milko" | "altanjoluu" | "all"


@router.post("/send-messenger")
def send_messenger(
    body: MessengerIn,
    _=Depends(require_role("admin", "supervisor")),
):
    """Messenger group руу тайлан илгээх."""
    if not ERKHET_VENV_PYTHON.exists():
        raise HTTPException(500, "erkhet-automation venv олдсонгүй")

    # Determine which reports to send
    if body.group == "milko":
        reports = ["milko_movement", "milko_sale"]
    elif body.group == "altanjoluu":
        reports = ["altanjoluu_movement", "altanjoluu_sale"]
    elif body.group == "all":
        reports = ["milko_movement", "milko_sale", "altanjoluu_movement", "altanjoluu_sale"]
    else:
        raise HTTPException(400, f"Буруу group: {body.group}")

    # First download the reports
    results = []
    for rt in reports:
        dl = _run_erkhet(rt)
        results.append({"report": rt, "download": dl["ok"], "error": dl["stderr"][:200] if not dl["ok"] else ""})

    # Then send via messenger
    try:
        send_result = subprocess.run(
            [str(ERKHET_VENV_PYTHON), "send_reports.py"],
            cwd=str(ERKHET_DIR),
            capture_output=True,
            text=True,
            timeout=120,
        )
        messenger_ok = send_result.returncode == 0
    except Exception as e:
        messenger_ok = False
        results.append({"report": "messenger", "download": False, "error": str(e)})

    return {"ok": messenger_ok, "reports": results}


@router.get("/status")
def get_status(_=Depends(require_role("admin", "supervisor"))):
    """Сүүлийн ажиллалтын мэдээлэл."""
    status = {
        "erkhet_dir_exists": ERKHET_DIR.exists(),
        "venv_exists": ERKHET_VENV_PYTHON.exists(),
        "downloads_count": len(list(ERKHET_DOWNLOADS.glob("*"))) if ERKHET_DOWNLOADS.exists() else 0,
    }

    # Latest downloaded files
    if ERKHET_DOWNLOADS.exists():
        files = sorted(ERKHET_DOWNLOADS.iterdir(), key=lambda f: f.stat().st_mtime, reverse=True)
        status["latest_files"] = [
            {"name": f.name, "size": f.stat().st_size, "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat()}
            for f in files[:10]
        ]
    else:
        status["latest_files"] = []

    # Schedule
    if SCHEDULE_FILE.exists():
        try:
            status["schedule"] = json.loads(SCHEDULE_FILE.read_text())
        except Exception:
            status["schedule"] = None
    else:
        status["schedule"] = {"hour": 8, "minute": 0, "enabled": False}

    return status


@router.get("/logs")
def get_logs(_=Depends(require_role("admin", "supervisor"))):
    """erkhet-automation лог файлууд."""
    if not ERKHET_LOGS.exists():
        return []

    log_files = sorted(ERKHET_LOGS.glob("*.log"), reverse=True)[:10]
    result = []
    for lf in log_files:
        try:
            content = lf.read_text(encoding="utf-8", errors="replace")[-3000:]
        except Exception:
            content = "(уншихад алдаа)"
        result.append({
            "date": lf.stem,
            "content": content,
            "size": lf.stat().st_size,
        })
    return result


class ScheduleIn(BaseModel):
    hour: int = 8
    minute: int = 0
    enabled: bool = True
    messenger_enabled: bool = True


@router.post("/schedule")
def set_schedule(
    body: ScheduleIn,
    _=Depends(require_role("admin")),
):
    """Хуваарь тохируулах."""
    SCHEDULE_FILE.parent.mkdir(parents=True, exist_ok=True)
    data = body.dict()
    data["updated_at"] = datetime.now().isoformat()
    SCHEDULE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    return {"ok": True, "schedule": data}


@router.delete("/schedule")
def delete_schedule(_=Depends(require_role("admin"))):
    """Хуваарь цуцлах."""
    if SCHEDULE_FILE.exists():
        data = json.loads(SCHEDULE_FILE.read_text())
        data["enabled"] = False
        SCHEDULE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    return {"ok": True}
