"""Үнийн тохиргоо — Хархорин агуулахын зарах үнэ = сүүлийн орлогын нэгж үнэ (2-р шат: ЗӨВХӨН УНШИНА).

Эх сурвалж (2026-10-26 шалгасан):
  · Эрхэт орлого: `inventory/trs/?kind=-4&inv_location=7` XHR → `var items = [...]` (500 мөр/хуудас).
    2026 оны 22,877 мөр дараалан 86 сек — 7 хоногоор хувааж, шинээс хуучин руу. Дараагийн синк нь
    сүүлийн REFETCH_DAYS хоногийг л дахин татна (засагдсан баримтыг барина).
  · Зөвхөн харилцсан данс 310104 (нийлүүлэгчийн өглөг)-тэй орлого — хэрэглэгчийн дүрэм 2026-10-26.
    «Тооллого» нь 313011, гэхдээ «Урамшуулал»-ын 751 мөр 310104 дээр тул харилцагчаар бас хасна
    (Эрхэтэд «Тооллого » ард нь зайтай). Бутархай нэгж үнэ (2026 онд 162 мөр) байх ёсгүй → «шалгах».
  · erxes pricing plan: `pricingPlans(status:"active")`. Хархорин агуулахын хэлтэст 122 plan-ы 120 нь
    жижиглэнгийн хэлтэстэй ХУВААЛЦСАН. Хоосон branchIds/departmentIds = бүгдэд.
  · POS «Хархорин агуулах»-ын үнийг онлайнаар асуух боломжгүй (poscProducts 0 бараа) — бодит үнийг
    posOrders-оос (unitPrice*count − discountAmount)/count.
  · 2023 оны зарим plan (Гоё −20/−30) бодит борлуулалтад ҮЙЛЧЛЭЭГҮЙ — тооцоолсон үнэ нь таамаг, бодит
    борлуулалтын үнийг хамт харуулна.

erxes, Эрхэт рүү юу ч бичихгүй. Plan үүсгэх/засах нь 3-р шатнаас (тусдаа модуль, admin батлалттай).
"""
from __future__ import annotations

import glob
import json
import os
import threading
import time
import traceback
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

SETTINGS_FILE = Path("app/data/price_cost_settings.json")
RESULT_FILE = Path("app/data/outputs/price_cost.json")
ERKHET_MASTER_DIR = Path("app/data/uploads/Эрхэт бараа")

# Хатуу тогтмол — тохиргооноос өөрчлөгдөхгүй (бусад салбарт нөлөөлөхөөс сэргийлнэ)
POS_ID = "NwSh4cYxFvAjSRBKg"            # POS «Хархорин агуулах»
BRANCH_ID = "cYWmnA3wvK8hDh9Nz"         # Хархорин (жижиглэнтэй хуваалцдаг)
HA_BRANCH_ID = "63QqoSYzMBJuCaRoE"      # Хархорин агуулах (branch) — үнэ үүгээр бодогддог (documents/print)
DEPARTMENT_ID = "yiWzFs7HNt4AHjwmy"     # Хархорин агуулах
RETAIL_DEPARTMENT_ID = "3iHyxYCL73LhG5yTk"  # Хархорин заал (жижиглэн)
# Манай plan-ы хамрах хүрээ — хэрэглэгч 2026-10-26: branch+department хамт; subtraction тул агуулах =
# үндсэн − value = орлогын үнэ, заал = өөрийн одоогийн үнэ дээр мөн адил зөрүү (+1000 г.м.)
PLAN_BRANCH_IDS = [BRANCH_ID, HA_BRANCH_ID]
PLAN_DEPARTMENT_IDS = [DEPARTMENT_ID, RETAIL_DEPARTMENT_ID]
LOCATION_NAMES = {"6": "04 Хархорин заал", "7": "05 Хархорин агуулах"}

