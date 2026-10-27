"""Үнийн тохиргоо — erxes pricing plan БИЧИХ хэсэг (3-р шатнаас). ЗӨВХӨН admin-ы баталснаар дуудагдана.

Хатуу хамгаалалт (энэ модулиас өөр газраас erxes рүү plan бичихгүй):
  · Илгээх mutation нь ЗӨВХӨН `pricingPlanAdd`, `pricingPlanEdit` (`_send` дотор allowlist). Устгахгүй,
    `productsEdit` гэх мэт барааны mutation огт байхгүй.
  · Add: branchIds == {Хархорин, Хархорин агуулах}, departmentIds == {агуулах, заал}, products == [нэг бараа],
    type subtraction, value = erxes үндсэн − орлого. Хэрэглэгч 2026-10-26: fixed биш; branch+department хамт
    сонгож байж ажилладаг; заалны үнэ ч мөн адил зөрүүгээр (+1000 г.м.) өөрчлөгдөх нь зөв.
  · Edit: plan_id нь pc_managed_plans-д (ЭНЭ систем үүсгэсэн) байх ёстой; зөвхөн value/type/status/name.
  · Илгээсний дараа pricingPlanDetail + documents/print (агуулахын branch+department)-ээр бодит үнийг
    шалгана; Add-ын үнэ таарахгүй бол тэр даруй archived болгоно.
  · Бүх өөрчлөлт pc_price_audit-д (хэн, хэзээ, хуучин → шинэ, Эрхэтийн баримт №, print үнэ өмнө → дараа).

CLI (backend хавтаснаас; --apply-гүй бол юу ч илгээхгүй):
  python -m app.services.price_cost_apply create 102061 [--apply]
  python -m app.services.price_cost_apply sync <plan_id> [--apply]        — value-г үндсэн − орлогоор шинэчилнэ
  python -m app.services.price_cost_apply deactivate <plan_id> [--apply]
  python -m app.services.price_cost_apply activate <plan_id> [--apply]
  python -m app.services.price_cost_apply prices 102061                    — агуулах/заалны print үнэ
"""
from __future__ import annotations

import json
import re
import sys
import threading
import uuid
from datetime import datetime

from app.services.price_cost import (BRANCH_ID, DEPARTMENT_ID, HA_BRANCH_ID, PLAN_BRANCH_IDS, PLAN_DEPARTMENT_IDS,
                                     RETAIL_DEPARTMENT_ID)

PREFIX = "[AUTO-COST HA]"
ALLOWED = {"pricingPlanAdd", "pricingPlanEdit"}
EDIT_FIELDS = {"_id", "value", "type", "status", "name"}
LABEL_TEMPLATE = "63e0d1c289900a8db3052d6b"         # erxes «Шошго» — үнийг pricing plan-тай нь бодож гаргадаг
POINTS = {"agulah": (HA_BRANCH_ID, DEPARTMENT_ID), "zaal": (BRANCH_ID, RETAIL_DEPARTMENT_ID)}
DETAIL_FIELDS = ("_id name status type value applyType branchIds departmentIds products isPriority "
                 "categories tags productsExcluded")
_PRICE_RE = re.compile(r"Үнэ\s*:(?:\s|&nbsp;|<[^>]+>)*([\d,]+(?:\.\d+)?)")


class ApplyError(RuntimeError):
    pass


def _client():
    from app.services.erxes_client import get_client
    return get_client()


def _send(mutation: str, doc: dict) -> dict:
    if mutation not in ALLOWED:
        raise ApplyError(f"Зөвшөөрөгдөөгүй mutation: {mutation}")
    itype = "PricingPlanAddInput" if mutation == "pricingPlanAdd" else "PricingPlanEditInput"
    r = _client().gql("mutation($d:%s){ %s(doc:$d){ _id } }" % (itype, mutation), {"d": doc})
    pid = (r.get(mutation) or {}).get("_id")
    if not pid:
        raise ApplyError(f"{mutation}: erxes хариу хоосон")
    return {"_id": pid}


def detail(plan_id: str) -> dict:
    return _client().gql("query($id:String){ pricingPlanDetail(id:$id){ %s } }" % DETAIL_FIELDS,
                         {"id": plan_id}).get("pricingPlanDetail") or {}


