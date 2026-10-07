"""Ebarimt тайлан — сар бүрийн эх файлуудыг нэгтгэж харилцагч бүрээр
худалдан авалт vs Ebarimt шивэлтийг тооцно (хуучин Tailan.xlsm VBA-ийн орлуулалт).

Тооцооллын дүрэм (2026-06 сарын жинхэнэ өгөгдлөөр Tailan.xlsm-тэй 523/524 мөр
яг тулгаж баталсан; 1 зөрсөн мөр нь VBA-ийн Регистр тусгаарлагч таниагүй алдаа
байсныг энд зөв болгосон):
  • Худалдан авалт  = Файл оруулалтын орлогын файл (Оргил — үндсэн, Хархорин — салбарын) дахь
                      нийлүүлэгчийн тухайн сарын орлогын нийлбэр (Кодоор) — app/services/income_index.
                      2026-10-06-аас Ebarimt цэсэнд orgil/harhorin.xls (өглөгийн тайлан, "Гүйлгээ
                      Кредит") оруулахаа больсон; хуучин файл нь орлогын файлгүй сард л ашиглагдана.
  • Ebarimt шивэлт  = EBARIMT/EBARIMT2.xlsx-ийн "Нийт дүн" нийлбэр
                      (Харилцагчийн ТТД = Data-ийн Регистр; олон регистрийг
                       ';' ',' '.' зай зэргээр тусгаарлаж болно)
  • Ажилтан         = Data.xlsx-ийн "Нөат" багана — ажилтан бүр өөрийн
                      харилцагчдаа шүүж хардаг

Endpoint-ууд:
  POST   /ebarimt/import            — multipart (year, month, kind=data|ebarimt|ebarimt2, file)
  GET    /ebarimt/slots             — ?year&month → файлын төрлүүдийн төлөв
  GET    /ebarimt/download          — ?year&month&kind → түүхий файл татах
  DELETE /ebarimt/{year}/{month}/{kind}
  GET    /ebarimt/report            — ?year&month → нэгтгэсэн тайлан (mtime cache)
  GET    /ebarimt/months            — ?year → сар бүрт оруулсан файлын төрлүүд
  GET    /ebarimt/report-range      — ?year&months=1,2,3 → сонгосон сарууд/бүтэн оны нэгтгэл
  GET    /ebarimt/entries           — ?year&months&code&which=orgil|harhorin → харилцагчийн шивсэн
                                      Ebarimt (НӨАТ) баримтууд — тайлан дээрх Ebarimt дүнгийн задаргаа
  GET    /ebarimt/purchases         — ?year&months&code&which → ХА-ийн задаргаа: орлогын файлын баримтууд
                                      (дүн, бараа мөрүүд) — app/services/income_index
  PUT    /ebarimt/exempt            — НӨАТ чөлөөлөгдөх дүн (он, сар, харилцагч, салбар)
  PUT    /ebarimt/employee          — сонгосон харилцагчдын тухайн сарын ажилтныг нэг дор солих (админ)
  GET/POST/DELETE /ebarimt/employees — Data-д бүртгэлгүй, гараар нэмсэн ажилтнууд (нэмэх/устгах — админ)
  PUT    /ebarimt/receipt-link      — бүртгэлгүй регистрийн баримт(ууд)-ыг харилцагчид холбох / салгах

Тайлангийн хариунд: unregistered — Data-д бүртгэлгүй регистрээр шивсэн Ebarimt (ТТД, нэр, дүн);
мөр бүрийн hist — ажилтан/ХА/Ebarimt утгын өөрчлөлтийн түүх (ebarimt_history, mouse-оор харуулна).

Зөрүү = Худалдан авалт − Манайд шивсэн НӨАТ (Ebarimt) − НӨАТ чөлөөлөгдөх дүн.
"""
from __future__ import annotations

import itertools
import os
import re
import shutil
import threading
from collections import defaultdict
from typing import Optional
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_role
from app.core.audit import audit
from app.models.user import User
from app.models.ebarimt_file import (
    EbarimtFile, EbarimtNote, EbarimtCustomerOverride, EbarimtExempt, EbarimtEmployeeAssign,
    EbarimtEmployee, EbarimtHistory, EbarimtReceiptLink, EBARIMT_KINDS,
)


router = APIRouter(prefix="/ebarimt", tags=["ebarimt"])

UPLOAD_DIR = Path("app/data/uploads/ebarimt")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Ebarimt цэсэнд оруулдаг файлууд. orgil/harhorin (өглөгийн тайлан) — хуучин, оруулахаа больсон:
# ХА нь Файл оруулалтын орлогын файлаас бодогдоно (хуучин файлыг орлогын файлгүй сард л ашиглана).
UPLOAD_KINDS = ("data", "ebarimt", "ebarimt2")
BRANCHES = ("orgil", "harhorin")


# ── Helpers ──────────────────────────────────────────────────────────────────

def _norm_code(v) -> str:
    """Код/ТТД-г харьцуулах хэлбэрт: '50474.0'→'50474', '011'→'11'."""
    s = str(v).strip()
    if s.endswith(".0"):
        s = s[:-2]
    try:
        return str(int(s))
    except (ValueError, TypeError):
        return s


def _split_registry(v) -> list[str]:
    """Регистр талбарыг задлах — '5338131;8457751', '2020505 .8464448',
    '5222125, 2613921' гэх мэт олон янзын тусгаарлагчийг бүгдийг таньдаг."""
    s = "" if v is None else str(v).strip()
    if not s or s.lower() in ("nan", "none"):
        return []
    return [_norm_code(p) for p in re.split(r"[;,／/\\.\s]+", s) if p.strip()]


def _read_excel(path: Path, **kw):
    """Өргөтгөлөөс хамаарч зөв engine-ээр уншина (.xls → xlrd)."""
    import pandas as pd
    name = str(path).lower()
    order = ["xlrd", "openpyxl"] if name.endswith(".xls") else ["openpyxl", "xlrd"]
    last = None
    for eng in order:
        try:
            return pd.read_excel(path, engine=eng, **kw)
        except Exception as e:
            last = e
    raise last  # type: ignore[misc]


def _safe_row_count(path: Path) -> int:
    try:
        df = _read_excel(path, header=None, dtype=str)
        return int(len(df))
    except Exception:
        return 0


# ── Parsers (Tailan.xlsm-тэй тулгаж баталсан) ────────────────────────────────

def _parse_data(path: Path) -> list[dict]:
    """Data.xlsx → харилцагчийн жагсаалт (эхний 7 багана, дарааллаар)."""
    import pandas as pd
    df = _read_excel(path, header=0).iloc[:, :7]
    df.columns = ["code", "name", "registry", "phone", "achilt", "emp", "tailbar"]
    out = []
    for r in df.itertuples():
        if pd.isna(r.code) or str(r.code).strip() == "":
            continue
        def clean(v):
            s = "" if v is None else str(v).strip()
            return "" if s.lower() in ("nan", "none") else s
        out.append({
            "code":     _norm_code(r.code),
            "name":     clean(r.name),
            "registry": clean(r.registry),
            "regs":     _split_registry(r.registry),
            "phone":    _norm_code(r.phone) if clean(r.phone) else "",
            "emp":      clean(r.emp),
            "tailbar":  clean(r.tailbar),
        })
    return out


def _parse_purchases(path: Path) -> tuple[dict[str, float], dict[str, str]]:
    """orgil/harhorin.xls → ({Код: Гүйлгээ Кредит}, {Код: Нэр}).

    Header мөрийг автоматаар олно. Эхний дата мөр нь дансны нийт дүнгийн мөр
    (310101 'Байгууллагад өгөх өглөг' / 310104) тул ХАСНА — тэр нь харилцагч биш."""
    import pandas as pd
    raw = _read_excel(path, header=None)
    start = 2  # анхдагч: 'Код' header + 'Дебет/Кредит' мөрийн дараа
    for i in range(min(6, len(raw))):
        if str(raw.iloc[i, 0]).strip() == "Код":
            start = i + 2
            break
    amounts: dict[str, float] = {}
    names: dict[str, str] = {}
    first_data = True
    for i in range(start, len(raw)):
        code = raw.iloc[i, 0]
        if pd.isna(code):
            continue
        if first_data:
            # Дансны нийт дүнгийн мөр — алгасна
            first_data = False
            continue
        try:
            v = raw.iloc[i, 5]  # Гүйлгээ Кредит
            c = _norm_code(code)
            amounts[c] = float(v) if pd.notna(v) else 0.0
            nm = raw.iloc[i, 1]
            names[c] = "" if pd.isna(nm) else str(nm).strip()
        except Exception:
            continue
    return amounts, names


