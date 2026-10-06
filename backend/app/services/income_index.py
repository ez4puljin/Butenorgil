"""Орлогын файлын индекс — Ebarimt тайлангийн «ХА» (худалдан авалт)-ын задаргаанд.

Эх файл: Эрхэтийн «Бараа материалын гүйлгээ» (Файл оруулалт → Орлогын файл), мөр бүр нэг барааны
орлого: Баримтын дугаар · Огноо · Утга · Харьцсан дансд (кт:310101 = нийлүүлэгчийн өглөг) ·
Харилцагч код/нэр · Бараа материал код/нэр · Байршил · Тоо хэмжээ · Нэгж үнэ · Дебет · Хөнгөлөлт ·
Хэрэглэгч. Дебет нь НӨАТ-тэй худалдан авалтын дүн — 2026-08-д нийлбэр нь Оргил ХА-ийн 99.8%.

Индекс: (салбар, он, сар) → нийлүүлэгчийн код → баримтууд (дүн, бараа мөрүүд). Сарыг мөрийн
огноогоор ялгана (2026-аас өмнөх бүтэн оны файлд ч ажиллана). Файл бүрийг mtime-аар cache-лэнэ —
warm loop болон файл оруулах бүрт урьдчилан уншдаг тул Ebarimt цэсэнд хүлээлтгүй.

2026-10-06-аас Ebarimt тайлангийн ХА (худалдан авалт) өөрөө эндээс бодогдоно (month_summary) —
Ebarimt цэсэнд өглөгийн тайлан (orgil/harhorin.xls) оруулахаа больсон. Орлогын файлын бүх мөр
кт:310101 (нийлүүлэгчийн өглөг) — 2026 оны 3, 4, 8-р сард шалгасан.

Салбар: orgil — үндсэн IncomeFile, harhorin — BranchIncomeFile.
"""
from __future__ import annotations

import re
import threading
from datetime import date, datetime, timedelta
from pathlib import Path

MAIN_DIR = Path("app/data/uploads/income")
BRANCH_DIR = Path("app/data/uploads/income_branch")
BRANCHES = {"orgil": "Оргил", "harhorin": "Хархорин"}

_CACHE: dict[str, tuple[float, dict]] = {}          # path → (mtime, {(он, сар): {код: [баримт]}})
_LOCK = threading.Lock()


def _code(v) -> str:
    """Ebarimt тайлангийн _norm_code-той ижил: '50474.0'→'50474', '011'→'11'."""
    s = str(v if v is not None else "").strip()
    if s.endswith(".0"):
        s = s[:-2]
    try:
        return str(int(s))
    except (ValueError, TypeError):
        return s