DEFAULTS = {
    "locations": ["7"],
    "brands": ["АПУ трейдинг ХХК", "АПУ дэйри ХХК"],
    "accounts": ["310104"],
    "exclude_customers": ["Тооллого", "Урамшуулал"],
    "year_start": "2026-01-01",
    "guard_pct": 30,
    "max_apply": 200,
    "schedule": ["08:30", "18:30"],     # УБ цаг — зөвхөн уншдаг синк; хоосон = унтраалттай
    "notify": True,                     # шинэ «Plan засах/үүсгэх» санал гарвал Telegram
}
REFETCH_DAYS = 21
POS_REFETCH_DAYS = 14
MIN_GAP = 120                       # сек — гараар дахин шинэчлэх завсар
TOL = 0.5                           # ₮ — «таарч байна» гэх зөрүү
CONDITIONAL = ("isQuantityEnabled", "isPriceEnabled", "isExpiryEnabled", "isRepeatEnabled")

_state = {"running": False, "error": "", "last_start": 0.0, "step": ""}
_lock = threading.Lock()


# ── тохиргоо ─────────────────────────────────────────────────────────
def load_settings() -> dict:
    s = dict(DEFAULTS)
    try:
        s.update(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
    except Exception:
        pass
    return s


def save_settings(patch: dict) -> dict:
    s = load_settings()
    for k in ("locations", "brands", "exclude_customers", "accounts"):
        if k in patch and isinstance(patch[k], list):
            s[k] = [str(x).strip() for x in patch[k] if str(x).strip()]
    s["locations"] = [x for x in s["locations"] if x in LOCATION_NAMES] or ["7"]
    for k, lo, hi in (("guard_pct", 1, 100), ("max_apply", 1, 1000)):
        if k in patch:
            s[k] = max(lo, min(hi, int(patch[k])))
    if isinstance(patch.get("schedule"), list):
        s["schedule"] = sorted({t for t in (_hhmm(x) for x in patch["schedule"]) if t})
    if "notify" in patch:
        s["notify"] = bool(patch["notify"])
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(s, ensure_ascii=False, indent=1), encoding="utf-8")
    return s


# ── Эрхэт ────────────────────────────────────────────────────────────
def parse_items(content: str) -> list[dict] | None:
    """`var items = [...]` массивыг хаалт тэнцвэржүүлж (string доторх []-ийг алгасаж) таслаад parse."""
    i = content.find("var items")
    if i < 0:
        return None
    i = content.find("[", i)
    if i < 0:
        return None
    depth, ins, esc = 0, False, False
    for k in range(i, len(content)):
        ch = content[k]
        if ins:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                ins = False
        elif ch == '"':
            ins = True
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return json.loads(content[i:k + 1])
    return None


def items_from_response(j: dict) -> list[dict]:
    for b in j.get("blocks") or []:
        it = parse_items(b.get("content") or "")
        if it is not None:
            return it
    raise ValueError("Эрхэтийн хариунд `var items` олдсонгүй")


def _num(v) -> float:
    try:
        return float(str(v).replace(",", "")) if v not in (None, "") else 0.0
    except ValueError:
        return 0.0


def _fetch_window(c, loc: str, d1: date, d2: date) -> list[dict]:
    out, page = [], 1
    while True:
        path = (f"inventory/trs/?kind=-4&date1={d1}&date2={d2}&inv_location={loc}"
                f"&paginate_by=500&page={page}")
        for attempt in range(3):
            try:
                rows = items_from_response(c.ajax(path))
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(3 * (attempt + 1))
        out += rows
        if len(rows) < 500 or page > 60:
            return out
        page += 1


