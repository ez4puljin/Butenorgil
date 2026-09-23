"""Эрхэт рүү ERP Excel-ийг ШУУД импортлох — захиалга (purchase_orders) ба
бараа тулгаж авах (receivings) хоёулаа ашигладаг дундын логик.

Урсгал (гараар хийхтэй ижил):
  1. Тайлант үеийг импортын огнооны он болгоно (session-д хадгалагддаг).
  2. «Файл импортлох» → Гарчиг = Excel-ийн нэр, Төрөл = Бараа материалын орлого, Файл.
  3. «Ажлын захиалга» (/queue/)-д мөр нэмэгдсэнийг шалгаж, дуусах хүртэл хянана.
Бүртгэл: ErkhetImportLog (purchase_order_id ЭСВЭЛ receiving_session_id), илгээсэн файл
app/data/erkhet_imports/-д хадгалагдана.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy.orm import Session

from app.models.purchase_order import ErkhetImportLog

IMPORT_ROLES = ("admin", "accountant", "supervisor")
IMPORT_KIND = "inv_income"            # Бараа материалын орлого
IMPORT_COMPANY = "buten_orgil"        # Эрхэтийн нэвтрэх эрх нь Бүтэн-Оргил ХХК-ийнх
PENDING = ("ok", "unknown", "queued")  # давхар импорт гэж тооцох төлөвүүд
STORE_DIR = Path("app/data/erkhet_imports")
COMPANY_ERROR = ("Эрхэт рүү шууд импорт зөвхөн Бүтэн-Оргил ХХК-д тохируулагдсан. "
                 "Оргил-Хорумын файлыг Excel-ээр татаж гараар импортлоно уу.")


def log_dict(r: ErkhetImportLog) -> dict:
    return {"id": r.id, "brand": r.brand, "qty_source": r.qty_source, "title": r.title, "status": r.status,
            "queue_id": r.queue_id or None,
            "erkhet_import_id": r.erkhet_import_id or None, "erkhet_status": r.erkhet_status, "doc_count": r.doc_count,
            "row_count": r.row_count, "message": r.message, "username": r.username,
            "created_at": (r.created_at.isoformat() + "Z") if r.created_at else None}


def local_since(r: ErkhetImportLog) -> str:
    """Бүртгэлийн UTC цагийг Эрхэтийн queue-ийн локал «YYYY-MM-DD HH:MM» хэлбэрт (−2 мин)."""
    off = datetime.now().astimezone().utcoffset() or timedelta(0)
    return (r.created_at + off - timedelta(minutes=2)).strftime("%Y-%m-%d %H:%M") if r.created_at else ""


def apply_result(r: ErkhetImportLog, res: dict) -> None:
    state = res.get("state") or "unknown"
    r.status = state if state in ("ok", "fail", "queued") else "unknown"
    if res.get("queue_id"):
        r.queue_id = int(res["queue_id"])
    r.erkhet_status = (res.get("queue_status") or "")[:100]
    if res.get("import_id"):
        r.erkhet_import_id = int(res["import_id"])
    if res.get("count") is not None:
        r.doc_count = int(res["count"] or 0)
    msg = "; ".join(res.get("errors") or []) or (res.get("result") or "")
    r.message = msg[:2000]


def refresh_logs(db: Session, logs: list) -> None:
    """Хүлээгдэж буй бүртгэлүүдийн төлөвийг Эрхэтийн queue-ээс шинэчилнэ."""
    from app.services.erkhet_client import get_client
    c = get_client()
    for r in logs:
        res = c.refresh_import(r.title, r.queue_id or 0, local_since(r))
        if res.get("state") == "missing" and not r.queue_id:
            continue
        apply_result(r, res)
    db.commit()


def refresh_pending(db: Session, logs: list) -> None:
    pending = [r for r in logs if r.status in ("queued", "unknown")]
    if pending:
        try:
            refresh_logs(db, pending)
        except Exception as e:                                   # noqa: BLE001
            print(f"[erkhet] төлөв шинэчлэхэд алдаа: {e}")


def previous(db: Session, *, brand: str, po_id: int = 0, recv_id: int = 0) -> list:
    q = db.query(ErkhetImportLog).filter(ErkhetImportLog.brand == brand, ErkhetImportLog.status.in_(PENDING))
    q = (q.filter(ErkhetImportLog.receiving_session_id == recv_id) if recv_id else
         q.filter(ErkhetImportLog.purchase_order_id == po_id, ErkhetImportLog.receiving_session_id == 0))
    return q.order_by(ErkhetImportLog.id.desc()).all()


def submit(db: Session, *, data: bytes, filename: str, nrows: int, year: int, company: str, brand: str,
           qty_source: str, username: str, po_id: int = 0, recv_id: int = 0) -> tuple[ErkhetImportLog, dict]:
    """Файлыг хадгалж, бүртгэл үүсгээд Эрхэт рүү илгээнэ. (log, client-ийн хариу) буцаана."""
    from app.services.erkhet_client import ErkhetError, get_client
    title = filename[:-5] if filename.lower().endswith(".xlsx") else filename
    STORE_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    tag = f"RECV{recv_id}" if recv_id else f"PO{po_id}"
    stored = STORE_DIR / f"{stamp}_{tag}_{re.sub(r'[^0-9A-Za-z_.-]', '_', filename)}"
    stored.write_bytes(data)

    log = ErkhetImportLog(purchase_order_id=po_id, receiving_session_id=recv_id, brand=brand, qty_source=qty_source,
                          company=company, title=title, filename=filename, stored_path=str(stored), row_count=nrows,
                          username=username, status="unknown")
    db.add(log)
    db.commit()
    db.refresh(log)
    try:
        res = get_client().import_file(title, IMPORT_KIND, filename, data, year=year)
    except ErkhetError as e:
        res = {"state": "fail", "errors": [str(e)]}
    except Exception as e:                                       # noqa: BLE001
        res = {"state": "unknown", "errors": [f"{type(e).__name__}: {e}"]}
    apply_result(log, res)
    db.commit()
    return log, res


def response(log: ErkhetImportLog, res: dict, year: int) -> dict:
    from app.services.erkhet_client import get_client
    ok = True if log.status == "ok" else (False if log.status == "fail" else None)
    return {**log_dict(log), "ok": ok, "errors": res.get("errors") or [], "period": year,
            "erkhet_url": f"{get_client().base}/queue/"}
