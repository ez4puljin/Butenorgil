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

# Статус → (ноцтой байдал, монгол тайлбар)
STATUS_INFO = {
    "BAD_PAYMENTS": ("error", "paymentsData буруу бүтэцтэй («undefined» очсон)"),
    "NOT_IN_ERKHET": ("error", "Эрхэт дээр алга"),
    "CASH": ("error", "Бэлнээр бүртгэгдсэн — авлага үүсээгүй"),
    "NO_RESPONSE": ("warn", "Эрхэтээс хариу ирээгүй"),
    "SYNC_ERROR": ("error", "Sync алдаатай"),
    "AMOUNT_DIFF": ("warn", "Дүн зөрүүтэй (deal / илгээсэн / Эрхэт)"),
    "PAYMENTS_DIFF": ("info", "paymentsData-ийн дүн шинэчлэгдээгүй (Эрхэтийн дүн зөв)"),
    "DATE_MISMATCH": ("warn", "Огноо зөрүүтэй"),
    "CANCEL_IN_ERKHET": ("warn", "Цуцлах stage боловч Эрхэт дээр байгаа"),
    "NO_HISTORY": ("warn", "Эрхэт дээр байгаа ч sync түүх олдсонгүй"),
    "PENDING": ("info", "Эцэслээгүй (бэлтгэх шат)"),
    "OK": ("ok", "Зөв — авлага үүссэн"),
}
_SEV_RANK = {"error": 3, "warn": 2, "info": 1, "ok": 0}


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
    """Хөдөлгөөний pipeline ({Агуулах → Заал}) борлуулалт биш — анхнаасаа хасна."""
    return "хөдөлгөөн" not in (name or "").lower()


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
        "details_sum": round(sum(_num(d.get("amount")) - _num(d.get("discount")) for d in details
                                 if isinstance(d, dict)), 2),
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


def classify(*, category: str, payments_data, deal_amount: float | None, created_at: str,
             check: dict | None, hists: list[dict], start: str = "", end: str = "",
             expect_date_type: str = "created") -> dict:
    """Deal-ийн статусууд (олон байж болно) + ноцтой байдал. Цэвэр функц — unit test-тэй.

    hists — parse_history-ийн үр дүн (хуучнаас шинэ рүү эрэмблэгдсэн)."""
    st: list[str] = []
    notes: list[str] = []
    last = hists[-1] if hists else None
    # Эрхэт дээр үлдсэн баримт = хамгийн сүүлийн АМЖИЛТТАЙ sync (дараагийнх нь timeout болсон байж болно)
    eff = next((h for h in reversed(hists) if not h["no_response"] and h["resp_success"] is True
                and h["resp_codes"]), None)
    in_erkhet = bool(check and check.get("isSynced"))

    if payments_bad(payments_data) or (last and last["has_undefined"]):
        st.append("BAD_PAYMENTS")
    if category == "expected" and not in_erkhet:
        st.append("NOT_IN_ERKHET")

    cash_sev = None
    base = eff or (last if last and not last["no_response"] else None)
    if in_erkhet and base:
        codes = base["resp_codes"]
        if base["debt"] <= 0 or ("CASH" in codes and "PAYMENT_CARD" not in codes):
            st.append("CASH")
            cash_sev = "error" if category == "expected" else "info" if category == "pending" else "warn"
            if base is not last:
                notes.append("Сүүлийн sync амжилтгүй — Эрхэт дээр өмнөх бэлэн баримт үлдсэн")
    if last and last["no_response"]:
        st.append("NO_RESPONSE")
    if last and not last["no_response"] and (last["error"] or last["resp_error"] or last["resp_success"] is not True):
        st.append("SYNC_ERROR")
    elif last and last["error"] and last["no_response"]:
        st.append("SYNC_ERROR")

    # Дүн: deal, илгээсэн авлага, Эрхэтийн бүртгэсэн — зөрвөл AMOUNT_DIFF. paymentsData нь бараа хасагдсаны
    # дараа шинэчлэгддэггүй тул тусад нь (PAYMENTS_DIFF, мэдээлэл) — 10/15–20-нд 201-ээс 42 ийм
    amounts = {}
    if deal_amount:
        amounts["deal"] = float(deal_amount)
    if base and base["debt"] > 0:
        amounts["debt"] = base["debt"]
    if base and base["resp_total"]:
        amounts["erkhet"] = float(base["resp_total"])
    core = dict(amounts)
    ps = payments_sum(payments_data)
    if ps:
        amounts["payments"] = ps
    if len(core) > 1 and max(core.values()) - min(core.values()) > 1:
        st.append("AMOUNT_DIFF")
        notes.append("Дүн: " + ", ".join(f"{k} {v:,.0f}" for k, v in amounts.items()))
    elif ps and core and max(abs(ps - v) for v in core.values()) > 1:
        st.append("PAYMENTS_DIFF")
        notes.append(f"paymentsData {ps:,.0f} ≠ " + ", ".join(f"{k} {v:,.0f}" for k, v in core.items()))

    # Огноо
    erk_date = (check or {}).get("syncedDate") or ""
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

    sev = {s: (cash_sev if s == "CASH" else STATUS_INFO[s][0]) for s in st}
    worst = max((sev[s] for s in st), key=lambda x: _SEV_RANK[x], default="ok")
    if (in_erkhet and base and base["debt"] > 0 and "PAYMENT_CARD" in base["resp_codes"]
            and worst != "error"):
        st.insert(0, "OK")
    if not st:
        if category == "pending":
            st.append("PENDING")
            worst = "info"
        else:
            st.append("OK")                     # cancel + Эрхэтэд байхгүй — зөв
    return {"statuses": st, "severity": worst, "status_sev": sev, "notes": notes,
            "in_erkhet": in_erkhet, "pay_label": pay_label(base or last), "amounts": amounts,
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


# ── Тохиргоо (DB) ────────────────────────────────────────────────────────────

def load_settings(db) -> tuple[dict[str, str], dict[str, str]]:
    from app.models.erkhet_sync_check import ErkhetSyncSetting
    st, pl = {}, {}
    for r in db.query(ErkhetSyncSetting).all():
        (st if r.kind == "stage" else pl)[r.ref_id] = r.value
    return st, pl


def stage_category(stage_id: str, stage_name: str, saved: dict[str, str]) -> str:
    return saved.get(stage_id) or default_category(stage_name)


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
                  hist_map: dict | None = None) -> list[dict]:
    """Deal бүрийн detail + түүх + Эрхэт → classify → хадгалах мөр."""
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
        res = classify(category=cat, payments_data=det.get("paymentsData"), deal_amount=amount,
                       created_at=d.get("createdAt"), check=chk, hists=hs, start=start, end=end)
        last = hs[-1] if hs else None
        prods = [p for p in (det.get("productsData") or []) if isinstance(p, dict)]
        out.append({
            "deal_id": d["_id"], "number": d.get("number") or "", "name": d.get("name") or "",
            "pipeline_id": sg.get("pipelineId", ""), "stage_id": sid, "category": cat, "amount": amount,
            "severity": res["severity"], "statuses": res["statuses"],
            "data": {
                "pipeline": pipe_names.get(sg.get("pipelineId", ""), ""), "stage": sg.get("name", ""),
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
