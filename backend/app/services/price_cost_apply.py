"""Үнийн тохиргоо — erxes pricing plan БИЧИХ хэсэг (3-р шатнаас). ЗӨВХӨН admin-ы баталснаар дуудагдана.

Хатуу хамгаалалт (энэ модулиас өөр газраас erxes рүү plan бичихгүй):
  · Илгээх mutation нь ЗӨВХӨН `pricingPlanAdd`, `pricingPlanEdit` (`_send` дотор allowlist). Устгахгүй,
    `productsEdit` гэх мэт барааны mutation огт байхгүй.
  · Add: departmentIds == [Хархорин агуулах], branchIds == [Хархорин], products == [нэг бараа], type fixed.
  · Edit: plan_id нь pc_managed_plans-д (ЭНЭ систем үүсгэсэн) байх ёстой; зөвхөн value/status/name.
  · Илгээсний дараа pricingPlanDetail-ээр буцааж уншиж шалгана; Add-ын хэлтэс/бараа таарахгүй бол
    тэр даруй archived болгоно.
  · Бүх өөрчлөлт pc_price_audit-д (хэн, хэзээ, хуучин → шинэ, Эрхэтийн баримт №).

CLI (backend хавтаснаас):
  python -m app.services.price_cost_apply create 102061 [--value 20500] [--apply]
  python -m app.services.price_cost_apply deactivate <plan_id> [--apply]
--apply-гүй бол юу ч илгээхгүй (dry-run).
"""
from __future__ import annotations

import json
import sys
import uuid
from datetime import datetime

from app.services.price_cost import BRANCH_ID, DEPARTMENT_ID

PREFIX = "[AUTO-COST HA]"
ALLOWED = {"pricingPlanAdd", "pricingPlanEdit"}
EDIT_FIELDS = {"_id", "value", "status", "name"}
DETAIL_FIELDS = ("_id name status type value applyType branchIds departmentIds products isPriority "
                 "categories tags productsExcluded")


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


def _check_add_doc(doc: dict) -> None:
    ok = (doc.get("departmentIds") == [DEPARTMENT_ID] and doc.get("branchIds") == [BRANCH_ID]
          and doc.get("applyType") == "product" and isinstance(doc.get("products"), list)
          and len(doc["products"]) == 1 and doc.get("type") == "fixed"
          and str(doc.get("name", "")).startswith(PREFIX)
          and isinstance(doc.get("value"), (int, float)) and doc["value"] > 0)
    if not ok:
        raise ApplyError("Plan-ы хамрах хүрээ буруу — илгээхгүй.")


def _audit(db, by, action, batch, plan_id, code, name, old, new, bill="", note=""):
    from app.models.price_cost import PcPriceAudit
    db.add(PcPriceAudit(by=by, action=action, batch=batch, plan_id=plan_id, code=code, name=name[:300],
                        old_value=old, new_value=new, bill_number=bill, note=note[:500]))


