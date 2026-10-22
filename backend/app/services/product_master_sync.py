"""Барааны мастер: erxes ↔ Эрхэт идэвхтэй барааны тулгалт + Master нэгтгэлийг автоматжуулах.

Өмнө нь хүн гараар: (1) Эрхэт → «Бараа материалын жагсаалт» Excel экспорт → «Эрхэт бараа» слот,
(2) erxes → барааны экспорт → «Эрксэс бараа» слот, (3) «Мастер нэгтгэл» ажиллуулдаг байсан
(2026-10-22-нд л гэхэд 2 удаа). Одоо хоёуланг нь шууд татна:

  Эрхэт  — `transactions/trs/to-excel/?source=/{cid}/inventory/item/list/` (Excel татах товчтой ижил):
           анхдагч = ИДЭВХТЭЙ (12,893); `search_is_deleted=true` = идэвхгүй + идэвхтэй (22,399).
           Жагсаалтын Excel-д «төлөв» багана байхгүй — идэвхгүй = бүгд − идэвхтэй.
           (`is_deleted=on` гэж өгвөл үл тоомсорлоно — хуудасны JS `search_is_deleted=`-г хэрэглэдэг.)
  erxes  — GraphQL `products(status, perPage:1000, page)` (active + deleted), tag/ангиллын нэр;
           гараар экспортолсон файлтай ИЖИЛ багана, формат (master_merge ERXES багана F/B/C/L).

2026-10-22 анхны тулгалт: хоёуланд идэвхтэй 12,884 — нэр/үнэ/баркод 100% таарсан; Эрхэтэд идэвхтэй
боловч erxes-д устгагдсан 9, erxes-д идэвхтэй боловч Эрхэтэд огт байхгүй 5.
"""
from __future__ import annotations

import io
import json
import threading
import traceback
from datetime import datetime
from pathlib import Path

import pandas as pd

UPLOAD_DIR = Path("app/data/uploads")
OUTPUT_DIR = Path("app/data/outputs")
RESULT_FILE = OUTPUT_DIR / "product_compare.json"
ERKHET_FOLDER = "Эрхэт бараа"
ERXES_FOLDER = "Эрксэс бараа"
ERXES_PUBLIC = "https://erxes.bto.mn/gateway/read-file?key="
MIN_RATIO = 0.9          # шинэ жагсаалт өмнөхийнхөөс 10%-иас их багассан бол слотыг СОЛИХГҮЙ (хоосон/хэсэгчилсэн экспорт)
EXPORT_COLS = ["barcodes", "imageUrl", "tagIds", "name", "shortName", "code", "bundleId", "type",
               "barcodeDescription", "description", "unitPrice", "createdAt", "status", "uom", "currency",
               "categoryName"]

_state = {"running": False, "step": "", "error": "", "started_at": None, "finished_at": None, "kind": ""}
_lock = threading.Lock()


def _norm(s) -> str:
    s = "" if s is None else str(s)
    return "" if s.lower() == "nan" else s.strip()


# ── Эрхэт ────────────────────────────────────────────────────────────────────

def erkhet_items_xlsx(include_inactive: bool = False) -> bytes:
    from app.services.erkhet_client import get_client
    c = get_client()
    q = "search=&search_type=0&search_cat_id=&search_loc_id=&search_is_deleted=true&" if include_inactive else ""
    r = c._get(f"transactions/trs/to-excel/?{q}source=/{c.company_id}/inventory/item/list/")
    if "spreadsheet" not in (r.headers.get("content-type") or ""):
        raise RuntimeError(f"Эрхэтээс Excel ирсэнгүй ({r.status_code} {r.headers.get('content-type')})")
    return r.content


def _erkhet_df(data: bytes) -> pd.DataFrame:
    df = pd.read_excel(io.BytesIO(data), dtype=str)
    if "Код" not in df.columns:
        raise RuntimeError("Эрхэтийн барааны жагсаалтад «Код» багана алга")
    return df


# ── erxes ────────────────────────────────────────────────────────────────────