def fetch_income(db, full: bool = False) -> dict:
    """Эрхэтийн орлогын мөрийг pc_income_rows-д тааруулна. → {from, rows}."""
    from app.models.price_cost import PcIncomeRow
    from app.services.erkhet_client import get_client
    s = load_settings()
    y0 = date.fromisoformat(s["year_start"])
    today = date.today()
    last = db.query(PcIncomeRow.date).order_by(PcIncomeRow.date.desc()).first()
    start = y0 if full or not last else max(y0, date.fromisoformat(last[0]) - timedelta(days=REFETCH_DAYS))
    c = get_client()
    got: list[tuple[str, dict]] = []
    for loc in s["locations"]:
        d2 = today
        while d2 >= start:
            d1 = max(start, d2 - timedelta(days=6))
            _state["step"] = f"Эрхэт орлого {LOCATION_NAMES.get(loc, loc)}: {d1}"
            got += [(loc, x) for x in _fetch_window(c, loc, d1, d2)]
            d2 = d1 - timedelta(days=1)
    q = db.query(PcIncomeRow).filter(PcIncomeRow.date >= start.isoformat())
    q.filter(PcIncomeRow.location_id.in_(s["locations"])).delete(synchronize_session=False)
    seen = set()
    for loc, x in got:
        rid = int(x.get("record_id") or 0)
        if not rid or rid in seen:
            continue
        seen.add(rid)
        db.merge(PcIncomeRow(
            record_id=rid, tr_id=int(x.get("tr__id") or 0), date=str(x.get("date") or "")[:10], location_id=loc,
            code=str(x.get("inventory__code") or "").strip(), name=str(x.get("inventory__name") or "")[:300],
            customer=str(x.get("customer__name") or "").strip()[:300], bill_number=str(x.get("bill_number") or "")[:60],
            count=_num(x.get("count")), total=_num(x.get("total_with_vat")),
            rel_accounts=str(x.get("rel_accounts") or "")[:60],
            description=str(x.get("description") or "")[:500]))
    db.commit()
    return {"from": start.isoformat(), "rows": len(seen)}


def account_ok(rel_accounts: str, accounts: list[str]) -> bool:
    """«кт:310104» (эсвэл «кт:310104, дт:…») нь тохируулсан дансны аль нэгийг агуулж байгаа эсэх."""
    got = {x.split(":")[-1].strip() for x in (rel_accounts or "").replace(";", ",").split(",") if x.strip()}
    return bool(got & set(accounts))


def is_fractional(price: float | None) -> bool:
    return price is not None and abs(price - round(price)) > 0.001


def latest_incomes(db) -> dict[str, list]:
    """Код → хүчинтэй орлогын мөрүүд (шинээс хуучин руу: date, record_id)."""
    from app.models.price_cost import PcIncomeRow
    s = load_settings()
    excl = {x.strip() for x in s["exclude_customers"]}
    accts = [a.strip() for a in s.get("accounts") or [] if a.strip()]
    by: dict[str, list] = defaultdict(list)
    for r in db.query(PcIncomeRow).filter(PcIncomeRow.location_id.in_(s["locations"])).all():
        if r.customer.strip() in excl or r.count <= 0 or r.total <= 0:
            continue
        if accts and not account_ok(r.rel_accounts, accts):
            continue
        by[r.code].append(r)
    for v in by.values():
        v.sort(key=lambda r: (r.date, r.record_id), reverse=True)
    return by


_master = {"mtime": 0.0, "rows": {}}


def erkhet_master() -> dict[str, dict]:
    """Хамгийн сүүлийн «Эрхэт бараа» Excel (product_master_sync өдөрт 3 удаа татдаг) → код → {brand, uom}."""
    files = sorted(glob.glob(str(ERKHET_MASTER_DIR / "*.xlsx")), key=os.path.getmtime)
    if not files:
        return {}
    mt = os.path.getmtime(files[-1])
    if _master["rows"] and _master["mtime"] == mt:
        return _master["rows"]
    import openpyxl
    rows = list(openpyxl.load_workbook(files[-1], read_only=True).active.iter_rows(values_only=True))
    h = [str(x or "").strip() for x in rows[0]]
    ic, ib, iu, iname = h.index("Код"), h.index("Брэнд нэр"), h.index("Хэмжих нэгж нэр"), h.index("Нэр")
    out = {}
    for r in rows[1:]:
        if r[ic]:
            out[str(r[ic]).strip()] = {"brand": str(r[ib] or "").strip(), "uom": str(r[iu] or "").strip(),
                                       "name": str(r[iname] or "").strip()}
    _master.update(mtime=mt, rows=out)
    return out


# ── erxes ────────────────────────────────────────────────────────────
PLAN_FIELDS = ("_id name status type value branchIds departmentIds products productsExcluded categories "
               "categoriesExcluded tags tagsExcluded applyType isPriority startDate endDate isStartDateEnabled "
               "isEndDateEnabled isQuantityEnabled isPriceEnabled isExpiryEnabled isRepeatEnabled priceAdjustType")


