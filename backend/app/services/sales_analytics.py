"""Борлуулалтын график — сарын борлуулалтыг (product_monthly_sales) мастерын ангиллаар урьдчилан
ачаалсан «cube».

Cube = бараа × он × сар × байршил (Агуулах / Заал / Заалны архи) × {тоо ширхэг, дүн ₮} (numpy).
Бараа бүрийн нэр, бренд, ангилал, байршлын tag — барааны мастер Excel-ээс (master_latest.xlsx).

Дахин бэлдэх (урьдчилан ачаалах):
  • мастер Excel шинэчлэгдэх (mtime) эсвэл сарын борлуулалт өөрчлөгдөх (DB signature) бүрт —
    warm loop (60 сек тутам), импорт/устгалын дараа background, хүсэлт ирэхэд хоцорсон бол;
  • бэлдсэний дараа түгээмэл харагдацуудыг (ангилал/бренд/бараа/байршил × дүн/тоо) урьдчилан
    тооцоолж кэшлэнэ — хэрэглэгч нээхэд шууд гарна.
Query: шүүлт (ангилал, бренд, tag, хайлт, код, байршил, сар) → бүлэглэх → сар бүрийн цуваа,
нийт, сарын өөрчлөлт (MoM), 3 сарын чиг хандлага, хувь. Үр дүнг LRU кэшлэнэ.
"""
from __future__ import annotations

import math
import re
import threading
import time
from collections import OrderedDict
from datetime import date, datetime
from pathlib import Path

import numpy as np
from sqlalchemy import text

KINDS = ("warehouse", "showroom", "liquor")
KIND_LABELS = {"warehouse": "Агуулах", "showroom": "Заал", "liquor": "Заалны архи"}
MASTER_FILE = Path("app/data/outputs/master_latest.xlsx")
NOT_IN_MASTER = "Мастерт бүртгэлгүй"
NO_BRAND = "Брэндгүй"
SEP = "||"                      # олон утгатай параметрийн тусгаарлагч (нэрэнд таслал байдаг)

_CUBE: dict | None = None
_LOCK = threading.Lock()
_QCACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_QLOCK = threading.Lock()
QCACHE_MAX = 300
_REBUILD_RUNNING = threading.Lock()


# ── Туслах ──────────────────────────────────────────────────────────────────

def _norm_code(v) -> str:
    s = re.sub(r"\.0$", "", str(v if v is not None else "").strip())
    return re.sub(r"\s+", "", s)


def _cat_label(raw: str) -> tuple[int, str]:
    """«905 Хятад бараа» → (905, «Хятад бараа»); «923 +Тамхи», «926 925 - Мах» шиг давхар код/тэмдгийг цэвэрлэнэ."""
    raw = (raw or "").strip()
    m = re.match(r"^(\d+)", raw)
    code = int(m.group(1)) if m else 99999
    label = re.sub(r"^(\d+\s*[-.–]?\s*)+", "", raw).lstrip("+-–. ").strip()
    return code, (label or raw or "Ангилалгүй")


def _num(x, nd: int = 0):
    """numpy/float → JSON-д аюулгүй (NaN/inf → None)."""
    if x is None:
        return None
    x = float(x)
    if math.isnan(x) or math.isinf(x):
        return None
    return round(x, nd) if nd else int(round(x))


def _signature(db) -> tuple:
    r = db.execute(text(
        "SELECT count(*), max(updated_at), total(qty_warehouse + qty_showroom + qty_liquor), "
        "total(amount_warehouse + amount_showroom + amount_liquor) FROM product_monthly_sales")).one()
    mt = MASTER_FILE.stat().st_mtime if MASTER_FILE.exists() else 0.0
    return (tuple(r), mt)