def _num(v) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def _date(v) -> date | None:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if isinstance(v, (int, float)) and v > 20000:                 # Excel serial
        return date(1899, 12, 30) + timedelta(days=int(v))
    s = str(v or "").strip()[:10]
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def _parse(path: Path) -> dict:
    """Файл → {(он, сар): {нийлүүлэгчийн код: [баримт…]}}; баримт = {doc, date, utga, account, user,
    supplier, amount, discount, locations, lines: [[код, нэр, байршил, тоо, нэгж үнэ, дүн, хөнгөлөлт]]}."""
    from python_calamine import CalamineWorkbook
    wb = CalamineWorkbook.from_path(str(path))
    rows = wb.get_sheet_by_name(wb.sheet_names[0]).to_python()
    hdr = next((i for i, r in enumerate(rows[:25])
                if {"Баримтын дугаар", "Харилцагч код"} <= {str(c).strip() for c in r}), -1)
    if hdr < 0:
        return {}
    ix = {str(c).strip(): i for i, c in enumerate(rows[hdr])}
    g = lambda r, k: r[ix[k]] if k in ix and ix[k] < len(r) else None
    docs: dict[tuple, dict] = {}
    for r in rows[hdr + 1:]:
        code = _code(g(r, "Харилцагч код"))
        doc = str(g(r, "Баримтын дугаар") or "").strip()
        d = _date(g(r, "Огноо"))
        if not code or code.lower() == "nan" or not doc or d is None:
            continue
        key = (d.year, d.month, code, doc)
        x = docs.get(key)
        if x is None:
            x = docs[key] = {
                "doc": doc, "date": d.isoformat(), "utga": str(g(r, "Утга") or "").strip(),
                "account": str(g(r, "Харьцсан дансд") or "").strip(), "user": str(g(r, "Хэрэглэгч") or "").strip(),
                "supplier": str(g(r, "Харилцагч нэр") or "").strip(), "amount": 0.0, "discount": 0.0,
                "locations": set(), "lines": [],
            }
        amt, disc = _num(g(r, "Дебет")), _num(g(r, "Хөнгөлөлт"))
        loc = str(g(r, "Байршил нэр") or "").strip()
        x["amount"] += amt
        x["discount"] += disc
        if loc:
            x["locations"].add(loc)
        x["lines"].append([re.sub(r"\.0$", "", str(g(r, "Бараа материал код") or "").strip()),
                           str(g(r, "Бараа материал нэр") or "").strip(), loc,
                           _num(g(r, "Тоо хэмжээ")), _num(g(r, "Нэгж үнэ")), amt, disc])
    out: dict = {}
    for (y, m, code, _doc), x in docs.items():
        x["locations"] = sorted(x["locations"])
        x["amount"], x["discount"] = round(x["amount"], 2), round(x["discount"], 2)
        out.setdefault((y, m), {}).setdefault(code, []).append(x)
    for by_code in out.values():
        for lst in by_code.values():
            lst.sort(key=lambda x: (x["date"], x["doc"]))
    return out


def _index(path: Path) -> dict:
    key, mtime = str(path), path.stat().st_mtime
    hit = _CACHE.get(key)
    if hit and hit[0] == mtime:
        return hit[1]
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
        try:
            idx = _parse(path)
        except Exception as e:                                    # эвдэрсэн файл бусдыг саатуулахгүй
            print(f"[income-index] {path.name} уншиж чадсангүй: {e}")
            idx = {}
        _CACHE[key] = (mtime, idx)
        return idx


def _file_recs(db, branch: str, year: int) -> list[tuple[dict, Path]]:
    """Тухайн оны (сарын эсвэл бүтэн оны) орлогын файлууд + мета (Ebarimt-д харуулна).
    Сарын файлтай онд бүтэн оны файлыг алгасна."""
    if branch == "orgil":
        from app.models.income_file import IncomeFile
        rows = db.query(IncomeFile).filter(IncomeFile.year == year).all()
        has_monthly = any((r.month or 0) > 0 for r in rows)
        rows, base = [r for r in rows if not (has_monthly and not r.month)], MAIN_DIR
    else:
        from app.models.income_file import BranchIncomeFile
        rows = db.query(BranchIncomeFile).filter(BranchIncomeFile.branch == branch, BranchIncomeFile.year == year).all()
        base = BRANCH_DIR
    out = []
    for r in rows:
        p = base / (r.stored_filename or "")
        if r.stored_filename and p.exists():
            out.append(({"filename": r.original_filename or r.stored_filename, "month": int(r.month or 0),
                         "size_bytes": int(r.size_bytes or 0), "row_count": int(r.row_count or 0),
                         "uploaded_at": r.uploaded_at.isoformat() if r.uploaded_at else None,
                         "uploaded_by": r.uploaded_by_name or "",
                         "key": f"{r.stored_filename}|{r.uploaded_at.isoformat() if r.uploaded_at else ''}"}, p))
    return out


def _files(db, branch: str, year: int) -> list[Path]:
    return [p for _, p in _file_recs(db, branch, year)]