def fetch_plans() -> list[dict]:
    from app.services.erxes_client import get_client
    c, out = get_client(), []
    for page in range(1, 100):
        rows = c.gql('query($p:Int){ pricingPlans(status:"active", page:$p, perPage:100){ %s } }' % PLAN_FIELDS,
                     {"p": page}).get("pricingPlans") or []
        out += rows
        if len(rows) < 100:
            return out
    return out


def fetch_products(codes: list[str]) -> dict[str, dict]:
    """Код → erxes бараа {_id, code, name, unitPrice, categoryId, tagIds} (идэвхтэй)."""
    from app.services.erkhet_stock_live import _product_index
    from app.services.erxes_client import get_client
    idx = _product_index()
    found = {c: idx[c] for c in codes if c in idx}
    ids = [p["_id"] for p in found.values()]
    extra: dict[str, dict] = {}
    c = get_client()
    for i in range(0, len(ids), 100):
        for p in c.gql("query($ids:[String],$pp:Int){ products(ids:$ids, perPage:$pp){ _id categoryId tagIds unitPrice } }",
                       {"ids": ids[i:i + 100], "pp": 100}).get("products") or []:
            extra[p["_id"]] = p
    out = {}
    for code, p in found.items():
        e = extra.get(p["_id"], {})
        out[code] = {"_id": p["_id"], "code": code, "name": p.get("name") or "",
                     "unitPrice": e.get("unitPrice", p.get("unitPrice")),
                     "categoryId": e.get("categoryId") or "", "tagIds": e.get("tagIds") or []}
    return out


def fetch_pos_sales(db) -> dict:
    from app.models.price_cost import PcPosSale
    from app.services.erxes_client import get_client
    s = load_settings()
    last = db.query(PcPosSale.paid_at).order_by(PcPosSale.paid_at.desc()).first()
    y0 = date.fromisoformat(s["year_start"])
    start = y0 if not last else max(y0, (last[0] + timedelta(hours=8)).date() - timedelta(days=POS_REFETCH_DAYS))
    c, n = get_client(), 0
    q = ('query($a:Date,$b:Date,$p:Int){ posOrders(page:$p, perPage:100, posId:"%s", sortField:"paidDate", '
         'sortDirection:-1, paidStartDate:$a, paidEndDate:$b){ _id number paidDate status items } }' % POS_ID)
    v = {"a": f"{start}T00:00:00+08:00", "b": f"{date.today() + timedelta(days=1)}T00:00:00+08:00"}
    db.query(PcPosSale).filter(PcPosSale.paid_at >= datetime.combine(start, datetime.min.time()) - timedelta(hours=8)) \
        .delete(synchronize_session=False)
    for page in range(1, 500):
        _state["step"] = f"POS борлуулалт: хуудас {page}"
        rows = c.gql(q, {**v, "p": page}).get("posOrders") or []
        for o in rows:
            st = str(o.get("status") or "").lower()
            if not o.get("paidDate") or "return" in st or "cancel" in st:
                continue
            paid = datetime.fromisoformat(o["paidDate"].replace("Z", "+00:00")).replace(tzinfo=None)
            for it in o.get("items") or []:
                if not it.get("_id") or not it.get("productId") or (it.get("count") or 0) <= 0:
                    continue
                db.merge(PcPosSale(item_id=it["_id"], order_id=o["_id"], number=str(o.get("number") or ""),
                                   paid_at=paid, product_id=it["productId"], count=float(it["count"]),
                                   unit_price=float(it.get("unitPrice") or 0),
                                   discount=float(it.get("discountAmount") or 0)))
                n += 1
        if len(rows) < 100:
            break
    db.commit()
    return {"from": start.isoformat(), "items": n}


# ── үнийн тооцоо (цэвэр функцууд — тесттэй) ──────────────────────────
def _active_by_date(plan: dict, today: date) -> bool:
    def d(x):
        try:
            return datetime.fromisoformat(str(x).replace("Z", "+00:00")).date()
        except Exception:
            return None
    if plan.get("isStartDateEnabled") and plan.get("startDate") and (d(plan["startDate"]) or today) > today:
        return False
    if plan.get("isEndDateEnabled") and plan.get("endDate") and (d(plan["endDate"]) or today) < today:
        return False
    return True


