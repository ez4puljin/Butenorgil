"""Erkhet sync шалгалт — erxes (sales) deal бүр Эрхэт рүү АВЛАГА (debtAmount) болж sync хийгдсэн эсэх.

Яагаад: 2026-10-д зарим апп (BTO300, «Захиалга») deal-ийн paymentsData-г {"totalAmount": N} гэх
буруу бүтэцтэй үүсгэсэн → sync-д `"undefined": null` очиж Эрхэт баримтыг БЭЛЭН (CASH) гэж бүртгэсэн,
авлага үүсээгүй. Бэлдэх шатны config (defaultPay="") ч мөн CASH болгодог. Зарим deal огт sync-гүй.

Эх сурвалж (erxes gateway, 2026-10-20-нд баталгаажсан):
  deals(pipelineId, noSkipArchive, sortField createdAt)  — жагсаалт (stageId талбаргүй — stage._id)
  dealDetail                                              — paymentsData, productsData
  syncHistories(contentType "sales:deal", 1 өдрөөр)       — илгээсэн orderInfos, Эрхэтийн хариу.
                                                            Хариу ХУУЧНААС ШИНЭ рүү — сүүлийнхийг createdAt-аар
  toCheckSynced(ids) — Эрхэт дээр байгаа эсэх (Эрхэт рүү шууд, удаан): 20-оор, 3 retry, ≥0.5с зай
  toSyncDeals(dealIds, configStageId, dateType) — дахин sync (ЗӨВХӨН хэрэглэгч dry-run баталсны дараа)
  dealsEdit(_id, paymentsData)                  — буруу paymentsData-г {} болгох

НУУЦ: syncHistories.sendData.payload-д apiKey/apiSecret/token байдаг — _scrub-аар хасаж хадгална.
Огноо: шүүлт Asia/Ulaanbaatar (UTC+8) өдрөөр; хадгалалт UTC.
"""
from __future__ import annotations

import json
import threading
import time
import traceback
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

UB = timezone(timedelta(hours=8))
BOARD_DEFAULT = "Хөвсгөл"
CHECK_BATCH = 20
SYNC_BATCH = 10
GAP = 0.5                                   # Эрхэт рүү хандах батч хоорондын зай (сек)
DATE_TYPES = [("", "Одоо (Now)"), ("lastMove", "Сүүлд шилжсэн"), ("created", "Үүссэн огноо"),
              ("closeOrCreated", "Хаах эсвэл үүссэн"), ("closeOrMove", "Хаах эсвэл шилжсэн"),
              ("firstOrMove", "Анх эсвэл шилжсэн"), ("firstOrCreated", "Анх эсвэл үүссэн")]
DATE_FIELDS = ("createdAt", "stageChangedDate", "closeDate")
CATEGORIES = ("expected", "pending", "cancel")
_SECRET = ("apikey", "apisecret", "token", "password", "secret", "cookie")

# Stage-ийн анхны ангилал (нэрээр) — DB-д тохиргоо байхгүй үед. UI-аас stage тус бүрээр засна.
DEFAULT_STAGE_NAMES = {
    "expected": ["Баримт хэвлэх", "Архив", "Архивлах", "Ачигдсан Мөрөн", "Бэлэн НӨАТ-тэй", "Бай/РД борлуулалт"],
    "pending": ["ХТ захиалга", "Bto300 захиалга", "Бэлдэх захиалга", "Бэлдэж буй захиалга",
                "Захиалгын хүсэлт"],
    "cancel": ["Захиалга устгах", "Захиалга хадгалах/устгах", "Устгах Захиалга", "Устгах", "Цуцлах баримт"],
}

# Статус → (ноцтой байдал, монгол тайлбар, богино нэр)
STATUS_INFO = {
    "BAD_PAYMENTS": ("error", "paymentsData буруу бүтэцтэй («undefined» очсон)", "paymentsData буруу"),
    "NOT_IN_ERKHET": ("error", "Эрхэт дээр алга", "Эрхэтэд алга"),
    "DUPLICATE": ("error", "Эрхэт дээр давхар үүссэн (нэг deal-ийн дугаартай 2+ баримт)", "Давхар үүссэн"),
    "WRONG_KIND": ("error", "Эрхэт дээр өөр төрлийн баримтаар орсон (борлуулалт ↔ хөдөлгөөн)", "Буруу төрлөөр"),
    "CASH": ("error", "Авлага 120101 дээр үүсээгүй (бэлнээр бүртгэгдсэн)", "Авлага 120101-д алга"),
    "SALES_AMOUNT_DIFF": ("error", "Борлуулалтын дүн зөрүүтэй — deal-ийн дүн (tickUsed) ≠ Эрхэтийн баримт",
                          "Борлуулалтын дүн зөрүүтэй"),
    "ITEMS_DIFF": ("error", "Бараа зөрүүтэй — tickUsed бараа тоо ширхэг/дүнгээрээ Эрхэтийн баримттай таарахгүй",
                   "Бараа зөрүүтэй"),
    "NO_RESPONSE": ("warn", "Эрхэтээс хариу ирээгүй", "Хариу ирээгүй"),
    "SYNC_ERROR": ("error", "Sync алдаатай", "Sync алдаатай"),
    "AMOUNT_DIFF": ("warn", "Дүн зөрүүтэй (deal / илгээсэн / Эрхэт)", "Дүн зөрүүтэй"),
    "PAYMENTS_DIFF": ("info", "paymentsData-ийн дүн шинэчлэгдээгүй (Эрхэтийн дүн зөв)", "paymentsData хуучирсан"),
    "DATE_MISMATCH": ("warn", "Огноо зөрүүтэй", "Огноо зөрүүтэй"),
    "CANCEL_IN_ERKHET": ("warn", "Цуцлах stage боловч Эрхэт дээр байгаа", "Цуцалсан ч Эрхэтэд бий"),
    "NO_HISTORY": ("warn", "Эрхэт дээр байгаа ч sync түүх олдсонгүй", "Sync түүхгүй"),
    "PENDING": ("info", "Эцэслээгүй (бэлтгэх шат)", "Эцэслээгүй"),
    "OK": ("ok", "Зөв — Эрхэтийн баримттай таарсан", "Зөв"),
}
_SEV_RANK = {"error": 3, "warn": 2, "info": 1, "ok": 0}

# Эрхэтийн барааны гүйлгээний төрөл (inventory/trs kind): борлуулалт / хөдөлгөөн
ERKHET_KIND = {"sale": -29, "move": -5}
RECEIVABLE = "120101"                        # борлуулалтын deal-ийн авлагын данс (дт)
# Эрхэтийн баримтын агуулгаас гарах статусууд — эдгээрийн аль нь ч байхгүй бол «таарсан»
CONTENT_STATUSES = ("NOT_IN_ERKHET", "DUPLICATE", "WRONG_KIND", "CASH", "SALES_AMOUNT_DIFF", "ITEMS_DIFF")
ERK_WINDOW = 3                               # Эрхэтээс татах цонх (өдөр)


