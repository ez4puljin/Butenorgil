"""POS тулгалт — касс → erxes → Эрхэт гэсэн ХОЁР шатыг бүрэн шалгана.

    1-р шат:  offline POS локал DB → erxes
    2-р шат:  erxes → Эрхэт

Яагаад хоёуланг нь вэ: `pos_auto_sync` зөвхөн 2-р шатыг шалгадаг. 1-р шатанд
гацсан захиалгыг erxes талаас ОГТ харах боломжгүй — erxes тэр захиалгын талаар
мэдэхгүй тул "бүгд sync хийгдсэн" гэж үнэн зөвөөр мэдээлнэ. Тиймээс локал POS
бүрээс шууд тоо аваад тулгах ёстой.

Кассын нийт борлуулалт = erxes дээрх борлуулалт + буцаалт
Энэ тэнцэл зөрвөл л жинхэнэ алдагдал (буцаагдсан захиалга `posOrders`-оос
алга болдог тул зөрүү нь өөрөө хэвийн).

Нарийн зүйлс (бүгд туршилтаар тогтоосон):
  · Локал талд `dateType:"paid"` ЗААВАЛ өгнө — эс тэгвээс үүсгэсэн огноогоор
    тоолж, шөнө дунд давсан захиалгаас болж хуурамч 1-2 зөрүү гарна.
  · Локал `statuses` нь `[String]` — хоосон жагсаалт өгөхгүй бол резолвер
    `undefined.length` дээр унана.
  · erxes-ийн `posOrders.syncedErkhet` талбар НАЙДВАРГҮЙ (40/40 зөрсөн:
    талбар нь False байхад бодит нь бүгд sync хийгдсэн байсан). Эрхэт рүү
    орсон эсэхийг ЗӨВХӨН `toCheckSynced`-ээр шалгана.
  · Нэг өдрийн бүрэн шалгалт POS тутамд ~13 сек тул календарьт шууд
    тооцохгүй — шөнө тооцоод `pos_recon_days` хүснэгтэд хадгална.
"""
from __future__ import annotations

import time
from datetime import date, datetime, timedelta

import requests

from app.core.config import settings

TIMEOUT = (10, 120)          # (холбогдох, унших) секунд
RETRIES = 3

_ORDERS_Q = ("query($a:Date,$b:Date,$pp:Int){ orders(startDate:$a,endDate:$b,"
             "statuses:[],dateType:\"paid\",page:1,perPage:$pp){ _id } }")
_CONFIG_Q = "{ currentConfig { _id name token } }"


# ── Локал POS руу хандах ─────────────────────────────────────────────
def local_urls() -> list[str]:
    """Тохиргооноос локал POS-уудын GraphQL хаягууд."""
    out = []
    for raw in (settings.pos_local_urls or "").split(","):
        u = raw.strip().rstrip("/")
        if not u:
            continue
        out.append(u if u.endswith("/graphql") else f"{u}/graphql")
    return out


def _gql(url: str, query: str, variables: dict | None = None) -> dict:
    """Локал POS руу GraphQL. Касс завгүй үед түр татгалздаг тул давтана."""
    last: Exception | None = None
    for i in range(RETRIES):
        try:
            r = requests.post(url, json={"query": query, "variables": variables or {}},
                              timeout=TIMEOUT, headers={"Content-Type": "application/json"})
            j = r.json()
            if j.get("errors"):
                raise RuntimeError(str(j["errors"][0].get("message"))[:120])
            return j.get("data") or {}
        except Exception as e:      # noqa: BLE001 — сүүлийнхийг дээшээ шиднэ
            last = e
            if i < RETRIES - 1:
                time.sleep(3 * (i + 1))
    raise RuntimeError(str(last)[:150])


def _paid_ids(url: str, day: str, per_page: int = 5000) -> set[str]:
    """Тухайн өдөр ТӨЛӨГДСӨН захиалгуудын id (локал offline POS)."""
    data = _gql(url, _ORDERS_Q, {"a": f"{day}T00:00:00.000Z",
                                 "b": f"{day}T23:59:59.999Z", "pp": per_page})
    return {o["_id"] for o in (data.get("orders") or []) if o.get("_id")}