def plan_applies(plan: dict, prod: dict, today: date | None = None,
                 branch_ids: tuple = (BRANCH_ID, HA_BRANCH_ID), department_id: str = DEPARTMENT_ID) -> bool:
    """Plan нь тухайн хэлтэс дэх барааны үнэд хамаарах эсэх. Хоосон branchIds/departmentIds = бүгдэд."""
    br, dp = plan.get("branchIds") or [], plan.get("departmentIds") or []
    if (br and not set(branch_ids) & set(br)) or (dp and department_id not in dp):
        return False
    if not _active_by_date(plan, today or date.today()):
        return False
    pid = prod.get("_id")
    if pid in (plan.get("productsExcluded") or []):
        return False
    at = plan.get("applyType")
    if at == "product":
        return pid in (plan.get("products") or [])
    if at == "category":
        cat = prod.get("categoryId")
        return bool(cat) and cat in (plan.get("categories") or []) and cat not in (plan.get("categoriesExcluded") or [])
    if at == "tag":
        t = set(prod.get("tagIds") or [])
        return bool(t & set(plan.get("tags") or [])) and not (t & set(plan.get("tagsExcluded") or []))
    return False


def plan_price(base: float | None, plan: dict) -> float | None:
    v, t = plan.get("value"), plan.get("type")
    if v is None:
        return None
    if t == "fixed":
        return float(v)
    if base is None:
        return None
    if t == "subtraction":
        return float(base) - float(v)
    if t == "percentage":
        return round(float(base) * (1 - float(v) / 100), 2)
    return None


def is_conditional(plan: dict) -> bool:
    """Тоо/дүн/хугацаа/давталтын нөхцөлтэй plan — 1 ширхэгийн үнэд шууд нөлөөлдөггүй."""
    return any(plan.get(k) for k in CONDITIONAL)


def config_price(base: float | None, plans: list[dict]) -> tuple[float | None, str]:
    """1 ширхэгийн тохиргоот үнэ → (үнэ, арга). арга: base | plan | guess (олон plan — erxes-ийн сонголт
    туршилтаар батлагдаагүй тул isPriority-тэйгээс хамгийн бага үнийг таамаглана)."""
    uncond = [p for p in plans if not is_conditional(p) and plan_price(base, p) is not None]
    if not uncond:
        return base, "base"
    if len(uncond) == 1:
        return plan_price(base, uncond[0]), "plan"
    pri = [p for p in uncond if p.get("isPriority")] or uncond
    return min(plan_price(base, p) for p in pri), "guess"


def classify(cfg: float | None, income: float | None) -> str:
    if income is None:
        return "none"
    if cfg is None:
        return "low"
    if abs(cfg - income) < TOL:
        return "eq"
    return "high" if cfg > income else "low"


def guard(new: float, ref: float | None, pct: float) -> bool:
    """True = хэвийн; False = өмнөхөөсөө ±pct%-иас их өөрчлөгдсөн (шалгах шаардлагатай)."""
    if not ref:
        return True
    return abs(new - ref) / abs(ref) * 100 <= pct


def plan_target(own_value: float | None, agulah_price: float, income: float) -> float:
    """Манай subtraction plan-ы утга: агуулахын бодит үнийг орлогын үнэ болгох (бусдын plan-ыг нөхнө)."""
    return round((own_value or 0.0) + agulah_price - income, 2)


def fetch_print_prices(product_ids: list[str], workers: int = 5) -> dict[str, dict]:
    """product_id → {agulah, zaal} — erxes «Шошго» (documents/print)-ээс, ≤5 зэрэгцээ."""
    from concurrent.futures import ThreadPoolExecutor
    from app.services.price_cost_apply import prices
    out: dict[str, dict] = {}
    done = [0]

    def one(pid):
        try:
            out[pid] = prices(pid)
        except Exception:  # noqa: BLE001
            out[pid] = {}
        done[0] += 1
        _state["step"] = f"erxes бодит үнэ (print): {done[0]}/{len(product_ids)}"
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(one, product_ids))
    return out


def _pct(a, b):
    return round((a - b) / b * 100, 1) if a is not None and b else None