def erxes_products() -> tuple[list[dict], dict[str, str]]:
    from app.services.erxes_client import get_client
    c = get_client()
    tags = {}
    p = 1
    while True:
        rows = c.gql('query($p:Int){ tags(type:"core:product", perPage:500, page:$p){ _id name } }', {"p": p}).get("tags") or []
        tags.update({t["_id"]: t["name"] for t in rows})
        if len(rows) < 500:
            break
        p += 1
    out: list[dict] = []
    for st in ("active", "deleted"):
        p = 1
        while True:
            rows = c.gql('query($s:String,$p:Int){ products(status:$s, perPage:1000, page:$p){ _id code name shortName '
                         'type unitPrice createdAt status barcodes attachment{ url } tagIds category{ name } '
                         'barcodeDescription description bundleId } }', {"s": st, "p": p}).get("products") or []
            out += rows
            if len(rows) < 1000 or p > 100:
                break
            p += 1
    return out, tags


def erxes_export_df(rows: list[dict], tags: dict[str, str]) -> pd.DataFrame:
    """Гараар экспортолсон erxes файлтай ижил хэлбэр: '-' хоосон, tagIds = нэрс ', '-аар (төгсгөлд ', ')."""
    def dash(v):
        v = _norm(v)
        return v if v else "-"
    recs = []
    for r in rows:
        url = ((r.get("attachment") or {}).get("url") or "").strip()
        tag_names = [tags.get(t, "") for t in (r.get("tagIds") or [])]
        tag_names = [t for t in tag_names if t]
        recs.append({
            "barcodes": ", ".join(r.get("barcodes") or []) or "-",
            "imageUrl": (url if url.startswith("http") else ERXES_PUBLIC + url) if url else "-",
            "tagIds": (", ".join(tag_names) + ", ") if tag_names else "-",
            "name": dash(r.get("name")), "shortName": dash(r.get("shortName")), "code": dash(r.get("code")),
            "bundleId": dash(r.get("bundleId")), "type": dash(r.get("type")),
            "barcodeDescription": dash(r.get("barcodeDescription")), "description": dash(r.get("description")),
            "unitPrice": r.get("unitPrice") if r.get("unitPrice") is not None else "-",
            "createdAt": _norm(r.get("createdAt"))[:10] or "-", "status": dash(r.get("status")),
            "uom": "-", "currency": "-", "categoryName": dash((r.get("category") or {}).get("name")),
        })
    return pd.DataFrame(recs, columns=EXPORT_COLS)


# ── Тулгалт ──────────────────────────────────────────────────────────────────

def _barcodes(s) -> set[str]:
    return {b.strip() for b in _norm(s).replace(";", ",").split(",") if b.strip() and b.strip() != "-"}


def _num(v) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return 0.0 if f != f or f in (float("inf"), float("-inf")) else f     # NaN JSON-ийг эвдэнэ


def compare(erk_active: pd.DataFrame, erk_all: pd.DataFrame, erx_rows: list[dict]) -> dict:
    ea = {}
    for r in erk_active.to_dict("records"):
        k = _norm(r.get("Код"))
        if k:
            ea[k] = r
    eall = {_norm(x) for x in erk_all["Код"] if _norm(x)}
    xa, xdel = {}, {}
    for r in erx_rows:
        k = _norm(r.get("code"))
        if not k:
            continue
        (xa if r.get("status") == "active" else xdel)[k] = r

    def erk_row(k, r):
        return {"code": k, "name": _norm(r.get("Нэр")), "price": _num(r.get("Нэгж үнэ")),
                "category": _norm(r.get("Ангилал нэр")), "barcodes": _norm(r.get("Баркод"))}

    def erx_row(k, r):
        return {"code": k, "name": _norm(r.get("name")), "price": _num(r.get("unitPrice")),
                "category": _norm((r.get("category") or {}).get("name")), "barcodes": ", ".join(r.get("barcodes") or []),
                "created": _norm(r.get("createdAt"))[:10]}

    A, X = set(ea), set(xa)
    groups = {
        "erkhet_only": [erk_row(k, ea[k]) for k in sorted(A - X - set(xdel))],
        "erxes_deleted": [erk_row(k, ea[k]) for k in sorted((A - X) & set(xdel))],
        "erxes_only": [erx_row(k, xa[k]) for k in sorted(X - eall)],
        "erkhet_inactive": [erx_row(k, xa[k]) for k in sorted((X - A) & eall)],
        "name_diff": [], "price_diff": [], "barcode_diff": [],
    }
    for k in sorted(A & X):
        e, x = ea[k], xa[k]
        if _norm(e.get("Нэр")) != _norm(x.get("name")):
            groups["name_diff"].append({"code": k, "erkhet": _norm(e.get("Нэр")), "erxes": _norm(x.get("name"))})
        if abs(_num(e.get("Нэгж үнэ")) - _num(x.get("unitPrice"))) > 0.5:
            groups["price_diff"].append({"code": k, "name": _norm(x.get("name")), "erkhet": _num(e.get("Нэгж үнэ")),
                                         "erxes": _num(x.get("unitPrice"))})
        be, bx = _barcodes(e.get("Баркод")), set(x.get("barcodes") or [])
        if be != bx:
            groups["barcode_diff"].append({"code": k, "name": _norm(x.get("name")), "erkhet": ", ".join(sorted(be)),
                                           "erxes": ", ".join(sorted(bx))})
    counts = {k: len(v) for k, v in groups.items()}
    return {"checked_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "erkhet_active": len(A), "erkhet_inactive": len(eall - A), "erxes_active": len(X), "erxes_deleted": len(xdel),
            "both_active": len(A & X), "counts": counts, "issues": sum(counts.values()), "groups": groups}