def print_price(product_id: str, branch_id: str, department_id: str) -> float | None:
    """erxes «Шошго»-г тухайн branch+department-аар render хийж «Үнэ»-г уншина (pricing plan тооцогдсон)."""
    c = _client()
    url = ("https://erxes.bto.mn/gateway/pl:documents/print?_id=" + LABEL_TEMPLATE
           + '&productIds=[{"id":"' + product_id + '","c":1}]&copies=1&width=80'
           + f"&branchId={branch_id}&departmentId={department_id}&isDate=")
    r = c._session().get(url, verify=False, timeout=60)
    m = _PRICE_RE.search(r.text)
    return float(m.group(1).replace(",", "")) if m else None


def prices(product_id: str) -> dict:
    return {k: print_price(product_id, b, d) for k, (b, d) in POINTS.items()}


def _same_set(a, b) -> bool:
    return isinstance(a, list) and sorted(a) == sorted(b)


def _check_add_doc(doc: dict) -> None:
    ok = (_same_set(doc.get("departmentIds"), PLAN_DEPARTMENT_IDS) and _same_set(doc.get("branchIds"), PLAN_BRANCH_IDS)
          and doc.get("applyType") == "product" and isinstance(doc.get("products"), list)
          and len(doc["products"]) == 1 and doc.get("type") == "subtraction"
          and str(doc.get("name", "")).startswith(PREFIX)
          and isinstance(doc.get("value"), (int, float)) and doc["value"] != 0 and doc["value"] == round(doc["value"]))
    if not ok:
        raise ApplyError("Plan-ы хамрах хүрээ/утга буруу — илгээхгүй.")


def _audit(db, by, action, batch, plan_id, code, name, old, new, bill="", note=""):
    from app.models.price_cost import PcPriceAudit
    db.add(PcPriceAudit(by=by, action=action, batch=batch, plan_id=plan_id, code=code, name=name[:300],
                        old_value=old, new_value=new, bill_number=bill, note=note[:500]))


def target_for(db, code: str, own_value: float | None = None) -> dict:
    """Код → {product, base, income, bill, now, value}. Бусдын plan-тай нийлж үйлчилдэг тул
    value = манай одоогийн value + (агуулахын бодит print үнэ − орлого) (price_cost.plan_target)."""
    from app.services.price_cost import fetch_products, is_fractional, latest_incomes, plan_target
    p = fetch_products([code]).get(code)
    if not p or p.get("unitPrice") is None:
        raise ApplyError(f"{code}: erxes-д идэвхтэй бараа/үндсэн үнэ олдсонгүй.")
    hist = latest_incomes(db).get(code) or []
    if not hist:
        raise ApplyError(f"{code}: хүчинтэй (310104) орлого алга.")
    income = round(hist[0].total / hist[0].count, 2)
    if is_fractional(income):
        raise ApplyError(f"{code}: орлогын нэгж үнэ бутархай ({income}) — Эрхэтийн баримтыг шалгана уу.")
    now = prices(p["_id"])
    if now["agulah"] is None:
        raise ApplyError(f"{code}: агуулахын одоогийн үнийг (print) уншиж чадсангүй.")
    return {"product": p, "base": float(p["unitPrice"]), "income": income, "bill": hist[0].bill_number,
            "now": now, "value": plan_target(own_value, now["agulah"], income)}


def _note(before: dict, after: dict) -> str:
    return f"агуулах {before['agulah']}→{after['agulah']}, заал {before['zaal']}→{after['zaal']}"


