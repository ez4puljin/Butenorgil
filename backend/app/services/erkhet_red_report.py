"""Улайлтын тайлан — Эрхэтэд сөрөг (улайсан) үлдэгдэлтэй бараа, тохируулсан байршлаар.

Эрхэтийн «Бараа материал /Өртгөөр/» тайланг (`inventory/report/generate/`, данс 150101,
Данс → Байршил → бараа) ӨНӨӨДРИЙН огноогоор НЭГ удаа татаж «Эцсийн үлдэгдэл» < 0 мөрийг шүүнэ.
Эрхэтийн тайланд «зөвхөн сөрөг» шүүлтүүр байхгүй (generate-remainder-д ч алга, 2026-10-22).

Ачаалал (2026-10-22 хэмжсэн): 4 байршлыг НЭГ тайланд асуухад Эрхэт 321 сек боловсруулаад 500 өгсөн —
тиймээс байршил бүрийг ТУСАД НЬ, дараалан (02: 22с, 12: 15с, 11: 19с, 01: 81с).
Автоматаар татахгүй (2026-11): хэрэглэгч байршлаа сонгоод «Татах» дарахад л. Сүүлийн 5 минутад татсан
байршлыг дахин асуухгүй. Үр дүн байршил бүрээр хадгалагдана — нэг хүний татлага нөгөөгийнхийг дарахгүй.
Сүүлд сонгосон байршлууд — `app/data/red_report_settings.json`.
"""
from __future__ import annotations

import io
import json
import threading
import time
import traceback
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd

SETTINGS_FILE = Path("app/data/red_report_settings.json")
RESULT_FILE = Path("app/data/outputs/red_report.json")
DEFAULTS = {"locations": ["01", "02", "11", "12"]}
MIN_GAP = 300                    # сек — энэ хугацаанд татсан байршлыг дахин асуухгүй
REPORT_PATH = "inventory/report/generate/"

_state = {"running": False, "error": ""}
_lock = threading.Lock()


def load_settings() -> dict:
    try:
        s = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        s = {}
    return {**DEFAULTS, **{k: v for k, v in s.items() if k in DEFAULTS}}


def save_settings(s: dict) -> dict:
    cur = load_settings()
    if "locations" in s:
        cur["locations"] = sorted({str(x).strip() for x in s["locations"] if str(x).strip()})
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(cur, ensure_ascii=False, indent=1), encoding="utf-8")
    return cur


def locations() -> list[dict]:
    """Эрхэтийн байршлууд [{id, code, name}] — form option «01 - Бөөний агуулах» (id нь өөр, 05→7)."""
    from app.services.erkhet_client import get_client
    out = []
    for oid, label in get_client().form_options(REPORT_PATH).get("inv_location", []):
        code, _, name = label.partition(" - ")
        out.append({"id": oid, "code": code.strip(), "name": name.strip()})
    return out


def parse(data: bytes, locs: dict[str, str]) -> list[dict]:
    """Данс → Байршил → бараа Excel → сөрөг үлдэгдэлтэй мөрүүд. locs: {code: name}."""
    df = pd.read_excel(io.BytesIO(data), header=None, dtype=str)
    out, cur = [], ""
    for r in df.itertuples(index=False):
        code = str(r[0] if r[0] is not None else "").strip()
        if not code or code == "nan" or code in ("Код",):
            continue
        rest = [str(x) for x in r[2:10]]
        empty = all(x in ("nan", "None", "") for x in rest)
        if empty:
            if code in locs:
                cur = code
            continue
        try:
            qty = float(r[8])
        except (TypeError, ValueError):
            continue
        if qty < 0 and cur:
            def f(v):
                try:
                    x = float(v)
                    return 0.0 if x != x else x
                except (TypeError, ValueError):
                    return 0.0
            out.append({"location": cur, "location_name": locs.get(cur, cur), "code": code,
                        "name": str(r[1] or "").strip(), "qty": qty, "amount": f(r[9]), "unit_cost": f(r[10]),
                        "begin_qty": f(r[2]), "in_qty": f(r[4]), "out_qty": f(r[6])})
    out.sort(key=lambda x: (x["location"], x["qty"]))
    return out


