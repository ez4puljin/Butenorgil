"""Барааны код солигдсоны дараа — захиалга, тулгалтын мөрийг БАРААГ НЬ өөрчлөхгүйгээр шинэ кодоор харуулах.

2026-10-д Эрхэтэд олон барааны кодыг сольсон (жишээ 101269 → 101040). Мастер нэгтгэл шинэ кодоор
шинэ Product үүсгэдэг, харин хуучин Product (хуучин код) захиалга/тулгалтын мөрөнд холбоотой хэвээр.
Мөрийн product_id-г солихгүй (тоо, үнэ, түүх хэвээр) — зөвхөн `display_code` бичиж, дэлгэц болон
Эрхэт рүү экспортод шинэ кодыг хэрэглэнэ.

Шинэ кодыг мастераас (master_latest.xlsx): хуучин барааны БАРКОДООР ганц код таарвал, эс бөгөөс
НЭРЭЭР ганц код таарвал. Олон таарсан / олдоогүйг тайланд гаргаж, гараар шийднэ.
Хүрээ: хэрэглэгчийн шийдвэрээр (2026-10-24) зөвхөн тухайн сарын захиалга (захиалсан тоотой мөр)
болон тулгалт.
"""
from __future__ import annotations

import collections
from datetime import date

import pandas as pd

MASTER = "app/data/outputs/master_latest.xlsx"


def _n(s) -> str:
    return "" if s is None or str(s) == "nan" else str(s).strip()


def _nn(s) -> str:
    return " ".join(_n(s).lower().split())


def _master_index():
    m = pd.read_excel(MASTER, dtype=str)
    codes, by_bc, by_name = set(), collections.defaultdict(set), collections.defaultdict(set)
    names: dict[str, str] = {}
    for r in m.to_dict("records"):
        c = _n(r.get("Код"))
        if not c:
            continue
        codes.add(c)
        names[c] = _nn(r.get("Нэр"))
        for b in _n(r.get("Баркод")).replace(";", ",").split(","):
            if b.strip():
                by_bc[b.strip()].add(c)
        by_name[_nn(r.get("Нэр"))].add(c)
    return codes, by_bc, by_name, names


def new_code_for(p, idx) -> tuple[str, str, list[str]]:
    """→ (шинэ код | "", арга «баркод»/«нэр»/«олон»/«олдсонгүй», нэр дэвшигчид)."""
    codes, by_bc, by_name, names = idx
    cands = set()
    for b in _n(p.barcode).replace(";", ",").split(","):
        cands |= by_bc.get(b.strip(), set())
    via = "баркод"
    if not cands:
        cands, via = set(by_name.get(_nn(p.name), set())), "нэр"
    cands.discard(_n(p.item_code))
    if len(cands) > 1:                      # баркод олон бараанд — нэр нь яг ижил нэг нь байвал түүнийг
        same = {c for c in cands if names.get(c) == _nn(p.name)}
        if len(same) == 1:
            return next(iter(same)), via + "+нэр", []
    if len(cands) == 1:
        return next(iter(cands)), via, []
    return "", ("олон" if cands else "олдсонгүй"), sorted(cands)[:5]


_cache: dict = {"mtime": None, "idx": None}


def master_index_cached():
    """_master_index()-ийг master_latest.xlsx өөрчлөгдөх хүртэл санана (мастер өдөрт 3 удаа шинэчлэгддэг)."""
    import os
    try:
        mtime = os.path.getmtime(MASTER)
    except OSError:
        return None
    if _cache["mtime"] != mtime:
        _cache["idx"], _cache["mtime"] = _master_index(), mtime
    return _cache["idx"]


def in_master(item_code) -> bool:
    idx = master_index_cached()
    return idx is None or _n(item_code) in idx[0]


def display_code_for(p) -> str | None:
    """Мастерт байхгүй (код солигдсон) бараанд шинэ кодыг буцаана; мастерт байгаа эсвэл олдохгүй бол None."""
    idx = master_index_cached()
    if p is None or idx is None or _n(p.item_code) in idx[0]:
        return None
    return new_code_for(p, idx)[0] or None


def remap_month(db, month_start: date, apply: bool = False) -> dict:
    """month_start-аас хойшх захиалга (order_qty_box > 0) ба тулгалтын мөрүүдэд display_code бичнэ."""
    from app.models.product import Product
    from app.models.purchase_order import PurchaseOrder, PurchaseOrderLine
    from app.models.receiving import ReceivingLine, ReceivingSession

    idx = _master_index()
    codes = idx[0]
    po_lines = (db.query(PurchaseOrderLine).join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderLine.purchase_order_id)
                .filter(PurchaseOrder.order_date >= month_start, PurchaseOrderLine.order_qty_box > 0).all())
    rc_lines = (db.query(ReceivingLine).join(ReceivingSession, ReceivingSession.id == ReceivingLine.session_id)
                .filter(ReceivingSession.date >= month_start).all())
    pids = {l.product_id for l in po_lines} | {l.product_id for l in rc_lines}
    prods = {p.id: p for p in db.query(Product).filter(Product.id.in_(pids)).all()} if pids else {}
    cache: dict[int, tuple] = {}
    stat = collections.Counter()
    unresolved: dict[str, dict] = {}
    changes: list[dict] = []

    def resolve(line, kind):
        p = prods.get(line.product_id)
        if not p or _n(p.item_code) in codes:
            if getattr(line, "display_code", None):
                stat[f"{kind}_cleared"] += 1
                if apply:
                    line.display_code = None
            return
        if p.id not in cache:
            cache[p.id] = new_code_for(p, idx)
        new, via, cands = cache[p.id]
        if new:
            stat[f"{kind}_{via}"] += 1
            if (line.display_code or "") != new:
                changes.append({"kind": kind, "line_id": line.id, "old": p.item_code, "new": new, "via": via, "name": p.name})
                if apply:
                    line.display_code = new
        else:
            stat[f"{kind}_{via}"] += 1
            unresolved.setdefault(p.item_code, {"code": p.item_code, "name": p.name, "reason": via, "candidates": cands,
                                                "po_lines": 0, "rc_lines": 0})
            unresolved[p.item_code]["po_lines" if kind == "po" else "rc_lines"] += 1

    for l in po_lines:
        resolve(l, "po")
    for l in rc_lines:
        resolve(l, "rc")
    if apply:
        db.commit()
    return {"month_start": month_start.isoformat(), "po_lines": len(po_lines), "rc_lines": len(rc_lines),
            "stat": dict(stat), "changes": changes, "unresolved": sorted(unresolved.values(), key=lambda x: x["code"]),
            "applied": apply}