def create(db, code: str, by: str, batch: str = "", apply: bool = False) -> dict:
    """Нэг бараанд [AUTO-COST HA] subtraction plan үүсгэнэ. Манай идэвхтэй plan байвал алдаа (sync ашигла)."""
    from app.models.price_cost import PcManagedPlan
    if db.query(PcManagedPlan).filter(PcManagedPlan.code == code, PcManagedPlan.status == "active").first():
        raise ApplyError(f"{code}: манай идэвхтэй plan аль хэдийн бий — sync ашиглана уу.")
    t = target_for(db, code)
    if abs(t["value"]) < 0.5:
        raise ApplyError(f"{code}: үндсэн үнэ = орлогын үнэ — plan шаардлагагүй.")
    p = t["product"]
    doc = {"name": f"{PREFIX} {code} {p['name']}"[:200], "status": "active", "type": "subtraction",
           "value": t["value"], "applyType": "product", "products": [p["_id"]], "branchIds": list(PLAN_BRANCH_IDS),
           "departmentIds": list(PLAN_DEPARTMENT_IDS), "isPriority": True}
    _check_add_doc(doc)
    before = t["now"]
    if not apply:
        return {"dry_run": True, "doc": doc, "income": t["income"], "base": t["base"], "prices_now": before}
    pid = _send("pricingPlanAdd", doc)["_id"]
    d = detail(pid)
    after = prices(p["_id"])
    bad = (not _same_set(d.get("departmentIds"), PLAN_DEPARTMENT_IDS) or not _same_set(d.get("branchIds"), PLAN_BRANCH_IDS)
           or d.get("products") != [p["_id"]] or d.get("type") != "subtraction"
           or float(d.get("value") or 0) != t["value"] or d.get("status") != "active"
           or after["agulah"] is None or abs(after["agulah"] - t["income"]) > 0.5)
    if bad:
        try:
            _send("pricingPlanEdit", {"_id": pid, "status": "archived"})
        finally:
            _audit(db, by, "rollback", batch or "-", pid, code, doc["name"], t["value"], None, t["bill"],
                   "Үүсгэсний дараах шалгалт таараагүй — архивласан. " + _note(before, after))
            db.commit()
        raise ApplyError(f"{code}: агуулахын үнэ {after['agulah']} (хүлээгдсэн {t['income']}) — plan-ыг архивлалаа ({pid}).")
    db.add(PcManagedPlan(plan_id=pid, code=code, product_id=p["_id"], value=t["value"], status="active", created_by=by))
    _audit(db, by, "create", batch or uuid.uuid4().hex[:12], pid, code, doc["name"], None, t["value"], t["bill"],
           _note(before, after))
    db.commit()
    return {"plan_id": pid, "value": t["value"], "before": before, "after": after}


def _managed(db, plan_id: str):
    from app.models.price_cost import PcManagedPlan
    m = db.get(PcManagedPlan, plan_id)
    if not m:
        raise ApplyError(f"{plan_id}: энэ систем үүсгээгүй plan — өөрчлөхгүй.")
    return m


def _edit(plan_id: str, fields: dict) -> dict:
    if set(fields) - (EDIT_FIELDS - {"_id"}):
        raise ApplyError("Зөвшөөрөгдөөгүй талбар засах гэж байна.")
    _send("pricingPlanEdit", {"_id": plan_id, **fields})
    return detail(plan_id)