def load_result() -> dict | None:
    try:
        return json.loads(RESULT_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def view(res: dict | None, codes) -> dict | None:
    """Хадгалсан үр дүнгээс сонгосон байршлууд. checked_at — тэдгээрийн хамгийн хуучин нь."""
    if not res:
        return None
    want = set(codes)
    locs = [x for x in res.get("locations", []) if x["code"] in want]
    errors = {k: v for k, v in (res.get("errors") or {}).items() if k in want}
    if not locs and not errors:
        return None
    items = [i for i in res.get("items", []) if i["location"] in want]
    checked = res.get("location_checked") or {}
    times = [checked[x["code"]] for x in locs if x["code"] in checked]
    return {**res, "locations": locs, "items": items, "count": len(items),
            "amount": round(sum(i["amount"] for i in items), 2),
            "by_location": {x["code"]: sum(1 for i in items if i["location"] == x["code"]) for x in locs},
            "errors": errors, "checked_at": min(times) if times else ""}


def status() -> dict:
    return {"running": _state["running"], "error": _state["error"]}


def _fresh(iso: str | None) -> bool:
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return False
    return (datetime.now(timezone.utc) - t).total_seconds() < MIN_GAP


def start(codes) -> bool:
    """Арын thread-д татна. Өөр татлага явж байвал False."""
    with _lock:
        if _state["running"]:
            return False
        _state.update(running=True, error="")
    threading.Thread(target=_run, args=(list(codes),), daemon=True, name="red-report").start()
    return True


def _run(codes: list[str]) -> dict:
    """Сонгосон байршлуудыг татаж, хадгалсан үр дүнд байршил бүрээр нэгтгэнэ."""
    try:
        from app.services.erkhet_client import get_client
        sel = [x for x in locations() if x["code"] in set(codes)]
        if not sel:
            raise RuntimeError("Байршил сонгоогүй байна")
        last = load_result() or {}
        checked = dict(last.get("location_checked") or {})
        names = {x["code"]: x["name"] for x in last.get("locations", []) if x["code"] in checked}
        items = [i for i in last.get("items", []) if i["location"] in checked]
        errors = dict(last.get("errors") or {})
        need = [x for x in sel if not _fresh(checked.get(x["code"]))]
        c = get_client()
        account = c.find_option(REPORT_PATH, "account", "150101") if need else ""
        ds = date.today().strftime("%m/%d/%Y")
        t = time.monotonic()
        failed = 0
        for i, x in enumerate(need):
            if i:
                time.sleep(3)                       # Эрхэтэд амсхийх завсар
            code = x["code"]
            items = [it for it in items if it["location"] != code]
            checked.pop(code, None)
            names.pop(code, None)
            try:
                data = c.report_excel(REPORT_PATH, {
                    "account": account, "inv_location": [x["id"]], "get_kind": "account_location",
                    "get_tr_kind": "all", "fraction": "2", "begin_date": ds, "end_date": ds}, timeout=600)
                items += parse(data, {code: x["name"]})
                checked[code] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                names[code] = x["name"]
                errors.pop(code, None)
            except Exception as e:              # нэг байршил алдвал бусдыг үргэлжлүүлнэ
                failed += 1
                errors[code] = str(e)[:200]
        if need and failed == len(sel):
            raise RuntimeError("; ".join(f"{x['code']}: {errors[x['code']]}" for x in need))
        items.sort(key=lambda it: (it["location"], it["qty"]))
        locs = [{"code": k, "name": names[k]} for k in sorted(names)]
        res = {"errors": errors, "checked_at": max(checked.values()) if checked else "", "day": date.today().isoformat(),
               "seconds": round(time.monotonic() - t, 1), "locations": locs, "location_checked": checked,
               "count": len(items), "amount": round(sum(i["amount"] for i in items), 2),
               "by_location": {x["code"]: sum(1 for i in items if i["location"] == x["code"]) for x in locs},
               "items": items}
        RESULT_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = RESULT_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
        tmp.replace(RESULT_FILE)
        return res
    except Exception as e:
        traceback.print_exc()
        _state["error"] = str(e)[:300]
        return {"error": _state["error"]}
    finally:
        _state["running"] = False