def _parse_ebarimt(path: Path) -> tuple[dict[str, float], dict[str, int]]:
    """EBARIMT/EBARIMT2.xlsx → ({ТТД: Нийт дүн нийлбэр}, {ТТД: баримтын тоо})."""
    import pandas as pd
    df = _read_excel(path, header=0)
    ttd_col, amt_col = None, None
    for c in df.columns:
        s = str(c)
        if "ТТД" in s:
            ttd_col = c
        elif "Нийт дүн" in s:
            amt_col = c
    if ttd_col is None or amt_col is None:
        # fallback: EBARIMT форматын байрлал (ТТД=5-р, Нийт дүн=8-р багана)
        cols = list(df.columns)
        ttd_col = ttd_col or (cols[4] if len(cols) > 4 else cols[-1])
        amt_col = amt_col or (cols[7] if len(cols) > 7 else cols[-1])
    sums: dict[str, float] = {}
    counts: dict[str, int] = {}
    for r in df.itertuples(index=False):
        row = dict(zip(df.columns, r))
        ttd = _norm_code(row.get(ttd_col))
        if not ttd or ttd.lower() == "nan":
            continue
        try:
            amt = float(row.get(amt_col) or 0)
        except (ValueError, TypeError):
            amt = 0.0
        sums[ttd] = sums.get(ttd, 0.0) + amt
        counts[ttd] = counts.get(ttd, 0) + 1
    return sums, counts


_entries_cache: dict[str, tuple[float, list[str], list[dict]]] = {}


def _cell(v):
    """Excel-ийн утгыг JSON-д: NaN→None, огноо→YYYY-MM-DD, numpy→python."""
    import pandas as pd
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(v, (pd.Timestamp, datetime)):
        return v.strftime("%Y-%m-%d")
    if hasattr(v, "item"):
        return v.item()
    return v


def _ebarimt_entries(path: Path) -> tuple[list[str], list[dict]]:
    """EBARIMT/EBARIMT2.xlsx → (баганууд, мөр бүр {_ttd, …файлын баганууд}). mtime cache."""
    key, mtime = str(path), path.stat().st_mtime
    hit = _entries_cache.get(key)
    if hit and hit[0] == mtime:
        return hit[1], hit[2]
    df = _read_excel(path, header=0)
    cols = [str(c) for c in df.columns]
    ttd_col = next((c for c in df.columns if "ТТД" in str(c)), None)
    if ttd_col is None:                                       # _parse_ebarimt-тэй ижил fallback
        ttd_col = df.columns[4] if len(df.columns) > 4 else df.columns[-1]
    rows = []
    for rec in df.to_dict("records"):
        ttd = _norm_code(rec.get(ttd_col))
        if not ttd or ttd.lower() == "nan":
            continue
        rows.append({"_ttd": ttd, **{str(k): _cell(v) for k, v in rec.items()}})
    with _report_lock:
        _entries_cache[key] = (mtime, cols, rows)
    return cols, rows


def _receipt_cols(cols: list[str]) -> dict:
    """Ebarimt файлын баганууд: ДДТД, Падаан №, Нийт дүн, Огноо, Харилцагчийн нэр."""
    return {"ddtd": next((c for c in cols if "ДДТД" in c), None),
            "padaan": next((c for c in cols if "Падаан" in c), None),
            "amt": next((c for c in cols if "Нийт дүн" in c), cols[7] if len(cols) > 7 else None),
            "date": next((c for c in cols if "Огноо" in c), None),
            "name": next((c for c in cols if "нэр" in c.lower()), None)}


def _rkey(rec: dict, rc: dict) -> str:
    """Баримтын тогтвортой түлхүүр — ДДТД (давхардаагүй дугаар); байхгүй бол Падаан №|огноо|ТТД|дүн."""
    d = str(rec.get(rc["ddtd"]) or "").strip() if rc["ddtd"] else ""
    if d and d.lower() != "nan":
        return d[:80]
    return f"P{rec.get(rc['padaan'])}|{rec.get(rc['date'])}|{rec['_ttd']}|{rec.get(rc['amt'])}"[:80]