def _load_master() -> dict[str, tuple]:
    """{code: (нэр, бренд, ангилал_raw, [tag])} — мастер Excel-ээс."""
    if not MASTER_FILE.exists():
        return {}
    from python_calamine import CalamineWorkbook
    wb = CalamineWorkbook.from_path(str(MASTER_FILE))
    sheet = "Нэгтгэл" if "Нэгтгэл" in wb.sheet_names else wb.sheet_names[0]
    rows = wb.get_sheet_by_name(sheet).to_python()
    if not rows:
        return {}
    ix = {str(c).strip(): i for i, c in enumerate(rows[0])}
    g = lambda r, k: r[ix[k]] if k in ix and ix[k] < len(r) and r[ix[k]] is not None else ""
    out = {}
    for r in rows[1:]:
        code = _norm_code(g(r, "Код"))
        if not code:
            continue
        tags = [t.strip() for t in str(g(r, "Байршил tag")).split(",") if t.strip() and t.strip().lower() != "nan"]
        out[code] = (str(g(r, "Нэр")).strip(), str(g(r, "Брэнд нэр")).strip(), str(g(r, "Ангилал нэр")).strip(), tags)
    return out


# ── Cube бэлдэх ─────────────────────────────────────────────────────────────

def _build(db, sig: tuple) -> dict:
    t0 = time.time()
    master = _load_master()
    rows = db.execute(text(
        "SELECT item_code, year, month, qty_warehouse, qty_showroom, qty_liquor, "
        "amount_warehouse, amount_showroom, amount_liquor FROM product_monthly_sales")).all()
    codes = sorted({r[0] for r in rows})
    years = sorted({int(r[1]) for r in rows}) or [date.today().year]
    P, Y = len(codes), len(years)
    cidx = {c: i for i, c in enumerate(codes)}
    yidx = {y: i for i, y in enumerate(years)}
    qty = np.zeros((P, Y, 12, 3))
    amt = np.zeros((P, Y, 12, 3))
    if rows:
        pi = np.fromiter((cidx[r[0]] for r in rows), dtype=np.int64, count=len(rows))
        yi = np.fromiter((yidx[int(r[1])] for r in rows), dtype=np.int64, count=len(rows))
        mi = np.fromiter((int(r[2]) - 1 for r in rows), dtype=np.int64, count=len(rows))
        vals = np.array([[float(v or 0) for v in r[3:9]] for r in rows])
        qty[pi, yi, mi, :] = vals[:, 0:3]
        amt[pi, yi, mi, :] = vals[:, 3:6]

    # Мастерт байхгүй (хуучин) кодын нэр/брендийг products хүснэгтээс
    fallback = {}
    missing = [c for c in codes if c not in master]
    if missing:
        for c, n, b in db.execute(text("SELECT item_code, name, brand FROM products")).all():
            fallback.setdefault(_norm_code(c), (str(n or ""), str(b or "")))
    names, brands_of, cats_raw, tags_of, in_master = [], [], [], [], []
    for c in codes:
        m = master.get(c)
        if m:
            names.append(m[0] or c); brands_of.append(m[1] or NO_BRAND); cats_raw.append(m[2]); tags_of.append(m[3])
            in_master.append(True)
        else:
            n, b = fallback.get(c, ("", ""))
            names.append(n or c); brands_of.append(b or NO_BRAND); cats_raw.append(None); tags_of.append([])
            in_master.append(False)

    brand_list = sorted(set(brands_of), key=lambda s: (s == NO_BRAND, s.lower()))
    bidx = {b: i for i, b in enumerate(brand_list)}
    cat_info: dict[str, int] = {}
    cat_of = []
    for raw in cats_raw:
        code, label = _cat_label(raw) if raw is not None else (10 ** 6, NOT_IN_MASTER)
        cat_info[label] = min(cat_info.get(label, code), code)
        cat_of.append(label)
    cat_list = sorted(cat_info, key=lambda lb: (cat_info[lb], lb))
    catidx = {c: i for i, c in enumerate(cat_list)}
    tag_list = sorted({t for ts in tags_of for t in ts})
    tagidx = {t: i for i, t in enumerate(tag_list)}
    tag_mat = np.zeros((P, max(1, len(tag_list))), dtype=bool)
    for p, ts in enumerate(tags_of):
        for t in ts:
            tag_mat[p, tagidx[t]] = True

    has = qty.sum(axis=0) > 0                                     # Y × 12 × 3 — аль сард дата байна
    now = datetime.now()
    cube = {
        "sig": sig, "version": f"{int(time.time())}", "built_at": now.isoformat(timespec="seconds"),
        "codes": np.array(codes, dtype=object), "names": names,
        "hay": [f"{c} {n} {b}".lower() for c, n, b in zip(codes, names, brands_of)],
        "brand_idx": np.array([bidx[b] for b in brands_of], dtype=np.int64),
        "cat_idx": np.array([catidx[c] for c in cat_of], dtype=np.int64),
        "brands": brand_list, "cats": cat_list, "tags": tag_list, "tag_mat": tag_mat,
        "in_master": np.array(in_master, dtype=bool),
        "years": years, "qty": qty, "amt": amt, "has": has,
    }
    cube["info"] = {
        "products": P, "rows": len(rows), "years": years, "master_products": len(master),
        "master_updated": datetime.fromtimestamp(sig[1]).isoformat(timespec="minutes") if sig[1] else None,
        "built_at": cube["built_at"], "build_ms": int((time.time() - t0) * 1000),
        "has_amount": bool(amt.sum() > 0),
    }
    return cube