def create(db, code: str, value: float, by: str, batch: str = "", bill: str = "", apply: bool = False) -> dict:
    """Нэг бараанд [AUTO-COST HA] plan үүсгэнэ. Аль хэдийн манай plan байвал алдаа (update ашигла)."""
    from app.models.price_cost import PcManagedPlan
    from app.services.price_cost import fetch_products
    if value != round(value):
        raise ApplyError(f"{code}: бутархай үнэ ({value}) — илгээхгүй.")
    if db.query(PcManagedPlan).filter(PcManagedPlan.code == code, PcManagedPlan.status == "active").first():
        raise ApplyError(f"{code}: манай идэвхтэй plan аль хэдийн бий — засах (update) ашиглана уу.")
    p = fetch_products([code]).get(code)
    if not p:
        raise ApplyError(f"{code}: erxes-д идэвхтэй бараа олдсонгүй.")
    doc = {"name": f"{PREFIX} {code} {p['name']}"[:200], "status": "active", "type": "fixed", "value": float(value),
           "applyType": "product", "products": [p["_id"]], "branchIds": [BRANCH_ID],
           "departmentIds": [DEPARTMENT_ID], "isPriority": True}
    _check_add_doc(doc)
    if not apply:
        return {"dry_run": True, "doc": doc}
    pid = _send("pricingPlanAdd", doc)["_id"]
    d = detail(pid)
    bad = (d.get("departmentIds") != [DEPARTMENT_ID] or d.get("branchIds") != [BRANCH_ID]
           or d.get("products") != [p["_id"]] or d.get("type") != "fixed" or float(d.get("value") or 0) != float(value)
           or d.get("status") != "active")
    if bad:
        try:
            _send("pricingPlanEdit", {"_id": pid, "status": "archived"})
        finally:
            _audit(db, by, "rollback", batch or "-", pid, code, doc["name"], value, None, bill,
                   "Үүсгэсний дараах шалгалт таараагүй — архивласан: " + json.dumps(d, ensure_ascii=False)[:300])
            db.commit()
        raise ApplyError(f"{code}: erxes-д үүссэн plan буруу байсан тул архивлалаа ({pid}).")
    db.add(PcManagedPlan(plan_id=pid, code=code, product_id=p["_id"], value=float(value), status="active", created_by=by))
    _audit(db, by, "create", batch or uuid.uuid4().hex[:12], pid, code, doc["name"], None, float(value), bill)
    db.commit()
    return {"plan_id": pid, "detail": d}


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


def update_value(db, plan_id: str, value: float, by: str, batch: str = "", bill: str = "", apply: bool = False) -> dict:
    m = _managed(db, plan_id)
    if value != round(value) or value <= 0:
        raise ApplyError(f"{m.code}: буруу үнэ ({value}).")
    if not apply:
        return {"dry_run": True, "plan_id": plan_id, "old": m.value, "new": value}
    d = _edit(plan_id, {"value": float(value)})
    if float(d.get("value") or 0) != float(value) or d.get("departmentIds") != [DEPARTMENT_ID]:
        raise ApplyError(f"{m.code}: засварын дараах шалгалт таарсангүй: {d}")
    old = m.value
    m.value, m.updated_at = float(value), datetime.utcnow()
    _audit(db, by, "update", batch or uuid.uuid4().hex[:12], plan_id, m.code, d.get("name") or "", old, float(value), bill)
    db.commit()
    return {"plan_id": plan_id, "old": old, "new": value}


def deactivate(db, plan_id: str, by: str, batch: str = "", note: str = "", apply: bool = False) -> dict:
    """Манай plan-ыг archived болгоно (устгахгүй)."""
    m = _managed(db, plan_id)
    if not apply:
        return {"dry_run": True, "plan_id": plan_id, "code": m.code}
    d = _edit(plan_id, {"status": "archived"})
    if d.get("status") != "archived":
        raise ApplyError(f"{m.code}: archived болсонгүй: {d}")
    m.status, m.updated_at = "archived", datetime.utcnow()
    _audit(db, by, "deactivate", batch or uuid.uuid4().hex[:12], plan_id, m.code, d.get("name") or "", m.value, None,
           note=note)
    db.commit()
    return {"plan_id": plan_id, "status": "archived"}


def _main(argv: list[str]) -> None:
    from app.core.db import SessionLocal
    apply = "--apply" in argv
    args = [a for a in argv if a != "--apply"]
    db = SessionLocal()
    try:
        if args[0] == "create":
            code = args[1]
            value = float(args[args.index("--value") + 1]) if "--value" in args else None
            bill = ""
            if value is None:
                from app.services.price_cost import latest_incomes
                hist = latest_incomes(db).get(code) or []
                if not hist:
                    raise ApplyError(f"{code}: хүчинтэй орлого алга.")
                value, bill = round(hist[0].total / hist[0].count, 2), hist[0].bill_number
            print(json.dumps(create(db, code, value, by="cli", bill=bill, apply=apply), ensure_ascii=False, indent=1))
        elif args[0] == "deactivate":
            print(json.dumps(deactivate(db, args[1], by="cli", note="CLI rollback", apply=apply), ensure_ascii=False))
        else:
            raise SystemExit(__doc__)
    finally:
        db.close()


if __name__ == "__main__":
    _main(sys.argv[1:])
