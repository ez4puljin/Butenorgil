"""Эрхэтээс шөнө бүр автоматаар дата татаж ERP-д оруулах sync.

Юу хийдэг вэ:
  Эрхэтийн "Бараа материал /Өртгөөр/" тайланг ӨЧИГДРИЙН огноогоор татаж,
  Эрхэтийн өөрийнх нь Excel болгож хөрвүүлээд, ERP-ийн "Бүх агуулахын
  үлдэгдэл" (balance slot) файлыг ЯГ гараар оруулдагтай ижилхэн солино.

Яагаад ийм замаар:
  • Эрхэтийн /reports/to-excel/ нь гараар татдагтай ЯГ ижил бүтэцтэй .xls
    гаргадаг тул ERP-ийн задлагч (balance_stock.parse_balance_file) огт
    өөрчлөгдөхгүй — эрсдэл хамгийн бага.
  • Файл солигдоход mtime өөрчлөгдөж, balance_stock-ийн cache өөрөө хүчингүй
    болдог тул Нөөц багана, Улайлт тайлан шууд шинэ датаг харна.

Хугацаа: бүтэн тайлан ~1-3 минут (Эрхэтийн серверийн боловсруулалт).
Тиймээс ЗӨВХӨН хуваарьт (шөнийн) ажиллагаанд зориулав — чат/UI-д синхроноор
дуудаж БОЛОХГҮЙ.
"""
from __future__ import annotations

import shutil
import threading
import traceback
from datetime import date, datetime, timedelta
from pathlib import Path

from app.core.db import SessionLocal
from app.models.balance_file import BalanceFile, BAL_KIND_WAREHOUSE
from app.services.erkhet_client import ErkhetError, get_client

# ERP-ийн үлдэгдлийн файлын байршил (balance_file.py-тэй ижил)
UPLOAD_DIR = Path("app/data/uploads/balance")

# Эрхэтийн "Бараа материал /Өртгөөр/" тайлан
REPORT_PATH = "inventory/report/generate/"

# "Бүх агуулахын үлдэгдэл" гэдэгт багтах байршлууд.
# Одоо гараар оруулж буй файлаас (warehouse.xls) яг эдгээр 4 байршил илэрсэн:
#   01 Бөөний агуулах · 02 Ус ундаа архи пиво
#   11 Жижиглэн барааны агуулах · 12 Гэрээт компаний агуулах
WAREHOUSE_LOCATION_IDS = ["1", "2", "11", "12"]

# Дансны сонголт — "150101 - Бэлэн бүтээгдэхүүн, бараа"
ACCOUNT_PREFIX = "150101"

REPORT_TIMEOUT = 900          # секунд — бүтэн тайлан удаан боловсруулагддаг

_sync_lock = threading.Lock()  # зэрэг 2 sync ажиллуулахгүй

# Сүүлийн ажиллагааны төлөв (UI/AI-д харуулах)
last_run: dict = {"at": None, "ok": None, "message": "", "rows": 0, "day": None}


def yesterday() -> date:
    return date.today() - timedelta(days=1)


def _erkhet_date(d: date) -> str:
    """Эрхэтийн datepicker формат (jQuery UI mm/dd/yy = MM/DD/YYYY)."""
    return d.strftime("%m/%d/%Y")


def fetch_warehouse_balance(day: date | None = None) -> bytes:
    """Өчигдрийн (эсвэл заасан өдрийн) агуулахын үлдэгдлийн тайланг
    Эрхэтээс .xls болгож татна."""
    d = day or yesterday()
    c = get_client()
    account = c.find_option(REPORT_PATH, "account", ACCOUNT_PREFIX)
    if not account:
        raise ErkhetError(f"'{ACCOUNT_PREFIX}' данс Эрхэтээс олдсонгүй.")
    ds = _erkhet_date(d)
    return c.report_excel(REPORT_PATH, {
        "account":       account,
        "inv_location":  WAREHOUSE_LOCATION_IDS,
        "get_kind":      "account_location",   # Данс → Байршил → бараа
        "get_tr_kind":   "all",                # шаардлагатай талбар
        "fraction":      "2",
        "begin_date":    ds,
        "end_date":      ds,                   # өчигдрийн эцсийн үлдэгдэл
    }, timeout=REPORT_TIMEOUT)