# ── нэгтгэх ──────────────────────────────────────────────────────────
def build(db) -> dict:
    from app.models.price_cost import PcManagedPlan, PcPosSale
    s = load_settings()
    master = erkhet_master()
    inc = latest_incomes(db)
    brands = set(s["brands"])
    codes = sorted(c for c, m in master.items() if m["brand"] in brands) if brands else sorted(inc)
    _state["step"] = "erxes бараа, plan"
    prods = fetch_products(codes)
    plans = fetch_plans()
    managed = {m.plan_id: m for m in db.query(PcManagedPlan).filter(PcManagedPlan.status == "active").all()}
    dept_plans = [p for p in plans if (not p.get("branchIds") or {BRANCH_ID, HA_BRANCH_ID} & set(p["branchIds"]))
                  and (not p.get("departmentIds") or DEPARTMENT_ID in p["departmentIds"])]
    unsupported = [p["name"] for p in dept_plans if p.get("applyType") not in ("product", "category", "tag")]
    pids = {p["_id"] for p in prods.values()}
    sales = defaultdict(list)
    for r in db.query(PcPosSale).filter(PcPosSale.product_id.in_(pids)).all():
        sales[r.product_id].append(r)
    today = date.today()
    printed = fetch_print_prices([p["_id"] for p in prods.values()])
    rows = []
    for code in codes:
        m, p = master.get(code, {}), prods.get(code)
        hist = inc.get(code) or []
        last = hist[0] if hist else None
        prev = next((h for h in hist[1:] if h.bill_number != (last.bill_number if last else "")), None)
        income = round(last.total / last.count, 2) if last else None
        prev_income = round(prev.total / prev.count, 2) if prev else None
        base = p.get("unitPrice") if p else None
        ap = [x for x in dept_plans if p and plan_applies(x, p, today)]
        calc, how = config_price(base, ap) if p else (None, "missing")
        pr = printed.get(p["_id"], {}) if p else {}
        # Тохиргоот үнэ = erxes «Шошго»-ны (documents/print) бодит үнэ; уншиж чадаагүй бол тооцоолсон таамаг
        cfg, how = (pr["agulah"], "print") if pr.get("agulah") is not None else (calc, how)
        own = [x for x in ap if x["_id"] in managed]
        others = [x for x in ap if x["_id"] not in managed]
        sl = sorted(sales.get(p["_id"], []) if p else [], key=lambda r: r.paid_at)
        ls = sl[-1] if sl else None
        real = round((ls.unit_price * ls.count - ls.discount) / ls.count, 2) if ls else None
        since = [r for r in sl if last and (r.paid_at + timedelta(hours=8)).date().isoformat() >= last.date]
        since_prices = sorted({round((r.unit_price * r.count - r.discount) / r.count, 2) for r in since})
        status = classify(cfg, income)
        # Санал болгох өөрчлөлт (dry-run) — 4-р шатанд «Батлах»
        # Манай plan: subtraction; бусдын plan-тай НИЙЛЖ үйлчилдэг (103118: −210 −60) тул нөхөх утга:
        # value = манай одоогийн value + (агуулахын бодит үнэ − орлого). Бусдын plan-гүй бол = үндсэн − орлого.
        action, review, target = "", False, None
        own_p = own[0] if own else None
        if income is not None and p and cfg is not None and how == "print":
            own_v = float(own_p["value"] or 0) if own_p and own_p.get("type") == "subtraction" else None
            target = plan_target(own_v, cfg, income)
            if own_p is not None:
                action = "" if own_v is not None and abs(cfg - income) < TOL else "update"
            elif status != "eq":
                action = "create"
            review = bool(action) and (not guard(income, cfg if own_p else prev_income, s["guard_pct"])
                                       or is_fractional(income))
        rows.append({
            "code": code, "name": (p or {}).get("name") or m.get("name") or (last.name if last else ""),
            "brand": m.get("brand", ""), "uom": m.get("uom", ""), "non_piece": bool(m.get("uom")) and m.get("uom") != "ширхэг",
            "in_erxes": bool(p), "product_id": (p or {}).get("_id", ""),
            "income": income, "fractional": is_fractional(income), "income_date": last.date if last else "", "income_customer": last.customer if last else "",
            "income_bill": last.bill_number if last else "", "income_count": last.count if last else None,
            "prev_income": prev_income, "prev_income_date": prev.date if prev else "",
            "base": base, "config": cfg, "config_how": how, "config_calc": calc, "zaal": pr.get("zaal"),
            "plans": [{"id": x["_id"], "name": x["name"], "type": x["type"], "value": x["value"],
                       "priority": bool(x.get("isPriority")), "conditional": is_conditional(x),
                       "shared": len(x.get("departmentIds") or []) != 1, "own": x["_id"] in managed,
                       "price": plan_price(base, x)} for x in ap],
            "others": len(others),
            "real": real, "real_date": (ls.paid_at + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M") if ls else "",
            "real_order": ls.number if ls else "",
            "since_count": len(since), "since_qty": sum(r.count for r in since), "since_prices": since_prices,
            "diff_config": round(cfg - income, 2) if cfg is not None and income is not None else None,
            "diff_config_pct": _pct(cfg, income), "diff_real": round(real - income, 2) if real is not None and income is not None else None,
            "diff_real_pct": _pct(real, income),
            "status": status, "action": action, "review": review, "target": target,
        })
    summ = {k: sum(1 for r in rows if r["status"] == k) for k in ("eq", "high", "low", "none")}
    summ.update(total=len(rows), overlap=sum(1 for r in rows if r["others"]), with_income=sum(1 for r in rows if r["income"] is not None),
                not_in_erxes=sum(1 for r in rows if not r["in_erxes"]), non_piece=sum(1 for r in rows if r["non_piece"]),
                pending=sum(1 for r in rows if r["action"]), review=sum(1 for r in rows if r["review"]))
    return {"rows": rows, "summary": summ, "unsupported_plans": unsupported, "dept_plans": len(dept_plans),
            "settings": s}


def run(by: str = "", full: bool = False, manual: bool = True) -> dict:
    from app.core.db import SessionLocal
    from app.models.price_cost import PcSyncRun
    with _lock:
        if _state["running"]:
            raise RuntimeError("Синк аль хэдийн ажиллаж байна.")
        if manual and _state["last_start"] and time.monotonic() - _state["last_start"] < MIN_GAP:
            raise RuntimeError(f"{int(MIN_GAP - (time.monotonic() - _state['last_start']))} секундын дараа дахин оролдоно уу.")
        _state.update(running=True, error="", last_start=time.monotonic(), step="эхэлж байна")
    db = SessionLocal()
    run_row = PcSyncRun(kind="read", by=by)
    db.add(run_row)
    db.commit()
    t0 = time.time()
    try:
        st_inc = fetch_income(db, full=full)
        st_pos = fetch_pos_sales(db)
        res = build(db)
        res["generated_at"] = datetime.utcnow().isoformat() + "Z"
        res["stats"] = {"income": st_inc, "pos": st_pos, "seconds": round(time.time() - t0, 1)}
        RESULT_FILE.parent.mkdir(parents=True, exist_ok=True)
        RESULT_FILE.write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
        run_row.status, run_row.stats = "ok", json.dumps({**res["stats"], **res["summary"]}, ensure_ascii=False)
        return res
    except Exception as e:
        _state["error"] = str(e)[:300]
        run_row.status, run_row.error = "error", traceback.format_exc()[-2000:]
        raise
    finally:
        run_row.finished_at = datetime.utcnow()
        db.commit()
        db.close()
        _state.update(running=False, step="")


def run_bg(by: str = "", full: bool = False) -> None:
    """Гараар — урьдчилан шалгаад thread-д."""
    with _lock:
        if _state["running"]:
            raise RuntimeError("Синк аль хэдийн ажиллаж байна.")
        if _state["last_start"] and time.monotonic() - _state["last_start"] < MIN_GAP:
            raise RuntimeError(f"{int(MIN_GAP - (time.monotonic() - _state['last_start']))} секундын дараа дахин оролдоно уу.")

    def _go():
        try:
            run(by=by, full=full, manual=False)
        except Exception as e:  # noqa: BLE001
            print(f"[price_cost] алдаа: {e}")
    threading.Thread(target=_go, daemon=True).start()


# ── хуваарь (5-р шат) ────────────────────────────────────────────────
UB = timedelta(hours=8)


def _hhmm(v) -> str | None:
    try:
        h, m = str(v).strip().split(":")
        h, m = int(h), int(m)
    except Exception:
        return None
    return f"{h:02d}:{m:02d}" if 0 <= h < 24 and 0 <= m < 60 else None


def due_slot(schedule: list[str], now_utc: datetime, last_start_utc: datetime | None) -> str | None:
    """Өнөөдрийн (УБ) хамгийн сүүлд өнгөрсөн цаг — түүнээс хойш синк эхлээгүй бол буцаана.
    Сервер тухайн цагт унтарсан байсан бол асахдаа нэг удаа нөхнө (зөвхөн тухайн өдөр)."""
    ub = now_utc + UB
    slots = [t for t in (_hhmm(x) for x in schedule) if t and t <= ub.strftime("%H:%M")]
    if not slots:
        return None
    slot = max(slots)
    slot_utc = datetime.combine(ub.date(), datetime.strptime(slot, "%H:%M").time()) - UB
    return None if last_start_utc and last_start_utc >= slot_utc else slot


def run_scheduled() -> dict | None:
    """Хуваарийн цаг болсон бол ЗӨВХӨН УНШДАГ синк. erxes рүү юу ч бичихгүй — батлах нь үргэлж гараар."""
    from app.core.db import SessionLocal
    from app.models.price_cost import PcSyncRun
    s = load_settings()
    if not s.get("schedule") or _state["running"]:
        return None
    db = SessionLocal()
    try:
        last = db.query(PcSyncRun.started_at).order_by(PcSyncRun.id.desc()).first()
    finally:
        db.close()
    slot = due_slot(s["schedule"], datetime.utcnow(), last[0] if last else None)
    if not slot:
        return None
    prev = load_result() or {}
    try:
        res = run(by=f"хуваарь {slot}", manual=False)
    except Exception as e:  # noqa: BLE001
        _notify(s, f"❌ Үнийн тохиргоо: хуваарийн синк ({slot}) амжилтгүй: {str(e)[:300]}")
        return None
    _notify_new(s, prev, res)
    return res


def _pending(res: dict) -> dict[str, str]:
    return {r["code"]: r["action"] + ("!" if r["review"] else "") for r in res.get("rows", []) if r.get("action")}


def _notify_new(s: dict, prev: dict, res: dict) -> None:
    """Санал болгосон өөрчлөлтийн жагсаалт өмнөхөөс өөрчлөгдсөн, хоосон биш үед л мэдэгдэнэ."""
    now, before = _pending(res), _pending(prev)
    if not now or now == before:
        return
    rows = {r["code"]: r for r in res["rows"]}
    new = [c for c in now if before.get(c) != now[c]]
    lines = []
    for c in new[:15]:
        r = rows[c]
        lines.append(f"• {c} {r['name'][:30]}: {r['config'] or 0:,.0f} → {r['income']:,.0f}"
                     + (" ⚠️ шалгах" if r["review"] else ""))
    more = f"\n… бас {len(new) - 15}" if len(new) > 15 else ""
    _notify(s, f"💲 Үнийн тохиргоо (Хархорин агуулах): {len(now)} бараанд plan санал"
               f" ({len(new)} шинэ)\n" + "\n".join(lines) + more
            + "\nERP → Үнийн тохиргоо-оос шалгаж «Батлах» (автоматаар ӨӨРЧЛӨГДӨХГҮЙ).")


def _notify(s: dict, text: str) -> None:
    if not s.get("notify", True):
        return
    try:
        from app.core.health_monitor import send_telegram
        send_telegram(text)
    except Exception as e:  # noqa: BLE001
        print(f"[price_cost] telegram: {e}")


def load_result() -> dict | None:
    try:
        return json.loads(RESULT_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def status() -> dict:
    return {"running": _state["running"], "error": _state["error"], "step": _state["step"],
            "next_manual_in": max(0, int(MIN_GAP - (time.monotonic() - _state["last_start"])))
            if _state["last_start"] else 0}