def load_result() -> dict | None:
    try:
        return json.loads(RESULT_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _save_result(res: dict) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = RESULT_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
    tmp.replace(RESULT_FILE)


# ── Ажлууд ───────────────────────────────────────────────────────────────────

def status() -> dict:
    return dict(_state)


def _start(kind: str) -> bool:
    with _lock:
        if _state["running"]:
            return False
        _state.update(running=True, kind=kind, step="Эхэлж байна…", error="",
                      started_at=datetime.utcnow().isoformat() + "Z", finished_at=None)
        return True


def _finish(err: str = "") -> None:
    _state.update(running=False, error=err, step="" if not err else _state["step"],
                  finished_at=datetime.utcnow().isoformat() + "Z")


def _fetch_all():
    _state["step"] = "Эрхэтээс идэвхтэй барааг татаж байна…"
    act_bytes = erkhet_items_xlsx(False)
    _state["step"] = "Эрхэтээс бүх (идэвхгүй орсон) барааг татаж байна…"
    all_bytes = erkhet_items_xlsx(True)
    _state["step"] = "erxes-ээс бараа татаж байна…"
    rows, tags = erxes_products()
    return act_bytes, _erkhet_df(act_bytes), _erkhet_df(all_bytes), rows, tags


def run_compare(notify: bool = False) -> dict:
    """Зөвхөн тулгалт (слот, мастерт хүрэхгүй)."""
    if not _start("compare"):
        return {"busy": True}
    try:
        _, act, allx, rows, _ = _fetch_all()
        res = compare(act, allx, rows)
        res["source"] = "compare"
        prev = load_result()
        _save_result(res)
        if notify:
            _notify(res, prev)
        _finish()
        return res
    except Exception as e:
        traceback.print_exc()
        _finish(str(e)[:500])
        return {"error": str(e)}


def _latest(folder: str) -> Path | None:
    fs = sorted((UPLOAD_DIR / folder).glob("*.xl*"), key=lambda f: f.stat().st_mtime, reverse=True)
    return fs[0] if fs else None


def _rows_in(path: Path | None) -> int:
    if not path:
        return 0
    try:
        return len(pd.read_excel(path, usecols=[0]))
    except Exception:
        return 0


def run_master_auto(user: str = "(автомат)", notify: bool = False) -> dict:
    """Master-ын гар ажлыг орлоно: хоёр жагсаалтыг татаж слотод хадгалаад мастер нэгтгэл + тулгалт."""
    if not _start("master"):
        return {"busy": True}
    from app.core.db import SessionLocal
    from app.models.import_log import ImportLog
    try:
        act_bytes, act, allx, rows, tags = _fetch_all()
        erx_df = erxes_export_df(rows, tags)
        # Хамгаалалт: хоосон/хэсэгчилсэн экспорт слотыг солиж мастерийн өгөгдлийг арилгахаас сэргийлнэ
        prev_k, prev_x = _rows_in(_latest(ERKHET_FOLDER)), _rows_in(_latest(ERXES_FOLDER))
        if prev_k and len(act) < prev_k * MIN_RATIO:
            raise RuntimeError(f"Эрхэтийн жагсаалт {len(act)} мөр — өмнөх {prev_k}-аас хэт цөөн, слотыг солисонгүй")
        if prev_x and len(erx_df) < prev_x * MIN_RATIO:
            raise RuntimeError(f"erxes жагсаалт {len(erx_df)} мөр — өмнөх {prev_x}-аас хэт цөөн, слотыг солисонгүй")
        stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        kp = UPLOAD_DIR / ERKHET_FOLDER / f"{ERKHET_FOLDER}_{stamp}.xlsx"
        xp = UPLOAD_DIR / ERXES_FOLDER / f"{ERXES_FOLDER}_{stamp}.xlsx"
        kp.parent.mkdir(parents=True, exist_ok=True)
        xp.parent.mkdir(parents=True, exist_ok=True)
        kp.write_bytes(act_bytes)
        erx_df.to_excel(xp, index=False)

        _state["step"] = "Мастер нэгтгэл хийж байна…"
        db = SessionLocal()
        try:
            for key, path in (("erkhet_stock", kp), ("erxes_sales", xp)):
                db.add(ImportLog(import_key=key, username=user, filename=f"(автомат) {path.name}", status="ok",
                                 message="Автоматаар татсан"))
            log = ImportLog(import_key="master_merge", username=user, filename=f"(автомат) {kp.name} + {xp.name}",
                            status="ok", message="")
            db.add(log)
            db.commit()
            db.refresh(log)
            try:
                from app.scripts import master_merge as mm
                from app.services.master_refresh import refresh_products_from_master
                from app.services.custom_master import after_import as custom_after_import
                result = mm.main(str(kp), str(xp), str(OUTPUT_DIR))
                master_path = result.get("master_path") or str(OUTPUT_DIR / "master_latest.xlsx")
                refresh_products_from_master(db, master_path)
                custom_after_import(db, "product", Path(master_path), by=user)
                log.message = "done (автомат)"
                db.commit()
            except Exception as e:
                db.rollback()
                log.status, log.message = "fail", str(e)[:500]
                db.commit()
                raise
        finally:
            db.close()

        _state["step"] = "Тулгаж байна…"
        res = compare(act, allx, rows)
        res["source"] = "master"
        res["master"] = {"erkhet_file": kp.name, "erxes_file": xp.name, "erkhet_rows": len(act), "erxes_rows": len(erx_df)}
        prev = load_result()
        _save_result(res)
        if notify:
            _notify(res, prev)
        _finish()
        return res
    except Exception as e:
        traceback.print_exc()
        _finish(str(e)[:500])
        if notify:
            try:
                from app.core.health_monitor import send_telegram
                send_telegram(f"❌ Барааны мастер автомат шинэчлэл амжилтгүй: {str(e)[:300]}")
            except Exception:
                pass
        return {"error": str(e)}


_LABELS = {
    "erkhet_only": "Эрхэтэд идэвхтэй — erxes-д огт алга",
    "erxes_deleted": "Эрхэтэд идэвхтэй — erxes-д устгагдсан",
    "erxes_only": "erxes-д идэвхтэй — Эрхэтэд огт алга",
    "erkhet_inactive": "erxes-д идэвхтэй — Эрхэтэд идэвхгүй",
    "name_diff": "Нэр зөрүүтэй",
    "price_diff": "Үнэ зөрүүтэй",
    "barcode_diff": "Баркод зөрүүтэй",
}


def _notify(res: dict, prev: dict | None = None) -> None:
    """Зөрүү байгаа бөгөөд өмнөх үр дүнгээс өөрчлөгдсөн үед л (өдөрт хэд хэдэн удаа ажилладаг)."""
    if not res.get("issues"):
        return
    if prev and prev.get("counts") == res.get("counts"):
        return
    from app.core.health_monitor import send_telegram
    lines = [f"• {_LABELS[k]}: {v}" for k, v in res["counts"].items() if v]
    send_telegram("📦 Барааны мастер: erxes ↔ Эрхэт зөрүү\n" + "\n".join(lines)
                  + "\nХянах самбар → Барааны мэдээлэл-ээс дэлгэрэнгүй.")