# ── Тулгалт ──────────────────────────────────────────────────────────
def _status_of(unexplained: int, unsynced: int, error: str) -> str:
    if error:
        return "bad"
    if unexplained:
        return "bad"
    if unsynced:
        return "warn"
    return "ok"


def reconcile_day(day: str = "", urls: list[str] | None = None,
                  should_cancel=None) -> dict:
    """Нэг өдрийн ХОЁР ШАТЫН тулгалт. Мэдээллийн санд хүрэхгүй.

    Мөр бүр: pos_name, pos_token, local_count, erxes_count, returns_count,
             unexplained, synced_count, unsynced_count, status, error
    """
    from app.services.erxes_client import get_client

    day = (day or (date.today() - timedelta(days=1)).isoformat())[:10]
    urls = urls if urls is not None else local_urls()
    if not urls:
        return {"day": day, "rows": [], "unexplained": 0, "unsynced": 0, "errors": 0}

    ex = get_client()
    try:
        plist = ex.pos_list()
    except Exception:
        plist = []
    # Буцаалт нь ДАРАА өдөр хийгдсэн байж болох тул өнөөдрийг хүртэл хамруулна.
    # enrich=False — тулгалтад зөвхөн content_id хэрэгтэй, дүн хэрэггүй.
    try:
        rets = ex.pos_returns(day, date.today().isoformat(), enrich=False)
    except Exception:
        rets = []

    rows: list[dict] = []
    for url in urls:
        row = {"url": url, "pos_name": url, "pos_token": "",
               "local_count": 0, "erxes_count": 0, "returns_count": 0,
               "unexplained": 0, "synced_count": 0, "unsynced_count": 0,
               "status": "bad", "error": ""}
        try:
            cfg = (_gql(url, _CONFIG_Q).get("currentConfig") or {})
            row["pos_name"] = cfg.get("name") or url
            token = cfg.get("token") or ""
            row["pos_token"] = token
            match = [p for p in plist if token and p.get("token") == token]
            if not match:
                raise RuntimeError("erxes дээр тохирох POS олдсонгүй")

            lids = _paid_ids(url, day)                                   # 1-р шат: локал
            eids = ex.pos_order_ids(match[0]["_id"], day,
                                    should_cancel=should_cancel)         # 1-р шат: erxes
            chk = ex.check_synced(eids, should_cancel=should_cancel)      # 2-р шат: Эрхэт
            synced = sum(1 for c in chk if c.get("isSynced"))
            mine = [r for r in rets if r.get("content_id") in lids]

            row.update({
                "local_count": len(lids),
                "erxes_count": len(eids),
                "returns_count": len(mine),
                "unexplained": len(lids) - len(eids) - len(mine),
                "synced_count": synced,
                "unsynced_count": len(eids) - synced,
            })
            row["status"] = _status_of(row["unexplained"], row["unsynced_count"], "")
        except Exception as e:      # noqa: BLE001 — POS нэг нь унтарсан ч бусад үргэлжилнэ
            row["error"] = str(e)[:250]
            row["status"] = "bad"
        rows.append(row)

    return {
        "day": day,
        "rows": rows,
        "unexplained": sum(r["unexplained"] for r in rows),
        "unsynced": sum(r["unsynced_count"] for r in rows),
        "errors": sum(1 for r in rows if r["error"]),
    }


# ── Хадгалалт ────────────────────────────────────────────────────────
def save_day(db, day: str, rows: list[dict]) -> None:
    """Өдрийн үр дүнг upsert хийнэ (POS тус бүрээр нэг мөр)."""
    from app.models.pos_recon import PosReconDay

    for r in rows:
        token = r.get("pos_token") or r.get("url") or ""
        rec = (db.query(PosReconDay)
               .filter(PosReconDay.day == day, PosReconDay.pos_token == token)
               .first())
        if rec is None:
            rec = PosReconDay(day=day, pos_token=token)
            db.add(rec)
        rec.pos_name = r.get("pos_name") or ""
        rec.local_count = int(r.get("local_count") or 0)
        rec.erxes_count = int(r.get("erxes_count") or 0)
        rec.returns_count = int(r.get("returns_count") or 0)
        rec.unexplained = int(r.get("unexplained") or 0)
        rec.synced_count = int(r.get("synced_count") or 0)
        rec.unsynced_count = int(r.get("unsynced_count") or 0)
        rec.status = r.get("status") or "bad"
        rec.error = (r.get("error") or "")[:250]
        rec.checked_at = datetime.utcnow()
    db.commit()


