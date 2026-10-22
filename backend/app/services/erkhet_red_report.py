"""Улайлтын тайлан — Эрхэтэд сөрөг (улайсан) үлдэгдэлтэй бараа, тохируулсан байршлаар.

Эрхэтийн «Бараа материал /Өртгөөр/» тайланг (`inventory/report/generate/`, данс 150101,
Данс → Байршил → бараа) ӨНӨӨДРИЙН огноогоор НЭГ удаа татаж «Эцсийн үлдэгдэл» < 0 мөрийг шүүнэ.
Эрхэтийн тайланд «зөвхөн сөрөг» шүүлтүүр байхгүй (generate-remainder-д ч алга, 2026-10-22).

Ачаалал (2026-10-22 хэмжсэн): 4 байршлыг НЭГ тайланд асуухад Эрхэт 321 сек боловсруулаад 500 өгсөн —
тиймээс байршил бүрийг ТУСАД НЬ, дараалан (02: 22с, 12: 15с, 11: 19с, 01: 81с; нийт ~2.5 мин).
Ажлын цагаар (08–20) анхдагчаар 1 цагт нэг удаа; гараар шинэчлэхэд 5 минутын завсар.
Тохиргоо (байршлууд) — Хянах самбараас; `app/data/red_report_settings.json`.
"""
from __future__ import annotations

import io
import json
import threading
import time
import traceback
from datetime import date, datetime
from pathlib import Path

import pandas as pd

SETTINGS_FILE = Path("app/data/red_report_settings.json")
RESULT_FILE = Path("app/data/outputs/red_report.json")
DEFAULTS = {"locations": ["01", "02", "11", "12"], "interval_min": 60, "start_hour": 8, "end_hour": 20}
MIN_GAP = 300                    # сек — гараар дахин шинэчлэх завсар
REPORT_PATH = "inventory/report/generate/"

_state = {"running": False, "error": "", "last_start": 0.0}
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
    for k in ("interval_min", "start_hour", "end_hour"):
        if k in s and s[k] is not None:
            cur[k] = int(s[k])
    cur["interval_min"] = max(15, min(cur["interval_min"], 720))
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


def status() -> dict:
    return {"running": _state["running"], "error": _state["error"],
            "next_manual_in": max(0, int(MIN_GAP - (time.monotonic() - _state["last_start"])))
            if _state["last_start"] else 0}


def run(manual: bool = False) -> dict:
    with _lock:
        if _state["running"]:
            return {"busy": True}
        if manual and _state["last_start"] and time.monotonic() - _state["last_start"] < MIN_GAP:
            return {"too_soon": True, **status()}
        _state.update(running=True, error="", last_start=time.monotonic())
    try:
        from app.services.erkhet_client import get_client
        s = load_settings()
        all_locs = locations()
        sel = [x for x in all_locs if x["code"] in set(s["locations"])]
        if not sel:
            raise RuntimeError("Байршил сонгоогүй байна")
        c = get_client()
        account = c.find_option(REPORT_PATH, "account", "150101")
        ds = date.today().strftime("%m/%d/%Y")
        t = time.monotonic()
        items, errors = [], {}
        for i, x in enumerate(sel):
            if i:
                time.sleep(3)                       # Эрхэтэд амсхийх завсар
            try:
                data = c.report_excel(REPORT_PATH, {
                    "account": account, "inv_location": [x["id"]], "get_kind": "account_location",
                    "get_tr_kind": "all", "fraction": "2", "begin_date": ds, "end_date": ds}, timeout=600)
                items += parse(data, {x["code"]: x["name"]})
            except Exception as e:              # нэг байршил алдвал бусдыг үргэлжлүүлнэ
                errors[x["code"]] = str(e)[:200]
        if errors and len(errors) == len(sel):
            raise RuntimeError("; ".join(f"{k}: {v}" for k, v in errors.items()))
        items.sort(key=lambda it: (it["location"], it["qty"]))
        res = {"errors": errors, "checked_at": datetime.utcnow().isoformat(timespec="seconds") + "Z", "day": date.today().isoformat(),
               "seconds": round(time.monotonic() - t, 1), "locations": [{"code": x["code"], "name": x["name"]} for x in sel],
               "count": len(items), "amount": round(sum(i["amount"] for i in items), 2),
               "by_location": {x["code"]: sum(1 for i in items if i["location"] == x["code"]) for x in sel},
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


def due() -> bool:
    """Хуваарийн loop-д: ажлын цагаар, interval өнгөрсөн бол."""
    s = load_settings()
    now = datetime.now()
    if not (s["start_hour"] <= now.hour < s["end_hour"]):
        return False
    r = load_result()
    if not r:
        return True
    try:
        last = datetime.fromisoformat(r["checked_at"].rstrip("Z"))
    except (KeyError, ValueError):
        return True
    return (datetime.utcnow() - last).total_seconds() >= s["interval_min"] * 60