def sync(db, plan_id: str, by: str, batch: str = "", apply: bool = False) -> dict:
    """Манай plan-ы value-г агуулахын бодит үнэ = орлого болохоор (type subtraction) шинэчилнэ."""
    m = _managed(db, plan_id)
    cur = detail(plan_id)
    if not _same_set(cur.get("departmentIds"), PLAN_DEPARTMENT_IDS) or not _same_set(cur.get("branchIds"), PLAN_BRANCH_IDS):
        raise ApplyError(f"{m.code}: plan-ы branch/department гараар өөрчлөгдсөн — өөрчлөхгүй, шалгана уу.")
    if cur.get("type") != "subtraction" or cur.get("status") != "active":
        raise ApplyError(f"{m.code}: plan-ы төрөл/төлөв гараар өөрчлөгдсөн ({cur.get('type')}, {cur.get('status')}) — шалгана уу.")
    t = target_for(db, m.code, own_value=float(cur.get("value") or 0))
    if t["product"]["_id"] != m.product_id:
        raise ApplyError(f"{m.code}: бараа солигдсон байна — гараар шалгана уу.")
    if t["value"] == 0:
        # Үндсэн үнэ (эсвэл бусдын plan) аль хэдийн орлоготой тэнцсэн — манай plan илүүц → архивлана.
        if not apply:
            return {"dry_run": True, "plan_id": plan_id, "code": m.code, "status": "archived",
                    "income": t["income"], "prices_now": t["now"]}
        r = set_status(db, plan_id, "archived", by, batch, note="value 0 — үндсэн үнэ орлоготой тэнцсэн.", apply=True)
        if r["after"]["agulah"] is None or abs(r["after"]["agulah"] - t["income"]) > 0.5:
            set_status(db, plan_id, "active", by, batch, note="архивласны дараа таарсангүй — сэргээв.", apply=True)
            raise ApplyError(f"{m.code}: архивласны дараа агуулах {r['after']['agulah']} ≠ орлого {t['income']} — сэргээв.")
        return {**r, "code": m.code, "archived": True}
    before = t["now"]
    res = {"plan_id": plan_id, "code": m.code, "old": {"type": cur.get("type"), "value": cur.get("value")},
           "new": {"type": "subtraction", "value": t["value"]}, "income": t["income"], "prices_now": before}
    if not apply:
        return {"dry_run": True, **res}
    d = _edit(plan_id, {"type": "subtraction", "value": t["value"]})
    after = prices(m.product_id)
    if (d.get("type") != "subtraction" or float(d.get("value") or 0) != t["value"]
            or after["agulah"] is None or abs(after["agulah"] - t["income"]) > 0.5):
        raise ApplyError(f"{m.code}: засварын дараах шалгалт таарсангүй: агуулах {after['agulah']}, {d}")
    old = cur.get("value")
    m.value, m.updated_at = t["value"], datetime.utcnow()
    _audit(db, by, "update", batch or uuid.uuid4().hex[:12], plan_id, m.code, d.get("name") or "", old, t["value"],
           t["bill"], f"{cur.get('type')}→subtraction; " + _note(before, after))
    db.commit()
    return {**res, "after": after}


def set_status(db, plan_id: str, status: str, by: str, batch: str = "", note: str = "", apply: bool = False) -> dict:
    """Манай plan-ыг archived (буцаах) эсвэл active болгоно. Устгахгүй."""
    if status not in ("archived", "active"):
        raise ApplyError("status нь archived/active.")
    m = _managed(db, plan_id)
    before = prices(m.product_id)
    if not apply:
        return {"dry_run": True, "plan_id": plan_id, "code": m.code, "status": status, "prices_now": before}
    d = _edit(plan_id, {"status": status})
    if d.get("status") != status:
        raise ApplyError(f"{m.code}: {status} болсонгүй: {d}")
    after = prices(m.product_id)
    m.status, m.updated_at = status, datetime.utcnow()
    _audit(db, by, "deactivate" if status == "archived" else "activate", batch or uuid.uuid4().hex[:12], plan_id,
           m.code, d.get("name") or "", m.value, None if status == "archived" else m.value,
           note=(note + " " if note else "") + _note(before, after))
    db.commit()
    return {"plan_id": plan_id, "status": status, "before": before, "after": after}


def deactivate(db, plan_id: str, by: str, batch: str = "", note: str = "", apply: bool = False) -> dict:
    return set_status(db, plan_id, "archived", by, batch, note, apply)


# ── багцаар батлах / буцаах (самбарын «Батлах») ─────────────────────
_batch = {"running": False, "batch": "", "done": 0, "total": 0, "results": [], "kind": ""}
_batch_lock = threading.Lock()


def batch_status() -> dict:
    return dict(_batch, results=list(_batch["results"]))


def _start(kind: str, total: int) -> str:
    with _batch_lock:
        if _batch["running"]:
            raise ApplyError("Өөр батлалт ажиллаж байна.")
        b = uuid.uuid4().hex[:12]
        _batch.update(running=True, batch=b, done=0, total=total, results=[], kind=kind)
        return b