def _row_count(path: Path) -> int:
    try:
        import pandas as pd
        return int(len(pd.read_excel(path, header=None, dtype=str)))
    except Exception:
        return 0


def sync_warehouse_balance(day: date | None = None) -> dict:
    """Татаад ERP-ийн 'Бүх агуулахын үлдэгдэл' slot-ыг шинэчилнэ.

    Хуучин файлыг .bak болгож хадгална (буцаах боломжтой)."""
    d = day or yesterday()
    with _sync_lock:
        started = datetime.utcnow()
        data = fetch_warehouse_balance(d)

        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        target = UPLOAD_DIR / f"{BAL_KIND_WAREHOUSE}.xls"

        # Шинэ файлыг эхлээд түр байрлалд бичиж, задарч байгааг шалгана —
        # эвдэрсэн файлаар ажиллаж байгаа датаг дарж болохгүй.
        tmp = UPLOAD_DIR / f".{BAL_KIND_WAREHOUSE}.new.xls"
        tmp.write_bytes(data)
        rows = _row_count(tmp)
        if rows < 50:
            tmp.unlink(missing_ok=True)
            raise ErkhetError(f"Татсан файл хэт бага мөртэй ({rows}) — солихоос татгалзлаа.")

        if target.exists():
            shutil.copy2(target, UPLOAD_DIR / f"{BAL_KIND_WAREHOUSE}.bak.xls")
        tmp.replace(target)

        # DB-ийн метадатаг гараар оруулдагтай ижил байдлаар шинэчилнэ
        db = SessionLocal()
        try:
            rec = db.query(BalanceFile).filter(
                BalanceFile.kind == BAL_KIND_WAREHOUSE).first()
            fname = f"Эрхэт_автомат_{d.isoformat()}.xls"
            if not rec:
                rec = BalanceFile(kind=BAL_KIND_WAREHOUSE)
                db.add(rec)
            rec.original_filename = fname
            rec.stored_filename = target.name
            rec.size_bytes = target.stat().st_size
            rec.row_count = rows
            rec.uploaded_by_id = 0
            rec.uploaded_by_name = "Эрхэт автомат sync"
            rec.uploaded_at = datetime.utcnow()
            db.commit()
        finally:
            db.close()

        # Cache-ийг урьдчилан халаана (mtime өөрчлөгдсөн тул автоматаар
        # хүчингүй болсон — энэ нь зөвхөн эхний хүсэлтийг хурдасгана)
        try:
            from app.services.balance_stock import warm_balance_maps
            warm_balance_maps()
        except Exception as e:
            print(f"[erkhet-sync] cache halaah aldaa: {e}")

        secs = (datetime.utcnow() - started).total_seconds()
        return {"ok": True, "day": d.isoformat(), "rows": rows,
                "size_kb": round(target.stat().st_size / 1024),
                "seconds": round(secs, 1)}


def run_nightly_sync(notify: bool = True) -> dict:
    """Шөнийн sync — алдаа гарвал ХЭЗЭЭ Ч exception шидэхгүй (loop унтрахгүй).
    Үр дүнг Telegram-аар мэдэгдэнэ."""
    global last_run
    d = yesterday()
    try:
        res = sync_warehouse_balance(d)
        last_run = {"at": datetime.utcnow().isoformat(timespec="seconds"), "ok": True,
                    "message": f"{res['rows']} мөр", "rows": res["rows"], "day": res["day"]}
        print(f"[erkhet-sync] ✅ {d} — {res['rows']} мөр, {res['seconds']}с")
        if notify:
            _notify(f"✅ Эрхэт sync: {d} өдрийн үлдэгдэл шинэчлэгдлээ "
                    f"({res['rows']} мөр, {res['seconds']}с)")
        return res
    except Exception as e:
        msg = str(e)[:200]
        last_run = {"at": datetime.utcnow().isoformat(timespec="seconds"), "ok": False,
                    "message": msg, "rows": 0, "day": d.isoformat()}
        print(f"[erkhet-sync] ❌ {d} — {msg}")
        traceback.print_exc()
        if notify:
            _notify(f"❌ Эрхэт sync амжилтгүй ({d}): {msg}")
        return {"ok": False, "day": d.isoformat(), "error": msg}


def _notify(text: str) -> None:
    try:
        from app.core.health_monitor import send_telegram
        send_telegram(text)
    except Exception:
        pass