def _prewarm(cube: dict) -> None:
    """Түгээмэл харагдацуудыг урьдчилан тооцоолж кэшлэнэ (нээхэд шууд гарна)."""
    y = default_year(cube)
    m_from, m_to = default_months(cube, y)
    for metric in ("amount", "qty"):
        for dim in ("category", "brand", "product", "location"):
            try:
                query(cube, year=y, m_from=m_from, m_to=m_to, kinds=KINDS, metric=metric, dim=dim)
            except Exception as e:                                # урьдчилсан тооцоо алдвал хэрэглэгчийн хүсэлт л тооцно
                print(f"[sales-analytics] prewarm {metric}/{dim}: {e}")


_SIG_CHECKED = {"at": 0.0}
SIG_MAX_AGE = 10.0            # сек — хүсэлт бүрт signature (SUM query) асуухгүй; импорт/warm өөрөө шинэчилнэ


def get_cube(db, force: bool = False) -> dict:
    """Шинэчлэгдсэн cube — мастер/борлуулалт өөрчлөгдсөн бол энд дахин бэлдэнэ."""
    global _CUBE
    c = _CUBE
    if c is not None and not force and time.time() - _SIG_CHECKED["at"] < SIG_MAX_AGE:
        return c
    sig = _signature(db)
    _SIG_CHECKED["at"] = time.time()
    if c is not None and c["sig"] == sig and not force:
        return c
    with _LOCK:
        c = _CUBE
        if c is not None and c["sig"] == sig and not force:
            return c
        c = _build(db, sig)
        with _QLOCK:
            _QCACHE.clear()
        _CUBE = c
        _prewarm(c)
        print(f"[sales-analytics] cube бэлдлээ: {c['info']['products']} бараа, {c['info']['rows']} мөр, "
              f"{c['info']['build_ms']}мс")
        return c


def warm() -> None:
    """main-ийн warm loop-оос (60с тутам) / импортын дараа — өөрчлөгдсөн бол урьдчилан дахин ачаална."""
    from app.core.db import SessionLocal
    db = SessionLocal()
    try:
        _SIG_CHECKED["at"] = 0.0                                  # заавал signature шалгана
        get_cube(db)
    finally:
        db.close()


_AMOUNTS_DONE = {"done": False}


def ensure_amounts_once() -> None:
    """Процесс эхлэхэд нэг удаа: дүнгүй slot-уудын дүнг хадгалсан файлаас нөхнө (тоог хөндөхгүй)."""
    if _AMOUNTS_DONE["done"]:
        return
    _AMOUNTS_DONE["done"] = True
    from app.core.db import SessionLocal
    from app.api.product_monthly_sales import get_ms_config
    from app.services.product_monthly_sales_parser import backfill_amounts
    db = SessionLocal()
    try:
        cfg = get_ms_config()
        rep = backfill_amounts(db, code_col=cfg["code_col"], qty_col=cfg["qty_col"], only_missing=True)
        if rep["slots"]:
            print(f"[sales-analytics] дүн нөхлөө: {len(rep['slots'])} slot, {rep['updated_rows']} мөр")
    finally:
        db.close()