def apply_codes(codes: list[str], by: str, max_apply: int) -> str:
    """Сонгосон кодуудад plan үүсгэх/засах — background thread, дараалан. → batch id."""
    from app.core.db import SessionLocal
    from app.models.price_cost import PcManagedPlan
    codes = list(dict.fromkeys(c.strip() for c in codes if c and c.strip()))
    if not codes:
        raise ApplyError("Бараа сонгоогүй.")
    if len(codes) > max_apply:
        raise ApplyError(f"Нэг удаад {max_apply}-аас ихгүй ({len(codes)} сонгосон).")
    b = _start("apply", len(codes))

    def go():
        db = SessionLocal()
        try:
            for code in codes:
                try:
                    m = db.query(PcManagedPlan).filter(PcManagedPlan.code == code, PcManagedPlan.status == "active").first()
                    r = sync(db, m.plan_id, by, b, apply=True) if m else create(db, code, by, b, apply=True)
                    act = ("archive" if r.get("archived") else "update") if m else "create"
                    _batch["results"].append({"code": code, "ok": True, "action": act,
                                              "after": r.get("after")})
                except Exception as e:  # noqa: BLE001 — нэг барааны алдаа бусдыг зогсоохгүй
                    db.rollback()
                    _batch["results"].append({"code": code, "ok": False, "error": str(e)[:300]})
                _batch["done"] += 1
        finally:
            db.close()
            _batch["running"] = False
    threading.Thread(target=go, daemon=True).start()
    return b


def rollback_batch(batch: str, by: str) -> str:
    """Тухайн багцын өөрчлөлтийг буцаана: үүсгэсэн plan → archived, засварласан → хуучин value,
    архивласан → active."""
    from app.core.db import SessionLocal
    from app.models.price_cost import PcPriceAudit
    db = SessionLocal()
    try:
        rows = (db.query(PcPriceAudit)
                .filter(PcPriceAudit.batch == batch, PcPriceAudit.action.in_(("create", "update", "deactivate")))
                .order_by(PcPriceAudit.id.desc()).all())
        items = [(r.action, r.plan_id, r.code, r.old_value) for r in rows]
    finally:
        db.close()
    if not items:
        raise ApplyError("Энэ багцад буцаах өөрчлөлт алга.")
    b = _start("rollback", len(items))

    def go():
        db = SessionLocal()
        try:
            for action, plan_id, code, old in items:
                try:
                    if action == "create":
                        r = set_status(db, plan_id, "archived", by, b, note=f"Багц {batch}-ийг буцаав.", apply=True)
                    elif action == "deactivate":
                        r = set_status(db, plan_id, "active", by, b, note=f"Багц {batch}-ийг буцаав.", apply=True)
                    else:
                        m = _managed(db, plan_id)
                        before = prices(m.product_id)
                        d = _edit(plan_id, {"type": "subtraction", "value": float(old)})
                        if float(d.get("value") or 0) != float(old):
                            raise ApplyError(f"{code}: хуучин утга сэргээгдсэнгүй: {d}")
                        after = prices(m.product_id)
                        cur = m.value
                        m.value, m.updated_at = float(old), datetime.utcnow()
                        _audit(db, by, "rollback", b, plan_id, code, d.get("name") or "", cur, float(old),
                               note=f"Багц {batch}-ийг буцаав. " + _note(before, after))
                        db.commit()
                        r = {"after": after}
                    _batch["results"].append({"code": code, "ok": True, "action": "rollback", "after": r.get("after")})
                except Exception as e:  # noqa: BLE001
                    db.rollback()
                    _batch["results"].append({"code": code, "ok": False, "error": str(e)[:300]})
                _batch["done"] += 1
        finally:
            db.close()
            _batch["running"] = False
    threading.Thread(target=go, daemon=True).start()
    return b


def _main(argv: list[str]) -> None:
    from app.core.db import SessionLocal
    apply = "--apply" in argv
    args = [a for a in argv if a != "--apply"]
    db = SessionLocal()
    try:
        cmd = args[0] if args else ""
        if cmd == "create":
            out = create(db, args[1], by="cli", apply=apply)
        elif cmd == "sync":
            out = sync(db, args[1], by="cli", apply=apply)
        elif cmd in ("deactivate", "activate"):
            out = set_status(db, args[1], "archived" if cmd == "deactivate" else "active", by="cli", note="CLI", apply=apply)
        elif cmd == "prices":
            from app.services.price_cost import fetch_products
            out = prices(fetch_products([args[1]])[args[1]]["_id"])
        else:
            raise SystemExit(__doc__)
        print(json.dumps(out, ensure_ascii=False, indent=1))
    finally:
        db.close()


if __name__ == "__main__":
    _main(sys.argv[1:])