def run_and_save(day: str = "", urls: list[str] | None = None,
                 should_cancel=None) -> dict:
    """Тооцоод шууд хадгална (шөнийн ажил болон гар аргаар дахин шалгахад)."""
    from app.core.db import SessionLocal

    res = reconcile_day(day, urls, should_cancel=should_cancel)
    if res["rows"]:
        db = SessionLocal()
        try:
            save_day(db, res["day"], res["rows"])
        finally:
            db.close()
    return res


def _row_dict(rec) -> dict:
    return {
        "pos_name": rec.pos_name, "pos_token": rec.pos_token,
        "local_count": rec.local_count, "erxes_count": rec.erxes_count,
        "returns_count": rec.returns_count, "unexplained": rec.unexplained,
        "synced_count": rec.synced_count, "unsynced_count": rec.unsynced_count,
        "status": rec.status, "error": rec.error,
        "checked_at": rec.checked_at.isoformat(timespec="seconds") if rec.checked_at else None,
    }


def load_rows(db, day: str) -> list[dict]:
    """Хадгалсан өдрийн мөрүүд (буцаалтын жагсаалтгүй — шуурхай)."""
    from app.models.pos_recon import PosReconDay

    recs = (db.query(PosReconDay).filter(PosReconDay.day == (day or "")[:10])
            .order_by(PosReconDay.pos_name).all())
    return [_row_dict(r) for r in recs]


def worst(statuses: list[str]) -> str:
    """Хамгийн муу төлөв — календарийн нүдний өнгө үүнээс шийдэгдэнэ."""
    for s in ("bad", "warn", "ok"):
        if s in statuses:
            return s
    return "none"


def month_summary(db, year: int, month: int) -> dict:
    """Календарьт зориулсан өдөр тутмын төлөв (хадгалсан датанаас — шуурхай)."""
    from app.models.pos_recon import PosReconDay

    start = date(year, month, 1)
    end = date(year + (month == 12), (month % 12) + 1, 1)
    recs = (db.query(PosReconDay)
            .filter(PosReconDay.day >= start.isoformat(),
                    PosReconDay.day < end.isoformat())
            .all())
    by_day: dict[str, list] = {}
    for r in recs:
        by_day.setdefault(r.day, []).append(r)

    days = []
    d = start
    while d < end:
        ds = d.isoformat()
        group = by_day.get(ds, [])
        days.append({
            "day": ds,
            "status": worst([g.status for g in group]) if group else "none",
            "local": sum(g.local_count for g in group),
            "erxes": sum(g.erxes_count for g in group),
            "returns": sum(g.returns_count for g in group),
            "unexplained": sum(g.unexplained for g in group),
            "unsynced": sum(g.unsynced_count for g in group),
            "pos_count": len(group),
        })
        d += timedelta(days=1)
    return {"year": year, "month": month, "days": days}


def day_detail(db, day: str) -> dict:
    """Нэг өдрийн дэлгэрэнгүй — POS тус бүрийн тоо + буцаалтын жагсаалт.

    Буцаалтыг захиалгын дугаарын угтвараар (YYYYMMDD_) шүүнэ — ингэснээр
    локал POS унтарсан байсан ч дэлгэрэнгүйг харуулж чадна."""
    from app.models.pos_recon import PosReconDay

    day = (day or "")[:10]
    recs = (db.query(PosReconDay).filter(PosReconDay.day == day)
            .order_by(PosReconDay.pos_name).all())

    returns: list[dict] = []
    try:
        from app.services.erxes_client import get_client
        prefix = day.replace("-", "")
        # Буцаалт хожим хийгдсэн байж болох тул 14 хоногийн цонхоор хайна.
        end = (date.fromisoformat(day) + timedelta(days=14)).isoformat()
        end = min(end, date.today().isoformat())
        for r in get_client().pos_returns(day, end):
            if str(r.get("number") or "").startswith(prefix):
                returns.append(r)
    except Exception:
        pass

    return {
        "day": day,
        "rows": [_row_dict(r) for r in recs],
        "returns": returns,
        "status": worst([r.status for r in recs]) if recs else "none",
        "checked": bool(recs),
    }
