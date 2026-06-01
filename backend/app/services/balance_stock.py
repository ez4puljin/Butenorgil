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
    (refresh_stock_from_balance-тэй ижил логик: A=код, I=тоо)."""
    p = str(path)
    eng = "xlrd" if p.lower().endswith(".xls") else "openpyxl"
    df = pd.read_excel(p, sheet_name=0, header=None, engine=eng)
    out: dict[str, float] = {}
    if df.shape[1] < 9:
        return out
    for _, row in df.iloc[2:].iterrows():     # 0,1-р мөр — header
        code = _normalize_code(row.iloc[0])
        # Зөвхөн 6+ оронтой бараа мөр (ангилал/агуулахын дэд нийлбэрийг алгасна)
        if not code or not re.match(r"^\d{6,}$", code):
            continue
        out[code] = out.get(code, 0.0) + _safe_float(row.iloc[8])   # I багана (8)
    return out


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
    cached = _parse_cache.get(str(path))
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        m = parse_balance_file(path)
    except Exception:
        m = {}
    _parse_cache[str(path)] = (mtime, m)
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