def signature(db, year: int) -> tuple:
    """Ebarimt тайлангийн cache-д: тухайн оны орлогын файлууд (салбар, зам, mtime) — файл
    оруулах/солих/устгах бүрт өөрчлөгдөж тайлан дахин бодогдоно."""
    out = []
    for b in BRANCHES:
        for _, p in _file_recs(db, b, year):
            try:
                out.append((b, str(p), p.stat().st_mtime))
            except OSError:
                pass
    return tuple(sorted(out))


def _month_files(db, branch: str, year: int, month: int) -> list[tuple[dict, Path]]:
    """Тухайн сарын ХА-д орох файлууд: тэр сарын слотын файл (агуулгаас үл хамааран — хоосон экспорт
    бол ХА 0), эсвэл бүтэн оны файл (тэр сарын мөр агуулсан бол). Сарын файл ЗӨВХӨН өөрийн сарын
    мөрөөр тооцогдоно — олон сарын экспортыг нэг слотод оруулбал хөрш сард давхар тоологдохгүй."""
    return [(meta, p) for meta, p in _file_recs(db, branch, year)
            if meta["month"] == month or (meta["month"] == 0 and (year, month) in _index(p))]


def covers(db, branch: str, year: int, month: int) -> bool:
    """Тухайн сарын орлогын файл байгаа эсэх."""
    return bool(_month_files(db, branch, year, month))


def month_summary(db, branch: str, year: int, month: int) -> dict | None:
    """Ebarimt тайлангийн ХА: нийлүүлэгч бүрийн тухайн сарын орлогын нийлбэр + файлын мэдээлэл
    (файлууд, баримт/мөрийн тоо, огнооны хүрээ). Тэр сарыг хамарсан орлогын файл байхгүй бол None."""
    amounts: dict[str, float] = {}
    names: dict[str, str] = {}
    files, n_docs, n_lines, d_from, d_to = [], 0, 0, None, None
    for meta, p in _month_files(db, branch, year, month):
        by_code = _index(p).get((year, month), {})
        files.append(meta)
        for code, docs in by_code.items():
            for d in docs:
                amounts[code] = amounts.get(code, 0.0) + d["amount"]
                if d["supplier"] and code not in names:
                    names[code] = d["supplier"]
                n_docs += 1
                n_lines += len(d["lines"])
                d_from = d["date"] if d_from is None or d["date"] < d_from else d_from
                d_to = d["date"] if d_to is None or d["date"] > d_to else d_to
    if not files:
        return None
    return {"amounts": amounts, "names": names, "files": files, "docs": n_docs, "lines": n_lines,
            "total": round(sum(amounts.values()), 2), "date_from": d_from, "date_to": d_to}


def documents(db, branch: str, year: int, month: int, code: str) -> list[dict] | None:
    """Нийлүүлэгчийн тухайн сарын орлогын баримтууд. Тэр сарын орлогын файл байхгүй бол None."""
    files = _month_files(db, branch, year, month)
    if not files:
        return None
    out = []
    for _, p in files:
        out += _index(p).get((year, month), {}).get(_code(code), [])
    return sorted(out, key=lambda x: (x["date"], x["doc"]))


def warm(years: int = 2) -> None:
    """Сүүлийн `years` оны бүх салбарын орлогын файлыг урьдчилан уншина (өөрчлөгдөөгүй бол агшин зуур)."""
    from app.core.db import SessionLocal
    db = SessionLocal()
    try:
        this_year = datetime.now().year
        for branch in BRANCHES:
            for y in range(this_year - years + 1, this_year + 1):
                for p in _files(db, branch, y):
                    _index(p)
    finally:
        db.close()


def warm_async() -> None:
    """Файл оруулсны дараа — background-д шууд уншиж эхэлнэ (warm loop-ийн 60с-ийг хүлээхгүй)."""
    threading.Thread(target=warm, name="income-index-warm", daemon=True).start()
