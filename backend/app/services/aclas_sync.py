"""Erxes барааны segment → Aclas LB1H жин (PLU) sync.

Жин зөвхөн дотоод сүлжээнд UDP 5001-ээр холбогддог тул сервер шууд хүрэхгүй. Дэлгүүрийн PC дээрх
32-бит «Aclas Agent» (aclas_agent/AclasAgent.cs, AclasSDK.dll) сервер рүү outbound холбогдож даалгавар
татаж гүйцэтгэнэ. Энэ модуль: segment-ээс бараа татах → PLU мөр → diff → даалгавар → баталгаажуулалт.

PLU файл (2026-10-21-нд жингээс татаж баталсан): tab, CRLF, эхний мөр баганын нэр, Name1 нь cp1251 байт.
Жингийн фонт орос — Ө/Ү байхгүй тул Ү→Y, ө→о г.м (mn_encode). Шошгоны тогтмол бичвэр зураг тул зөв.

Үнэ: offline POS (192.168.1.254:7000 «Бүтэн Оргил ХХК», API :4030) дээрх ЖИЖИГЛЭНГИЙН үнэ (poscProducts.unitPrice)
— хэрэглэгчийн шийдвэр 2026-10-21. erxes-ийн бүтээгдэхүүний unitPrice-аас зөрдөг (Гурвалжин будаа 4240 vs 3850).
Локал POS-д байхгүй бараа алгасагдана.

Sync-ийн дүрэм:
  • Бид зөвхөн ӨӨРСДИЙН оруулсан (managed) PLU-г удирдана — жин дээр гараар оруулсан бараа хэвээр.
  • Удирдах талбар: Name1, Price, ItemCode, UnitID, ValidDate. ValidDate (хадгалах хоног — шошго хэвлэснээс
    хойш) нь бүх sync-ийн бараанд тохиргооны «valid_days» (2026-10-21 хэрэглэгч: 90 хоног); 0 бол жин дээрх
    утгыг хөндөхгүй (шинэ бараанд 0).
  • Илгээсний дараа жингээс буцааж татаж харьцуулна; зөвхөн баталгаажсаны дараа төлөв (state) шинэчилнэ.
  • PLU upload нь UPSERT — илгээсэн файлд байхгүй бүртгэл жин дээр үлдэнэ (2026-10-21 туршсан).
    procType 3 нь файлын агуулгаас үл хамааран БҮХ PLU-г цэвэрлэдэг (2026-10-21 туршилтаар жин 2 мин
    хоосорсон). Тиймээс хуучин бүртгэлийг устгах = «цэвэрлэх → зөвхөн segment-ийн жагсаалт илгээх»
    (replace). replace_all=True (хэрэглэгч 2026-10-21: «жин дээр хуучин бүртгэлийг устгадаг байх») үед
    segment-д ороогүй БҮХ бүртгэл устна; агент илгээх амжилтгүй бол өмнөх жагсаалтыг тэр даруй буцаана.
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import threading
import time
from datetime import datetime, timedelta

DEFAULT_HEADER = ["Name1", "ID", "Label1ID", "DiscountID", "DepartmentID", "BarcodeType1", "Price", "UnitID",
                  "ValidDate", "Message1", "Message2", "PackageWeight", "PackageType", "TareValue", "ItemCode"]
NEW_ROW_DEFAULTS = {"Label1ID": b"0", "DiscountID": b"0", "DepartmentID": b"1", "BarcodeType1": b"54",
                    "UnitID": b"4", "ValidDate": b"0", "Message1": b"0", "Message2": b"0", "PackageWeight": b"0",
                    "PackageType": b"0", "TareValue": b"0"}
MANAGED = ("Name1", "Price", "ItemCode", "UnitID", "ValidDate")
PLU_AUTO_START = 800001                     # тоон биш кодтой бараанд оноох PLU дугаар
SETTINGS_DEFAULT = {"segment_ids": [], "interval_min": 15, "auto_enabled": False, "dry_run": True,
                    "label_id": 0, "default_valid_days": 90, "name_max": 26, "replace_all": True,
                    "price_pos_url": "http://192.168.1.254:4030/graphql"}
JOB_TIMEOUT_MIN = 10
MAX_ATTEMPTS = 3

_MN = str.maketrans({"Ү": "Y", "ү": "y", "Ө": "О", "ө": "о", "\t": " ", "\r": " ", "\n": " "})


def mn_encode(text: str) -> bytes:
    """Монгол кирилл → жингийн фонт (cp1251). Ө, Ү байхгүй — ойролцоо үсгээр (2026-10-21 хэвлэж шалгасан)."""
    return (text or "").translate(_MN).encode("cp1251", errors="replace")


def mn_preview(text: str) -> str:
    return mn_encode(text).decode("cp1251")


# ── PLU файл ────────────────────────────────────────────────────────────────

def parse_plu(raw: bytes | None) -> tuple[list[str], list[dict[str, bytes]]]:
    if not raw:
        return list(DEFAULT_HEADER), []
    lines = [ln for ln in raw.split(b"\r\n") if ln.strip()]
    if not lines:
        return list(DEFAULT_HEADER), []
    header = [h.decode("ascii", "replace") for h in lines[0].split(b"\t")]
    rows = []
    for ln in lines[1:]:
        cells = ln.split(b"\t")
        rows.append({h: (cells[i] if i < len(cells) else b"0") for i, h in enumerate(header)})
    return header, rows


def build_plu(header: list[str], rows: list[dict[str, bytes]]) -> bytes:
    out = [b"\t".join(h.encode() for h in header)]
    for r in rows:
        out.append(b"\t".join(r.get(h, NEW_ROW_DEFAULTS.get(h, b"0")) for h in header))
    return b"\r\n".join(out) + b"\r\n"


def _rid(r: dict[str, bytes]) -> int:
    try:
        return int(r.get("ID", b"0").decode() or 0)
    except ValueError:
        return 0


def row_view(r: dict[str, bytes]) -> dict:
    return {"plu": _rid(r), "name": r.get("Name1", b"").decode("cp1251", "replace"),
            "price": r.get("Price", b"").decode(), "code": r.get("ItemCode", b"").decode(),
            "unit": r.get("UnitID", b"").decode(), "valid": r.get("ValidDate", b"").decode()}


# ── Тохиргоо ────────────────────────────────────────────────────────────────

def get_settings(db) -> dict:
    from app.models.aclas import AclasSetting
    out = dict(SETTINGS_DEFAULT)
    for r in db.query(AclasSetting).all():
        if r.key in SETTINGS_DEFAULT:
            try:
                out[r.key] = json.loads(r.value)
            except ValueError:
                pass
    return out


def _kv(db, key: str, default=None):
    from app.models.aclas import AclasSetting
    r = db.get(AclasSetting, key)
    return r.value if r else default


def _set_kv(db, key: str, value: str, by: str = "") -> None:
    from app.models.aclas import AclasSetting
    r = db.get(AclasSetting, key)
    if r is None:
        r = AclasSetting(key=key)
        db.add(r)
    r.value, r.updated_by, r.updated_at = value, by, datetime.utcnow()


def save_settings(db, data: dict, by: str) -> dict:
    for k, v in data.items():
        if k in SETTINGS_DEFAULT:
            _set_kv(db, k, json.dumps(v, ensure_ascii=False), by)
    db.commit()
    return get_settings(db)


def new_agent_token(db, by: str) -> str:
    tok = "acl_" + secrets.token_urlsafe(32)
    _set_kv(db, "agent_token_hash", hashlib.sha256(tok.encode()).hexdigest(), by)
    db.commit()
    return tok


def check_agent_token(db, tok: str) -> bool:
    h = _kv(db, "agent_token_hash", "")
    return bool(h) and bool(tok) and secrets.compare_digest(h, hashlib.sha256(tok.encode()).hexdigest())


# ── erxes ───────────────────────────────────────────────────────────────────

def _gql(q: str, v: dict | None = None):
    from app.services.erxes_client import get_client
    last = None
    for i in range(3):
        try:
            return get_client().gql(q, v or {})
        except Exception as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise last  # type: ignore[misc]


def fetch_segments() -> list[dict]:
    return _gql('query($c: [String]!) { segments(contentTypes: $c) { _id name count } }',
                {"c": ["core:product"]}).get("segments") or []


def fetch_segment_products(seg_id: str) -> list[dict]:
    out, page = [], 1
    while True:
        rows = _gql('query($s: String, $p: Int, $pp: Int) { products(segment: $s, page: $p, perPage: $pp) '
                    '{ _id code name unitPrice uom status } }', {"s": seg_id, "p": page, "pp": 500}).get("products") or []
        out += rows
        if len(rows) < 500 or page > 100:
            return out
        page += 1


_price_cache: dict = {"url": "", "at": 0.0, "by_id": {}, "by_code": {}, "names": {}}


def local_prices(url: str) -> tuple[dict[str, float], dict[str, float]]:
    """Offline POS-ийн жижиглэнгийн үнэ {product _id: үнэ}, {код: үнэ} (60с cache). Нэвтрэлтгүй локал API."""
    import requests
    if _price_cache["url"] == url and time.time() - _price_cache["at"] < 60:
        return _price_cache["by_id"], _price_cache["by_code"]
    by_id, by_code, names, page = {}, {}, {}, 1
    while True:
        r = requests.post(url, json={"query": 'query($p: Int) { poscProducts(page: $p, perPage: 5000) { _id code name unitPrice } }',
                                     "variables": {"p": page}}, timeout=60)
        j = r.json()
        if j.get("errors"):
            raise RuntimeError(f"Локал POS: {j['errors'][0].get('message', '')[:200]}")
        rows = (j.get("data") or {}).get("poscProducts") or []
        for x in rows:
            if x.get("code") and x.get("name"):
                names[str(x["code"]).strip()] = " ".join(str(x["name"]).split())
            if x.get("unitPrice") is not None:
                by_id[x["_id"]] = float(x["unitPrice"])
                if x.get("code"):
                    by_code[str(x["code"]).strip()] = float(x["unitPrice"])
        if len(rows) < 5000 or page > 20:
            break
        page += 1
    _price_cache.update(url=url, at=time.time(), by_id=by_id, by_code=by_code, names=names)
    return by_id, by_code


def local_names(url: str) -> dict[str, str]:
    """Offline POS-ийн барааны нэр {код: нэр} (erxes-ийн нэр — Ө/Ү бүрэн)."""
    local_prices(url)
    return _price_cache["names"]


# ── Hotkey хуудас (LINK66) ──────────────────────────────────────────────────
# Жингийн hotkey товчны PLU-г LINK66 өөрийн SQLite-д (LsHotkeytbl, KeyboardTbl) хадгалдаг бөгөөд
# хуудсыг латин нэрээр хэвлэдэг. Бид ижил байрлал/хэмжээ (мм)-ээр erxes-ийн нэрээр хэвлэнэ.
LINK66_DB = r"C:\Program Files (x86)\Aclas LINK66\Database\Default.db"


def hotkey_sheet(db, scale=None) -> dict:
    import sqlite3
    path = _kv(db, "link66_db", "") or LINK66_DB
    try:
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    except Exception as e:
        raise RuntimeError(f"LINK66-ийн сан нээгдсэнгүй ({path}): {e}")
    try:
        rows = c.execute("select HotkeyID, KeyboardID, ButtonIndex, ButtonValue, PLUName, IsFunKey "
                         "from LsHotkeytbl order by HotkeyID, ButtonIndex").fetchall()
        kb = {r[0]: r for r in c.execute("select ID, Row, Col, PageWidth, PageHeight, BorderLeft, BorderTop, "
                                         "ButtonWidth, ButtonHeight, HorizontalSpace, VerticalSpace from KeyboardTbl")}
    finally:
        c.close()
    st = get_settings(db)
    try:
        names = local_names(st.get("price_pos_url") or SETTINGS_DEFAULT["price_pos_url"])
    except Exception:
        names = {}
    on_scale = {_rid(r): r for r in parse_plu(scale.state_raw)[1]} if scale is not None and scale.state_raw else None
    sheets: dict[str, dict] = {}
    for hid, kid, idx, plu, lname, fun in rows:
        k = kb.get(kid)
        if not k:
            continue
        _id, nrow, ncol, pw, ph, bl, bt, bw, bh, hs, vs = k
        per = nrow * ncol
        sh = sheets.setdefault(hid, {"hotkey": hid, "keyboard": kid, "rows": nrow, "cols": ncol, "page_w": pw,
                                     "page_h": ph, "left": bl, "top": bt, "btn_w": bw, "btn_h": bh, "hgap": hs or 0,
                                     "vgap": vs or 0, "pages": 1, "buttons": []})
        page = (idx - 1) // per
        sh["pages"] = max(sh["pages"], page + 1)
        if not plu:
            continue
        code = str(plu)
        sr = on_scale.get(int(plu)) if on_scale is not None else None
        sh["buttons"].append({"index": idx, "page": page, "row": ((idx - 1) % per) // ncol, "col": (idx - 1) % ncol,
                              "plu": int(plu), "name": names.get(code) or (sr.get("Name1", b"").decode("cp1251") if sr else "")
                              or lname or "", "link66_name": lname or "", "from_erxes": code in names,
                              "on_scale": (sr is not None) if on_scale is not None else None, "fun": bool(fun)})
    return {"sheets": list(sheets.values()), "db": path}


# ── PLU мөр бэлтгэх ба diff ─────────────────────────────────────────────────

def _assign_plu(db, products: list[dict], taken: set[int]) -> dict[str, int]:
    """Код нь ≤6 оронтой тоо бол тэр нь PLU; биш бол тогтвортой дугаар оноож хадгална."""
    from app.models.aclas import AclasPluId
    saved = {r.product_id: r.plu for r in db.query(AclasPluId).all()}
    used = set(taken) | set(saved.values())
    out = {}
    for p in products:
        code = (p.get("code") or "").strip()
        if code.isdigit() and 1 <= len(code) <= 6 and int(code) > 0:
            out[p["_id"]] = int(code)
        elif p["_id"] in saved:
            out[p["_id"]] = saved[p["_id"]]
    nxt = PLU_AUTO_START
    for p in products:
        if p["_id"] in out:
            continue
        while nxt in used or nxt in out.values():
            nxt += 1
        out[p["_id"]] = nxt
        used.add(nxt)
        db.add(AclasPluId(product_id=p["_id"], code=(p.get("code") or "")[:60], plu=nxt))
    db.commit()
    return out


def desired_rows(db, settings: dict, products: list[dict] | None = None, scale_ids: set[int] | None = None
                 ) -> tuple[dict[int, dict], list[dict]]:
    """Сонгосон segment-үүдийн бараа → {PLU: {row, product, warnings}}, skipped[]."""
    if products is None:
        merged: dict[str, dict] = {}
        for sid in settings["segment_ids"]:
            for p in fetch_segment_products(sid):
                merged.setdefault(p["_id"], p)
        products = list(merged.values())
    try:
        by_id, by_code = local_prices(settings.get("price_pos_url") or SETTINGS_DEFAULT["price_pos_url"])
    except Exception as e:
        raise RuntimeError(f"Offline POS-оос жижиглэнгийн үнэ татаж чадсангүй ({settings.get('price_pos_url')}): {e}")
    skipped, ok = [], []
    for p in products:
        price = by_id.get(p["_id"], by_code.get((p.get("code") or "").strip()))
        p = {**p, "erxes_price": p.get("unitPrice"), "unitPrice": price}
        why = ("идэвхгүй бараа" if (p.get("status") or "active") not in ("active", "")
               else "offline POS-д бараа алга (үнэгүй)" if price is None
               else "үнэ 0" if price <= 0
               else "нэргүй" if not (p.get("name") or "").strip() else "")
        if why:
            skipped.append({"code": p.get("code"), "name": p.get("name"), "reason": why})
        else:
            ok.append(p)
    plus = _assign_plu(db, ok, scale_ids or set())
    nmax = int(settings.get("name_max") or 26)
    out: dict[int, dict] = {}
    for p in sorted(ok, key=lambda x: x.get("code") or ""):
        plu = plus[p["_id"]]
        if plu in out:
            skipped.append({"code": p.get("code"), "name": p.get("name"),
                            "reason": f"PLU {plu} давхардсан ({out[plu]['product'].get('code')})"})
            continue
        warns = []
        name = " ".join((p.get("name") or "").split())
        if len(name) > nmax:
            warns.append(f"нэр {len(name)} тэмдэгт → {nmax}")
            name = name[:nmax].rstrip()
        if (p.get("uom") or "").lower() not in ("кг", "kg"):
            warns.append(f"нэгж «{p.get('uom') or '—'}» (жин кг-аар үнэлнэ)")
        code = (p.get("code") or "").strip()
        item = code if code.isdigit() else str(plu)
        if not code.isdigit():
            warns.append("код тоо биш — ItemCode = PLU")
        row = {"Name1": mn_encode(name), "ID": str(plu).encode(), "Price": str(int(round(float(p["unitPrice"])))).encode(),
               "ItemCode": item.encode(), "UnitID": b"4"}
        out[plu] = {"row": row, "product": p, "warnings": warns, "name_src": name}
    return out, skipped


def make_plan(db, scale, settings: dict | None = None, desired: tuple | None = None, state_raw: bytes | None = None
              ) -> dict:
    """Жингийн мэдэгдэж буй төлөв ↔ хүссэн мөрүүд → нэмэх/өөрчлөх/хасах + илгээх файл."""
    settings = settings or get_settings(db)
    header, cur = parse_plu(state_raw if state_raw is not None else scale.state_raw)
    cur_by = {_rid(r): r for r in cur}
    want, skipped = desired or desired_rows(db, settings, scale_ids=set(cur_by))
    managed_prev = set(json.loads(scale.managed_ids or "[]"))
    stale = set(json.loads(scale.stale_ids or "[]"))
    items, add, chg, same = [], 0, 0, 0
    final: dict[int, dict] = {}
    for plu, w in want.items():
        old = cur_by.get(plu)
        row = dict(old) if old else {h: NEW_ROW_DEFAULTS.get(h, b"0") for h in header}
        if not old:
            row["Label1ID"] = str(int(settings.get("label_id") or 0)).encode()
        vd = int(settings.get("default_valid_days") or 0)
        if vd or not old:
            row["ValidDate"] = str(vd).encode()           # бүх бараанд ижил (0 бол жин дээрхийг хадгална)
        row.update(w["row"])
        final[plu] = row
        diffs = [f for f in MANAGED if old is not None and old.get(f, b"") != row.get(f, b"")]
        st = "add" if old is None else "change" if diffs else "same"
        add += st == "add"
        chg += st == "change"
        same += st == "same"
        p = w["product"]
        items.append({"plu": plu, "code": p.get("code"), "name": p.get("name"), "name_scale": row["Name1"].decode("cp1251"),
                      "price": int(row["Price"]), "valid": int(row.get("ValidDate", b"0") or 0),
                      "erxes_price": p.get("erxes_price"), "uom": p.get("uom"),
                      "status": st, "warnings": w["warnings"],
                      "before": row_view(old) if old else None, "diffs": diffs,
                      "manual_override": old is not None and plu not in managed_prev})
    replace_all = bool(settings.get("replace_all", True))
    if replace_all:                                  # segment-д ороогүй БҮХ бүртгэл устна
        removed = sorted(i for i in cur_by if i not in want)
    else:                                            # зөвхөн өмнө нь бидний оруулсан, segment-ээс гарсан
        removed = sorted(i for i in managed_prev if i not in want and i in cur_by and i not in stale)
    keep = [r for r in cur if _rid(r) not in want and _rid(r) not in removed]
    rows = keep + [final[p] for p in sorted(final)]
    unmanaged = [row_view(r) for r in keep if _rid(r) not in managed_prev]
    return {
        "scale_id": scale.id, "state_known": bool(scale.state_raw) or state_raw is not None,
        "summary": {"desired": len(want), "add": add, "change": chg, "same": same, "remove": len(removed),
                    "skipped": len(skipped), "unmanaged": len(unmanaged), "warnings": sum(1 for i in items if i["warnings"])},
        "changed": bool(add or chg or removed),
        "items": items, "removed": [row_view(cur_by[i]) for i in removed], "skipped": skipped, "unmanaged": unmanaged,
        "upload": build_plu(header, rows), "desired_ids": sorted(want),
        # upsert хуучныг устгадаггүй тул устгах зүйл байвал агент эхлээд цэвэрлээд илгээнэ
        "replace": bool(removed),
    }


def verify(plan_rows: dict[int, dict], removed: list[int], verify_raw: bytes) -> dict:
    """Илгээсний дараа жингээс татсан файлыг хүссэнтэй харьцуулна."""
    _h, rows = parse_plu(verify_raw)
    by = {_rid(r): r for r in rows}
    bad, missing = [], []
    for plu, want in plan_rows.items():
        got = by.get(plu)
        if got is None:
            missing.append(plu)
            continue
        diff = [f for f in MANAGED if got.get(f, b"") != want.get(f, b"")]
        if diff:
            bad.append({"plu": plu, "fields": diff, "want": row_view(want), "got": row_view(got)})
    still = [i for i in removed if i in by]
    return {"ok": not bad and not missing, "checked": len(plan_rows), "mismatch": bad, "missing": missing,
            "not_removed": still, "scale_count": len(rows)}


# ── Даалгавар (агент) ───────────────────────────────────────────────────────

def b64(b: bytes | None) -> str:
    return base64.b64encode(b or b"").decode()


def unb64(s: str | None) -> bytes:
    return base64.b64decode(s or "")


def enqueue(db, scale, kind: str, payload: dict | None = None, by: str = "", plan: dict | None = None):
    from app.models.aclas import AclasJob
    act = db.query(AclasJob).filter(AclasJob.scale_id == scale.id, AclasJob.kind == kind,
                                    AclasJob.status.in_(("pending", "running"))).first()
    if act:
        return act, False
    j = AclasJob(scale_id=scale.id, kind=kind, payload=json.dumps(payload or {}), created_by=by,
                 plan=json.dumps(plan or {}, ensure_ascii=False), next_try_at=datetime.utcnow())
    db.add(j)
    db.commit()
    return j, True


def poll(db) -> dict | None:
    """Агентад дараагийн даалгавар (нэг жинд зэрэг нэг даалгавар)."""
    from app.models.aclas import AclasJob, AclasScale
    now = datetime.utcnow()
    _set_kv(db, "agent_last_seen", now.isoformat())
    # Гацсан даалгаврыг (агент унтарсан г.м) дахин дараалалд
    for j in db.query(AclasJob).filter(AclasJob.status == "running").all():
        if (j.heartbeat_at or j.started_at or now) < now - timedelta(minutes=JOB_TIMEOUT_MIN):
            _fail(db, j, "Агент хариу өгөөгүй (timeout)")
    busy = {j.scale_id for j in db.query(AclasJob).filter(AclasJob.status == "running").all()}
    for j in db.query(AclasJob).filter(AclasJob.status == "pending").order_by(AclasJob.id):
        if j.scale_id in busy or (j.next_try_at and j.next_try_at > now):
            continue
        s = db.get(AclasScale, j.scale_id)
        if not s or not s.enabled:
            j.status, j.error, j.finished_at = "error", "Жин идэвхгүй/устгагдсан", now
            continue
        j.status, j.attempts, j.started_at, j.heartbeat_at = "running", j.attempts + 1, now, now
        db.commit()
        return {"id": j.id, "kind": j.kind, "scale": {"id": s.id, "ip": s.ip, "name": s.name,
                                                      "label_index": s.label_index},
                "payload": json.loads(j.payload or "{}")}
    db.commit()
    return None


def _notify(text: str) -> None:
    try:
        from app.core.health_monitor import send_telegram
        send_telegram(text)
    except Exception:
        pass


def _fail(db, j, err: str, code: str = "") -> None:
    from app.models.aclas import AclasScale
    now = datetime.utcnow()
    j.error = (f"[{code}] " if code else "") + err[:1500]
    if j.attempts < MAX_ATTEMPTS and j.kind != "label":
        j.status, j.next_try_at = "pending", now + timedelta(minutes=2 ** j.attempts)
    else:
        j.status, j.finished_at = "error", now
        s = db.get(AclasScale, j.scale_id)
        _notify(f"⚖️ Aclas жин «{s.name if s else j.scale_id}» — {j.kind} амжилтгүй: {j.error[:300]}")
    db.commit()


def _backup(db, scale, job_id, reason, plu=None, fmt=None, mp=None):
    from app.models.aclas import AclasBackup
    if not (plu or fmt or mp):
        return
    db.add(AclasBackup(scale_id=scale.id, job_id=job_id, reason=reason, plu_raw=plu, label_index=scale.label_index,
                       label_format=fmt, label_map=mp, plu_count=len(parse_plu(plu)[1]) if plu else 0))
    # Сүүлийн 40-ийг үлдээнэ
    olds = db.query(AclasBackup).filter(AclasBackup.scale_id == scale.id).order_by(AclasBackup.id.desc()).offset(40).all()
    for o in olds:
        db.delete(o)


def agent_current(db, job, plu_raw: bytes) -> dict:
    """sync: агент жингийн одоогийн PLU-г илгээнэ → нөөцлөөд илгээх файлыг буцаана."""
    from app.models.aclas import AclasScale
    s = db.get(AclasScale, job.scale_id)
    job.heartbeat_at = datetime.utcnow()
    _backup(db, s, job.id, "sync-өмнө", plu=plu_raw)
    s.state_raw, s.state_at = plu_raw, datetime.utcnow()
    plan = make_plan(db, s, state_raw=plu_raw)
    if not plan["changed"]:
        job.status, job.finished_at = "done", datetime.utcnow()
        job.result = json.dumps({"no_change": True, "summary": plan["summary"]}, ensure_ascii=False)
        db.commit()
        return {"skip": True, "reason": "Өөрчлөлтгүй"}
    stored = {k: v for k, v in plan.items() if k not in ("upload",)}
    stored["upload_b64"] = b64(plan["upload"])
    job.plan = json.dumps(stored, ensure_ascii=False, default=str)
    db.commit()
    return {"upload_b64": stored["upload_b64"], "replace": bool(plan.get("replace"))}


def agent_finish(db, job, body: dict) -> dict:
    from app.models.aclas import AclasScale
    s = db.get(AclasScale, job.scale_id)
    now = datetime.utcnow()
    if job.status not in ("running",):
        return {"ok": False, "detail": "Даалгавар идэвхгүй"}
    if not body.get("ok"):
        if job.kind == "ping" or "холбогд" in (body.get("error") or ""):
            s.last_ping_ok, s.last_ping_at = False, now
        _fail(db, job, body.get("error") or "Алдаа", body.get("code") or "")
        return {"ok": True}
    res: dict = {"log": body.get("log") or []}
    if job.kind == "ping":
        s.last_ping_ok, s.last_ping_at, s.last_info = True, now, (body.get("info") or "")[:2000]
    elif job.kind == "backup":
        plu = unb64(body.get("plu_b64")) if body.get("plu_b64") else None
        _backup(db, s, job.id, "гараар нөөц", plu=plu, fmt=unb64(body.get("format_b64")) or None,
                mp=unb64(body.get("map_b64")) or None)
        if plu:
            s.state_raw, s.state_at = plu, now
        res["plu_count"] = len(parse_plu(plu)[1]) if plu else 0
        s.last_ping_ok, s.last_ping_at = True, now
    elif job.kind in ("sync", "restore"):
        vr = unb64(body.get("verify_b64"))
        plan = json.loads(job.plan or "{}")
        if job.kind == "sync":
            want = {_rid(r): r for r in parse_plu(unb64(plan.get("upload_b64")))[1] if _rid(r) in set(plan.get("desired_ids") or [])}
            removed = [r["plu"] for r in plan.get("removed") or []]
            v = verify(want, removed, vr)
            s.managed_ids = json.dumps(plan.get("desired_ids") or [])
            if v["not_removed"]:
                s.stale_ids = json.dumps(sorted(set(json.loads(s.stale_ids or "[]")) | set(v["not_removed"])))
            s.last_sync_at = now
            res.update(verify=v, summary=plan.get("summary"))
            if not v["ok"]:
                _notify(f"⚖️ Aclas «{s.name}»: илгээсний дараа {len(v['mismatch'])} зөрүү, {len(v['missing'])} дутуу")
        else:
            res["scale_count"] = len(parse_plu(vr)[1])
        if vr:
            s.state_raw, s.state_at = vr, now
        s.last_ping_ok, s.last_ping_at = True, now
    elif job.kind == "label":
        res["preview_b64"] = body.get("preview_b64") or ""
    job.status, job.finished_at, job.error = "done", now, ""
    job.result = json.dumps(res, ensure_ascii=False, default=str)
    db.commit()
    return {"ok": True}


# ── Автомат хуваарь ─────────────────────────────────────────────────────────

_tick_lock = threading.Lock()


def tick(force: bool = False) -> dict:
    """Хуваарьт: хугацаа болсон бол жин бүрт өөрчлөлт байвал sync даалгавар үүсгэнэ (dry_run үед үүсгэхгүй)."""
    from app.core.db import SessionLocal
    from app.models.aclas import AclasScale
    if not _tick_lock.acquire(blocking=False):
        return {"skipped": "busy"}
    db = SessionLocal()
    try:
        st = get_settings(db)
        if not force and (not st["auto_enabled"] or st["dry_run"] or not st["segment_ids"]):
            return {"skipped": "disabled"}
        last = _kv(db, "last_tick_at", "")
        if not force and last and datetime.fromisoformat(last) > datetime.utcnow() - timedelta(minutes=int(st["interval_min"] or 15)):
            return {"skipped": "not due"}
        _set_kv(db, "last_tick_at", datetime.utcnow().isoformat())
        db.commit()
        scales = db.query(AclasScale).filter(AclasScale.enabled == True).all()  # noqa: E712
        if not scales:
            return {"queued": 0}
        cur_ids = set()
        for s in scales:
            cur_ids |= {_rid(r) for r in parse_plu(s.state_raw)[1]}
        want = desired_rows(db, st, scale_ids=cur_ids)
        n = 0
        for s in scales:
            plan = make_plan(db, s, st, desired=want)
            if plan["changed"] or not s.state_raw:
                _j, created = enqueue(db, s, "sync", by="(хуваарь)",
                                      plan={"summary": plan["summary"]})
                n += created
        return {"queued": n}
    except Exception as e:
        _notify(f"⚖️ Aclas sync хуваарь алдаа: {e}"[:300])
        return {"error": str(e)}
    finally:
        db.close()
        _tick_lock.release()