def rebuild_async() -> None:
    """Импорт/устгалын дараа — хэрэглэгчийг хүлээлгэхгүй background-д дахин бэлдэнэ."""
    if not _REBUILD_RUNNING.acquire(blocking=False):
        return                                                    # аль хэдийн явж байна — дараагийн warm барина

    def run():
        try:
            warm()
        except Exception as e:
            print(f"[sales-analytics] rebuild алдаа: {e}")
        finally:
            _REBUILD_RUNNING.release()
    threading.Thread(target=run, name="sales-analytics-rebuild", daemon=True).start()


# ── Он/сарын анхдагч утга ────────────────────────────────────────────────────

def months_with_data(cube: dict, year: int) -> list[int]:
    if year not in cube["years"]:
        return []
    yi = cube["years"].index(year)
    return [m + 1 for m in range(12) if cube["has"][yi, m].any()]


def default_year(cube: dict) -> int:
    today = date.today()
    ys = [y for y in cube["years"] if months_with_data(cube, y)]
    if today.year in ys and [m for m in months_with_data(cube, today.year) if m < today.month]:
        return today.year
    return ys[-1] if ys else today.year


def default_months(cube: dict, year: int) -> tuple[int, int]:
    """Энэ он бол өмнөх сарууд (явагдаж буй сарыг оруулахгүй); бусад онд дататай бүх сар."""
    ms = months_with_data(cube, year)
    today = date.today()
    if year == today.year:
        past = [m for m in ms if m < today.month]
        ms = past or ms
    return (ms[0], ms[-1]) if ms else (1, 12)


def meta(cube: dict) -> dict:
    counts_b = np.bincount(cube["brand_idx"], minlength=len(cube["brands"]))
    counts_c = np.bincount(cube["cat_idx"], minlength=len(cube["cats"]))
    y = default_year(cube)
    return {
        "info": cube["info"], "version": cube["version"],
        "years": [{"year": yr, "months": months_with_data(cube, yr),
                   "kinds": {k: [m + 1 for m in range(12) if cube["has"][cube["years"].index(yr), m, ki]]
                             for ki, k in enumerate(KINDS)},
                   "default": list(default_months(cube, yr))}
                  for yr in cube["years"] if months_with_data(cube, yr)],
        "default_year": y,
        "kinds": [{"key": k, "label": KIND_LABELS[k]} for k in KINDS],
        "categories": [{"name": c, "count": int(n)} for c, n in zip(cube["cats"], counts_c)],
        "brands": [{"name": b, "count": int(n)} for b, n in zip(cube["brands"], counts_b)],
        "tags": cube["tags"],
    }


# ── Query ────────────────────────────────────────────────────────────────────

def _split(v) -> tuple:
    if not v:
        return ()
    if isinstance(v, (list, tuple)):
        return tuple(x for x in v if x)
    return tuple(x for x in str(v).split(SEP) if x)


def query(cube: dict, *, year: int, m_from: int, m_to: int, kinds=KINDS, metric: str = "amount",
          dim: str = "category", cats=(), brands=(), tags=(), q: str = "", code: str = "",
          sort: str = "total", top: int = 50) -> dict:
    kinds = tuple(k for k in KINDS if k in set(kinds)) or KINDS
    cats, brands, tags = _split(cats), _split(brands), _split(tags)
    m_from, m_to = max(1, min(12, int(m_from))), max(1, min(12, int(m_to)))
    if m_from > m_to:
        m_from, m_to = m_to, m_from
    top = max(1, min(500, int(top)))
    key = (cube["version"], year, m_from, m_to, kinds, metric, dim, cats, brands, tags, q.strip().lower(),
           code.strip(), sort, top)
    with _QLOCK:
        hit = _QCACHE.get(key)
        if hit is not None:
            _QCACHE.move_to_end(key)
            return hit
    res = _compute(cube, year, m_from, m_to, kinds, metric, dim, cats, brands, tags, q.strip().lower(),
                   code.strip(), sort, top)
    with _QLOCK:
        _QCACHE[key] = res
        while len(_QCACHE) > QCACHE_MAX:
            _QCACHE.popitem(last=False)
    return res