def _num0(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


_rindex_cache: dict[str, tuple[float, dict]] = {}


def _receipt_index(path: Path) -> dict[str, dict]:
    """Ebarimt файлын баримтууд → {түлхүүр: {ttd, amt, padaan, date, name}} (mtime cache)."""
    key, mtime = str(path), path.stat().st_mtime
    hit = _rindex_cache.get(key)
    if hit and hit[0] == mtime:
        return hit[1]
    cols, recs = _ebarimt_entries(path)
    rc = _receipt_cols(cols)
    idx = {}
    for rec in recs:
        idx[_rkey(rec, rc)] = {"ttd": rec["_ttd"], "amt": _num0(rec.get(rc["amt"])) if rc["amt"] else 0.0,
                               "padaan": rec.get(rc["padaan"]) if rc["padaan"] else "",
                               "date": rec.get(rc["date"]) if rc["date"] else "",
                               "name": str(rec.get(rc["name"]) or "").strip() if rc["name"] else ""}
    _rindex_cache[key] = (mtime, idx)
    return idx


def _link_state(db: Session, year: int, month: int, payload: dict) -> dict:
    """Тухайн сарын баримтын холбоосууд → adj: регистрээр тулгах map-аас холбосон баримтыг хассан,
    extra: харилцагч бүрт нэмэх дүн/тоо, resolved: холбоосуудын жагсаалт (файлд алга бол stale)."""
    st: dict = {"active": False, "adj": None, "extra": {}, "resolved": []}
    if payload.get("error"):
        return st
    links = db.query(EbarimtReceiptLink).filter(EbarimtReceiptLink.year == year,
                                                EbarimtReceiptLink.month == month).all()
    if not links:
        return st
    maps = payload.get("maps") or {}
    adj = {k: dict(maps.get(k) or {}) for k in ("v1", "c1", "v2", "c2")}
    paths = _stored_paths(db, year, month)
    idx = {w: (_receipt_index(paths[k]) if paths.get(k) is not None else {})
           for w, k in (("orgil", "ebarimt"), ("harhorin", "ebarimt2"))}
    for L in links:
        rec = idx.get(L.which, {}).get(L.rkey)
        item = {"month": month, "which": L.which, "rkey": L.rkey, "ttd": L.ttd or "", "code": L.code,
                "amount": float(L.amount or 0), "padaan": "", "date": "", "name": "", "stale": rec is None,
                "by": L.created_by_name or "", "at": L.created_at.isoformat() if L.created_at else None}
        if rec is not None:
            vk, ck = ("v1", "c1") if L.which == "orgil" else ("v2", "c2")
            adj[vk][rec["ttd"]] = adj[vk].get(rec["ttd"], 0.0) - rec["amt"]
            adj[ck][rec["ttd"]] = adj[ck].get(rec["ttd"], 0) - 1
            ex = st["extra"].setdefault(L.code, {"orgil": [0.0, 0], "harhorin": [0.0, 0]})
            ex[L.which][0] += rec["amt"]
            ex[L.which][1] += 1
            item.update({"ttd": rec["ttd"], "amount": rec["amt"], "padaan": rec["padaan"], "date": rec["date"],
                         "name": rec["name"]})
        st["resolved"].append(item)
    st.update(active=True, adj=adj)
    return st


# ── Report computation (mtime cache) ─────────────────────────────────────────

_report_cache: dict[tuple[int, int], dict] = {}
_report_lock = threading.Lock()
_parse_memo: dict[tuple[str, str], tuple[float, object]] = {}
_payload_ver = itertools.count(1)          # payload дахин бодогдох бүрт шинэ дугаар (түүхийн gate)


def _memo(fn, path: Path):
    """Файлын parse-ийг (функц, зам, mtime)-аар санана — орлогын файл өөрчлөгдөж тайлан дахин
    бодогдоход Data/Ebarimt-ийг (pandas, хэдэн секунд) дахин уншихгүй."""
    key, mtime = (fn.__name__, str(path)), path.stat().st_mtime
    hit = _parse_memo.get(key)
    if hit and hit[0] == mtime:
        return hit[1]
    val = fn(path)
    _parse_memo[key] = (mtime, val)
    return val


def _stored_paths(db: Session, year: int, month: int) -> dict[str, Path | None]:
    rows = db.query(EbarimtFile).filter(
        EbarimtFile.year == year, EbarimtFile.month == month,
    ).all()
    out: dict[str, Path | None] = {k: None for k in EBARIMT_KINDS}
    for r in rows:
        if r.kind in out and r.stored_filename:
            p = UPLOAD_DIR / r.stored_filename
            out[r.kind] = p if p.exists() else None
    return out


# Data.xlsx-д байхгүй ч худалдан авалттай харилцагчдын "ажилтан" шошго
ORPHAN_EMP = "Data-д байхгүй"
EMPTY_EMP = "(хоосон)"


def _vat_for(regs: list[str], vmap: dict[str, float], cmap: dict[str, int]) -> tuple[float, int]:
    return float(sum(vmap.get(t, 0.0) for t in regs)), int(sum(cmap.get(t, 0) for t in regs))


def _purchase_source(db: Session, paths: dict[str, Path | None], year: int, month: int,
                     branch: str) -> tuple[dict[str, float], dict[str, str], dict]:
    """ХА-ийн эх сурвалж: Файл оруулалтын орлогын файл → (тэр сард байхгүй бол) хуучин өглөгийн
    тайлан (orgil/harhorin.xls) → хоосон. Буцаах: ({код: ХА}, {код: нэр}, UI-д харуулах мэдээлэл)."""
    from app.services import income_index
    s = income_index.month_summary(db, branch, year, month)
    if s is not None:
        return s["amounts"], s["names"], {
            "source": "income", **{k: s[k] for k in ("files", "docs", "lines", "total", "date_from", "date_to")}}
    legacy = paths.get(branch)
    if legacy is not None:
        amounts, names = _memo(_parse_purchases, legacy)
        return amounts, names, {"source": "legacy", "total": round(sum(amounts.values()), 2)}
    return {}, {}, {"source": "none"}


def _compute_report(paths: dict[str, Path | None],
                    purchases: dict[str, tuple[dict[str, float], dict[str, str]]]) -> dict:
    if paths.get("data") is None:
        return {"rows": [], "employees": [], "maps": None,
                "error": "Data файл (харилцагчийн мэдээлэл) оруулаагүй байна."}

    customers = _memo(_parse_data, paths["data"])  # type: ignore[arg-type]
    o_map, o_names = purchases["orgil"]
    h_map, h_names = purchases["harhorin"]
    v1, c1 = _memo(_parse_ebarimt, paths["ebarimt"]) if paths.get("ebarimt") else ({}, {})
    v2, c2 = _memo(_parse_ebarimt, paths["ebarimt2"]) if paths.get("ebarimt2") else ({}, {})

    def mk_row(code, name, registry, regs, phone, tailbar, emp, is_orphan=False):
        po = float(o_map.get(code, 0.0))
        ph = float(h_map.get(code, 0.0))
        vo, no = _vat_for(regs, v1, c1)
        vh, nh = _vat_for(regs, v2, c2)
        return {
            "employee":          emp,
            "code":              code,
            "name":              name,
            "registry":          registry,
            "phone":             phone,
            "tailbar":           tailbar,
            "is_orphan":         is_orphan,
            "purchase_orgil":    po,
            "vat_orgil":         vo,
            "diff_orgil":        po - vo,
            "cnt_orgil":         no,
            "purchase_harhorin": ph,
            "vat_harhorin":      vh,
            "diff_harhorin":     ph - vh,
            "cnt_harhorin":      nh,
        }

    rows = [
        mk_row(c["code"], c["name"], c["registry"], c["regs"],
               c["phone"], c["tailbar"], c["emp"] or EMPTY_EMP)
        for c in customers
    ]

    # ── Data-д байхгүй ч худалдан авалттай харилцагчид ───────────────
    known = {c["code"] for c in customers}
    orphan_codes = {
        k for k, v in list(o_map.items()) + list(h_map.items())
        if k not in known and abs(v) > 0.5
    }
    for code in sorted(orphan_codes):
        name = o_names.get(code) or h_names.get(code) or ""
        rows.append(mk_row(code, name, "", [], "", "", ORPHAN_EMP, is_orphan=True))

    return {
        "rows": rows,
        # Регистрийн гар засвар үед Ebarimt дүнг дахин тооцоолоход хэрэгтэй
        "maps": {"v1": v1, "c1": c1, "v2": v2, "c2": c2},
        "error": None,
    }


def _build_employees(rows: list[dict]) -> list[dict]:
    """Ажилтан бүрийн харилцагчийн тоо. Data-д байхгүй бүлэг үргэлж сүүлд. Нэгтгэсэн тайланд
    (emp_months) харилцагч аль нэг сард тэр ажилтанд хуваарилагдсан бол тоологдоно."""
    counts: dict[str, int] = {}
    for r in rows:
        names = {x["name"] for x in r["emp_months"]} if r.get("emp_months") else {r["employee"]}
        for n in names:
            counts[n] = counts.get(n, 0) + 1
    return [
        {"name": k, "customers": v}
        for k, v in sorted(
            counts.items(),
            key=lambda x: (x[0] == ORPHAN_EMP, x[0] == EMPTY_EMP, -x[1], x[0]),
        )
    ]


def get_report(db: Session, year: int, month: int) -> dict:
    """Тайланг mtime cache-тэйгээр буцаана — Ebarimt цэсний файлууд болон тухайн оны орлогын
    файлууд өөрчлөгдөөгүй бол дахин бодохгүй (агшин зуур)."""
    from app.services import income_index
    paths = _stored_paths(db, year, month)
    sig = tuple(
        (k, str(p), p.stat().st_mtime if p else 0)
        for k, p in sorted(paths.items(), key=lambda x: x[0])
    ) + (income_index.signature(db, year),)
    key = (year, month)
    with _report_lock:
        cached = _report_cache.get(key)
        if cached and cached["sig"] == sig:
            return cached["payload"]
        purchases, sources = {}, {}
        for b in BRANCHES:
            amounts, names, info = _purchase_source(db, paths, year, month, b)
            purchases[b], sources[b] = (amounts, names), info
        payload = _compute_report(paths, purchases)
        payload["purchase_source"] = sources
        payload["missing"] = ([k for k in UPLOAD_KINDS if paths.get(k) is None]
                              + [f"income_{b}" for b in BRANCHES if sources[b]["source"] == "none"])
        payload["_ver"] = next(_payload_ver)
        _report_cache[key] = {"sig": sig, "payload": payload}
        return payload


def warm_ebarimt_reports() -> None:
    """main-ийн warm loop-оос — энэ болон өмнөх оны оруулсан сар бүрийн тайлан, баримтын задаргааг
    cache-д бэлдэнэ (нэгтгэсэн тайлан, НӨАТ задаргаа анх нээхэд хүлээхгүй). Өөрчлөгдөөгүй бол агшин зуур."""
    from app.core.db import SessionLocal
    from app.services import income_index
    income_index.warm()                                           # ХА задаргаа — орлогын файлууд
    db = SessionLocal()
    try:
        this_year = datetime.now().year
        yms = sorted({(r.year, r.month) for r in db.query(EbarimtFile.year, EbarimtFile.month).distinct()
                      if r.year >= this_year - 1})
        for y, m in yms:
            payload, rows = month_rows(db, y, m)
            record_history(db, y, m, payload, rows)                # файл шинэчлэгдсэн бол өөрчлөлтийг бичнэ
            for kind in ("ebarimt", "ebarimt2"):
                p = _stored_paths(db, y, m).get(kind)
                if p is not None:
                    _ebarimt_entries(p)
    finally:
        db.close()


# ── Endpoints ────────────────────────────────────────────────────────────────

def _validate_ym(year: int, month: int):
    if not (2000 <= year <= 2100) or not (1 <= month <= 12):
        raise HTTPException(400, "Он/сар буруу.")


@router.post("/import")
def import_file(
    request: Request,
    year: int = Form(...),
    month: int = Form(...),
    kind: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Файлыг шалгуургүйгээр хэвээр нь хадгална. (жил, сар, төрөл)-д өмнө нь
    файл байсан бол солино."""
    _validate_ym(year, month)
    if kind in BRANCHES:
        raise HTTPException(400, "Худалдан авалтыг Файл оруулалт → Орлогын файлаас автоматаар бодно — "
                                 "энд оруулах шаардлагагүй.")
    if kind not in UPLOAD_KINDS:
        raise HTTPException(400, f"kind нь {list(UPLOAD_KINDS)}-ийн нэг байх ёстой.")

    orig_name = (file.filename or "upload").replace("\\", "_").replace("/", "_")
    ext = os.path.splitext(orig_name)[1] or ".xlsx"
    stored_name = f"{year}-{month:02d}_{kind}{ext}"
    saved_path = UPLOAD_DIR / stored_name

    prev = db.query(EbarimtFile).filter(
        EbarimtFile.year == year, EbarimtFile.month == month, EbarimtFile.kind == kind,
    ).first()
    if prev and prev.stored_filename and prev.stored_filename != stored_name:
        try:
            (UPLOAD_DIR / prev.stored_filename).unlink(missing_ok=True)
        except Exception:
            pass

    try:
        with open(saved_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    finally:
        try:
            file.file.close()
        except Exception:
            pass

    size_bytes = saved_path.stat().st_size if saved_path.exists() else 0
    row_count = _safe_row_count(saved_path)
    now = datetime.utcnow()

    if prev:
        prev.original_filename = orig_name
        prev.stored_filename = stored_name
        prev.size_bytes = size_bytes
        prev.row_count = row_count
        prev.uploaded_by_id = int(getattr(u, "id", 0) or 0)
        prev.uploaded_by_name = str(getattr(u, "username", "") or "")
        prev.uploaded_at = now
    else:
        db.add(EbarimtFile(
            year=year, month=month, kind=kind,
            original_filename=orig_name, stored_filename=stored_name,
            size_bytes=size_bytes, row_count=row_count,
            uploaded_by_id=int(getattr(u, "id", 0) or 0),
            uploaded_by_name=str(getattr(u, "username", "") or ""),
            uploaded_at=now,
        ))
    db.commit()

    audit(
        db, request, u,
        action="ebarimt_file_import",
        entity_type="ebarimt_file",
        extra={"year": year, "month": month, "kind": kind,
               "filename": orig_name, "size_bytes": size_bytes, "row_count": row_count},
        autocommit=True,
    )

    return {"ok": True, "year": year, "month": month, "kind": kind,
            "filename": orig_name, "size_bytes": size_bytes, "row_count": row_count}


def _file_info(r: EbarimtFile) -> dict:
    return {
        "filename": r.original_filename,
        "size_bytes": r.size_bytes or 0,
        "row_count": r.row_count or 0,
        "uploaded_at": (r.uploaded_at.isoformat() if r.uploaded_at else None),
        "uploaded_by": r.uploaded_by_name or "",
    }


@router.get("/slots")
def list_slots(
    year: int = Query(...),
    month: int = Query(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """5 төрлийн төлөв — UI-ийн upload слотуудад."""
    _validate_ym(year, month)
    rows = db.query(EbarimtFile).filter(
        EbarimtFile.year == year, EbarimtFile.month == month,
    ).all()
    out: dict[str, dict | None] = {k: None for k in EBARIMT_KINDS}
    for r in rows:
        if r.kind in out:
            out[r.kind] = _file_info(r)
    return out


@router.get("/download")
def download_file(
    year: int = Query(...),
    month: int = Query(...),
    kind: str = Query(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    _validate_ym(year, month)
    if kind not in EBARIMT_KINDS:
        raise HTTPException(400, "kind буруу.")
    r = db.query(EbarimtFile).filter(
        EbarimtFile.year == year, EbarimtFile.month == month, EbarimtFile.kind == kind,
    ).first()
    if not r or not r.stored_filename:
        raise HTTPException(404, "Файл олдсонгүй.")
    path = UPLOAD_DIR / r.stored_filename
    if not path.exists():
        raise HTTPException(404, "Хадгалсан файл байхгүй байна.")
    return FileResponse(
        path=str(path),
        filename=r.original_filename or r.stored_filename,
        media_type="application/octet-stream",
    )


@router.delete("/{year}/{month}/{kind}")
def delete_slot(
    year: int,
    month: int,
    kind: str,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    _validate_ym(year, month)
    if kind not in EBARIMT_KINDS:
        raise HTTPException(400, "kind буруу.")
    r = db.query(EbarimtFile).filter(
        EbarimtFile.year == year, EbarimtFile.month == month, EbarimtFile.kind == kind,
    ).first()
    if not r:
        return {"ok": True, "removed": 0}
    if r.stored_filename:
        try:
            (UPLOAD_DIR / r.stored_filename).unlink(missing_ok=True)
        except Exception:
            pass
    db.delete(r)
    db.commit()
    audit(
        db, request, u,
        action="ebarimt_file_delete",
        entity_type="ebarimt_file",
        extra={"year": year, "month": month, "kind": kind},
        autocommit=True,
    )
    return {"ok": True, "removed": 1}


def month_rows(db: Session, year: int, month: int) -> tuple[dict, list[dict]]:
    """Сарын тайлан (cache) + тэмдэглэл, харилцагчийн гар засвар (overlay) → (payload, мөрүүд)."""
    payload = get_report(db, year, month)
    maps = payload.get("maps") or {}

    # Тэмдэглэл + гар засварыг cache-ээс ГАДУУР overlay хийнэ
    # (эдгээр өөрчлөгдөхөд файлын cache хүчинтэй хэвээр байдаг тул)
    notes = {
        n.code: n.note
        for n in db.query(EbarimtNote).filter(
            EbarimtNote.year == year, EbarimtNote.month == month,
        ).all()
        if (n.note or "").strip()
    }
    ovr = {o.code: o for o in db.query(EbarimtCustomerOverride).all()}
    exempts = {x.code: x for x in db.query(EbarimtExempt).filter(
        EbarimtExempt.year == year, EbarimtExempt.month == month).all()}
    assigns = {a.code: a for a in db.query(EbarimtEmployeeAssign).filter(
        EbarimtEmployeeAssign.year == year, EbarimtEmployeeAssign.month == month).all()}
    # Бүртгэлгүй регистрийн баримтыг харилцагчид холбосон бол Ebarimt-ийг бүх мөрөнд дахин тооцоолно
    ls = _link_state(db, year, month, payload)
    vmap = ls["adj"] if ls["active"] else maps

    out_rows = []
    for r in payload["rows"]:
        row = {**r, "note": notes.get(r["code"], ""), "defaults": {}, "link_orgil": 0.0, "link_harhorin": 0.0}
        o = ovr.get(r["code"])
        if o is not None:
            for fld, attr in (("employee", "employee"), ("registry", "registry"),
                              ("phone", "phone"), ("tailbar", "tailbar")):
                val = getattr(o, attr, None)
                if val is None:
                    continue                      # засвар байхгүй
                if val == row[fld]:
                    continue                      # утга ижил — санамж харуулах шаардлагагүй
                row["defaults"][fld] = row[fld]   # анхны (Data) утгыг санамжид
                row[fld] = val
            # Ажилтан хоосон болговол шошгыг сэргээнэ
            if not (row["employee"] or "").strip():
                row["employee"] = ORPHAN_EMP if r.get("is_orphan") else EMPTY_EMP
        # Регистр өөрчлөгдсөн эсвэл баримт холбоос байвал Ebarimt дүнг дахин тооцоолно
        if "registry" in row["defaults"] or ls["active"]:
            regs = _split_registry(row["registry"])
            vo, no = _vat_for(regs, vmap.get("v1", {}), vmap.get("c1", {}))
            vh, nh = _vat_for(regs, vmap.get("v2", {}), vmap.get("c2", {}))
            ex = ls["extra"].get(r["code"])
            if ex:
                vo, no = vo + ex["orgil"][0], no + ex["orgil"][1]
                vh, nh = vh + ex["harhorin"][0], nh + ex["harhorin"][1]
                row["link_orgil"], row["link_harhorin"] = ex["orgil"][0], ex["harhorin"][0]
            row.update({"vat_orgil": vo, "cnt_orgil": no, "vat_harhorin": vh, "cnt_harhorin": nh})
        # Сарын ажилтны хуваарь (админ) — Data/гар засвараас давамгайлна; defaults-д үндсэн утга
        a = assigns.get(r["code"])
        if a is not None and a.employee:
            row["emp_pinned"] = True                  # энэ сард гараар тогтоосон — Data шинэчлэгдсэн ч хэвээр
            if a.employee != row["employee"]:
                row["defaults"]["employee"] = row["employee"]
                row["employee"] = a.employee
                row["emp_assigned"] = True
        x = exempts.get(r["code"])
        row["exempt_orgil"] = float(x.orgil or 0) if x else 0.0
        row["exempt_harhorin"] = float(x.harhorin or 0) if x else 0.0
        row["diff_orgil"] = row["purchase_orgil"] - row["vat_orgil"] - row["exempt_orgil"]
        row["diff_harhorin"] = row["purchase_harhorin"] - row["vat_harhorin"] - row["exempt_harhorin"]
        out_rows.append(row)
    return payload, out_rows


# ── Өөрчлөлтийн түүх (ebarimt_history) ─────────────────────────────────────────────────────

HIST_FIELDS = ("emp", "po", "ph", "vo", "vh")
_DATA_KINDS = ("init", "file", "legacy", "edit", "link", "unlink")
_hist_lock = threading.RLock()
_hist_sig: dict[tuple[int, int], tuple] = {}


def _efile_meta(r: EbarimtFile | None) -> dict:
    if r is None:
        return {"file": "", "key": "none", "at": None, "by": ""}
    at = r.uploaded_at
    return {"file": r.original_filename or r.stored_filename, "at": at, "by": r.uploaded_by_name or "",
            "key": f"{r.stored_filename}|{at.isoformat() if at else ''}"}


def _field_files(db: Session, year: int, month: int, payload: dict) -> dict[str, dict]:
    """Талбар бүрийн эх файл (нэр, хувилбарын түлхүүр, оруулсан цаг, хэн) — өөрчлөлтийн шалтгаанд."""
    files = {r.kind: r for r in db.query(EbarimtFile).filter(
        EbarimtFile.year == year, EbarimtFile.month == month).all()}
    out = {"emp": _efile_meta(files.get("data")), "vo": _efile_meta(files.get("ebarimt")),
           "vh": _efile_meta(files.get("ebarimt2"))}
    for b, f in (("orgil", "po"), ("harhorin", "ph")):
        src = (payload.get("purchase_source") or {}).get(b) or {}
        if src.get("source") == "income":
            fl = src.get("files") or []
            last = max(fl, key=lambda x: x.get("uploaded_at") or "") if fl else {}
            at = last.get("uploaded_at")
            out[f] = {"file": ", ".join(x["filename"] for x in fl), "key": "|".join(x.get("key", "") for x in fl),
                      "at": datetime.fromisoformat(at) if at else None, "by": last.get("uploaded_by", "")}
        elif src.get("source") == "legacy":
            out[f] = _efile_meta(files.get(b))
        else:
            out[f] = {"file": "", "key": "none", "at": None, "by": ""}
    return out


def _hist_values(rows: list[dict]) -> dict[str, dict]:
    """Код бүрийн одоогийн утга. Ажилтан — гар хуваарилалтаас өмнөх (Data) утга; Data-д давхардсан
    кодын ажилтнуудыг « / »-аар нэгтгэнэ."""
    vals: dict[str, dict] = {}
    for r in rows:
        emp = r["defaults"].get("employee", r["employee"]) if r.get("emp_assigned") else r["employee"]
        v = vals.get(r["code"])
        if v is None:
            vals[r["code"]] = {"emp": emp, "po": r["purchase_orgil"], "ph": r["purchase_harhorin"],
                               "vo": r["vat_orgil"], "vh": r["vat_harhorin"]}
        elif emp not in v["emp"].split(" / "):
            v["emp"] = " / ".join(sorted(v["emp"].split(" / ") + [emp]))
    return vals


def record_history(db: Session, year: int, month: int, payload: dict, rows: list[dict],
                   edit_kind: str = "edit", edit_file: str = "", edit_by: str = "",
                   edit_at: datetime | None = None) -> None:
    """Тайлангийн одоогийн утгыг түүхийн сүүлийн утгатай харьцуулж, өөрчлөгдсөнийг бичнэ.
    Шалтгаан: тухайн талбарын эх файл солигдсон бол «file», үгүй бол «edit». Анх удаа — «init»
    (ХА орлогын файлаас бол өмнө нь хуучин өглөгийн тайлангийн утгыг «legacy»-гаар). Тайлан эсвэл
    регистрийн засвар өөрчлөгдөөгүй бол юу ч хийхгүй (gate)."""
    if payload.get("error"):
        return
    cnt, last_upd = db.query(func.count(EbarimtCustomerOverride.id),
                             func.max(EbarimtCustomerOverride.updated_at)).one()
    lcnt, lmax = db.query(func.count(EbarimtReceiptLink.id), func.max(EbarimtReceiptLink.created_at)).filter(
        EbarimtReceiptLink.year == year, EbarimtReceiptLink.month == month).one()
    sig = (payload.get("_ver"), cnt, last_upd, lcnt, lmax)
    with _hist_lock:
        if _hist_sig.get((year, month)) == sig:
            return
        meta = _field_files(db, year, month, payload)
        last: dict[tuple[str, str], EbarimtHistory] = {}
        for h in db.query(EbarimtHistory).filter(EbarimtHistory.year == year, EbarimtHistory.month == month,
                                                  EbarimtHistory.kind.in_(_DATA_KINDS)).order_by(EbarimtHistory.id):
            last[(h.code, h.field)] = h
        first = not last
        vals = _hist_values(rows)
        new: list[EbarimtHistory] = []

        def add(code, f, val, kind, m):
            h = EbarimtHistory(year=year, month=month, code=code, field=f, kind=kind,
                               text=val if f == "emp" else None, num=None if f == "emp" else float(val),
                               file=(m["file"] or "")[:300], file_key=(m["key"] or "")[:300], at=m["at"],
                               by_name=(m["by"] or "")[:120])
            new.append(h)
            last[(code, f)] = h

        if first:
            # ХА орлогын файл руу шилжихээс өмнөх хуучин өглөгийн тайлангийн утга
            paths = _stored_paths(db, year, month)
            for b, f in (("orgil", "po"), ("harhorin", "ph")):
                if payload["purchase_source"][b]["source"] == "income" and paths.get(b) is not None:
                    amounts, _ = _memo(_parse_purchases, paths[b])
                    lm = _efile_meta(db.query(EbarimtFile).filter(EbarimtFile.year == year, EbarimtFile.month == month,
                                                                 EbarimtFile.kind == b).first())
                    for code, v in vals.items():
                        lv = float(amounts.get(code, 0.0))
                        if abs(lv) > 0.5 or abs(v[f]) > 0.5:
                            add(code, f, lv, "legacy", lm)
        for code, v in vals.items():
            for f in HIST_FIELDS:
                cur, prev, m = v[f], last.get((code, f)), meta[f]
                if prev is None:                      # 0 ч гэсэн бичнэ — дараа нь 0 → дүн болсныг харуулахад
                    add(code, f, cur, "init", m)
                    continue
                changed = (cur != (prev.text or "")) if f == "emp" else abs(cur - (prev.num or 0.0)) > 0.5
                if changed:
                    if prev.file_key != m["key"]:
                        add(code, f, cur, "file", m)
                        continue
                    # Файл солигдоогүй — гар засвар (регистр) эсвэл баримт холбоос; хэн/хэзээ
                    o = None
                    if edit_kind == "edit" and not edit_by:
                        o = db.query(EbarimtCustomerOverride).filter(EbarimtCustomerOverride.code == code).first()
                    add(code, f, cur, edit_kind, {
                        "file": edit_file or m["file"], "key": m["key"],
                        "at": edit_at or (o.updated_at if o else None) or datetime.utcnow(),
                        "by": edit_by or (o.updated_by_name if o else "") or ""})
        if first:
            # Түүх эхлэхээс өмнө гараар сольсон ажилтнууд
            for a in db.query(EbarimtEmployeeAssign).filter(EbarimtEmployeeAssign.year == year,
                                                            EbarimtEmployeeAssign.month == month).all():
                if a.code in vals:
                    new.append(EbarimtHistory(year=year, month=month, code=a.code, field="emp", kind="manual",
                                              text=a.employee, at=a.updated_at, by_name=a.updated_by_name or ""))
        if new:
            db.add_all(new)
            db.commit()
        _hist_sig[(year, month)] = sig


def _attach_history(db: Session, year: int, month: int, rows: list[dict]) -> None:
    """Өөрчлөлттэй (2+ бичлэг) талбаруудын түүхийг мөрөнд row["hist"] болгон хавсаргана."""
    ev: dict[tuple[str, str], list] = defaultdict(list)
    for h in db.query(EbarimtHistory).filter(EbarimtHistory.year == year, EbarimtHistory.month == month
                                             ).order_by(EbarimtHistory.id):
        ev[(h.code, h.field)].append(h)
    for r in rows:
        hist = {}
        for f in HIST_FIELDS:
            lst = ev.get((r["code"], f))
            if lst and len(lst) > 1:
                hist[f] = [{"v": h.text if f == "emp" else h.num, "k": h.kind, "f": h.file,
                            "at": h.at.isoformat() if h.at else None, "by": h.by_name} for h in lst]
        if hist:
            r["hist"] = hist


def _receipt_links(db: Session, year: int, month: int, payload: dict, rows: list[dict]) -> list[dict]:
    """Тухайн сард харилцагчид холбосон бүртгэлгүй регистрийн баримтууд (харилцагчийн нэртэй)."""
    names = {r["code"]: r["name"] for r in rows}
    out = _link_state(db, year, month, payload)["resolved"]
    for x in out:
        x["cname"] = names.get(x["code"], "")
    return sorted(out, key=lambda x: (str(x["date"]), x["ttd"]))


def _name_col(cols: list[str]) -> str | None:
    return next((c for c in cols if "нэр" in c.lower()), None)


def _unregistered(db: Session, year: int, month: int, payload: dict, rows: list[dict]) -> list[dict]:
    """Data файлын (гар засвартай) аль ч харилцагчийн регистрт байхгүй ТТД-ээр шивсэн Ebarimt —
    тайланд тулгагдаагүй дүн. Нэрийг Ebarimt файлын «Харилцагчийн нэр»-ээс."""
    ls = _link_state(db, year, month, payload)
    maps = ls["adj"] if ls["active"] else (payload.get("maps") or {})
    regs: set[str] = set()
    for r in rows:
        regs |= set(_split_registry(r.get("registry")))
    names: dict[str, str] = {}
    paths = _stored_paths(db, year, month)
    for kind in ("ebarimt", "ebarimt2"):
        if paths.get(kind) is not None:
            cols, recs = _ebarimt_entries(paths[kind])
            nc = _name_col(cols)
            for rec in recs:
                if rec["_ttd"] not in regs and rec["_ttd"] not in names and nc:
                    names[rec["_ttd"]] = str(rec.get(nc) or "").strip()
    out: dict[str, dict] = {}
    for vk, ck, w in (("v1", "c1", "orgil"), ("v2", "c2", "harhorin")):
        for t, v in (maps.get(vk) or {}).items():
            if t in regs or (int((maps.get(ck) or {}).get(t, 0)) <= 0 and abs(v) < 0.5):
                continue                                               # бүртгэлтэй / бүх баримтыг холбосон
            x = out.setdefault(t, {"ttd": t, "name": names.get(t, ""), "vat_orgil": 0.0, "cnt_orgil": 0,
                                   "vat_harhorin": 0.0, "cnt_harhorin": 0})
            x[f"vat_{w}"] += float(v)
            x[f"cnt_{w}"] += int((maps.get(ck) or {}).get(t, 0))
    return sorted(out.values(), key=lambda x: -(x["vat_orgil"] + x["vat_harhorin"]))


@router.get("/report")
def report(
    year: int = Query(...),
    month: int = Query(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Нэгтгэсэн тайлан: харилцагч бүрээр худалдан авалт vs Ebarimt шивэлт,
    хариуцсан ажилтнаар шүүх боломжтой. Файлууд өөрчлөгдөөгүй бол cache-ээс."""
    _validate_ym(year, month)
    payload, out_rows = month_rows(db, year, month)
    record_history(db, year, month, payload, out_rows)
    _attach_history(db, year, month, out_rows)

    rows = db.query(EbarimtFile).filter(
        EbarimtFile.year == year, EbarimtFile.month == month,
    ).all()
    files: dict[str, dict | None] = {k: None for k in EBARIMT_KINDS}
    for r in rows:
        if r.kind in files:
            files[r.kind] = _file_info(r)
    return {
        **{k: v for k, v in payload.items() if k != "maps" and not k.startswith("_")},
        "rows": out_rows,
        "employees": _build_employees(out_rows),
        "unregistered": [] if payload.get("error") else _unregistered(db, year, month, payload, out_rows),
        "receipt_links": [] if payload.get("error") else _receipt_links(db, year, month, payload, out_rows),
        "files": files, "year": year, "month": month,
    }


def _parse_months(months: str) -> list[int]:
    try:
        ms = sorted({int(x) for x in (months or "").replace(" ", "").split(",") if x})
    except ValueError:
        raise HTTPException(400, "Сарын жагсаалт буруу.")
    if any(not 1 <= m <= 12 for m in ms):
        raise HTTPException(400, "Сар 1–12 байх ёстой.")
    return ms


@router.get("/months")
def uploaded_months(
    year: int = Query(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Тухайн онд сар бүр ямар файл оруулсан — нэгтгэсэн тайлангийн сар сонголтод.
    kinds — Ebarimt цэсэнд оруулсан файлууд; purchase — салбар бүрийн ХА-ийн эх сурвалж
    (income = орлогын файл, legacy = хуучин өглөгийн тайлан, None = байхгүй)."""
    from app.services import income_index
    _validate_ym(year, 1)
    kinds: dict[int, list[str]] = {}
    for r in db.query(EbarimtFile).filter(EbarimtFile.year == year).all():
        if r.stored_filename and (UPLOAD_DIR / r.stored_filename).exists():
            kinds.setdefault(r.month, []).append(r.kind)
    out = []
    for m, ks in sorted(kinds.items()):
        purchase = {b: ("income" if income_index.covers(db, b, year, m) else "legacy" if b in ks else None)
                    for b in BRANCHES}
        up = sorted(k for k in ks if k in UPLOAD_KINDS)
        out.append({"month": m, "kinds": up, "purchase": purchase,
                    "complete": set(up) >= set(UPLOAD_KINDS) and all(v == "income" for v in purchase.values())})
    return out


_SUM_FIELDS = ("purchase_orgil", "vat_orgil", "cnt_orgil", "exempt_orgil", "link_orgil",
               "purchase_harhorin", "vat_harhorin", "cnt_harhorin", "exempt_harhorin", "link_harhorin")


@router.get("/report-range")
def report_range(
    year: int = Query(...),
    months: str = Query("", description="1,2,3 — хоосон бол тухайн оны Data-тай бүх сар"),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Сонгосон сарууд (эсвэл бүтэн он)-ын нэгтгэсэн тайлан: сар бүрийн тайланг (гар засвартай)
    харилцагчийн кодоор нэмнэ. Харилцагчийн мэдээлэл — хамгийн сүүлийн сарынх; тэмдэглэлүүд
    сараар; by_month — сар бүрийн {po, vo, eo, ph, vh, eh} (ХА, Ebarimt, чөлөөлөгдөх × салбар)."""
    _validate_ym(year, 1)
    ms = _parse_months(months) or [x["month"] for x in uploaded_months(year=year, db=db, u=u) if "data" in x["kinds"]]
    agg: dict[str, dict] = {}
    unreg: dict[str, dict] = {}
    links: list[dict] = []
    used, skipped, missing = [], [], {}
    for m in ms:
        payload, rows = month_rows(db, year, m)
        if payload.get("error"):
            skipped.append(m)
            continue
        used.append(m)
        record_history(db, year, m, payload, rows)
        _attach_history(db, year, m, rows)
        links += _receipt_links(db, year, m, payload, rows)
        for x in _unregistered(db, year, m, payload, rows):
            t = unreg.setdefault(x["ttd"], {"ttd": x["ttd"], "name": "", "vat_orgil": 0.0, "cnt_orgil": 0,
                                            "vat_harhorin": 0.0, "cnt_harhorin": 0, "months": {}})
            t["name"] = x["name"] or t["name"]
            for f in ("vat_orgil", "cnt_orgil", "vat_harhorin", "cnt_harhorin"):
                t[f] += x[f]
            t["months"][m] = {"vo": x["vat_orgil"], "vh": x["vat_harhorin"]}
        if payload.get("missing"):
            missing[m] = payload["missing"]
        for r in rows:
            a = agg.get(r["code"])
            if a is None:
                a = agg[r["code"]] = {**r, **{f: 0 for f in _SUM_FIELDS}, "notes": [], "by_month": {}, "_emp": {},
                                      "hist_m": {}}
                a.pop("hist", None)
            else:                                              # сүүлийн сарын мэдээлэл давамгайлна
                a.update({k: r[k] for k in ("employee", "name", "registry", "phone", "tailbar", "defaults", "is_orphan")})
            for f in _SUM_FIELDS:
                a[f] += r[f]
            if (r.get("note") or "").strip():
                a["notes"].append(f"{m}-р сар: {r['note'].strip()}")
            a["by_month"][m] = {"po": r["purchase_orgil"], "vo": r["vat_orgil"], "eo": r["exempt_orgil"],
                                "ph": r["purchase_harhorin"], "vh": r["vat_harhorin"], "eh": r["exempt_harhorin"]}
            a["_emp"].setdefault(r["employee"], []).append(m)
            for f, evs in (r.get("hist") or {}).items():               # сар бүрийн өөрчлөлтийн түүх
                a["hist_m"].setdefault(f, {})[m] = evs
    out = []
    for a in agg.values():
        a["diff_orgil"] = a["purchase_orgil"] - a["vat_orgil"] - a["exempt_orgil"]
        a["diff_harhorin"] = a["purchase_harhorin"] - a["vat_harhorin"] - a["exempt_harhorin"]
        a["note"] = "; ".join(a.pop("notes"))
        # Харилцагч аль ажилтанд хэдэн сар хуваарилагдсан — олон сартайг эхэнд
        a["emp_months"] = sorted(({"name": k, "months": sorted(set(v))} for k, v in a.pop("_emp").items()),
                                 key=lambda x: (-len(x["months"]), -max(x["months"])))
        out.append(a)
    return {
        "rows": out, "employees": _build_employees(out), "year": year, "months": used,
        "unregistered": sorted(unreg.values(), key=lambda x: -(x["vat_orgil"] + x["vat_harhorin"])),
        "receipt_links": links,
        "skipped": skipped, "missing": missing,
        "error": None if used else "Сонгосон саруудад Data файл (харилцагчийн мэдээлэл) оруулаагүй байна.",
    }


@router.get("/entries")
def ebarimt_entries(
    year: int = Query(...),
    months: str = Query(..., description="1 эсвэл 1,2,3"),
    code: str = Query("", max_length=30),
    which: str = Query("orgil", pattern="^(orgil|harhorin)$"),
    ttd: str = Query("", max_length=40),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Тайлан дээрх Ebarimt (НӨАТ) дүнгийн задаргаа — тухайн харилцагчийн регистр(үүд)-ээр
    Оргил/Хархорин руу шивсэн баримтууд (EBARIMT/EBARIMT2 файлын мөрүүд), сар бүрээр.
    ttd өгвөл харилцагчгүйгээр тэр регистрээр (Data-д бүртгэлгүй регистрийн жагсаалтаас)."""
    if not code.strip() and not ttd.strip():
        raise HTTPException(400, "code эсвэл ttd өгнө үү.")
    _validate_ym(year, 1)
    ms = _parse_months(months)
    if not ms:
        raise HTTPException(400, "Сар сонгоно уу.")
    kind = "ebarimt" if which == "orgil" else "ebarimt2"
    columns: list[str] = []
    out, registries, no_file = [], set(), []
    for m in ms:
        if ttd.strip():
            regs = {_norm_code(ttd.strip())}
        else:
            _payload, rows = month_rows(db, year, m)
            row = next((r for r in rows if r["code"] == code.strip()), None)
            if row is None:
                continue
            regs = set(_split_registry(row.get("registry")))
        registries |= regs
        path = _stored_paths(db, year, m).get(kind)
        if path is None:
            no_file.append(m)
            continue
        links = {L.rkey: L for L in db.query(EbarimtReceiptLink).filter(
            EbarimtReceiptLink.year == year, EbarimtReceiptLink.month == m, EbarimtReceiptLink.which == which).all()}
        mine = bool(code.strip()) and any(L.code == code.strip() for L in links.values())
        if not regs and not mine:
            continue
        cols, recs = _ebarimt_entries(path)
        rc = _receipt_cols(cols)
        names = {r["code"]: r["name"] for r in get_report(db, year, m).get("rows", [])} if links else {}
        columns += [c for c in cols if c not in columns]
        for rec in recs:
            rk = _rkey(rec, rc)
            L = links.get(rk)
            if code.strip():                       # харилцагчийн задаргаа
                if L is not None and L.code != code.strip():
                    continue                       # өөр харилцагчид холбосон
                if L is None and rec["_ttd"] not in regs:
                    continue
            elif rec["_ttd"] not in regs:
                continue
            item = {"month": m, "_rkey": rk, "_ttd": rec["_ttd"], **{k: v for k, v in rec.items() if k != "_ttd"}}
            if L is not None:
                item["_link"] = {"code": L.code, "name": names.get(L.code, ""), "by": L.created_by_name or "",
                                 "at": L.created_at.isoformat() if L.created_at else None}
            out.append(item)
    return {"code": code.strip(), "which": which, "year": year, "months": ms, "columns": columns,
            "registries": sorted(registries), "no_file": no_file, "rows": out}


@router.get("/purchases")
def purchase_documents(
    year: int = Query(...),
    months: str = Query(..., description="1 эсвэл 1,2,3"),
    code: str = Query(..., max_length=30),
    which: str = Query("orgil", pattern="^(orgil|harhorin)$"),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """ХА (худалдан авалт)-ын задаргаа: Файл оруулалтын орлогын файлаас тухайн нийлүүлэгчийн баримтууд
    (дүн, бараа мөрүүд). Оргил — үндсэн орлогын файл, Хархорин — салбарын орлогын файл.
    missing — орлогын файл оруулаагүй сарууд."""
    from app.services import income_index
    _validate_ym(year, 1)
    ms = _parse_months(months)
    if not ms:
        raise HTTPException(400, "Сар сонгоно уу.")
    docs, missing = [], []
    for m in ms:
        got = income_index.documents(db, which, year, m, code.strip())
        if got is None:
            missing.append(m)
            continue
        docs += [{"month": m, **d} for d in got]
    return {"code": code.strip(), "which": which, "year": year, "months": ms, "missing": missing,
            "documents": docs, "total": round(sum(d["amount"] for d in docs), 2)}


class ExemptIn(BaseModel):
    year: int
    month: int
    code: str
    which: str                       # orgil | harhorin
    amount: Optional[float] = None   # None / 0 → арилгана


@router.put("/exempt")
def save_exempt(
    body: ExemptIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """НӨАТ чөлөөлөгдөх дүн — Зөрүү = ХА − Ebarimt − чөлөөлөгдөх. Хоёр салбар хоёулаа 0 бол мөрийг устгана."""
    import math
    _validate_ym(body.year, body.month)
    code = (body.code or "").strip()
    if not code:
        raise HTTPException(400, "code хоосон байна.")
    if body.which not in ("orgil", "harhorin"):
        raise HTTPException(400, "Салбар orgil эсвэл harhorin.")
    amount = round(float(body.amount or 0), 2)
    if not math.isfinite(amount) or abs(amount) > 1e12:
        raise HTTPException(400, "Дүн буруу байна.")
    r = db.query(EbarimtExempt).filter(EbarimtExempt.year == body.year, EbarimtExempt.month == body.month,
                                       EbarimtExempt.code == code).first()
    if r is None:
        if not amount:
            return {"ok": True, "which": body.which, "amount": 0.0}
        r = EbarimtExempt(year=body.year, month=body.month, code=code, orgil=0.0, harhorin=0.0)
        db.add(r)
    setattr(r, body.which, amount)
    r.updated_by_name = str(getattr(u, "username", "") or "")
    r.updated_at = datetime.utcnow()
    if not (r.orgil or 0) and not (r.harhorin or 0):
        db.delete(r)
    db.commit()
    return {"ok": True, "which": body.which, "amount": amount}


class EmployeeAssignIn(BaseModel):
    year: int
    month: int
    codes: list[str]
    employee: Optional[str] = None      # None → тухайн сарын Data-ийн ажилтанд буцаана


@router.put("/employee")
def assign_employee(
    body: EmployeeAssignIn,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    """Сонгосон харилцагчдын ТУХАЙН САРЫН хариуцсан ажилтныг нэг дор солих (зөвхөн админ).
    Гараар тогтоосон ажилтан тэр сарын Data файл дахин оруулсан ч өөрчлөгдөхгүй (түүхэнд хадгална).
    employee=None — гар хуваарийг цуцалж Data файлын ажилтанд буцаана."""
    _validate_ym(body.year, body.month)
    codes = sorted({(c or "").strip() for c in body.codes if (c or "").strip()})
    if not codes:
        raise HTTPException(400, "Харилцагч сонгоогүй байна.")
    if len(codes) > 5000:
        raise HTTPException(400, "Хэт олон харилцагч.")
    emp = None if body.employee is None else body.employee.strip()[:120]
    if emp == "":
        raise HTTPException(400, "Ажилтны нэр хоосон байна.")
    payload, rows = month_rows(db, body.year, body.month)
    if payload.get("error"):
        raise HTTPException(400, payload["error"])
    # Хуваарь хийхээс өмнөх (Data/гар засварын) ажилтан
    base = {r["code"]: (r["defaults"].get("employee", r["employee"]) if r.get("emp_assigned") else r["employee"])
            for r in rows}
    who, now = str(getattr(u, "username", "") or ""), datetime.utcnow()
    changed = reverted = skipped = 0
    with _hist_lock:
        record_history(db, body.year, body.month, payload, rows)      # «анх»-ны утгууд түүхэнд байх ёстой
        existing = {a.code: a for a in db.query(EbarimtEmployeeAssign).filter(
            EbarimtEmployeeAssign.year == body.year, EbarimtEmployeeAssign.month == body.month).all()}
        for code in codes:
            if code not in base:
                skipped += 1
                continue
            a = existing.get(code)
            if emp is None:
                if a is not None:
                    db.delete(a)
                    reverted += 1
                    db.add(EbarimtHistory(year=body.year, month=body.month, code=code, field="emp", kind="revert",
                                          text=base[code], at=now, by_name=who))
                continue
            if a is None:
                a = EbarimtEmployeeAssign(year=body.year, month=body.month, code=code)
                db.add(a)
            if a.employee != emp:
                changed += 1
                db.add(EbarimtHistory(year=body.year, month=body.month, code=code, field="emp", kind="manual",
                                      text=emp, at=now, by_name=who))
            a.employee, a.updated_by_name, a.updated_at = emp, who, now
        if emp is not None and emp not in set(base.values()) \
                and not db.query(EbarimtEmployee).filter(EbarimtEmployee.name == emp).first():
            db.add(EbarimtEmployee(name=emp, created_by_name=who, created_at=now))   # Data-д байхгүй нэр
        db.commit()
    audit(db, request, u, action="ebarimt_employee_assign", entity_type="ebarimt",
          extra={"year": body.year, "month": body.month, "employee": emp, "codes": len(codes),
                 "changed": changed, "reverted": reverted, "skipped": skipped}, autocommit=True)
    return {"ok": True, "changed": changed, "reverted": reverted, "skipped": skipped}


class ReceiptLinkIn(BaseModel):
    year: int
    month: int
    which: str                       # orgil | harhorin
    rkeys: list[str]                 # баримтын түлхүүрүүд (entries-ийн _rkey)
    code: Optional[str] = None       # None → холбоосыг салгана


@router.put("/receipt-link")
def link_receipts(
    body: ReceiptLinkIn,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Бүртгэлгүй регистрийн баримт(ууд)-ыг харилцагчид холбоно — тэр харилцагчийн Ebarimt дүнд
    нэмэгдэнэ. code=None бол холбоосыг салгана. Өөрчлөлт түүхэнд «link» төрлөөр бичигдэнэ."""
    _validate_ym(body.year, body.month)
    if body.which not in BRANCHES:
        raise HTTPException(400, "Салбар orgil эсвэл harhorin.")
    rkeys = sorted({(k or "").strip() for k in body.rkeys if (k or "").strip()})
    if not rkeys:
        raise HTTPException(400, "Баримт сонгоогүй байна.")
    if len(rkeys) > 2000:
        raise HTTPException(400, "Хэт олон баримт.")
    payload, rows = month_rows(db, body.year, body.month)
    if payload.get("error"):
        raise HTTPException(400, payload["error"])
    code = (body.code or "").strip() or None
    names = {r["code"]: r["name"] for r in rows}
    if code is not None and code not in names:
        raise HTTPException(400, f"{code} кодтой харилцагч {body.month}-р сарын тайланд алга.")
    path = _stored_paths(db, body.year, body.month).get("ebarimt" if body.which == "orgil" else "ebarimt2")
    idx = _receipt_index(path) if path is not None else {}
    who, now = str(getattr(u, "username", "") or ""), datetime.utcnow()
    linked = unlinked = skipped = 0
    ttds: set[str] = set()
    with _hist_lock:
        record_history(db, body.year, body.month, payload, rows)          # өмнөх төлөв түүхэнд
        existing = {L.rkey: L for L in db.query(EbarimtReceiptLink).filter(
            EbarimtReceiptLink.year == body.year, EbarimtReceiptLink.month == body.month,
            EbarimtReceiptLink.which == body.which).all()}
        for rk in rkeys:
            L, rec = existing.get(rk), idx.get(rk)
            if code is None:
                if L is not None:
                    ttds.add(L.ttd or "")
                    db.delete(L)
                    unlinked += 1
                continue
            if rec is None:
                skipped += 1
                continue
            if L is None:
                L = EbarimtReceiptLink(year=body.year, month=body.month, which=body.which, rkey=rk)
                db.add(L)
            L.code, L.ttd, L.amount = code, rec["ttd"], rec["amt"]
            L.created_by_name, L.created_at = who, now
            ttds.add(rec["ttd"])
            linked += 1
        db.commit()
        payload2, rows2 = month_rows(db, body.year, body.month)
        n = linked or unlinked
        detail = f"ТТД {', '.join(sorted(t for t in ttds if t))} · {n} баримт"[:300]
        record_history(db, body.year, body.month, payload2, rows2, edit_kind="link" if code else "unlink",
                       edit_file=detail, edit_by=who, edit_at=now)
    audit(db, request, u, action="ebarimt_receipt_link", entity_type="ebarimt",
          extra={"year": body.year, "month": body.month, "which": body.which, "code": code, "receipts": len(rkeys),
                 "linked": linked, "unlinked": unlinked, "skipped": skipped}, autocommit=True)
    return {"ok": True, "linked": linked, "unlinked": unlinked, "skipped": skipped}


class EmployeeIn(BaseModel):
    name: str


@router.get("/employees")
def list_employees(
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Data-д бүртгэлгүй, гараар нэмсэн ажилтнууд (Data-гийнх тайлангийн мөрөөс харагдана)."""
    return [{"name": e.name, "created_by": e.created_by_name or "",
             "created_at": e.created_at.isoformat() if e.created_at else None}
            for e in db.query(EbarimtEmployee).order_by(EbarimtEmployee.name).all()]


@router.post("/employees")
def add_employee(
    body: EmployeeIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    name = (body.name or "").strip()[:120]
    if not name:
        raise HTTPException(400, "Ажилтны нэр хоосон байна.")
    if not db.query(EbarimtEmployee).filter(EbarimtEmployee.name == name).first():
        db.add(EbarimtEmployee(name=name, created_by_name=str(getattr(u, "username", "") or ""),
                               created_at=datetime.utcnow()))
        db.commit()
    return {"ok": True, "name": name}


@router.delete("/employees")
def delete_employee(
    name: str = Query(..., max_length=120),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    """Сонголтын жагсаалтаас хасна — өмнө нь хуваарилсан сарууд хэвээр үлдэнэ."""
    r = db.query(EbarimtEmployee).filter(EbarimtEmployee.name == name.strip()).first()
    if r:
        db.delete(r)
        db.commit()
    return {"ok": True, "removed": int(bool(r))}


class OverrideIn(BaseModel):
    code:  str
    field: str            # employee | registry | phone | tailbar
    value: Optional[str]  # None → засварыг цуцалж Data-ийн утгад буцаана


@router.put("/customer-override")
def save_override(
    body: OverrideIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Харилцагчийн мэдээллийг гараар засах (бүх сард нийтлэг).
    value=None бол засварыг цуцалж Data файлын утгыг сэргээнэ."""
    code = (body.code or "").strip()
    if not code:
        raise HTTPException(400, "code хоосон байна.")
    if body.field == "employee":
        raise HTTPException(400, "Ажилтныг сар бүрээр солино (зөвхөн админ).")
    if body.field not in ("registry", "phone", "tailbar"):
        raise HTTPException(400, "Зөвхөн Регистр/Утас/Тайлбар засна.")

    r = db.query(EbarimtCustomerOverride).filter(
        EbarimtCustomerOverride.code == code,
    ).first()

    if body.value is None:
        if r:
            setattr(r, body.field, None)
            # Бүх талбар цэвэрлэгдсэн бол бичлэгийг устгана
            if all(getattr(r, f) is None for f in ("employee", "registry", "phone", "tailbar")):
                db.delete(r)
            else:
                r.updated_by_name = str(getattr(u, "username", "") or "")
                r.updated_at = datetime.utcnow()
            db.commit()
        return {"ok": True, "field": body.field, "value": None}

    if not r:
        r = EbarimtCustomerOverride(code=code)
        db.add(r)
    setattr(r, body.field, body.value.strip()[:300])
    r.updated_by_name = str(getattr(u, "username", "") or "")
    r.updated_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "field": body.field, "value": getattr(r, body.field)}


class NoteIn(BaseModel):
    year:  int
    month: int
    code:  str
    note:  str = ""


@router.put("/note")
def save_note(
    body: NoteIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin", "supervisor", "manager")),
):
    """Харилцагчийн тайлбарыг хадгална (upsert). Хоосон → устгана."""
    _validate_ym(body.year, body.month)
    code = body.code.strip()
    if not code:
        raise HTTPException(400, "code хоосон байна.")
    r = db.query(EbarimtNote).filter(
        EbarimtNote.year == body.year, EbarimtNote.month == body.month,
        EbarimtNote.code == code,
    ).first()
    note = (body.note or "").strip()
    if not note:
        if r:
            db.delete(r)
            db.commit()
        return {"ok": True, "note": ""}
    if not r:
        r = EbarimtNote(year=body.year, month=body.month, code=code)
        db.add(r)
    r.note = note[:500]
    r.updated_by_name = str(getattr(u, "username", "") or "")
    r.updated_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "note": r.note}
