"""
Хянах самбарын server-side cache (stale-while-revalidate).

Зорилго: Хянах самбар нээх болгонд хүнд тооцоолол (том Excel унших, олон
aggregation) давтан ажиллаж, бүх төхөөрөмж удаан хүлээдэг байсныг арилгах.

Ажиллах зарчим:
  • Server тооцооллын ҮР ДҮНГ (snapshot) санах ойд хадгална.
  • Хүсэлт ирэхэд бэлэн snapshot-ыг ШУУД буцаана (loading-гүй).
  • Хэрэв эх өгөгдөл (жишээ нь master Excel файл) ӨӨРЧЛӨГДСӨН бол (mtime-аар
    илрүүлнэ) snapshot-ыг хуучирсан гэж үзэж, BACKGROUND-д дахин тооцоолоод
    шинэчилнэ. Энэ хооронд хэрэглэгчид хуучин snapshot шууд очно (хүлээхгүй).
  • Эхний удаа (snapshot огт байхгүй) л синхрон тооцоолно.
  • startup болон 60с тутмын warmer нь snapshot-уудыг урьдчилан бэлдэж байдаг
    тул анхны хүсэлт хүртэл хурдан.

Энэ нь нэг процессын (single uvicorn worker) хувьд төгс ажиллана — ERP нэг
worker-аар явдаг тул санах ойн cache хуваалцагдана.
"""
from __future__ import annotations

import time
import threading
from typing import Any, Callable, Optional

from app.core.db import SessionLocal


# key -> (compute_fn(db)->data, sig_fn()->signature | None)
_computers: dict[str, tuple[Callable, Optional[Callable]]] = {}
# key -> {"data":..., "ts":float, "version":int, "sig":Any}
_cache: dict[str, dict] = {}
_recomputing: set[str] = set()
_lock = threading.Lock()
_version = 0
_TTL = 90.0  # sechutsemt: snapshot хэт хуучрахаас сэргийлж background refresh хийх дээд хязгаар


def register(key: str, compute_fn: Callable, sig_fn: Optional[Callable] = None) -> None:
    """Тооцоолох функц бүртгэх.
    compute_fn(db) -> JSON-serializable өгөгдөл.
    sig_fn() -> өгөгдлийн эх сурвалжийн "хувилбар" (жишээ нь файлын mtime).
                Энэ утга өөрчлөгдвөл snapshot-ыг хуучирсан гэж үзнэ.
    """
    _computers[key] = (compute_fn, sig_fn)


def invalidate() -> None:
    """Бүх snapshot-ыг хуучин гэж тэмдэглэх (дараагийн хүсэлтэд background refresh)."""
    global _version
    with _lock:
        _version += 1


def _current_sig(sig_fn: Optional[Callable]) -> Any:
    if sig_fn is None:
        return None
    try:
        return sig_fn()
    except Exception:
        return None


def _compute(compute_fn: Callable) -> Any:
    db = SessionLocal()
    try:
        return compute_fn(db)
    finally:
        db.close()


def _store(key: str, data: Any, version: int, sig: Any) -> None:
    with _lock:
        _cache[key] = {"data": data, "ts": time.time(), "version": version, "sig": sig}


def _is_fresh(entry: Optional[dict], cur_ver: int, cur_sig: Any, has_sig: bool) -> bool:
    """Snapshot шинэхэн эсэх:
      • Файлтай (sig_fn-тэй): файлын mtime өөрчлөгдөөгүй бол ҮРГЭЛЖ шинэ
        (TTL-ээр дахин тооцоолохгүй — дэмий ачаалал үүсгэхгүй).
      • Файлгүй (DB-д суурилсан): TTL дотор бол шинэ.
    """
    if not entry or entry["version"] != cur_ver:
        return False
    if has_sig:
        return entry["sig"] == cur_sig
    return (time.time() - entry["ts"]) < _TTL


def _bg_recompute(key: str, compute_fn: Callable, version: int, sig: Any) -> None:
    try:
        data = _compute(compute_fn)
        _store(key, data, version, sig)
    except Exception:
        pass
    finally:
        with _lock:
            _recomputing.discard(key)


def cached(key: str) -> Any:
    """Бэлэн snapshot-ыг шууд буцаана. Хуучирсан бол background-д шинэчилнэ."""
    entry_fn = _computers.get(key)
    if not entry_fn:
        raise KeyError(f"dashboard_cache: '{key}' бүртгэгдээгүй")
    compute_fn, sig_fn = entry_fn
    cur_sig = _current_sig(sig_fn)
    has_sig = sig_fn is not None

    with _lock:
        entry = _cache.get(key)
        cur_ver = _version
        is_fresh = _is_fresh(entry, cur_ver, cur_sig, has_sig)
        spawn = False
        if entry and not is_fresh and key not in _recomputing:
            _recomputing.add(key)
            spawn = True

    # Бэлэн (шинэхэн) snapshot
    if entry and is_fresh:
        return entry["data"]

    # Хуучирсан snapshot байгаа → шууд буцаагаад background-д шинэчилнэ
    if entry is not None:
        if spawn:
            threading.Thread(
                target=_bg_recompute, args=(key, compute_fn, cur_ver, cur_sig), daemon=True
            ).start()
        return entry["data"]

    # Snapshot огт байхгүй (эхний удаа) → синхрон тооцоолно
    data = _compute(compute_fn)
    _store(key, data, cur_ver, cur_sig)
    return data


def warm(key: str) -> None:
    """Нэг snapshot-ыг шаардлагатай бол (дахин) тооцоолно — startup/warmer-д.
    Аль хэдийн шинэ (файл өөрчлөгдөөгүй) бол алгасна — дэмий ачаалал үүсгэхгүй."""
    entry_fn = _computers.get(key)
    if not entry_fn:
        return
    compute_fn, sig_fn = entry_fn
    cur_sig = _current_sig(sig_fn)
    has_sig = sig_fn is not None
    with _lock:
        entry = _cache.get(key)
        cur_ver = _version
        if _is_fresh(entry, cur_ver, cur_sig, has_sig):
            return  # шинэ хэвээр — дахин тооцоолохгүй
    try:
        data = _compute(compute_fn)
        _store(key, data, cur_ver, cur_sig)
    except Exception:
        pass


def warm_all() -> None:
    """Бүртгэгдсэн бүх snapshot-ыг урьдчилан бэлдэнэ."""
    for key in list(_computers.keys()):
        warm(key)
