"""Дарагдсан барааны тайлан — тухайн өдөр (Улаанбаатарын цагаар) ҮҮССЭН бүх deal-ийн tickUsed=false бараа,
агуулахаар. Хянах самбарт Улайлтын тайлангийн хажууд; хэвлэхэд агуулах бүр 1 хуудас (улайсан + дарагдсан).

erxes (2026-11-01-нд шалгасан):
  · deals(pipelineId, noSkipArchive, dateRangeFilters: [{name: "createdAt", from, to}]) { products } — бүх
    pipeline-аар. `products` нь бараа (code, name) + мөрийн өгөгдөл (tickUsed, departmentId…) өгдөг ч 10-аас
    олон бараатай deal-д 10 мөр + {"product": {"name": "...More"}} болж ТАСЛАГДДАГ → тийм deal-ийг
    dealDetail { products }-ээр бүтнээр нь авна. Жагсаалтын төрөлд productsData талбар байхгүй.
  · Мөрийн departmentId → Эрхэтийн байршил. Эрхэтийн inventory/trs-тэй тулгаж баталсан (2026-10-30, 88 deal):
    Бөөний 01, Архи ус ундаа 02, Жижиглэн 11, Гэрээт 12, Хархорин агуулах 05; бусад нь нэрээр.
    Мөрөнд department байхгүй бол тухайн deal-ийн бусад мөрийн давамгай агуулахаар (Эрхэт ч мөн тэгж бүртгэсэн).
"""
from __future__ import annotations

import threading
import time
from collections import Counter
from datetime import date, datetime, timedelta, timezone

UB = timezone(timedelta(hours=8))
MORE = "...More"                 # erxes-ийн deal жагсаалт 10 бараанаас цааш таслахдаа тавьдаг мөр
TTL = 600                        # сек — нэг өдрийн үр дүнг кэшлэх
META_TTL = 3600
PAGE = 100
# erxes department code → Эрхэтийн байршил
DEPT_LOCATION = {
    "Buunii.aguulah": "01", "arhiusundaa.aguulah": "02", "216": "03", "Хархорин": "04",
    "Хархорин агуулах": "05", "Aguulah.Hurguur": "10", "Jijiglen.aguulah": "11",
    "Gereetcompanies": "12", "Mu.Grash": "13",
}
UNKNOWN = "Агуулах тодорхойгүй"

_cache: dict[str, tuple[float, dict]] = {}
_meta: dict = {"at": 0.0, "deps": {}, "pipes": []}
_lock = threading.Lock()


def _gql(q: str, v: dict | None = None, tries: int = 3) -> dict:
    from app.services.erxes_client import get_client
    last: Exception | None = None
    for i in range(tries):
        try:
            return get_client().gql(q, v or {})
        except Exception as e:                  # 504/timeout — түр зуурын
            last = e
            time.sleep(1.5 * (i + 1))
    raise last  # type: ignore[misc]


def _num(v) -> float:
    try:
        x = float(v)
        return 0.0 if x != x else x
    except (TypeError, ValueError):
        return 0.0


def _ts(s) -> datetime | None:
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def location_names() -> dict[str, str]:
    from app.services.count_erkhet import FALLBACK_LOCATIONS
    return dict(FALLBACK_LOCATIONS)


def load_meta() -> dict:
    """departments {_id: {code, title}} + бүх board-ийн pipeline-ууд (1 цаг кэштэй)."""
    if _meta["pipes"] and time.monotonic() - _meta["at"] < META_TTL:
        return _meta
    deps = {d["_id"]: {"code": str(d.get("code") or "").strip(), "title": str(d.get("title") or "").strip()}
            for d in _gql('query { departments(withoutUserFilter: true) { _id code title } }').get("departments") or []}
    pipes = [{"_id": p["_id"], "name": p.get("name") or "", "board": b.get("name") or ""}
             for b in _gql('query { salesBoards(type: "deal") { _id name pipelines { _id name } } }').get("salesBoards") or []
             for p in b.get("pipelines") or []]
    _meta.update(at=time.monotonic(), deps=deps, pipes=pipes)
    return _meta


def fetch_deals(pipeline_id: str, a: datetime, b: datetime) -> list[dict]:
    """[a, b) хүрээнд ҮҮССЭН deal-ууд (архивласан ч орно)."""
    rng = f'[{{name: "createdAt", from: "{_iso(a)}", to: "{_iso(b)}"}}]'
    q = (f'query($p: String, $s: Int) {{ deals(pipelineId: $p, noSkipArchive: true, limit: {PAGE}, skip: $s, '
         f'dateRangeFilters: {rng}, sortField: "createdAt", sortDirection: 1) '
         '{ _id number name createdAt status stage products } }')
    out, skip = [], 0
    while True:
        rows = _gql(q, {"p": pipeline_id, "s": skip}).get("deals") or []
        for d in rows:
            t = _ts(d.get("createdAt"))
            if t and a <= t < b:
                out.append(d)
        if len(rows) < PAGE or skip > 5000:
            return out
        skip += PAGE


def fetch_products(deal_id: str) -> list[dict]:
    return ((_gql('query($id: String!) { dealDetail(_id: $id) { products } }', {"id": deal_id})
             .get("dealDetail") or {}).get("products") or [])


def truncated(products) -> bool:
    return any(isinstance(x, dict) and not x.get("productId") and (x.get("product") or {}).get("name") == MORE
               for x in products or [])


