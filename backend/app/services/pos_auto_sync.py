"""POS автомат татах — өчигдрийн бүх POS гүйлгээг Эрхэт рүү шөнө sync хийнэ.

Яагаад хэрэгтэй вэ: татагдаагүй гүйлгээ ӨӨРӨӨ АРИЛДАГГҮЙ. Хэн нэгэн гараар
шалгах хүртэл тэр мөнгө нягтлан бодох бүртгэлд ороогүй хэвээр үлддэг.
(Туршилтаар 2026-08-23-нд 9 гүйлгээ · 334,995₮ ийм байдалтай олдсон.)

Өдөр бүр шөнө: өчигдрийн БҮХ POS-ийн гүйлгээг шалгаад, татагдаагүйг нь
автоматаар татаж, үр дүнг Telegram-аар мэдэгдэнэ.
"""
from __future__ import annotations

import threading
import traceback
from datetime import date, datetime, timedelta

from app.services.erxes_client import ErxesError, get_client

# Нэг удаад хэдэн захиалга татах. toSyncOrders нь Эрхэт рүү бичдэг бөгөөд
# Эрхэт удаан тул том багц илгээвэл erxes-ийн gateway 504-ээр таслана.
# Ганцаар нь илгээх нь хамгийн найдвартай.
BATCH = 1
_lock = threading.Lock()    # зэрэг 2 удаа ажиллуулахгүй

# Сүүлийн ажиллагааны төлөв (өглөөний тайлан болон UI-д)
last_run: dict = {
    "at": None, "ok": None, "day": None,
    "total": 0, "unsynced": 0, "synced_ok": 0, "failed": 0,
    "amount": 0, "message": "",
}


def yesterday() -> date:
    return date.today() - timedelta(days=1)


def find_unsynced(day: date, pos_id: str = "") -> tuple[list[dict], list[str]]:
    """Тухайн өдрийн бүх захиалга ба тэдгээрээс татагдаагүйн id-г буцаана."""
    c = get_client()
    ds = day.isoformat()
    orders = c.pos_orders_all(pos_id, ds, ds)
    ids = [o["_id"] for o in orders if o.get("_id")]
    checked = c.check_synced(ids)
    synced = {r["_id"] for r in checked if r.get("isSynced")}
    unsynced = [o for o in orders if o.get("_id") and o["_id"] not in synced]
    return orders, [o["_id"] for o in unsynced]


def run_nightly_pos_sync(day: date | None = None, notify: bool = True) -> dict:
    """Өчигдрийн татагдаагүй POS гүйлгээг татна. ХЭЗЭЭ Ч exception шидэхгүй."""
    global last_run
    d = day or yesterday()
    if not _lock.acquire(blocking=False):
        return {"ok": False, "message": "аль хэдийн ажиллаж байна"}
    try:
        c = get_client()
        orders, todo = find_unsynced(d)
        amount = 0.0
        by_id = {o["_id"]: o for o in orders if o.get("_id")}
        for oid in todo:
            amount += float(by_id.get(oid, {}).get("totalAmount") or 0)

        ok = failed = 0
        for i in range(0, len(todo), BATCH):
            batch = todo[i:i + BATCH]
            try:
                c.sync_orders(batch)
                ok += len(batch)
            except Exception as e:
                # 504 ирсэн ч сервер дээр ГҮЙЦЭТГЭГДСЭН байж болно — сохроор
                # дахин оролдвол ДАВХАР татах эрсдэлтэй. Тиймээс дахин
                # шалгаад, үнэхээр татагдсан эсэхээр нь шийднэ.
                really = []
                if c._is_transient(e):
                    try:
                        res = c.check_synced(batch)
                        really = [r["_id"] for r in res if r.get("isSynced")]
                    except Exception:
                        pass
                if len(really) == len(batch):
                    ok += len(batch)
                    print(f"[pos-sync] 504 ирсэн ч татагдсан байна ({len(batch)})")
                else:
                    failed += len(batch) - len(really)
                    ok += len(really)
                    print(f"[pos-sync] татах алдаа: {str(e)[:90]}")

        last_run = {
            "at": datetime.utcnow().isoformat(timespec="seconds"), "ok": failed == 0,
            "day": d.isoformat(), "total": len(orders), "unsynced": len(todo),
            "synced_ok": ok, "failed": failed, "amount": round(amount),
            "message": f"{len(todo)} татагдаагүйгээс {ok} амжилттай",
        }
        print(f"[pos-sync] {d}: нийт {len(orders)}, татагдаагүй {len(todo)}, татсан {ok}, алдаа {failed}")

        if notify:
            if not todo:
                _notify(f"✅ POS sync ({d}): {len(orders)} гүйлгээ бүгд татагдсан байна")
            elif failed == 0:
                _notify(f"✅ POS sync ({d}): {ok} гүйлгээ татлаа · {round(amount):,}₮")
            else:
                _notify(f"⚠️ POS sync ({d}): {ok} татлаа, {failed} АЛДААТАЙ · {round(amount):,}₮")
        return last_run
    except Exception as e:
        msg = str(e)[:200]
        last_run = {"at": datetime.utcnow().isoformat(timespec="seconds"), "ok": False,
                    "day": d.isoformat(), "total": 0, "unsynced": 0, "synced_ok": 0,
                    "failed": 0, "amount": 0, "message": msg}
        print(f"[pos-sync] ❌ {msg}")
        traceback.print_exc()
        if notify:
            _notify(f"❌ POS sync амжилтгүй ({d}): {msg}")
        return {"ok": False, "error": msg}
    finally:
        _lock.release()


def _notify(text: str) -> None:
    try:
        from app.core.health_monitor import send_telegram
        send_telegram(text)
    except Exception:
        pass
