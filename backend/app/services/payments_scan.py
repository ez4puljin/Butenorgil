"""paymentsData илрүүлэгч ба засагч — Erkhet sync шалгалтын (erkhet_deal_check) дэд хэсэг.

erxes client, board/stage/config татах, sync түүх, toSyncDeals, түгжээ, stage-ийн ангиллыг
erkhet_deal_check-ээс ашиглана; энд зөвхөн шинэ зүйл:

  1) validate_payments_data-аар paymentsData-г шалгах (payments_validator)
  2) Дүнгийн тулгалт (analyze_amounts):
       A = dealDetail.amount.MNT  (= tickUsed мөрүүдийн amount-ийн нийлбэр, хямдралын ДАРАА)
       B = сүүлийн АМЖИЛТТАЙ sync-ийн orderInfos[0].details[].amount-ийн нийлбэр (мөн хямдралын
           ДАРАА — discount нь мэдээлэл; 2026/10/19-0007: Σamount 600,000 = debtAmount = Эрхэт)
       C = тэр sync-ийн responseData.ebarimt.totalAmount
     «Амжилттай» = success:true БА ebarimt объекттой (success:true боловч ebarimt-гүй — бэлдэх шатны
     config-ийн sync — тоогдохгүй).
  3) Засвар: dealsEdit(_id, paymentsData) — зөвхөн paymentsData (+modifiedAt) өөрчлөгддөгийг
     2026-10-22-нд 2026/10/16-0031 дээр баталсан. dealsEditProductData-г ХЭЗЭЭ Ч ашиглахгүй.
     Дараа нь toSyncDeals-ийг deal НЭГ НЭГЭЭР. Хэрэглэгч dry-run баталсны дараа л.
  4) 30 минут тутмын автомат скан — зөвхөн Telegram-аар мэдэгдэнэ (засахгүй, sync хийхгүй).
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from typing import Callable

from app.services import erkhet_deal_check as K
from app.services.payments_validator import DEFAULT_ALLOWED, ISSUES as PD_ISSUES, validate_payments_data

TOL = 1.0                       # ₮ — зөвшөөрөгдөх зөрүү
DETAIL_WORKERS = 8              # erxes client дотроо 4 зэрэгцээ хүсэлтээр хязгаарладаг
AUTO_EVERY_MIN = 30

# code → (ноцтой байдал, монгол тайлбар)
ISSUE_INFO = {
    **PD_ISSUES,
    "LAST_SYNC_UNDEFINED": ("error", "Сүүлийн sync-д төлбөрийн төрөл «undefined» очсон"),
    "ERKHET_CASH": ("error", "Эрхэт дээр БЭЛЭН (CASH) — авлага үүсээгүй"),
    "AMOUNT_MISMATCH": ("error", "Erxes ба Erkhet-ийн дүн зөрүүтэй"),
    "SENT_VS_RECORDED": ("warn", "Erkhet илгээсэн дүнгээс өөрийг бүртгэсэн"),
    "DEAL_TOTAL_INCONSISTENT": ("warn", "Erxes дотроо дүн зөрүүтэй (amount ≠ tickUsed нийлбэр)"),
    "CHANGED_AFTER_SYNC": ("warn", "Sync-ийн дараа өөрчлөгдөөд дахин sync хийгдээгүй"),
    "ITEM_MISMATCH": ("warn", "Бараа тус бүрийн зөрүү"),
    "ERKHET_NO_RESPONSE": ("warn", "Сүүлийн sync-д Erkhet хариу өгөөгүй (timedout)"),
    "NO_SYNC": ("info", "Erkhet рүү амжилттай sync хийгдээгүй"),
}
_RANK = {"error": 3, "warn": 2, "info": 1, "ok": 0}
# Erkhet-тэй холбоотой issue-г зөвхөн «expected» (Баримт хэвлэх, Ачигдсан, Архив) stage-д алдаа гэж үзнэ
_ERKHET_ISSUES = {"ERKHET_CASH", "AMOUNT_MISMATCH", "SENT_VS_RECORDED", "CHANGED_AFTER_SYNC", "ITEM_MISMATCH",
                  "ERKHET_NO_RESPONSE", "NO_SYNC"}

DETAIL_Q = ('query($id: String!) { dealDetail(_id: $id) { _id number name stageId amount modifiedAt createdAt '
            'stageChangedDate paymentsData products customers { firstName lastName primaryEmail } '
            'companies { primaryName } } }')


# ── Цэвэр функцууд (unit test-тэй) ───────────────────────────────────────────

def _amount_mnt(v) -> float:
    v = K._j(v)
    return K._num(v.get("MNT")) if isinstance(v, dict) else K._num(v)


def tick_rows(products) -> list[dict]:
    """dealDetail.products → tickUsed мөрүүд {code, name, qty, price, amount, discount}."""
    out = []
    for p in K._j(products) or []:
        if not isinstance(p, dict) or not p.get("tickUsed"):
            continue
        pr = p.get("product") if isinstance(p.get("product"), dict) else {}
        out.append({"code": str(pr.get("code") or p.get("productId") or ""), "name": pr.get("name") or "",
                    "qty": K._num(p.get("quantity")), "price": K._num(p.get("unitPrice")),
                    "amount": K._num(p.get("amount")), "discount": K._num(p.get("discount"))})
    return out


def _is_success(h: dict) -> bool:
    eb = (h.get("response") or {}).get("ebarimt") if isinstance(h.get("response"), dict) else None
    return h.get("resp_success") is True and isinstance(eb, dict)


def _paid_sum(h: dict) -> float:
    eb = (h.get("response") or {}).get("ebarimt") or {}
    return sum(K._num(p.get("paidAmount")) for p in (eb.get("payments") or []) if isinstance(p, dict))


def _pay_fields_sum(h: dict) -> float:
    o = h.get("order") or {}
    return sum(K._num(v) for k, v in o.items() if k.endswith("Amount") and k != "totalAmount")


def item_compare(rows: list[dict], details: list[dict]) -> list[dict]:
    """Барааны кодоор нийлүүлж Erxes (tickUsed) ↔ Erkhet рүү илгээсэн details тулгана."""
    ex: dict[str, dict] = {}
    for r in rows:
        x = ex.setdefault(r["code"], {"code": r["code"], "name": r["name"], "qty": 0.0, "amount": 0.0,
                                      "price": r["price"], "discount": 0.0})
        x["qty"] += r["qty"]
        x["amount"] += r["amount"]
        x["discount"] += r["discount"]
    sent: dict[str, dict] = {}
    for d in details or []:
        if not isinstance(d, dict):
            continue
        c = str(d.get("inventoryCode") or "")
        x = sent.setdefault(c, {"qty": 0.0, "amount": 0.0})
        x["qty"] += K._num(d.get("count"))
        x["amount"] += K._num(d.get("amount"))
    # Кодоор таараагүй мөрүүдийг тоо+дүнгээр хосолно: erxes-ийн код sync-ээс хойш өөрчлөгдсөн байж болно
    # (2026/10/19-0053: erxes 214002 ↔ илгээсэн 214103, 1 × 77,650) — энэ нь дүнгийн зөрүү биш.
    alias: dict[str, str] = {}
    lone_s = [c for c in sent if c not in ex]
    for c in [c for c in ex if c not in sent]:
        e = ex[c]
        m = next((s for s in lone_s if abs(sent[s]["qty"] - e["qty"]) < 1e-6
                  and abs(sent[s]["amount"] - e["amount"]) <= TOL), None)
        if m:
            lone_s.remove(m)
            alias[c] = m
            sent[c] = sent.pop(m)
    out = []
    for c in sorted(set(ex) | set(sent)):
        e, s = ex.get(c), sent.get(c)
        row = {"code": c, "name": (e or {}).get("name", ""), "sent_code": alias.get(c, ""),
               "erxes_qty": e["qty"] if e else None, "erxes_price": e["price"] if e else None,
               "erxes_discount": e["discount"] if e else None, "erxes_amount": round(e["amount"], 2) if e else None,
               "sent_qty": s["qty"] if s else None, "sent_amount": round(s["amount"], 2) if s else None}
        row["diff"] = round((s["amount"] if s else 0) - (e["amount"] if e else 0), 2)
        row["mismatch"] = (e is None or s is None or abs(e["qty"] - s["qty"]) > 1e-6
                           or abs(e["amount"] - s["amount"]) > TOL)
        out.append(row)
    return out


def analyze_amounts(*, deal_amount, products, modified_at: str | None, hists: list[dict]) -> dict:
    """hists — erkhet_deal_check.parse_history-ийн үр дүн (хуучнаас шинэ рүү)."""
    issues: list[str] = []
    rows = tick_rows(products)
    a = _amount_mnt(deal_amount)
    tick_sum = round(sum(r["amount"] for r in rows), 2)
    if rows and abs(a - tick_sum) > TOL:
        issues.append("DEAL_TOTAL_INCONSISTENT")
    last = hists[-1] if hists else None
    eff = next((h for h in reversed(hists) if _is_success(h)), None)
    # Хуучин sync-д undefined байсан ч сүүлийнх нь зөв бол OK — зөвхөн хамгийн сүүлийнхийг харна
    if last and last["has_undefined"]:
        issues.append("LAST_SYNC_UNDEFINED")
    if last and last is not eff and (last["no_response"] or "timedout" in (last["resp_error"] or "").lower()):
        issues.append("ERKHET_NO_RESPONSE")
    out = {"erxes_amount": a, "tick_sum": tick_sum, "sent_amount": None, "sent_pay_fields": None,
           "erkhet_amount": None, "erkhet_paid": None, "amount_diff": 0.0, "erkhet_payment": "",
           "last_sync_at": last["at"] if last else None, "eff_sync_at": eff["at"] if eff else None,
           "eff_date": eff["date"] if eff else "", "last_date": last["date"] if last else "",
           "items": [], "issues": issues}
    if not eff:
        issues.append("NO_SYNC")
        return out
    b = eff["details_sum"]
    c = K._num(eff["resp_total"])
    codes = eff["resp_codes"]
    out.update(sent_amount=b, sent_pay_fields=_pay_fields_sum(eff), erkhet_amount=c, erkhet_paid=_paid_sum(eff),
               amount_diff=round(c - a, 2),
               erkhet_payment="PAYMENT_CARD" if "PAYMENT_CARD" in codes else "CASH" if "CASH" in codes else "")
    if out["erkhet_payment"] == "CASH" or eff["debt"] <= 0:
        issues.append("ERKHET_CASH")
    if abs(a - c) > TOL:
        issues.append("AMOUNT_MISMATCH")
        m = K._parse_ts(modified_at)
        s = K._parse_ts(eff["at"])
        if m and s and m > s:
            issues.append("CHANGED_AFTER_SYNC")
    if abs(b - c) > TOL:
        issues.append("SENT_VS_RECORDED")
    items = item_compare(rows, (eff.get("order") or {}).get("details") or [])
    out["items"] = items
    if any(i["mismatch"] for i in items):
        issues.append("ITEM_MISMATCH")
    return out


def assess(*, category: str, payments_data, allowed, deal_amount, products, modified_at, hists) -> dict:
    """Deal-ийн бүрэн дүгнэлт: paymentsData + дүн + ноцтой байдал."""
    am = analyze_amounts(deal_amount=deal_amount, products=products, modified_at=modified_at, hists=hists)
    v = validate_payments_data(payments_data, allowed, deal_total=am["tick_sum"] or am["erxes_amount"] or None)
    codes = list(dict.fromkeys([i["code"] for i in v["issues"]] + am["issues"]))
    sev = "ok"
    for c in codes:
        s = ISSUE_INFO[c][0]
        if c in _ERKHET_ISSUES and category != "expected":
            s = "info"                              # бэлтгэх / цуцлах шатанд Эрхэт-ийн зөрүү хэвийн
        if _RANK[s] > _RANK[sev]:
            sev = s
    return {**am, "issues": codes, "severity": sev, "payments_ok": v["ok"], "payments_issues": v["issues"]}


# ── erxes ────────────────────────────────────────────────────────────────────

def fetch_full_detail(deal_id: str) -> dict:
    return K._gql(DETAIL_Q, {"id": deal_id}).get("dealDetail") or {}


def _customer(det: dict) -> str:
    for c in det.get("companies") or []:
        if c.get("primaryName"):
            return c["primaryName"]
    for c in det.get("customers") or []:
        n = " ".join(x for x in (c.get("lastName"), c.get("firstName")) if x).strip()
        if n or c.get("primaryEmail"):
            return n or c["primaryEmail"]
    return ""


def load_allowed(db) -> list[str]:
    from app.models.erkhet_sync_check import ErkhetSyncSetting
    r = db.query(ErkhetSyncSetting).filter(ErkhetSyncSetting.kind == "paytypes",
                                           ErkhetSyncSetting.ref_id == "allowed").first()
    vals = [x.strip() for x in (r.value if r else "").split(",") if x.strip()]
    return vals or list(DEFAULT_ALLOWED)


def save_allowed(db, types: list[str], user: str) -> list[str]:
    from app.models.erkhet_sync_check import ErkhetSyncSetting
    vals = sorted({t.strip() for t in types if t and t.strip()}) or list(DEFAULT_ALLOWED)
    v = ",".join(vals)[:40]
    r = db.query(ErkhetSyncSetting).filter(ErkhetSyncSetting.kind == "paytypes",
                                           ErkhetSyncSetting.ref_id == "allowed").first()
    if not r:
        r = ErkhetSyncSetting(kind="paytypes", ref_id="allowed", name="Зөвшөөрөгдсөн төлбөрийн төрөл")
        db.add(r)
    r.value, r.updated_by, r.updated_at = v, user, datetime.utcnow()
    db.commit()
    return v.split(",")


# ── Скан (background) ────────────────────────────────────────────────────────

def _set_run(run_id: int, **kw) -> None:
    from app.core.db import SessionLocal
    from app.models.payments_scan import PaymentsScanRun
    db = SessionLocal()
    try:
        r = db.get(PaymentsScanRun, run_id)
        for k, v in kw.items():
            setattr(r, k, v)
        db.commit()
    finally:
        db.close()


def collect_deals(params: dict, progress: Callable[[str], None]) -> tuple[list[dict], dict, dict, dict]:
    """board(ууд) → pipeline → deal (createdAt-аар, УБ хүрээ). → (deals, stage_map, pipe_names, saved_st)."""
    from app.core.db import SessionLocal
    a, b = K.ub_range(params["startDate"], params["endDate"])
    meta = K.fetch_meta()
    want_b = set(params.get("boardIds") or [])
    boards = [x for x in meta["boards"] if not want_b or x["_id"] in want_b]
    db = SessionLocal()
    try:
        saved_st, saved_pl = K.load_settings(db)
    finally:
        db.close()
    want_p = set(params.get("pipelineIds") or [])
    stage_map = {s["_id"]: s for bd in meta["boards"] for p in bd["pipelines"] for s in p["stages"]}
    pipe_names = {p["_id"]: p["name"] for bd in meta["boards"] for p in bd["pipelines"]}
    want_cat = set(params.get("categories") or [])
    deals = []
    for bd in boards:
        for p in bd["pipelines"]:
            if want_p:
                if p["_id"] not in want_p:
                    continue
            elif saved_pl.get(p["_id"], "include" if K.default_pipeline_included(p["name"]) else "exclude") != "include":
                continue
            progress(f"Deal татаж байна: {bd['name']} / {p['name']}")
            for d in K.fetch_deals(p["_id"], params.get("dateField") or "createdAt", a, b):
                sid = (d.get("stage") or {}).get("_id") if isinstance(d.get("stage"), dict) else ""
                cat = K.stage_category(sid, (stage_map.get(sid) or {}).get("name", ""), saved_st)
                if want_cat and cat not in want_cat:
                    continue
                d["_board"] = bd["name"]
                deals.append(d)
    return deals, stage_map, pipe_names, saved_st


def scan_deals(deals: list[dict], stage_map: dict, pipe_names: dict, saved_st: dict, allowed: list[str],
               hist_since: date, progress: Callable[[str], None]) -> list[dict]:
    ids = [d["_id"] for d in deals]
    details: dict[str, dict] = {}
    done = [0]

    def one(did):
        for i in range(3):
            try:
                return did, fetch_full_detail(did)
            except Exception:
                time.sleep(1.5 * (i + 1))
        return did, {}

    with ThreadPoolExecutor(DETAIL_WORKERS) as ex:
        for did, det in ex.map(one, ids):
            details[did] = det
            done[0] += 1
            if done[0] % 25 == 0:
                progress(f"Deal дэлгэрэнгүй: {done[0]}/{len(ids)}")
    today = datetime.now(K.UB).date() + timedelta(days=1)
    hist_map = K.fetch_histories(set(ids), hist_since - timedelta(days=1), today, progress)
    out = []
    for d in deals:
        det = details.get(d["_id"]) or {}
        sid = det.get("stageId") or ((d.get("stage") or {}).get("_id") if isinstance(d.get("stage"), dict) else "")
        sg = stage_map.get(sid) or {}
        cat = K.stage_category(sid, sg.get("name", ""), saved_st)
        hs = [K.parse_history(h, d["_id"]) for h in hist_map.get(d["_id"], [])]
        res = assess(category=cat, payments_data=det.get("paymentsData"), allowed=allowed,
                     deal_amount=det.get("amount") if det else d.get("amount"), products=det.get("products"),
                     modified_at=det.get("modifiedAt"), hists=hs)
        last = hs[-1] if hs else None
        out.append({
            "deal_id": d["_id"], "number": d.get("number") or det.get("number") or "",
            "name": d.get("name") or det.get("name") or "", "pipeline_id": sg.get("pipelineId", ""),
            "stage_id": sid, "category": cat, "erxes_amount": res["erxes_amount"],
            "erkhet_amount": res["erkhet_amount"], "amount_diff": res["amount_diff"],
            "erkhet_payment": res["erkhet_payment"], "last_sync_undefined": bool(last and last["has_undefined"]),
            "payments_bad": not res["payments_ok"], "severity": res["severity"], "issues": res["issues"],
            "data": {
                "board": d.get("_board", ""), "pipeline": pipe_names.get(sg.get("pipelineId", ""), ""),
                "stage": sg.get("name", ""), "customer": _customer(det), "createdAt": d.get("createdAt"),
                "modifiedAt": det.get("modifiedAt"), "stageChangedDate": d.get("stageChangedDate"),
                "paymentsData": K._j(det.get("paymentsData")), "payments_issues": res["payments_issues"],
                "tick_sum": res["tick_sum"], "sent_amount": res["sent_amount"],
                "sent_pay_fields": res["sent_pay_fields"], "erkhet_paid": res["erkhet_paid"],
                "last_sync_at": res["last_sync_at"], "eff_sync_at": res["eff_sync_at"],
                "eff_date": res["eff_date"], "last_date": res["last_date"], "items": res["items"],
                "last_user": last["user_email"] if last else "",
                "hist_count": len(hs),
            },
        })
    return out


def summarize(rows: list[dict]) -> dict:
    s = {"total": len(rows), "by_issue": {}, "by_severity": {},
         "payments_bad": sum(1 for r in rows if r["payments_bad"]),
         "amount_mismatch": sum(1 for r in rows if "AMOUNT_MISMATCH" in r["issues"]),
         "amount_mismatch_sum": round(sum(r["amount_diff"] for r in rows if "AMOUNT_MISMATCH" in r["issues"]), 2),
         "amount_mismatch_abs": round(sum(abs(r["amount_diff"]) for r in rows if "AMOUNT_MISMATCH" in r["issues"]), 2),
         "cash_n": sum(1 for r in rows if r["erkhet_payment"] == "CASH"),
         "cash_amount": round(sum(r["erkhet_amount"] or 0 for r in rows if r["erkhet_payment"] == "CASH"), 2),
         "no_response": sum(1 for r in rows if "ERKHET_NO_RESPONSE" in r["issues"])}
    for r in rows:
        s["by_severity"][r["severity"]] = s["by_severity"].get(r["severity"], 0) + 1
        for c in r["issues"]:
            s["by_issue"][c] = s["by_issue"].get(c, 0) + 1
    return s


def _save_items(run_id: int, rows: list[dict]) -> None:
    from app.core.db import SessionLocal
    from app.models.payments_scan import PaymentsScanItem
    db = SessionLocal()
    try:
        for r in rows:
            db.add(PaymentsScanItem(
                run_id=run_id, deal_id=r["deal_id"], number=r["number"], name=r["name"][:300],
                pipeline_id=r["pipeline_id"], stage_id=r["stage_id"], category=r["category"],
                erxes_amount=r["erxes_amount"], erkhet_amount=r["erkhet_amount"], amount_diff=r["amount_diff"],
                erkhet_payment=r["erkhet_payment"], last_sync_undefined=r["last_sync_undefined"],
                payments_bad=r["payments_bad"], severity=r["severity"], issues=json.dumps(r["issues"]),
                data=json.dumps(r["data"], ensure_ascii=False, default=str)))
        db.commit()
    finally:
        db.close()


def run_scan(run_id: int, params: dict) -> list[dict]:
    """POST /erkhet-sync/payments-scan-ийн background ажил. ЗӨВХӨН уншина."""
    from app.core.db import SessionLocal

    def progress(msg: str, **kw):
        _set_run(run_id, progress=msg[:300], **kw)

    try:
        progress("erxes-ээс board, stage татаж байна…")
        deals, stage_map, pipe_names, saved_st = collect_deals(params, progress)
        progress(f"{len(deals)} deal олдлоо", total_n=len(deals))
        db = SessionLocal()
        try:
            allowed = load_allowed(db)
        finally:
            db.close()
        a, _ = K.ub_range(params["startDate"], params["endDate"])
        since = min((K._parse_ts(d.get("createdAt")) for d in deals), default=a).astimezone(K.UB).date()
        rows = scan_deals(deals, stage_map, pipe_names, saved_st, allowed, since, progress)
        _save_items(run_id, rows)
        _set_run(run_id, status="done", progress="Дууслаа", done_n=len(rows), total_n=len(rows),
                 summary=json.dumps(summarize(rows), ensure_ascii=False), finished_at=datetime.utcnow())
        return rows
    except Exception as e:
        traceback.print_exc()
        _set_run(run_id, status="error", error=str(e)[:2000], finished_at=datetime.utcnow())
        return []


# ── Засвар: dry-run ба гүйцэтгэл ─────────────────────────────────────────────

_PLANS: dict[str, dict] = {}          # token → {"at", "plan", "mode"}
_PLAN_TTL = 900


def _snapshot(det: dict) -> dict:
    pd = K._j(det.get("products")) or []
    rows = [{k: v for k, v in p.items() if k != "product"} for p in pd if isinstance(p, dict)]
    return {"rows": len(rows), "products": json.dumps(rows, sort_keys=True, default=str),
            "amount": _amount_mnt(det.get("amount")), "stageId": det.get("stageId"), "name": det.get("name")}


def _pick_config(configs: list[dict], pipeline_id: str, prev: dict | None) -> tuple[dict | None, str]:
    if not prev:
        return None, "Өмнөх sync алга — config/огноог тааруулах боломжгүй"
    o = prev.get("order") or {}
    cands = [c for c in configs if c["pipelineId"] == pipeline_id and c["defaultPay"] == "debtAmount"]
    if not cands:
        return None, "Энэ pipeline-д defaultPay=debtAmount config алга"
    if "hasVat" in o:
        cands = [c for c in cands if c["hasVat"] == bool(o.get("hasVat"))]
    same_user = [c for c in cands if prev.get("user_email") and c["userEmail"] == prev["user_email"]]
    cands = same_user or cands
    if len(cands) != 1:
        return None, f"Тохирох config {len(cands)} олдлоо (hasVat={o.get('hasVat')}, {prev.get('user_email')})"
    return cands[0], ""


def _pick_date_type(prev: dict | None, created_at, stage_changed) -> tuple[str, str]:
    d = (prev or {}).get("date") or ""
    if not d:
        return "", "Өмнөх sync-ийн огноо алга"
    if d == K.ub_date(created_at):
        return "created", ""
    if d == K.ub_date(stage_changed):
        return "lastMove", ""
    return "", f"Өмнөх огноо {d} нь үүссэн ({K.ub_date(created_at)}) / шилжсэн ({K.ub_date(stage_changed)}) огноотой таарахгүй — гараар"


def build_plan(deal_ids: list[str], mode: str, allowed: list[str]) -> list[dict]:
    """Dry-run — erxes-т юу ч бичихгүй. Deal бүрийн өмнөх/шинэ paymentsData, sync хийх эсэх, config, dateType."""
    meta = K.fetch_meta()
    stage_map = {s["_id"]: s for bd in meta["boards"] for p in bd["pipelines"] for s in p["stages"]}
    from app.core.db import SessionLocal
    db = SessionLocal()
    try:
        saved_st, _ = K.load_settings(db)
    finally:
        db.close()
    configs = meta["configs"]
    plan = []
    for did in deal_ids:
        det = fetch_full_detail(did)
        if not det:
            plan.append({"deal_id": did, "number": "", "action": "skip", "reason": "Deal олдсонгүй"})
            continue
        sid = det.get("stageId") or ""
        sg = stage_map.get(sid) or {}
        cat = K.stage_category(sid, sg.get("name", ""), saved_st)
        since = (K._parse_ts(det.get("createdAt")) or datetime.now(timezone.utc)).astimezone(K.UB).date() - timedelta(days=1)
        hs = [K.parse_history(h, did) for h in K.fetch_deal_histories(did, since)]
        res = assess(category=cat, payments_data=det.get("paymentsData"), allowed=allowed, deal_amount=det.get("amount"),
                     products=det.get("products"), modified_at=det.get("modifiedAt"), hists=hs)
        old = K._j(det.get("paymentsData"))
        need_fix = not res["payments_ok"]
        new = ({} if mode == "empty" else {"other": {"amount": res["tick_sum"], "currency": "MNT"}}) if need_fix else old
        prev = next((h for h in reversed(hs) if _is_success(h)), None) or (hs[-1] if hs else None)
        item = {"deal_id": did, "number": det.get("number") or "", "name": det.get("name") or "",
                "pipeline_id": sg.get("pipelineId", ""), "stage": sg.get("name", ""), "category": cat,
                "payments_before": old, "payments_after": new, "need_fix": need_fix, "issues": res["issues"],
                "erxes_amount": res["erxes_amount"], "erkhet_before": res["erkhet_amount"],
                "prev_date": (prev or {}).get("date", ""), "sync": False, "config_stage_id": "", "config_title": "",
                "date_type": "", "reason": ""}
        needs_sync = bool({"AMOUNT_MISMATCH", "ERKHET_CASH", "LAST_SYNC_UNDEFINED", "ERKHET_NO_RESPONSE",
                           "NO_SYNC"} & set(res["issues"])) or need_fix
        if cat == "expected" and needs_sync:
            cfg, why = _pick_config(configs, item["pipeline_id"], prev)
            dt, why2 = _pick_date_type(prev, det.get("createdAt"), det.get("stageChangedDate"))
            if cfg and dt:
                item.update(sync=True, config_stage_id=cfg["stageId"], config_title=cfg["title"], date_type=dt)
            else:
                item["reason"] = why or why2
        elif cat != "expected" and needs_sync and not need_fix:
            item["reason"] = "Бэлтгэх/цуцлах шат — sync хийхгүй"
        item["action"] = ("fix_sync" if need_fix and item["sync"] else "fix_only" if need_fix
                          else "sync_only" if item["sync"] else "skip")
        if item["action"] == "skip" and not item["reason"]:
            item["reason"] = "Засах зүйлгүй"
        plan.append(item)
    return plan


def store_plan(plan: list[dict], mode: str) -> str:
    now = time.monotonic()
    for k in [k for k, v in _PLANS.items() if now - v["at"] > _PLAN_TTL]:
        _PLANS.pop(k, None)
    token = hashlib.sha256(json.dumps([plan, mode, now], default=str).encode()).hexdigest()[:24]
    _PLANS[token] = {"at": now, "plan": plan, "mode": mode}
    return token


def take_plan(token: str) -> dict | None:
    p = _PLANS.get(token)
    if not p or time.monotonic() - p["at"] > _PLAN_TTL:
        return None
    return p


def _sync_and_verify(item: dict, started: datetime) -> tuple[bool, list[str], float | None]:
    """toSyncDeals (1 deal) → шинэ түүхийг шалгана; хариугүй/timedout бол 1 удаа дахин."""
    msgs: list[str] = []
    did = item["deal_id"]
    since = started.astimezone(K.UB).date() - timedelta(days=1)

    def newest():
        hs = [h for h in K.fetch_deal_histories(did, since) if (K._parse_ts(h.get("createdAt")) or started) >= started]
        return K.parse_history(hs[-1], did) if hs else None

    h = None
    for attempt in range(2):
        try:
            K.to_sync([did], item["config_stage_id"], item["date_type"])
        except Exception as e:
            msgs.append(f"toSyncDeals алдаа: {e}"[:200])
        time.sleep(4)
        h = newest()
        bad = h is None or h["no_response"] or "timedout" in (h["resp_error"] or "").lower()
        if not bad:
            break
        msgs.append("Erkhet хариугүй — дахин sync хийв" if attempt == 0 else "Erkhet хариугүй")
    if not h or not _is_success(h):
        return False, msgs + ["Шинэ амжилттай sync олдсонгүй"], None
    det = fetch_full_detail(did)
    a = _amount_mnt(det.get("amount"))
    ok = True
    if abs(h["debt"] - a) > TOL:
        ok = False
        msgs.append(f"debtAmount {h['debt']:,.0f} ≠ deal {a:,.0f}")
    if "PAYMENT_CARD" not in h["resp_codes"]:
        ok = False
        msgs.append(f"Erkhet төлбөр {','.join(h['resp_codes']) or '—'} (PAYMENT_CARD биш)")
    if abs(K._num(h["resp_total"]) - a) > TOL:
        ok = False
        msgs.append(f"Erkhet дүн {K._num(h['resp_total']):,.0f} ≠ deal {a:,.0f}")
    if item.get("prev_date") and h["date"] != item["prev_date"]:
        ok = False
        msgs.append(f"Огноо өөрчлөгдсөн: {item['prev_date']} → {h['date']}")
    return ok, msgs, K._num(h["resp_total"])


def run_fix(run_id: int, plan: list[dict], user_name: str) -> None:
    """Баталсан dry-run-ийн гүйцэтгэл — deal НЭГ НЭГЭЭР, дараалан. Snapshot зөрвөл БҮГДИЙГ зогсооно."""
    from app.core.db import SessionLocal
    from app.models.payments_scan import PaymentsFixAction

    todo = [x for x in plan if x["action"] != "skip"]
    ids = [x["deal_id"] for x in todo]
    ok_n = err_n = 0
    aborted = ""
    try:
        for i, x in enumerate(todo):
            _set_run(run_id, progress=f"{x['number']} ({i + 1}/{len(todo)})", done_n=i)
            act = PaymentsFixAction(run_id=run_id, deal_id=x["deal_id"], number=x["number"], action=x["action"],
                                    config_stage_id=x["config_stage_id"], config_title=x["config_title"][:300],
                                    date_type=x["date_type"], erkhet_before=x["erkhet_before"], user_name=user_name)
            msgs: list[str] = []
            started = datetime.now(timezone.utc)
            try:
                before = fetch_full_detail(x["deal_id"])
                snap_b = _snapshot(before)
                act.payments_before = json.dumps(K._j(before.get("paymentsData")), ensure_ascii=False)
                act.snapshot_before = json.dumps({k: v for k, v in snap_b.items() if k != "products"}, ensure_ascii=False)
                if x["need_fix"]:
                    # Хуучин paymentsData-г засахаас ӨМНӨ audit-д бичнэ (rollback)
                    db = SessionLocal()
                    try:
                        act.result = "pending"
                        db.add(act)
                        db.commit()
                        db.refresh(act)
                    finally:
                        db.close()
                    K._gql('mutation($id: String!, $p: JSON) { dealsEdit(_id: $id, paymentsData: $p) { _id } }',
                           {"id": x["deal_id"], "p": x["payments_after"]}, tries=1)
                    after = fetch_full_detail(x["deal_id"])
                    snap_a = _snapshot(after)
                    act.payments_after = json.dumps(K._j(after.get("paymentsData")), ensure_ascii=False)
                    act.snapshot_after = json.dumps({k: v for k, v in snap_a.items() if k != "products"}, ensure_ascii=False)
                    changed = [k for k in ("rows", "products", "amount", "stageId", "name") if snap_b[k] != snap_a[k]]
                    if changed:
                        aborted = f"{x['number']}: paymentsData засахад {', '.join(changed)} өөрчлөгдсөн — БҮГДИЙГ зогсоов"
                        msgs.append(aborted)
                        act.result = "aborted"
                        raise StopIteration
                    if json.dumps(K._j(after.get("paymentsData")), sort_keys=True) != json.dumps(x["payments_after"], sort_keys=True):
                        raise RuntimeError("paymentsData хүссэн утгаа авсангүй")
                    msgs.append("paymentsData засагдсан")
                if x["sync"]:
                    ok, m, after_amt = _sync_and_verify(x, started)
                    msgs += m
                    act.erkhet_after = after_amt
                    act.result = "ok" if ok else "error"
                else:
                    act.result = "ok"
            except StopIteration:
                pass
            except Exception as e:
                msgs.append(str(e)[:300])
                act.result = "error"
            act.message = "; ".join(msgs)[:2000]
            db = SessionLocal()
            try:
                db.merge(act)
                db.commit()
            finally:
                db.close()
            ok_n += act.result == "ok"
            err_n += act.result != "ok"
            if aborted:
                break
            time.sleep(K.GAP)
        _set_run(run_id, status="aborted" if aborted else "done", progress=aborted or "Дууслаа",
                 done_n=ok_n + err_n, error=aborted,
                 summary=json.dumps({"ok": ok_n, "error": err_n, "total": len(todo), "aborted": bool(aborted)}),
                 finished_at=datetime.utcnow())
    except Exception as e:
        traceback.print_exc()
        _set_run(run_id, status="error", error=str(e)[:2000], finished_at=datetime.utcnow())
    finally:
        K.unlock_deals(ids)


# ── 30 минут тутмын автомат скан (зөвхөн мэдэгдэнэ) ──────────────────────────

_NOTIFIED: dict[str, str] = {}        # deal_id → мэдэгдсэн issue-уудын түлхүүр (давхар мэдэгдэхгүй)
_SEEDED = [False]


def _alert_keys(issues: list[str], category: str) -> list[str]:
    return sorted(c for c in issues
                  if (c in PD_ISSUES and PD_ISSUES[c][0] == "error")
                  or (category == "expected" and c in ("AMOUNT_MISMATCH", "ERKHET_NO_RESPONSE")))


def _seed_notified(db) -> None:
    """Сервер дахин асахад өмнөх автомат сканы асуудлуудыг «мэдэгдсэн» гэж үзнэ (дахин спам хийхгүй)."""
    from app.models.payments_scan import PaymentsScanItem
    _SEEDED[0] = True
    prev = (db.query(PaymentsScanRun).filter(PaymentsScanRun.kind == "auto", PaymentsScanRun.status == "done")
            .order_by(PaymentsScanRun.id.desc()).first())
    if not prev:
        return
    for x in db.query(PaymentsScanItem).filter(PaymentsScanItem.run_id == prev.id):
        k = ",".join(_alert_keys(json.loads(x.issues or "[]"), x.category))
        if k:
            _NOTIFIED[x.deal_id] = k


def run_auto_scan(notify: bool = True) -> dict:
    """Сүүлийн 2 хоногт үүссэн deal. Буруу paymentsData, expected stage-ийн AMOUNT_MISMATCH,
    ERKHET_NO_RESPONSE шинээр гарвал Telegram. Засахгүй, sync хийхгүй."""
    from app.core.db import SessionLocal
    from app.models.payments_scan import PaymentsScanRun
    today = datetime.now(K.UB).date()
    params = {"startDate": (today - timedelta(days=2)).isoformat(), "endDate": today.isoformat(),
              "dateField": "createdAt"}
    db = SessionLocal()
    try:
        # Өдөрт 48 скан — 3 хоногоос хуучин автомат сканыг (мөрүүдтэй нь) цэвэрлэнэ
        from app.models.payments_scan import PaymentsScanItem
        old = [x.id for x in db.query(PaymentsScanRun.id).filter(
            PaymentsScanRun.kind == "auto", PaymentsScanRun.created_at < datetime.utcnow() - timedelta(days=3))]
        if old:
            db.query(PaymentsScanItem).filter(PaymentsScanItem.run_id.in_(old)).delete(synchronize_session=False)
            db.query(PaymentsScanRun).filter(PaymentsScanRun.id.in_(old)).delete(synchronize_session=False)
            db.commit()
        if not _SEEDED[0]:
            _seed_notified(db)
        r = PaymentsScanRun(kind="auto", status="running", params=json.dumps(params), created_by="(автомат)")
        db.add(r)
        db.commit()
        rid = r.id
    finally:
        db.close()
    rows = run_scan(rid, params)
    alert = []
    for x in rows:
        keys = _alert_keys(x["issues"], x["category"])
        k = ",".join(keys)
        if keys and _NOTIFIED.get(x["deal_id"]) != k:
            _NOTIFIED[x["deal_id"]] = k
            alert.append((x, keys))
        elif not keys:
            _NOTIFIED.pop(x["deal_id"], None)
    if notify and alert:
        from app.core.health_monitor import send_telegram
        lines = [f"• {x['number']} {x['data'].get('customer') or x['name']}: "
                 + ", ".join(ISSUE_INFO[c][1] for c in keys)
                 + (f" (Erxes {x['erxes_amount']:,.0f}₮ / Erkhet {x['erkhet_amount']:,.0f}₮)"
                    if x["erkhet_amount"] is not None and "AMOUNT_MISMATCH" in keys else "")
                 for x, keys in alert[:15]]
        send_telegram(f"⚠️ paymentsData / Erkhet дүнгийн шалгалт: {len(alert)} шинэ асуудал\n" + "\n".join(lines)
                      + "\nSync хяналт → paymentsData табаас шалгаж засна уу (автоматаар засахгүй).")
    return {"run_id": rid, "deals": len(rows), "alerts": len(alert)}