def _norm(s: str) -> str:
    """Stage нэр харьцуулах: латин X/x → кирилл Х, жижиг үсэг, зай."""
    return " ".join((s or "").replace("X", "Х").replace("x", "х").lower().split())


_DEFAULT_BY_NAME = {_norm(n): c for c, ns in DEFAULT_STAGE_NAMES.items() for n in ns}


def default_category(stage_name: str) -> str:
    """Тохиргоогүй stage: нэрээр; эс бөгөөс түлхүүр үгээр (erxes-д «Ачигдсан орон нутаг», «Устгах,Цуцлах
    баримт», «Захиалга устгах/хадгалах» г.м хувилбарууд бий); танихгүй бол «pending» (алдаа гаргахгүй)."""
    n = _norm(stage_name)
    if n in _DEFAULT_BY_NAME:
        return _DEFAULT_BY_NAME[n]
    if "устгах" in n or "цуцлах" in n:
        return "cancel"
    if "ачигдсан" in n or "архив" in n or "баримт хэвлэх" in n:
        return "expected"
    return "pending"


def default_pipeline_included(name: str) -> bool:
    """Бүх pipeline (хөдөлгөөнийх ч) анхнаасаа орно — хөдөлгөөнийг тоо ширхгээр нь шалгана."""
    return True


def pipeline_kind(name: str) -> str:
    """{Агуулах → Заал} хөдөлгөөн → «move» (Эрхэтэд хөдөлгөөний баримт), бусад → «sale» (борлуулалт + авлага)."""
    return "move" if "хөдөлгөөн" in (name or "").lower() else "sale"


# ── Туслахууд ────────────────────────────────────────────────────────────────

