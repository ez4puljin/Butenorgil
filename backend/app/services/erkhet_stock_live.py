"""Эрхэтийн үлдэгдлийг байршлаар нь бодит цагт — ХТ-ууд erxes deal дээр хардагтай ИЖИЛ эх сурвалж.

erxes gateway `erkhetRemainders(productIds, stageId, pipelineId) { _id remainder remainders }` —
erxes (syncerkhet) нь тухайн pipeline-ийн `remainderConfig` (данс 150101 + байршлууд)-аар Эрхэтийн
үлдэгдлийн API-г барааны жагсаалтаар НЭГ удаа дууддаг. Эрхэтийн тайлан (хүнд) ажиллуулахгүй.

Нэг тохиргоо бүх байршлыг хамардаггүй (2026-10-22): «Заалны хөдөлгөөн» 01,02,11,12,10 · «Архины заалны
хөдөлгөөн» 02,08 · «Хархорин» 05 — тиймээс бүх байршлыг хамрах хамгийн цөөн тохиргоог сонгоно.

Эрхэтэд ачаалал үүсгэхгүйн тулд:
  · барааны үлдэгдлийг 60 сек кэшилнэ (нэг барааг олон хүн харсан ч Эрхэт рүү 1 удаа);
  · нэг дуудлагад ≤ 50 бараа (200 өгөхөд хариу ирээгүй); нэг хүсэлтэд ≤ 50 бараа;
  · Эрхэт рүү зэрэг 2-оос олон дуудлага явуулахгүй (semaphore);
  · бүх барааг тогтмол татахгүй — зөвхөн хүн харж буй бараа.
"""
from __future__ import annotations

import threading
import time

TTL = 60                 # сек — үлдэгдлийн кэш
BATCH = 50
_SEM = threading.BoundedSemaphore(2)
_cache: dict[str, tuple[float, dict]] = {}          # erxes product _id → (at, {loc: qty})
_meta: dict = {"at": 0.0, "plan": [], "names": {}}
META_TTL = 3600

# Эрхэтийн байршлын нэр (inventory/report/generate/ form, 2026-10-22) — сүлжээ унасан үед нөөц
LOC_NAMES = {"01": "Бөөний агуулах", "02": "Ус ундаа архи пиво", "03": "Заал", "04": "Хархорин заал",
             "05": "Хархорин агуулах", "08": "Заалны архи", "10": "Агуулахын хөргүүр",
             "11": "Жижиглэн барааны агуулах", "12": "Гэрээт компаний агуулах", "13": "Гэр ахуйн барааны агуулах",
             "14": "Discrepancy Control", "17": "Аяны барааны гадна лангуу"}


def _gql(q: str, v: dict | None = None) -> dict:
    from app.services.erxes_client import get_client
    return get_client().gql(q, v or {})


def _load_meta() -> dict:
    """remainderConfig → бүх байршлыг хамрах хамгийн цөөн pipeline (greedy) + байршлын нэр."""
    if _meta["plan"] and time.monotonic() - _meta["at"] < META_TTL:
        return _meta
    v = (_gql('query{ configsGetValue(code:"remainderConfig") }').get("configsGetValue") or {})
    v = v.get("value", v) if isinstance(v, dict) else {}
    cfgs = [(k, {x.strip() for x in str(c.get("location") or "").split(",") if x.strip()})
            for k, c in (v or {}).items() if isinstance(c, dict) and c.get("account") == "150101"]
    need = set().union(*[s for _, s in cfgs]) if cfgs else set()
    plan: list[tuple[str, set]] = []
    while need:
        k, s = max(cfgs, key=lambda kv: len(kv[1] & need))
        if not s & need:
            break
        plan.append((k, s))
        need -= s
    names = dict(LOC_NAMES)
    try:
        from app.services.erkhet_client import get_client as ek
        for _, label in ek().form_options("inventory/report/generate/").get("inv_location", []):
            code, _, name = label.partition(" - ")
            if code.strip() and name.strip():
                names[code.strip()] = name.strip()
    except Exception:
        pass
    _meta.update(at=time.monotonic(), plan=plan, names=names)
    return _meta