def deal_lines(deal: dict, products, pipeline: str, deps: dict, names: dict) -> list[dict]:
    """Нэг deal-ийн tickUsed=false мөрүүд. Цэвэр функц — unit test-тэй."""
    prods = [x for x in products or [] if isinstance(x, dict) and x.get("productId")]
    common = Counter(x["departmentId"] for x in prods if x.get("departmentId")).most_common(1)
    fallback = common[0][0] if common else ""
    out = []
    for x in prods:
        if x.get("tickUsed"):
            continue
        dep_id = x.get("departmentId") or fallback
        dep = deps.get(dep_id) or {}
        loc = DEPT_LOCATION.get(dep.get("code", ""), "")
        pr = x.get("product") or {}
        out.append({
            "location": loc,
            "location_name": names.get(loc, loc) if loc else (dep.get("title") or UNKNOWN),
            "department": dep.get("title", ""), "dept_inferred": not x.get("departmentId") and bool(dep_id),
            "code": str(pr.get("code") or "").strip(), "name": str(pr.get("name") or "").strip() or "(бараа олдсонгүй)",
            "qty": _num(x.get("quantity")), "unit_price": _num(x.get("unitPrice")), "amount": _num(x.get("amount")),
            "deal_id": str(deal.get("_id") or ""), "number": str(deal.get("number") or ""),
            "deal_name": str(deal.get("name") or ""), "pipeline": pipeline,
            "stage": str((deal.get("stage") or {}).get("name") or ""), "status": str(deal.get("status") or ""),
            "created_at": str(deal.get("createdAt") or ""),
        })
    return out


def aggregate(lines: list[dict]) -> list[dict]:
    """(агуулах, бараа)-аар нэгтгэнэ: нийт тоо/дүн + аль deal-д хэдийг дарсан."""
    g: dict[tuple, dict] = {}
    for ln in lines:
        k = (ln["location"], ln["location_name"], ln["code"] or ln["name"])
        it = g.get(k)
        if it is None:
            it = g[k] = {"location": ln["location"], "location_name": ln["location_name"], "code": ln["code"],
                         "name": ln["name"], "qty": 0.0, "amount": 0.0, "deals": []}
        it["qty"] += ln["qty"]
        it["amount"] += ln["amount"]
        same = next((d for d in it["deals"] if d["number"] == ln["number"]), None)
        if same:
            same["qty"] += ln["qty"]
        else:
            it["deals"].append({"number": ln["number"], "name": ln["deal_name"], "qty": ln["qty"]})
    items = list(g.values())
    for it in items:
        it["qty"], it["amount"] = round(it["qty"], 3), round(it["amount"], 2)
    items.sort(key=lambda it: (it["location"] == "", it["location"], it["location_name"], it["name"].lower()))
    return items


def build(day: date, lines: list[dict], n_deals: int, errors: dict, seconds: float) -> dict:
    items = aggregate(lines)
    locs: dict[str, dict] = {}
    for it in items:
        key = it["location"] or it["location_name"]
        loc = locs.setdefault(key, {"key": key, "code": it["location"], "name": it["location_name"],
                                    "count": 0, "amount": 0.0})
        loc["count"] += 1
        loc["amount"] = round(loc["amount"] + it["amount"], 2)
    return {"day": day.isoformat(), "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "seconds": round(seconds, 1), "deals": n_deals, "deals_blocked": len({ln["deal_id"] for ln in lines}),
            "count": len(items), "amount": round(sum(it["amount"] for it in items), 2),
            "locations": list(locs.values()), "items": items, "lines": lines, "errors": errors}


def fetch_day(day: date) -> dict:
    meta = load_meta()
    names = location_names()
    a = datetime(day.year, day.month, day.day, tzinfo=UB)
    b = a + timedelta(days=1)
    t = time.monotonic()
    lines, n, errors = [], 0, {}
    for p in meta["pipes"]:
        try:
            deals = fetch_deals(p["_id"], a, b)
        except Exception as e:                  # нэг pipeline алдвал бусдыг үргэлжлүүлнэ
            errors[p["name"]] = str(e)[:200]
            continue
        for d in deals:
            n += 1
            prods = d.get("products") or []
            if truncated(prods):
                try:
                    prods = fetch_products(d["_id"])
                except Exception as e:          # таслагдсан 10 мөрөөрөө үлдэнэ — алдааг харуулна
                    errors[f"{p['name']} {d.get('number')}"] = str(e)[:200]
            lines += deal_lines(d, prods, p["name"], meta["deps"], names)
    if meta["pipes"] and len(errors) >= len(meta["pipes"]) and not n:
        raise RuntimeError("; ".join(f"{k}: {v}" for k, v in errors.items()))
    return build(day, lines, n, errors, time.monotonic() - t)


def get(day: date, refresh: bool = False) -> dict:
    """Кэштэй (10 мин). refresh=True бол дахин татна; нэг зэрэг ганц татлага."""
    k = day.isoformat()
    hit = _cache.get(k)
    if hit and not refresh and time.monotonic() - hit[0] < TTL:
        return hit[1]
    with _lock:
        hit = _cache.get(k)
        if hit and time.monotonic() - hit[0] < (10 if refresh else TTL):     # өөр хүн дөнгөж татсан
            return hit[1]
        res = fetch_day(day)
        _cache[k] = (time.monotonic(), res)
        for old in sorted(_cache, key=lambda x: _cache[x][0])[:-30]:
            _cache.pop(old, None)
        return res