def _j(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def _scrub(o):
    """apiKey/apiSecret/token-ийг хасна (log, DB, UI-д хэзээ ч гаргахгүй)."""
    if isinstance(o, dict):
        return {k: _scrub(v) for k, v in o.items() if not any(s in str(k).lower() for s in _SECRET)}
    if isinstance(o, list):
        return [_scrub(x) for x in o]
    return o


def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def ub_date(iso: str | None) -> str:
    """UTC ISO → Улаанбаатарын огноо «YYYY-MM-DD»."""
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return str(iso)[:10]
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(UB).date().isoformat()


def ub_range(start: str, end: str) -> tuple[datetime, datetime]:
    """УБ-ийн [start 00:00, end 23:59:59] → UTC (aware). 10/15 00:00 УБ = 10/14 16:00Z."""
    a = datetime.fromisoformat(start).replace(tzinfo=UB).astimezone(timezone.utc)
    b = (datetime.fromisoformat(end) + timedelta(days=1)).replace(tzinfo=UB).astimezone(timezone.utc)
    return a, b


def _parse_ts(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def payments_bad(pd) -> bool:
    """paymentsData-ийн утга бүр объект байх ёстой ({"other": {"amount": N}}). {"totalAmount": N} — буруу."""
    pd = _j(pd)
    if not pd:
        return False
    if not isinstance(pd, dict):
        return True
    return any(not isinstance(v, dict) for v in pd.values())


def payments_sum(pd) -> float:
    pd = _j(pd)
    if not isinstance(pd, dict):
        return 0.0
    return sum(_num(v.get("amount")) for v in pd.values() if isinstance(v, dict))


def parse_history(h: dict, deal_id: str = "") -> dict:
    """syncHistories мөр → илгээсэн/хүлээн авсан мэдээлэл (нууцгүй)."""
    send = _j(h.get("sendData")) or {}
    payload = _j(send.get("payload")) if isinstance(send, dict) else {}
    payload = payload if isinstance(payload, dict) else {}
    infos = _j(payload.get("orderInfos")) or []
    infos = infos if isinstance(infos, list) else [infos]
    o0 = next((x for x in infos if isinstance(x, dict) and x.get("orderId") == deal_id), None) \
        or (infos[0] if infos and isinstance(infos[0], dict) else {})
    pay_keys = sorted(k for k in o0 if k == "undefined" or (k.endswith("Amount") and k != "totalAmount"))
    resp = _j(h.get("responseData"))
    eb = (resp or {}).get("ebarimt") if isinstance(resp, dict) else None
    eb = eb if isinstance(eb, dict) else {}
    codes = [p.get("code") for p in (eb.get("payments") or []) if isinstance(p, dict)]
    details = o0.get("details") or []
    return {
        "id": h.get("_id"), "at": h.get("createdAt"), "by": h.get("createdBy") or "",
        "user_email": payload.get("userEmail") or "",
        "date": o0.get("date") or "", "number": o0.get("number") or "",
        "customer": o0.get("customerCode") or "",
        "pay_keys": pay_keys, "has_undefined": "undefined" in o0,
        "debt": _num(o0.get("debtAmount")),
        # details[].amount нь ХЯМДРАЛЫН ДАРААХ дүн, discount нь зөвхөн мэдээлэл (2026/10/19-0007:
        # Σamount 600,000 = debtAmount = Эрхэтийн totalAmount; Σ(amount−discount) 576,000 буруу)
        "details_sum": round(sum(_num(d.get("amount")) for d in details if isinstance(d, dict)), 2),
        "no_response": resp is None,
        "resp_codes": codes, "resp_total": _num(eb.get("totalAmount")) if eb else None,
        "resp_date": eb.get("date") or "",
        "resp_success": resp.get("success") if isinstance(resp, dict) else None,
        "resp_error": (resp.get("error") or "") if isinstance(resp, dict) else "",
        "resp_warning": (resp.get("warning") or "") if isinstance(resp, dict) else "",
        "error": h.get("error") or "",
        "order": _scrub({k: v for k, v in o0.items()}),
        "response": _scrub(resp),
    }


def pay_label(last: dict | None) -> str:
    """Илгээсэн төлбөрийн талбар: debtAmount / undefined / CASH (талбаргүй) / бусад."""
    if not last:
        return ""
    if last["has_undefined"]:
        return "undefined"
    if last["debt"] > 0:
        return "debtAmount"
    ks = [k for k in last["pay_keys"] if k != "debtAmount"]
    return ", ".join(ks) if ks else "CASH"


def _money(v) -> float:
    """Эрхэтийн «1,234.00» текст → тоо."""
    try:
        return float(str(v).replace(",", "")) if v not in (None, "") else 0.0
    except ValueError:
        return 0.0


def debit_accounts(rel: str) -> set[str]:
    """«кт:311004, дт:120101» → {"120101"} (зөвхөн дебет)."""
    return {x.split(":", 1)[1].strip() for x in (rel or "").split(",") if x.strip().startswith("дт:")}


def deal_items(products_data, codes: dict[str, str]) -> dict[str, dict]:
    """tickUsed=true бараа → {код: {qty, amount, name}} (нэг код олон мөртэй бол нийлбэр)."""
    out: dict[str, dict] = {}
    for p in products_data or []:
        if not isinstance(p, dict) or not p.get("tickUsed"):
            continue
        code = codes.get(p.get("productId") or "") or f"?{p.get('productId')}"
        x = out.setdefault(code, {"qty": 0.0, "amount": 0.0, "name": ""})
        x["qty"] += _num(p.get("quantity"))
        x["amount"] += _num(p.get("amount"))
    return out


def compare_erkhet(kind: str, items: dict[str, dict], deal_total: float, lines: list[dict]) -> dict:
    """Deal-ийн tickUsed бараа ↔ Эрхэтийн тухайн дугаартай баримт(ууд). Цэвэр функц — unit test-тэй.

    lines — fetch_erkhet_lines-ийн мөрүүд (bill_number == deal-ийн дугаар). Борлуулалт: код бүрийн тоо + дүн
    (НӨАТ-тэй), нийт дүн, дт:120101. Хөдөлгөөн: зөвхөн тоо (Эрхэт хөдөлгөөнийг өртгөөр бүртгэдэг — үнэгүй)."""
    want = ERKHET_KIND[kind]
    own = [x for x in lines if x["kind"] == want]
    other = [x for x in lines if x["kind"] != want]
    docs: dict[int, dict] = {}
    for x in own:
        d = docs.setdefault(x["tr_id"], {"tr_id": x["tr_id"], "date": x["date"], "total": 0.0, "lines": 0,
                                         "accounts": set(), "user": x.get("user", "")})
        d["total"] += x["total"]
        d["lines"] += 1
        d["accounts"] |= debit_accounts(x["accounts"])
    st: list[str] = []
    notes: list[str] = []
    if other:
        st.append("WRONG_KIND")
        notes.append(f"Эрхэтэд {'хөдөлгөөн' if kind == 'sale' else 'борлуулалт'}ын баримтаар орсон "
                     f"(#{', #'.join(str(t) for t in sorted({x['tr_id'] for x in other}))})")
    if len(docs) > 1:
        st.append("DUPLICATE")
        notes.append("Эрхэтэд давхар: " + "; ".join(f"#{d['tr_id']} {d['date']} {d['total']:,.0f}₮"
                                                   for d in sorted(docs.values(), key=lambda d: d["tr_id"])))
    main = max(docs) if docs else None                  # давхар бол хамгийн сүүлийнхийг тулгана
    erk: dict[str, dict] = {}
    for x in own:
        if x["tr_id"] != main:
            continue
        e = erk.setdefault(x["code"], {"qty": 0.0, "amount": 0.0, "name": x.get("name", "")})
        e["qty"] += x["qty"]
        e["amount"] += x["total"]
    erk_total = round(sum(e["amount"] for e in erk.values()), 2)
    diff = []
    if main is not None:
        for code in sorted(set(items) | set(erk)):
            a, b = items.get(code) or {}, erk.get(code) or {}
            dq, eq, da, ea = a.get("qty", 0.0), b.get("qty", 0.0), a.get("amount", 0.0), b.get("amount", 0.0)
            if abs(dq - eq) > 0.001 or (kind == "sale" and abs(da - ea) > 1):
                diff.append({"code": code, "name": b.get("name") or a.get("name") or "", "deal_qty": dq,
                             "erk_qty": eq, "deal_amount": round(da, 2), "erk_amount": round(ea, 2)})
        if diff:
            st.append("ITEMS_DIFF")
            notes.append(f"{len(diff)} бараа зөрүүтэй: " + ", ".join(
                f"{x['code']} ({x['deal_qty']:g}→{x['erk_qty']:g})" for x in diff[:5]) + (" …" if len(diff) > 5 else ""))
        if kind == "sale":
            if abs(deal_total - erk_total) > 1:
                st.append("SALES_AMOUNT_DIFF")
                notes.append(f"Борлуулалт: deal {deal_total:,.0f} ≠ Эрхэт {erk_total:,.0f} "
                             f"(зөрүү {deal_total - erk_total:+,.0f})")
            if RECEIVABLE not in docs[main]["accounts"]:
                st.append("CASH")
                acc = ", ".join(sorted(docs[main]["accounts"])) or "дебет данс алга"
                notes.append(f"Эрхэтийн баримт дт:{RECEIVABLE} биш ({acc})")
    main_doc = docs.get(main) if main is not None else None
    return {"found": bool(docs), "statuses": st, "notes": notes, "diff": diff[:300], "total": erk_total,
            "date": main_doc["date"] if main_doc else "",
            "docs": [{**d, "accounts": sorted(d["accounts"])} for d in sorted(docs.values(), key=lambda d: d["tr_id"])]}


def classify(*, category: str, payments_data, deal_amount: float | None, created_at: str,
             check: dict | None, hists: list[dict], start: str = "", end: str = "",
             expect_date_type: str = "created", kind: str = "sale", erk: dict | None = None) -> dict:
    """Deal-ийн статусууд (олон байж болно) + ноцтой байдал. Цэвэр функц — unit test-тэй.

    hists — parse_history-ийн үр дүн (хуучнаас шинэ рүү эрэмблэгдсэн).
    erk — compare_erkhet-ийн үр дүн (Эрхэтийн бодит баримт). Байвал авлага/дүн/бараа/давхардлыг ҮҮГЭЭР шийднэ;
    None (Эрхэтээс татаж чадаагүй) бол хуучин аргаар — sync түүхийн хариугаар."""
    st: list[str] = []
    notes: list[str] = []
    last = hists[-1] if hists else None
    # Эрхэт дээр үлдсэн баримт = хамгийн сүүлийн АМЖИЛТТАЙ sync (дараагийнх нь timeout болсон байж болно)
    eff = next((h for h in reversed(hists) if not h["no_response"] and h["resp_success"] is True
                and h["resp_codes"]), None)
    in_erkhet = erk["found"] if erk is not None else bool(check and check.get("isSynced"))
    if erk is not None and not erk["found"] and check and check.get("isSynced"):
        notes.append("toCheckSynced «байгаа» гэсэн ч Эрхэтэд энэ дугаартай баримт олдсонгүй")
    sale = kind == "sale"

    if sale and (payments_bad(payments_data) or (last and last["has_undefined"])):
        st.append("BAD_PAYMENTS")
    if category == "expected" and not in_erkhet:
        st.append("NOT_IN_ERKHET")

    cash_sev = "error" if category == "expected" else "info" if category == "pending" else "warn"
    base = eff or (last if last and not last["no_response"] else None)
    if erk is not None:
        if category != "cancel":
            st += [s for s in erk["statuses"] if s not in st]
            notes += erk["notes"]
    elif sale and in_erkhet and base:
        codes = base["resp_codes"]
        if base["debt"] <= 0 or ("CASH" in codes and "PAYMENT_CARD" not in codes):
            st.append("CASH")
            if base is not last:
                notes.append("Сүүлийн sync амжилтгүй — Эрхэт дээр өмнөх бэлэн баримт үлдсэн")
    if last and last["no_response"]:
        st.append("NO_RESPONSE")
    if last and not last["no_response"] and (last["error"] or last["resp_error"] or last["resp_success"] is not True):
        st.append("SYNC_ERROR")
    elif last and last["error"] and last["no_response"]:
        st.append("SYNC_ERROR")

    amounts = {}
    ps = payments_sum(payments_data)
    if erk is not None:
        # Гол шалгалт: deal-ийн дүн (tickUsed) ↔ Эрхэтийн баримт. paymentsData — зөвхөн мэдээлэл.
        if deal_amount:
            amounts["deal"] = float(deal_amount)
        if erk["found"]:
            amounts["erkhet" if sale else "erkhet_cost"] = erk["total"]      # хөдөлгөөн — өртгөөр
        if ps and sale:
            amounts["payments"] = ps
    elif sale:
        # Хуучин арга (Эрхэтийн баримт татаж чадаагүй үед): deal, илгээсэн авлага, Эрхэтийн хариу — зөрвөл
        # AMOUNT_DIFF. paymentsData нь бараа хасагдсаны дараа шинэчлэгддэггүй тул тусад нь (PAYMENTS_DIFF)
        if deal_amount:
            amounts["deal"] = float(deal_amount)
        if base and base["debt"] > 0:
            amounts["debt"] = base["debt"]
        if base and base["resp_total"]:
            amounts["erkhet"] = float(base["resp_total"])
        core = dict(amounts)
        if ps:
            amounts["payments"] = ps
        if len(core) > 1 and max(core.values()) - min(core.values()) > 1:
            st.append("AMOUNT_DIFF")
            notes.append("Дүн: " + ", ".join(f"{k} {v:,.0f}" for k, v in amounts.items()))
        elif ps and core and max(abs(ps - v) for v in core.values()) > 1:
            st.append("PAYMENTS_DIFF")
            notes.append(f"paymentsData {ps:,.0f} ≠ " + ", ".join(f"{k} {v:,.0f}" for k, v in core.items()))

    # Огноо — Эрхэтийн баримтын огноо (байвал), эс бөгөөс toCheckSynced / сүүлийн sync
    erk_date = (erk or {}).get("date") or (check or {}).get("syncedDate") or ""
    erk_date = str(erk_date)[:10] if erk_date else (last["date"] if last else "")
    expect = ub_date(created_at) if expect_date_type == "created" else ""
    if in_erkhet and erk_date:
        bad_date = False
        if expect and erk_date != expect:
            bad_date = True
            notes.append(f"Эрхэтийн огноо {erk_date} ≠ үүссэн {expect}")
        if start and end and not (start <= erk_date <= end):
            bad_date = True
            notes.append(f"Эрхэтийн огноо {erk_date} хүрээнээс гадна")
        ds = {h["date"] for h in hists if h["date"] and not h["no_response"]}
        if len(ds) > 1:
            bad_date = True
            notes.append("Өөр өөр огноотой sync: " + ", ".join(sorted(ds)))
        if bad_date:
            st.append("DATE_MISMATCH")

    if category == "cancel" and in_erkhet:
        st.append("CANCEL_IN_ERKHET")
    if in_erkhet and not last and category != "cancel":
        st.append("NO_HISTORY")

    sev = {s: STATUS_INFO[s][0] for s in st}
    if "CASH" in sev:
        sev["CASH"] = cash_sev
    if erk is not None and category == "pending":
        # Эцэслээгүй deal: бэлдэх config-оор бэлэн (CASH) байх нь хэвийн; гэвч Эрхэтэд аль хэдийн орсон баримтын
        # дүн/бараа зөрвөл Эрхэтийн тайлан одоо буруу — анхааруулга
        for s in CONTENT_STATUSES:
            if s in sev and s != "CASH":
                sev[s] = "warn"
    # Эрхэтийн баримт бүрэн таарсан бол сүүлийн sync-ийн алдаа/хариугүй байдал нөлөөгүй (өмнөх sync үлдсэн)
    content_ok = erk is not None and in_erkhet and category != "cancel" and not any(s in st for s in CONTENT_STATUSES)
    if content_ok and ("SYNC_ERROR" in sev or "NO_RESPONSE" in sev):
        for s in ("SYNC_ERROR", "NO_RESPONSE"):
            if s in sev:
                sev[s] = "info"
        notes.append("Сүүлийн sync алдаатай ч Эрхэтийн баримт deal-тэй таарч байна")
    worst = max((sev[s] for s in st), key=lambda x: _SEV_RANK[x], default="ok")
    if erk is not None:
        ok = content_ok and worst != "error"
    elif sale:
        ok = bool(in_erkhet and base and base["debt"] > 0 and "PAYMENT_CARD" in base["resp_codes"]
                  and worst != "error")
    else:
        ok = in_erkhet and worst != "error"
    if ok:
        st.insert(0, "OK")
    if not st:
        if category == "pending":
            st.append("PENDING")
            worst = "info"
        else:
            st.append("OK")                     # cancel + Эрхэтэд байхгүй — зөв
    return {"statuses": st, "severity": worst, "status_sev": sev, "notes": notes,
            "in_erkhet": in_erkhet, "pay_label": pay_label(base or last) if sale else "", "amounts": amounts,
            "erkhet_date": erk_date}


# ── erxes дуудлагууд ─────────────────────────────────────────────────────────

def _client():
    from app.services.erxes_client import get_client
    return get_client()


def _gql(q: str, v: dict | None = None, tries: int = 3):
    last = None
    for i in range(tries):
        try:
            return _client().gql(q, v or {})
        except Exception as e:                  # 504/timeout — түр зуурын
            last = e
            time.sleep(1.5 * (i + 1))
    raise last  # type: ignore[misc]


def fetch_meta() -> dict:
    """Board → pipeline → stage, ebarimtConfig (нууцгүй)."""
    boards = _gql('query { salesBoards(type: "deal") { _id name pipelines { _id name } } }')["salesBoards"]
    for b in boards:
        for p in b["pipelines"]:
            p["stages"] = _gql('query($p: String!) { salesStages(pipelineId: $p) { _id name pipelineId } }',
                               {"p": p["_id"]}).get("salesStages") or []
    return {"boards": boards, "configs": fetch_configs()}


def fetch_configs() -> list[dict]:
    raw = _gql('query { configsGetValue(code: "ebarimtConfig") }').get("configsGetValue")
    v = _j(raw)
    v = _j(v.get("value", v)) if isinstance(v, dict) and "value" in v else v
    out = []
    for k, c in (v or {}).items():
        if not isinstance(c, dict):
            continue
        c = _scrub(c)
        out.append({"stageId": c.get("stageId") or k, "title": c.get("title") or "", "boardId": c.get("boardId") or "",
                    "pipelineId": c.get("pipelineId") or "", "userEmail": c.get("userEmail") or "",
                    "defaultPay": c.get("defaultPay") or "", "hasVat": bool(c.get("hasVat")),
                    "hasCitytax": bool(c.get("hasCitytax"))})
    return out


_DEALS_Q = '''query($p: String, $s: Int) { deals(pipelineId: $p, noSkipArchive: true, limit: 200, skip: $s,
  sortField: "createdAt", sortDirection: -1) { _id number name createdAt stageChangedDate closeDate status stage amount } }'''


def fetch_deals(pipeline_id: str, date_field: str, a: datetime, b: datetime) -> list[dict]:
    """createdAt-аар буурахаар татаж, хүрээний эхлэлээс өмнө үүссэнд хүрмэгц зогсоно
    (stageChangedDate/closeDate-ээр шүүх бол 60 хоногийн өмнөөс)."""
    cutoff = a if date_field == "createdAt" else a - timedelta(days=60)
    out, skip = [], 0
    while True:
        rows = _gql(_DEALS_Q, {"p": pipeline_id, "s": skip}).get("deals") or []
        stop = False
        for d in rows:
            c = _parse_ts(d.get("createdAt"))
            if c and c < cutoff:
                stop = True
                break
            t = _parse_ts(d.get(date_field))
            if t and a <= t < b:
                out.append(d)
        if stop or len(rows) < 200 or skip > 20000:
            return out
        skip += 200


def fetch_detail(deal_id: str) -> dict:
    return _gql('query($id: String!) { dealDetail(_id: $id) { _id number stageId paymentsData productsData } }',
                {"id": deal_id}).get("dealDetail") or {}


_HIST_Q = '''query($c: String, $a: Date, $b: Date, $p: Int) { syncHistories(contentType: "sales:deal",
  contentId: $c, startDate: $a, endDate: $b, page: $p, perPage: 100) {
  _id contentId createdAt createdBy error sendData responseData } }'''


def fetch_histories(ids: set[str], start: date, end: date, progress: Callable[[str], None] | None = None
                    ) -> dict[str, list[dict]]:
    """1 өдрөөр хуваан (их хүрээнд 400 өгдөг), хуудаслан татаж ids-д хамаарахыг л үлдээнэ."""
    out: dict[str, dict[str, dict]] = {}
    d = start
    while d <= end:
        page = 1
        while True:
            rows = _gql(_HIST_Q, {"c": None, "a": d.isoformat(), "b": (d + timedelta(days=1)).isoformat(),
                                  "p": page}).get("syncHistories") or []
            for h in rows:
                if h.get("contentId") in ids:
                    out.setdefault(h["contentId"], {})[h["_id"]] = h
            if len(rows) < 100 or page > 200:
                break
            page += 1
        if progress:
            progress(f"Sync түүх: {d.isoformat()}")
        d += timedelta(days=1)
    return {k: sorted(v.values(), key=lambda h: h.get("createdAt") or "") for k, v in out.items()}


def fetch_deal_histories(deal_id: str, since: date) -> list[dict]:
    hs, page = [], 1
    while True:
        rows = _gql(_HIST_Q, {"c": deal_id, "a": since.isoformat(),
                              "b": (datetime.now(timezone.utc).date() + timedelta(days=1)).isoformat(),
                              "p": page}).get("syncHistories") or []
        hs += rows
        if len(rows) < 100:
            break
        page += 1
    return sorted(hs, key=lambda h: h.get("createdAt") or "")


def check_synced(ids: list[str], progress: Callable[[str], None] | None = None) -> dict[str, dict]:
    out = {}
    for i in range(0, len(ids), CHECK_BATCH):
        chunk = ids[i:i + CHECK_BATCH]
        r = _gql('mutation($ids: [String]) { toCheckSynced(ids: $ids) { _id isSynced syncedDate syncedBillNumber '
                 'syncedCustomer } }', {"ids": chunk})
        for x in r.get("toCheckSynced") or []:
            out[x["_id"]] = x
        if progress:
            progress(f"Эрхэт шалгаж байна: {min(i + CHECK_BATCH, len(ids))}/{len(ids)}")
        time.sleep(GAP)
    return out


def fetch_product_codes(ids) -> dict[str, str]:
    """erxes productId → барааны код (идэвхтэй, дараа нь устгагдсан)."""
    need = list(dict.fromkeys(i for i in ids if i))
    out: dict[str, str] = {}
    for status in (None, "deleted"):
        rest = [i for i in need if i not in out]
        for i in range(0, len(rest), 100):
            chunk = rest[i:i + 100]
            rows = _gql('query($ids:[String],$pp:Int,$st:String){ products(ids:$ids, perPage:$pp, status:$st)'
                        '{ _id code } }', {"ids": chunk, "pp": len(chunk), "st": status}).get("products") or []
            out.update({p["_id"]: (p.get("code") or "").strip() for p in rows})
    return out


def _erk_page(c, path: str) -> list[dict]:
    from app.services.price_cost import items_from_response
    for attempt in range(3):
        try:
            return items_from_response(c.ajax(path))
        except Exception:
            if attempt == 2:
                raise
            time.sleep(3 * (attempt + 1))
    return []


def fetch_erkhet_lines(d1: date, d2: date, progress: Callable[[str], None] | None = None
                       ) -> dict[str, list[dict]]:
    """Эрхэтийн барааны гүйлгээ (inventory/trs, ЗӨВХӨН уншина) — борлуулалт (-29) ба хөдөлгөөн (-5),
    баримтын дугаар нь deal-ийн дугаар («2026/10/28-0066»). → {bill_number: [мөр]}.

    Дугаараар (огноогүй) шүүвэл ~2 мин/deal удаан тул огнооны цонх + «YYYY/» угтвараар (POS-ын баримтыг хасна)."""
    from urllib.parse import quote
    from app.services.erkhet_client import get_client
    c = get_client()
    out: dict[str, list[dict]] = {}
    seen: set = set()
    for kind in ERKHET_KIND.values():
        a = d1
        while a <= d2:
            b = min(d2, a + timedelta(days=ERK_WINDOW - 1))
            for y in sorted({a.year, b.year}):
                page = 1
                while True:
                    rows = _erk_page(c, f"inventory/trs/?kind={kind}&date1={a}&date2={b}"
                                        f"&bill_number={quote(f'{y}/')}&paginate_by=500&page={page}")
                    for x in rows:
                        rid = x.get("record_id")
                        if rid in seen:
                            continue
                        seen.add(rid)
                        out.setdefault(str(x.get("bill_number") or "").strip(), []).append({
                            "kind": int(x.get("kind") or kind), "tr_id": int(x.get("tr__id") or 0),
                            "date": str(x.get("date") or "")[:10], "code": str(x.get("inventory__code") or "").strip(),
                            "name": str(x.get("inventory__name") or "").strip(), "qty": _num(x.get("count")),
                            "total": _money(x.get("total_with_vat")), "accounts": x.get("rel_accounts") or "",
                            "location": x.get("inv_location__name") or "", "user": x.get("tr__user") or ""})
                    if len(rows) < 500 or page > 200:
                        break
                    page += 1
            if progress:
                progress(f"Эрхэтийн {'борлуулалт' if kind == ERKHET_KIND['sale'] else 'хөдөлгөөн'}: {b.isoformat()}")
            a = b + timedelta(days=1)
    return out


# ── Тохиргоо (DB) ────────────────────────────────────────────────────────────

def load_settings(db) -> tuple[dict[str, str], dict[str, str]]:
    from app.models.erkhet_sync_check import ErkhetSyncSetting
    st, pl = {}, {}
    for r in db.query(ErkhetSyncSetting).all():
        (st if r.kind == "stage" else pl)[r.ref_id] = r.value
    return st, pl


def stage_category(stage_id: str, stage_name: str, saved: dict[str, str]) -> str:
    return saved.get(stage_id) or default_category(stage_name)


def erk_window(deals: list[dict], check_map: dict) -> tuple[date, date]:
    """Эрхэтээс татах огноо: хамгийн эртний (deal үүссэн / Эрхэтийн огноо) − 2 хоног … өнөөдөр
    (дараа нь давхар sync хийгдсэн баримтыг ч барина)."""
    today = datetime.now(UB).date()

    def d(v):
        try:
            return date.fromisoformat(str(v)[:10])
        except ValueError:
            return None
    created = [x for x in (d(ub_date(x.get("createdAt"))) for x in deals) if x]
    lo = min(created, default=today)
    synced = [x for x in (d(c.get("syncedDate")) for c in check_map.values() if isinstance(c, dict)) if x]
    lo = min([lo] + [x for x in synced if x >= lo - timedelta(days=60)])      # хачин эртний огноог тоохгүй
    return lo - timedelta(days=2), today


# ── Шалгалт (background) ─────────────────────────────────────────────────────

_RUN_LOCK = threading.Lock()


def _set_run(run_id: int, **kw) -> None:
    from app.core.db import SessionLocal
    from app.models.erkhet_sync_check import ErkhetSyncRun
    db = SessionLocal()
    try:
        r = db.get(ErkhetSyncRun, run_id)
        for k, v in kw.items():
            setattr(r, k, v)
        db.commit()
    finally:
        db.close()


def analyze_deals(deals: list[dict], stage_map: dict[str, dict], pipe_names: dict[str, str],
                  saved_st: dict[str, str], hist_since: date, start: str, end: str,
                  progress: Callable[[str], None], check_map: dict | None = None,
                  hist_map: dict | None = None, erk_map: dict | None = None) -> list[dict]:
    """Deal бүрийн detail + түүх + Эрхэт (toCheckSynced + бодит баримтын мөр) → classify → хадгалах мөр."""
    ids = [d["_id"] for d in deals]
    details = {}
    for i, d in enumerate(deals):
        details[d["_id"]] = fetch_detail(d["_id"])
        if i % 20 == 0:
            progress(f"Deal дэлгэрэнгүй: {i + 1}/{len(deals)}")
    if hist_map is None:
        today = datetime.now(UB).date() + timedelta(days=1)
        hist_map = fetch_histories(set(ids), hist_since - timedelta(days=1), today, progress)
    if check_map is None:
        check_map = check_synced(ids, progress)
    progress("Барааны код татаж байна…")
    codes = fetch_product_codes(p.get("productId") for det in details.values()
                                for p in (det.get("productsData") or []) if isinstance(p, dict))
    if erk_map is None:
        try:
            erk_map = fetch_erkhet_lines(*erk_window(deals, check_map), progress)
        except Exception as e:                  # Эрхэт уналаа — хуучин аргаар (sync түүхээр) үргэлжлүүлнэ
            traceback.print_exc()
            progress(f"Эрхэтийн баримт татаж чадсангүй ({e}) — sync түүхээр шалгана")
            erk_map = None
    out = []
    for d in deals:
        det = details.get(d["_id"]) or {}
        sid = det.get("stageId") or ((_j(d.get("stage")) or {}).get("_id") if isinstance(_j(d.get("stage")), dict) else "")
        sg = stage_map.get(sid) or {}
        cat = stage_category(sid, sg.get("name", ""), saved_st)
        hs = [parse_history(h, d["_id"]) for h in hist_map.get(d["_id"], [])]
        amt = _j(d.get("amount")) or {}
        amount = _num(amt.get("MNT")) if isinstance(amt, dict) else _num(amt)
        chk = check_map.get(d["_id"])
        kind = pipeline_kind(pipe_names.get(sg.get("pipelineId", ""), ""))
        prods = [p for p in (det.get("productsData") or []) if isinstance(p, dict)]
        items = deal_items(prods, codes)
        erk = None
        if erk_map is not None:
            bills = {d.get("number") or "", (chk or {}).get("syncedBillNumber") or ""} - {""}
            erk = compare_erkhet(kind, items, round(sum(x["amount"] for x in items.values()), 2),
                                 [x for b in bills for x in erk_map.get(b, [])])
        res = classify(category=cat, payments_data=det.get("paymentsData"), deal_amount=amount,
                       created_at=d.get("createdAt"), check=chk, hists=hs, start=start, end=end,
                       kind=kind, erk=erk)
        last = hs[-1] if hs else None
        out.append({
            "deal_id": d["_id"], "number": d.get("number") or "", "name": d.get("name") or "",
            "pipeline_id": sg.get("pipelineId", ""), "stage_id": sid, "category": cat, "amount": amount,
            "severity": res["severity"], "statuses": res["statuses"],
            "data": {
                "pipeline": pipe_names.get(sg.get("pipelineId", ""), ""), "stage": sg.get("name", ""), "kind": kind,
                "erk": ({"docs": erk["docs"], "diff": erk["diff"], "total": erk["total"]} if erk else None),
                "createdAt": d.get("createdAt"), "stageChangedDate": d.get("stageChangedDate"),
                "closeDate": d.get("closeDate"), "status": d.get("status"),
                "paymentsData": _j(det.get("paymentsData")), "payments_bad": payments_bad(det.get("paymentsData")),
                "products": {"count": len(prods), "used": sum(1 for p in prods if p.get("tickUsed")),
                             "sum_used": round(sum(_num(p.get("amount")) for p in prods if p.get("tickUsed")), 2),
                             "sum_all": round(sum(_num(p.get("amount")) for p in prods), 2)},
                "check": chk or {}, "erkhet_bill": (chk or {}).get("syncedBillNumber") or "",
                "erkhet_customer": (chk or {}).get("syncedCustomer") or "",
                "erkhet_date": res["erkhet_date"], "last_sync_at": last["at"] if last else None,
                "pay_label": res["pay_label"],
                "resp_codes": last["resp_codes"] if last else [], "status_sev": res["status_sev"],
                "notes": res["notes"], "amounts": res["amounts"],
                "last_user": last["user_email"] if last else "",
                "hists": hs,
            },
        })
    return out


def run_check(run_id: int, params: dict) -> None:
    """POST /erkhet-sync/check-ийн background ажил."""
    from app.core.db import SessionLocal
    from app.models.erkhet_sync_check import ErkhetSyncItem

    def progress(msg: str, **kw):
        _set_run(run_id, progress=msg[:300], **kw)

    try:
        start, end = params["startDate"], params["endDate"]
        date_field = params.get("dateField") or "createdAt"
        a, b = ub_range(start, end)
        progress("erxes-ээс board, stage татаж байна…")
        meta = fetch_meta()
        board = next((x for x in meta["boards"] if x["_id"] == params.get("boardId")), None) \
            or next((x for x in meta["boards"] if BOARD_DEFAULT in x["name"]), None)
        if not board:
            raise RuntimeError("Board олдсонгүй")
        db = SessionLocal()
        try:
            saved_st, saved_pl = load_settings(db)
        finally:
            db.close()
        want_p = set(params.get("pipelineIds") or [])
        pipes = [p for p in board["pipelines"]
                 if (p["_id"] in want_p if want_p else
                     saved_pl.get(p["_id"], "include" if default_pipeline_included(p["name"]) else "exclude")
                     == "include")]
        stage_map = {s["_id"]: s for p in board["pipelines"] for s in p["stages"]}
        pipe_names = {p["_id"]: p["name"] for p in board["pipelines"]}
        want_s = set(params.get("stageIds") or [])
        deals = []
        for p in pipes:
            progress(f"Deal татаж байна: {p['name']}")
            for d in fetch_deals(p["_id"], date_field, a, b):
                sid = (d.get("stage") or {}).get("_id") if isinstance(d.get("stage"), dict) else ""
                if want_s and sid not in want_s:
                    continue
                deals.append(d)
        progress(f"{len(deals)} deal олдлоо", total_n=len(deals))
        hist_since = min((_parse_ts(d.get("createdAt")) for d in deals), default=a).astimezone(UB).date()
        rows = analyze_deals(deals, stage_map, pipe_names, saved_st, hist_since, start, end, progress)
        db = SessionLocal()
        try:
            for r in rows:
                db.add(ErkhetSyncItem(run_id=run_id, deal_id=r["deal_id"], number=r["number"], name=r["name"][:300],
                                      pipeline_id=r["pipeline_id"], stage_id=r["stage_id"], category=r["category"],
                                      amount=r["amount"], severity=r["severity"],
                                      statuses=json.dumps(r["statuses"]),
                                      data=json.dumps(r["data"], ensure_ascii=False, default=str)))
            db.commit()
        finally:
            db.close()
        _set_run(run_id, status="done", progress="Дууслаа", done_n=len(rows), total_n=len(rows),
                 summary=json.dumps(summarize(rows), ensure_ascii=False), finished_at=datetime.utcnow())
    except Exception as e:
        traceback.print_exc()
        _set_run(run_id, status="error", error=str(e)[:2000], finished_at=datetime.utcnow())


def summarize(rows: list[dict]) -> dict:
    s = {"total": len(rows), "amount": round(sum(r["amount"] for r in rows), 2), "by_status": {}, "by_severity": {}}
    for r in rows:
        x = s["by_severity"].setdefault(r["severity"], {"n": 0, "amount": 0.0})
        x["n"] += 1
        x["amount"] += r["amount"]
        for st in r["statuses"]:
            y = s["by_status"].setdefault(st, {"n": 0, "amount": 0.0})
            y["n"] += 1
            y["amount"] += r["amount"]
    return s


# ── Дахин sync ───────────────────────────────────────────────────────────────

_LOCKED: set[str] = set()
_LOCK = threading.Lock()


def lock_deals(ids: list[str]) -> list[str]:
    """Давхар sync-ээс сэргийлнэ. Аль хэдийн ажиллаж буй deal-уудыг буцаана (хоосон бол түгжсэн)."""
    with _LOCK:
        busy = [i for i in ids if i in _LOCKED]
        if not busy:
            _LOCKED.update(ids)
        return busy


def unlock_deals(ids: list[str]) -> None:
    with _LOCK:
        _LOCKED.difference_update(ids)


def edit_payments_empty(deal_id: str) -> tuple[bool, Any]:
    """paymentsData → {} (2026-10-д ингэж засаад sync хийхэд бүгдэд авлага үүссэн). Дараа нь шалгана."""
    _gql('mutation($id: String!, $p: JSON) { dealsEdit(_id: $id, paymentsData: $p) { _id } }',
         {"id": deal_id, "p": {}}, tries=1)
    after = _j(fetch_detail(deal_id).get("paymentsData"))
    return (not after), after


def to_sync(ids: list[str], config_stage_id: str, date_type: str) -> dict:
    r = _gql('mutation($d: [String], $c: String, $t: String) { toSyncDeals(dealIds: $d, configStageId: $c, '
             'dateType: $t) }', {"d": ids, "c": config_stage_id, "t": date_type}, tries=1)
    return _j(r.get("toSyncDeals")) or {}


def run_resync(run_id: int, params: dict, user_name: str) -> None:
    """Хэрэглэгч dry-run баталсны дараах ажил. params: items [{deal_id, number, pipeline_id, statuses}],
    configs {pipelineId: configStageId}, dateType, fixPayments."""
    from app.core.db import SessionLocal
    from app.models.erkhet_sync_check import ErkhetSyncAction

    items = params["items"]
    ids = [x["deal_id"] for x in items]
    started = datetime.now(timezone.utc)
    date_type = params.get("dateType", "created")
    cfgs = {c["stageId"]: c for c in fetch_configs()}
    log: dict[str, dict] = {x["deal_id"]: {"number": x.get("number", ""), "before": x.get("statuses") or [],
                                           "cfg": params["configs"].get(x.get("pipeline_id"), ""),
                                           "pay_before": "", "pay_after": "", "msg": [], "result": ""}
                            for x in items}

    def progress(msg: str, **kw):
        _set_run(run_id, progress=msg[:300], **kw)

    try:
        # 1) paymentsData засах
        if params.get("fixPayments"):
            for i, x in enumerate(items):
                det = fetch_detail(x["deal_id"])
                pd = det.get("paymentsData")
                if not payments_bad(pd):
                    continue
                L = log[x["deal_id"]]
                L["pay_before"] = json.dumps(_j(pd), ensure_ascii=False)
                try:
                    ok, after = edit_payments_empty(x["deal_id"])
                    L["pay_after"] = json.dumps(after, ensure_ascii=False)
                    if not ok:
                        L["result"] = "error"
                        L["msg"].append("paymentsData хоосон болсонгүй — sync алгассан")
                except Exception as e:
                    L["result"] = "error"
                    L["msg"].append(f"paymentsData засаж чадсангүй: {e}"[:300])
                progress(f"paymentsData засаж байна: {i + 1}/{len(items)}")
        # 2) toSyncDeals — config бүрээр, 10-аар, дараалан
        todo = [x for x in items if log[x["deal_id"]]["result"] != "error"]
        by_cfg: dict[str, list[str]] = {}
        for x in todo:
            c = log[x["deal_id"]]["cfg"]
            if not c:
                log[x["deal_id"]].update(result="error")
                log[x["deal_id"]]["msg"].append("Config сонгоогүй")
                continue
            by_cfg.setdefault(c, []).append(x["deal_id"])
        n = 0
        for c, dids in by_cfg.items():
            for i in range(0, len(dids), SYNC_BATCH):
                chunk = dids[i:i + SYNC_BATCH]
                try:
                    r = to_sync(chunk, c, date_type)
                    for k in ("error", "skipped"):
                        for d in (r.get(k) or []):
                            did = d if isinstance(d, str) else (d or {}).get("_id") or (d or {}).get("id")
                            if did in log:
                                log[did]["msg"].append(f"toSyncDeals {k}: {json.dumps(d, ensure_ascii=False)[:200]}")
                except Exception as e:
                    for did in chunk:
                        log[did]["msg"].append(f"toSyncDeals алдаа: {e}"[:300])
                n += len(chunk)
                progress(f"Sync хийж байна: {n}/{len(todo)}", done_n=n)
                time.sleep(GAP)
        # 3) хариу ирээгүй бол 1 удаа дахин
        time.sleep(3)
        since = started.astimezone(UB).date() - timedelta(days=1)
        synced = [d for ds in by_cfg.values() for d in ds]
        hist: dict[str, list[dict]] = {}
        for i, did in enumerate(synced):
            hs = [h for h in fetch_deal_histories(did, since) if (_parse_ts(h.get("createdAt")) or started) >= started]
            if hs and _j(hs[-1].get("responseData")) is None:
                log[did]["msg"].append("Эрхэтээс хариу ирээгүй — дахин sync хийв")
                try:
                    to_sync([did], log[did]["cfg"], date_type)
                    time.sleep(3)
                    hs = [h for h in fetch_deal_histories(did, since)
                          if (_parse_ts(h.get("createdAt")) or started) >= started]
                except Exception as e:
                    log[did]["msg"].append(f"Дахин sync алдаа: {e}"[:300])
            if not hs:
                log[did]["msg"].append("Шинэ sync түүх олдсонгүй")
            hist[did] = hs
            progress(f"Үр дүн шалгаж байна: {i + 1}/{len(synced)}")
            time.sleep(0.2)
        # 4) Эрхэт дээр баталгаажуулж дахин ангилна
        rows = []
        if synced:
            meta = fetch_meta()
            stage_map = {s["_id"]: s for b in meta["boards"] for p in b["pipelines"] for s in p["stages"]}
            pipe_names = {p["_id"]: p["name"] for b in meta["boards"] for p in b["pipelines"]}
            db = SessionLocal()
            try:
                saved_st, _ = load_settings(db)
            finally:
                db.close()
            full = _deals_by_ids(synced)
            rows = analyze_deals([full.get(d, {"_id": d}) for d in synced], stage_map, pipe_names, saved_st,
                                 since, "", "", progress,
                                 hist_map={d: fetch_deal_histories(d, since - timedelta(days=60)) for d in synced})
        after = {r["deal_id"]: r for r in rows}
        db = SessionLocal()
        try:
            for x in items:
                L = log[x["deal_id"]]
                r = after.get(x["deal_id"])
                if L["result"] != "error":
                    L["result"] = "ok" if r and "OK" in r["statuses"] and r["severity"] != "error" else "error"
                c = cfgs.get(L["cfg"], {})
                db.add(ErkhetSyncAction(
                    run_id=run_id, deal_id=x["deal_id"], number=L["number"], config_stage_id=L["cfg"],
                    config_title=c.get("title", ""), date_type=date_type, payments_before=L["pay_before"],
                    payments_after=L["pay_after"], before_statuses=json.dumps(L["before"]),
                    after_statuses=json.dumps(r["statuses"] if r else []), result=L["result"],
                    message="; ".join(L["msg"])[:2000], user_name=user_name))
            db.commit()
        finally:
            db.close()
        ok = sum(1 for L in log.values() if L["result"] == "ok")
        _set_run(run_id, status="done", progress="Дууслаа", done_n=len(items),
                 summary=json.dumps({"ok": ok, "error": len(items) - ok, "total": len(items)}),
                 finished_at=datetime.utcnow())
    except Exception as e:
        traceback.print_exc()
        _set_run(run_id, status="error", error=str(e)[:2000], finished_at=datetime.utcnow())
    finally:
        unlock_deals(ids)


def _deals_by_ids(ids: list[str]) -> dict[str, dict]:
    """Жагсаалтын талбарууд (createdAt, amount, stage) — dealDetail-д байхгүй тул deals(_ids)-аар."""
    out = {}
    for i in range(0, len(ids), 50):
        try:
            rows = _gql('query($ids: [String]) { deals(_ids: $ids, noSkipArchive: true, limit: 100) { _id number name '
                        'createdAt stageChangedDate closeDate status stage amount } }', {"ids": ids[i:i + 50]})
            for d in rows.get("deals") or []:
                out[d["_id"]] = d
        except Exception:
            pass
    return out


# ── Өдөр бүрийн автомат шалгалт (зөвхөн мэдэгдэнэ, sync ХИЙХГҮЙ) ─────────────────

def run_daily_check(notify: bool = True) -> dict:
    from app.core.db import SessionLocal
    from app.models.erkhet_sync_check import ErkhetSyncRun, ErkhetSyncItem
    today = datetime.now(UB).date()
    params = {"dateField": "createdAt", "startDate": (today - timedelta(days=7)).isoformat(),
              "endDate": (today - timedelta(days=1)).isoformat()}
    db = SessionLocal()
    try:
        r = ErkhetSyncRun(kind="check", status="running", params=json.dumps(params), created_by="(автомат)")
        db.add(r)
        db.commit()
        rid = r.id
    finally:
        db.close()
    run_check(rid, params)
    db = SessionLocal()
    try:
        run = db.get(ErkhetSyncRun, rid)
        bad = db.query(ErkhetSyncItem).filter(ErkhetSyncItem.run_id == rid, ErkhetSyncItem.severity == "error").all()
        res = {"run_id": rid, "status": run.status, "errors": len(bad)}
        if notify and run.status == "done" and bad:
            from app.core.health_monitor import send_telegram
            cnt: dict[str, int] = {}
            for x in bad:
                for s in json.loads(x.statuses):
                    if STATUS_INFO.get(s, ("",))[0] == "error" or s == "CASH":
                        cnt[s] = cnt.get(s, 0) + 1
            send_telegram(
                f"⚠️ Erkhet sync шалгалт ({params['startDate']} – {params['endDate']}): {len(bad)} асуудалтай deal, "
                f"{sum(x.amount for x in bad):,.0f}₮\n"
                + "\n".join(f"• {STATUS_INFO[k][1]}: {v}" for k, v in sorted(cnt.items(), key=lambda kv: -kv[1]))
                + "\nТайлан → Erkhet sync шалгалт-аас харж, шаардлагатай бол дахин sync хийнэ үү.")
        elif notify and run.status == "error":
            from app.core.health_monitor import send_telegram
            send_telegram(f"❌ Erkhet sync шалгалт амжилтгүй: {run.error[:300]}")
        return res
    finally:
        db.close()