def remainders(product_ids: list[str]) -> dict[str, dict[str, float]]:
    """{erxes product _id: {байршил: тоо}} — кэшгүйг л Эрхэт рүү (erxes-ээр) асууна."""
    now = time.monotonic()
    out: dict[str, dict[str, float]] = {}
    todo = []
    for i in dict.fromkeys(product_ids):
        hit = _cache.get(i)
        if hit and now - hit[0] < TTL:
            out[i] = hit[1]
        else:
            todo.append(i)
    if todo:
        plan = _load_meta()["plan"]
        fresh: dict[str, dict[str, float]] = {i: {} for i in todo}
        for start in range(0, len(todo), BATCH):
            chunk = todo[start:start + BATCH]
            for pipe, locs in plan:
                with _SEM:
                    rows = _gql('query($ids:[String],$p:String){ erkhetRemainders(productIds:$ids, stageId:"", '
                                'pipelineId:$p){ _id remainders } }', {"ids": chunk, "p": pipe}).get("erkhetRemainders") or []
                for r in rows:
                    for x in r.get("remainders") or []:
                        loc = str(x.get("location") or "")
                        if loc in locs and r.get("_id") in fresh:
                            fresh[r["_id"]][loc] = float(x.get("remainder") or 0)
        t = time.monotonic()
        for i, v in fresh.items():
            _cache[i] = (t, v)
            out[i] = v
        if len(_cache) > 20000:
            for k in [k for k, (at, _) in _cache.items() if t - at > TTL]:
                _cache.pop(k, None)
    return out


_PQ = ('query($q:String,$n:Int){ products(status:"active", searchValue:$q, perPage:$n, page:1)'
       '{ _id code name unitPrice barcodes uom category{ name } } }')


def _with_stock(prods: list[dict]) -> list[dict]:
    rem = remainders([p["_id"] for p in prods])
    names = _meta.get("names") or LOC_NAMES
    out = []
    for p in prods:
        r = rem.get(p["_id"], {})
        locs = [{"code": k, "name": names.get(k, k), "qty": q} for k, q in sorted(r.items())]
        out.append({"id": p["_id"], "code": p.get("code") or "", "name": p.get("name") or "",
                    "price": p.get("unitPrice"), "barcodes": p.get("barcodes") or [], "uom": p.get("uom") or "",
                    "category": (p.get("category") or {}).get("name") or "",
                    "total": sum(q for q in r.values()), "locations": locs})
    return out


def search(q: str, limit: int = 20) -> list[dict]:
    """Код / нэр / баркодоор хайж үлдэгдэлтэй нь. Кодоор ЯГ таарсныг эхэнд."""
    q = (q or "").strip()
    if not q:
        return []
    prods = _gql(_PQ, {"q": q, "n": min(max(limit, 1), BATCH)}).get("products") or []
    prods.sort(key=lambda p: (p.get("code") != q and q not in (p.get("barcodes") or []), p.get("code") or ""))
    return _with_stock(prods)


_index: dict = {"at": 0.0, "by_code": {}}
_index_lock = threading.Lock()
INDEX_TTL = 3600


def _product_index() -> dict[str, dict]:
    """Идэвхтэй бүх бараа код → erxes бараа (≈13 хуудас, ~3 сек; 1 цаг кэш) — код бүрийг хайхгүйн тулд."""
    if _index["by_code"] and time.monotonic() - _index["at"] < INDEX_TTL:
        return _index["by_code"]
    with _index_lock:
        if _index["by_code"] and time.monotonic() - _index["at"] < INDEX_TTL:
            return _index["by_code"]
        by: dict[str, dict] = {}
        page = 1
        while True:
            rows = _gql('query($p:Int){ products(status:"active", perPage:1000, page:$p){ _id code name unitPrice '
                        'barcodes uom category{ name } } }', {"p": page}).get("products") or []
            for p in rows:
                if p.get("code"):
                    by[str(p["code"]).strip()] = p
            if len(rows) < 1000 or page > 100:
                break
            page += 1
        _index.update(at=time.monotonic(), by_code=by)
        return by


def by_codes(codes: list[str]) -> list[dict]:
    """Кодын жагсаалтаар (≤ 50) — захиалга, тооллогын мөрөнд харуулахад."""
    idx = _product_index()
    prods = [idx[c] for c in dict.fromkeys(x.strip() for x in codes if x and x.strip()) if c in idx][:BATCH]
    return _with_stock(prods)