def _compute(cube, year, m_from, m_to, kinds, metric, dim, cats, brands, tags, q, code, sort, top) -> dict:
    t0 = time.time()
    months = list(range(m_from, m_to + 1))
    M = len(months)
    nd = 1 if metric == "qty" else 0
    empty = {"year": year, "months": months, "metric": metric, "dim": dim, "kinds": list(kinds),
             "kpi": None, "by_location": [], "total_series": [0] * M, "rows": [], "rows_total": 0,
             "movers": {"up": [], "down": []}, "trend_basis": None}
    if year not in cube["years"]:
        return empty
    yi = cube["years"].index(year)
    K = [KINDS.index(k) for k in kinds]
    base = cube["amt" if metric == "amount" else "qty"]

    P = len(cube["names"])
    mask = np.ones(P, dtype=bool)
    if cats:
        ids = [cube["cats"].index(c) for c in cats if c in cube["cats"]]
        mask &= np.isin(cube["cat_idx"], ids)
    if brands:
        ids = [cube["brands"].index(b) for b in brands if b in cube["brands"]]
        mask &= np.isin(cube["brand_idx"], ids)
    if tags:
        ids = [cube["tags"].index(t) for t in tags if t in cube["tags"]]
        mask &= cube["tag_mat"][:, ids].any(axis=1) if ids else False
    if code:
        mask &= cube["codes"] == code
    if q:
        toks = q.split()
        mask &= np.fromiter((all(t in h for t in toks) for h in cube["hay"]), dtype=bool, count=P)
    idx = np.nonzero(mask)[0]
    sub = base[idx][:, yi][:, [m - 1 for m in months]][:, :, K]    # P' × M × K'
    by_loc = sub.sum(axis=0)                                      # M × K'
    total_series = by_loc.sum(axis=1)                             # M
    prod = sub.sum(axis=2)                                        # P' × M
    grand = float(total_series.sum())

    # ── Бүлэглэх ──
    if dim == "location":
        gs = by_loc.T
        keys = list(kinds)
        labels = [KIND_LABELS[k] for k in kinds]
        subs = [""] * len(keys)
        counts = [int(((sub[:, :, i].sum(axis=1)) > 0).sum()) for i in range(len(K))]
    elif dim == "product":
        gs = prod
        keys = [str(c) for c in cube["codes"][idx]]
        labels = [cube["names"][i] for i in idx]
        subs = [f"{cube['brands'][cube['brand_idx'][i]]} · {cube['cats'][cube['cat_idx'][i]]}" for i in idx]
        counts = [1] * len(idx)
    else:
        gid_all = cube["brand_idx"] if dim == "brand" else cube["cat_idx"]
        names = cube["brands"] if dim == "brand" else cube["cats"]
        gid = gid_all[idx]
        gs = np.zeros((len(names), M))
        np.add.at(gs, gid, prod)
        keys = list(names)
        labels = list(names)
        sold = prod.sum(axis=1) > 0
        cnt = np.bincount(gid[sold], minlength=len(names))
        counts = [int(x) for x in cnt]
        subs = [f"{int(x)} бараа" for x in cnt]
    totals = gs.sum(axis=1) if len(gs) else np.zeros(0)
    keep = np.nonzero(totals > 0)[0]

    # ── Өсөлт/бууралт ──
    def trend_parts(arr):
        if M >= 6:
            return arr[..., -3:].mean(axis=-1), arr[..., -6:-3].mean(axis=-1), (months[-3:], months[-6:-3])
        if M >= 2:
            h = M // 2
            return arr[..., -h:].mean(axis=-1), arr[..., :h].mean(axis=-1), (months[-h:], months[:h])
        return None, None, None

    with np.errstate(divide="ignore", invalid="ignore"):
        last = gs[:, -1] if M else np.zeros(len(gs))
        prev = gs[:, -2] if M >= 2 else np.full(len(gs), np.nan)
        mom = np.where(prev > 0, (last - prev) / prev * 100, np.nan)
        recent, basev, basis = trend_parts(gs)
        trend = np.where(basev > 0, (recent - basev) / basev * 100, np.nan) if recent is not None else np.full(len(gs), np.nan)
        # KPI
        t_last = float(total_series[-1]) if M else 0.0
        t_prev = float(total_series[-2]) if M >= 2 else None
        tr, tb, _ = trend_parts(total_series)

    def row(i):
        return {"key": keys[i], "label": labels[i], "sub": subs[i], "count": counts[i],
                "series": [_num(v, nd) for v in gs[i]], "total": _num(totals[i], nd),
                "last": _num(last[i], nd), "prev": _num(prev[i], nd) if M >= 2 else None,
                "mom": _num(mom[i], 1), "trend": _num(trend[i], 1),
                "share": _num(totals[i] / grand * 100, 1) if grand else None}

    # Эрэмбэ: нийт; өсөлт/бууралт нь бага борлуулалттай «шуугиан»-ыг хасахын тулд нийтээр эхний 300,
    # мөн шүүсэн нийт дүнгийн 0.1%-иас доошгүй бүлгүүдээс (жишээ: 1→9 ширхэг = +800% гарахгүй)
    by_total = keep[np.argsort(-totals[keep], kind="stable")]
    significant = by_total[:300]
    significant = significant[totals[significant] >= grand * 0.001]
    if sort in ("growth", "decline"):
        sig_ok = significant[~np.isnan(trend[significant])]
        order = sig_ok[np.argsort(-trend[sig_ok] if sort == "growth" else trend[sig_ok], kind="stable")]
    else:
        order = by_total
    rows = [row(i) for i in order[:top]]

    movers = {"up": [], "down": []}
    if dim != "location":
        sig_ok = significant[~np.isnan(trend[significant])]
        if dim == "category":                                     # мастерт бүртгэлгүй (ихэвчлэн хасагдсан) бараа бол чиг биш
            sig_ok = np.array([i for i in sig_ok if labels[i] != NOT_IN_MASTER], dtype=np.int64)
        up = sig_ok[trend[sig_ok] > 0]
        down = sig_ok[trend[sig_ok] < 0]
        up = up[np.argsort(-trend[up], kind="stable")][:8]
        down = down[np.argsort(trend[down], kind="stable")][:8]
        mv = lambda i: {"key": keys[i], "label": labels[i], "trend": _num(trend[i], 1),
                        "recent": _num(recent[i], nd), "base": _num(basev[i], nd), "total": _num(totals[i], nd)}
        movers = {"up": [mv(i) for i in up], "down": [mv(i) for i in down]}

    return {
        "year": year, "months": months, "metric": metric, "dim": dim, "kinds": list(kinds),
        "kpi": {
            "total": _num(grand, nd), "avg_month": _num(grand / M, nd) if M else None,
            "last": _num(t_last, nd), "prev": _num(t_prev, nd) if t_prev is not None else None,
            "mom": _num((t_last - t_prev) / t_prev * 100, 1) if t_prev else None,
            "trend": _num((tr - tb) / tb * 100, 1) if tr is not None and tb else None,
            "products": int((prod.sum(axis=1) > 0).sum()),
        },
        "trend_basis": {"recent": basis[0], "base": basis[1]} if basis else None,
        "by_location": [{"key": k, "label": KIND_LABELS[k], "series": [_num(v, nd) for v in by_loc[:, i]],
                         "total": _num(by_loc[:, i].sum(), nd)} for i, k in enumerate(kinds)],
        "total_series": [_num(v, nd) for v in total_series],
        "rows": rows, "rows_total": int(len(keep)), "movers": movers,
        "ms": int((time.time() - t0) * 1000),
    }
