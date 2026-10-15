"""Мастерт бүртгэлтэй барааны индекс — баркод / код → бараа.

Эх сурвалж: «Мастер нэгтгэл» (app/data/outputs/master_latest.xlsx, «Нэгтгэл» хуудас, ~12.8 мянган
бараа). «Баркод» багана нь таслалаар тусгаарласан олон баркодтой байж болно
(101007 → 3263286350185,3263280104975,3263286345518). Файлын mtime-аар кэшилнэ —
мастер шинэчлэгдмэгц дараагийн хайлтад шинэ индекс.

UPC-A (12 оронтой) ↔ EAN-13 («0» угтвартай) хувилбарыг ч таньдаг (заалны тооллоготой ижил).
"""
from __future__ import annotations

import threading

from app.services.mobile_pdf import MASTER_FILE, norm_code

_IDX: dict = {"mtime": None, "by_code": {}, "by_barcode": {}}
_LOCK = threading.Lock()


def _load() -> tuple[dict, dict]:
    if not MASTER_FILE.exists():
        return {}, {}
    mtime = MASTER_FILE.stat().st_mtime
    if _IDX["mtime"] == mtime:
        return _IDX["by_code"], _IDX["by_barcode"]
    with _LOCK:
        if _IDX["mtime"] == mtime:
            return _IDX["by_code"], _IDX["by_barcode"]
        from python_calamine import CalamineWorkbook
        wb = CalamineWorkbook.from_path(str(MASTER_FILE))
        sheet = "Нэгтгэл" if "Нэгтгэл" in wb.sheet_names else wb.sheet_names[0]
        rows = wb.get_sheet_by_name(sheet).to_python()
        ix = {str(c).strip(): i for i, c in enumerate(rows[0])} if rows else {}
        g = lambda r, k: r[ix[k]] if k in ix and ix[k] < len(r) else None
        by_code: dict[str, dict] = {}
        by_barcode: dict[str, list[str]] = {}
        for r in rows[1:]:
            code = norm_code(g(r, "Код"))
            if not code:
                continue
            barcodes = [b for b in (norm_code(x) for x in str(g(r, "Баркод") or "").split(",")) if b]
            img = str(g(r, "imageUrl") or "").strip()
            by_code[code] = {
                "code": code,
                "name": str(g(r, "Нэр") or "").strip(),
                "barcodes": barcodes,
                "brand": str(g(r, "Брэнд нэр") or "").strip(),
                "category": str(g(r, "Ангилал нэр") or "").strip(),
                "image": img if img.startswith("http") else "",
            }
            for b in barcodes:
                lst = by_barcode.setdefault(b, [])
                if code not in lst:
                    lst.append(code)
        _IDX.update(mtime=mtime, by_code=by_code, by_barcode=by_barcode)
        return by_code, by_barcode


def _variants(q: str) -> list[str]:
    v = [q]
    if q.isdigit():
        if len(q) == 12:
            v.append("0" + q)
        elif len(q) in (13, 14) and q.startswith("0"):
            v.append(q[1:])
    return v


def resolve(q: str) -> dict | None:
    """Баркод эсвэл код → мастерын бараа (ЯГ таарсан). Олдохгүй бол None.

    Нэг баркод хэд хэдэн бараанд бүртгэгдсэн бол (мастерт ~255 ийм баркод) `candidates`-д
    бүгдийг нь өгнө — тоолж буй хүн аль бараа болохыг сонгоно (автоматаар эхнийхийг авбал
    буруу бараанд тоологдоно)."""
    q = norm_code(q)
    if not q:
        return None
    by_code, by_barcode = _load()
    if q in by_code:
        return {**by_code[q], "matched": "code"}
    for cand in _variants(q):
        codes = by_barcode.get(cand)
        if codes:
            hit = by_code[codes[0]]
            cands = [{"code": c, "name": by_code[c]["name"]} for c in codes] if len(codes) > 1 else []
            return {**hit, "matched": "barcode", "candidates": cands}
    return None


def stats() -> dict:
    by_code, by_barcode = _load()
    return {"products": len(by_code), "barcodes": len(by_barcode), "file": MASTER_FILE.name,
            "exists": MASTER_FILE.exists()}
