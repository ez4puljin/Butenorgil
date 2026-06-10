"""Үлдэгдлийн файлуудаас барааны нөөц (stock) map үүсгэнэ.

Захиалгын байршлаас хамаарч "Нөөц" багана дараах файлуудаас тооцогдоно:
  - location="warehouse" → Бүх агуулахын үлдэгдэл файл
  - location="showroom"  → Үндсэн заал + Архины заал (код-оор нийлбэр)

Excel баганын бүтэц нь Эрхэт "Үлдэгдлийн тайлан"-тай ижил (батлагдсан):
  A багана (0) = барааны код, I багана (8) = эцсийн үлдэгдэл (тоо).
  Эхний 2 мөр гарчиг, зөвхөн 6+ оронтой код, давхар код нийлнэ.

Файл бүрийг mtime-аар cache хийнэ — өдөр бүр шинэ файл орвол л дахин уншина.
"""
from __future__ import annotations

import re
import threading
from pathlib import Path

import pandas as pd
from sqlalchemy.orm import Session

from app.models.balance_file import (
    BalanceFile,
    BAL_KIND_WAREHOUSE,
    BAL_KIND_MAIN,
    BAL_KIND_LIQUOR,
)

UPLOAD_DIR = Path("app/data/uploads/balance")

# abs_path -> (mtime, {item_code: qty})
_parse_cache: dict[str, tuple[float, dict[str, float]]] = {}
# Олон хэрэглэгч зэрэг хандахад нэг файлыг олон thread зэрэг parse хийхээс
# (cache stampede) сэргийлнэ.
_parse_lock = threading.Lock()


def _normalize_code(raw) -> str:
    if pd.isna(raw):
        return ""
    s = re.sub(r"\.0$", "", str(raw).strip())
    return re.sub(r"\s+", "", s)


def _safe_float(raw) -> float:
    try:
        v = float(raw)
        return 0.0 if pd.isna(v) else v
    except (TypeError, ValueError):
        return 0.0


def parse_balance_file(path: Path) -> dict[str, float]:
    """Үлдэгдлийн тайлан Excel → {item_code: эцсийн үлдэгдэл}.
    (refresh_stock_from_balance-тэй ижил логик: A=код, I=тоо).

    VECTORIZED — iterrows ашиглахгүй (мянган мөртэй файлд 10x+ хурдан).
    A багана (0) = код, I багана (8) = тоо. Эхний 2 мөр гарчиг.
    Зөвхөн 6+ оронтой код, давхар код нийлнэ."""
    p = str(path)
    eng = "xlrd" if p.lower().endswith(".xls") else "openpyxl"
    df = pd.read_excel(p, sheet_name=0, header=None, engine=eng)
    if df.shape[1] < 9 or len(df) <= 2:
        return {}
    sub = df.iloc[2:]                                  # 0,1-р мөр — header
    codes = (
        sub.iloc[:, 0].astype(str).str.strip()
        .str.replace(r"\.0$", "", regex=True)          # 123.0 → 123
        .str.replace(r"\s+", "", regex=True)
    )
    # Зөвхөн 6+ оронтой код (ангилал/агуулахын дэд нийлбэр '01','150101'-ийг бус —
    # хуучин логиктой ижил: 6+ цифр л үлдэнэ)
    mask = codes.str.fullmatch(r"\d{6,}").fillna(False)
    if not mask.any():
        return {}
    qty = pd.to_numeric(sub.iloc[:, 8], errors="coerce").fillna(0.0)   # I багана (8)
    grouped = qty[mask].groupby(codes[mask]).sum()
    return {str(k): float(v) for k, v in grouped.items()}


def _cached_map_for(stored_filename: str) -> dict[str, float]:
    """Тухайн файлын код→үлдэгдэл map (mtime-аар cache). Алдвал хоосон."""
    if not stored_filename:
        return {}
    path = UPLOAD_DIR / stored_filename
    if not path.exists():
        return {}
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return {}
    key = str(path)
    cached = _parse_cache.get(key)
    if cached and cached[0] == mtime:
        return cached[1]
    # Cache хүйтэн/хуучирсан — зөвхөн НЭГ thread parse хийнэ (бусад нь lock-д
    # хүлээгээд бэлэн cache-ээс авна → олон хэрэглэгч зэрэг нээхэд stampede болохгүй).
    with _parse_lock:
        cached = _parse_cache.get(key)
        if cached and cached[0] == mtime:
            return cached[1]
        try:
            m = parse_balance_file(path)
        except Exception:
            m = {}
        _parse_cache[key] = (mtime, m)
        return m


def get_location_stock_map(db: Session, location: str) -> dict[str, float]:
    """Байршлаас хамаарч код→нөөц map буцаана.
      warehouse → Бүх агуулах файл
      showroom  → Үндсэн заал + Архины заал (нийлбэр)
    Файл оруулаагүй / код тохирохгүй бол тухайн код map-д орохгүй (дараа нь 0)."""
    rows = {r.kind: r.stored_filename for r in db.query(BalanceFile).all()}
    if location == "showroom":
        m_main = _cached_map_for(rows.get(BAL_KIND_MAIN, ""))
        m_liq = _cached_map_for(rows.get(BAL_KIND_LIQUOR, ""))
        if not m_main and not m_liq:
            return {}
        out = dict(m_main)
        for code, qty in m_liq.items():
            out[code] = out.get(code, 0.0) + qty
        return out
    # warehouse (default)
    return _cached_map_for(rows.get(BAL_KIND_WAREHOUSE, ""))


def warm_balance_maps() -> None:
    """Бүх баланс файлыг cache-д урьдчилан уншина (startup + 60с background loop).
    Ингэснээр захиалга/бренд нээхэд parse хүлээхгүй — шууд cache-ээс авна.
    Файл өдөр бүр шинэчлэгдвэл mtime өөрчлөгдөж, дараагийн warm-д дахин уншина."""
    from app.core.db import SessionLocal
    db = SessionLocal()
    try:
        for r in db.query(BalanceFile).all():
            _cached_map_for(r.stored_filename)
    except Exception:
        pass
    finally:
        db.close()
