from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from collections import defaultdict

from app.api.deps import get_current_user, get_db, require_role
from app.models.user import User
from app.models.sales_report import SalesImportLog, SalesCacheRow
from app.services.sales_report_parser import parse_and_store

router = APIRouter(prefix="/sales-report", tags=["sales-report"])

UPLOAD_DIR = Path("app/data/uploads/Борлуулалтын тайлан")
CUSTOMER_INFO_PATH = Path("app/data/outputs/customer_info_last.xlsx")


def _customer_phone_map() -> dict[str, str]:
    """Return {customer_code: phone} from the last imported customer info Excel."""
    if not CUSTOMER_INFO_PATH.exists():
        return {}
    try:
        import pandas as pd
        df = pd.read_excel(CUSTOMER_INFO_PATH, header=None, dtype=str)
        result: dict[str, str] = {}
        for _, row in df.iterrows():
            code  = str(row.iloc[0]).strip() if len(row) > 0 else ""
            phone = str(row.iloc[6]).strip() if len(row) > 6 else ""
            if not code or code.lower() in ("nan", "код", ""):
                continue
            code  = code[:-2]  if code.endswith(".0")  else code
            phone = phone[:-2] if phone.endswith(".0") else phone
            if phone.lower() == "nan":
                phone = ""
            result[code] = phone
        return result
    except Exception:
        return {}
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

INSTRUCTIONS_FILE = Path("app/data/sales_report_instructions.json")
INSTRUCTIONS_FILE.parent.mkdir(parents=True, exist_ok=True)

EXCLUDED_BRANDS_FILE = Path("app/data/sales_report_excluded_brands.json")


def _load_excluded_brands() -> list[str]:
    if EXCLUDED_BRANDS_FILE.exists():
        try:
            return json.loads(EXCLUDED_BRANDS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _save_excluded_brands(brands: list[str]) -> None:
    EXCLUDED_BRANDS_FILE.write_text(
        json.dumps(brands, ensure_ascii=False, indent=2), encoding="utf-8"
    )

REGION_LABELS = {
    "zuun_bus":   "Мөрөн зүүн бүс",
    "baruun_bus": "Мөрөн баруун бүс",
    "oronnnutag": "Ороннутаг",
}

DEFAULT_INSTRUCTIONS: dict[str, list[str]] = {
    "zuun_bus": [
        "Эрхэт системд нэвтэрч Борлуулалт → Дэлгэрэнгүй тайлан руу орно.",
        "Салбар: Мөрөн зүүн бүс, Огноо: тухайн сарын 1-ний өдрөөс сарын сүүлийн өдөр хүртэл.",
        "Excel (.xlsx) форматаар экспортолж энд оруулна.",
    ],
    "baruun_bus": [
        "Эрхэт системд нэвтэрч Борлуулалт → Дэлгэрэнгүй тайлан руу орно.",
        "Салбар: Мөрөн баруун бүс, Огноо: тухайн сарын 1-ний өдрөөс сарын сүүлийн өдөр хүртэл.",
        "Excel (.xlsx) форматаар экспортолж энд оруулна.",
    ],
    "oronnnutag": [
        "Эрхэт системд нэвтэрч Борлуулалт → Дэлгэрэнгүй тайлан руу орно.",
        "Салбар: Ороннутаг, Огноо: тухайн сарын 1-ний өдрөөс сарын сүүлийн өдөр хүртэл.",
        "Excel (.xlsx) форматаар экспортолж энд оруулна.",
    ],
}

VALID_REGIONS = set(REGION_LABELS.keys())
VALID_YEARS   = list(range(2024, 2027))
VALID_MONTHS  = list(range(1, 13))


def _load_instructions() -> dict[str, list[str]]:
    if INSTRUCTIONS_FILE.exists():
        try:
            return json.loads(INSTRUCTIONS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_instructions(data: dict[str, list[str]]) -> None:
    INSTRUCTIONS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


# ── Upload ─────────────────────────────────────────────────────

@router.post("/upload")
async def upload_sales_report(
    region: str  = Form(...),
    year:   int  = Form(...),
    month:  int  = Form(...),
    f: UploadFile = File(...),
    db: Session = Depends(get_db),
    u:  User    = Depends(require_role("admin", "supervisor", "manager")),
):
    if region not in VALID_REGIONS:
        raise HTTPException(400, f"Буруу бүс: {region}")
    if year not in VALID_YEARS:
        raise HTTPException(400, f"Буруу он: {year}")
    if month not in VALID_MONTHS:
        raise HTTPException(400, f"Буруу сар: {month}")

    suffix = Path(f.filename or "").suffix.lower()
    if suffix not in (".xlsx", ".xls"):
        raise HTTPException(400, "Зөвхөн .xlsx / .xls файл зөвшөөрөгдөнө")

    # save file
    folder = UPLOAD_DIR / region / str(year) / f"{month:02d}"
    folder.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = folder / f"{ts}{suffix}"
    dest.write_bytes(await f.read())

    log = SalesImportLog(
        region      = region,
        year        = year,
        month       = month,
        filename    = f.filename or dest.name,
        filepath    = str(dest),
        uploaded_by = u.username,
        status      = "ok",
        message     = f"{REGION_LABELS[region]} {year}/{month:02d} файл хадгалагдлаа",
    )
    db.add(log)
    db.commit()
    db.refresh(log)

    # Parse and cache sales rows immediately after upload
    row_count = 0
    try:
        row_count = parse_and_store(str(dest), region, year, month, log.id, db)
        log.message = f"{REGION_LABELS[region]} {year}/{month:02d} — {row_count} мөр боловсруулагдлаа"
        log.status  = "ok"
    except Exception as exc:
        log.status  = "error"
        log.message = f"Боловсруулахад алдаа: {str(exc)[:300]}"
    db.commit()

    return {
        "ok":       True,
        "region":   region,
        "year":     year,
        "month":    month,
        "filename": f.filename,
        "message":  log.message,
        "row_count": row_count,
    }


# ── Re-parse all existing uploads ─────────────────────────────

@router.post("/reparse-all")
def reparse_all(
    db: Session = Depends(get_db),
    u:  User    = Depends(require_role("admin", "supervisor", "manager")),
):
    """Re-parse every existing uploaded file and rebuild the sales_cache_rows table."""
    from pathlib import Path as _Path

    # Get the latest upload per (region, year, month)
    logs = (
        db.query(SalesImportLog)
        .order_by(SalesImportLog.id.desc())
        .all()
    )
    # Keep only the newest log per slot
    seen: set = set()
    to_process: list[SalesImportLog] = []
    for log in logs:
        key = (log.region, log.year, log.month)
        if key not in seen:
            seen.add(key)
            to_process.append(log)

    results = []
    for log in to_process:
        fp = _Path(log.filepath)
        if not fp.exists():
            results.append({"region": log.region, "year": log.year, "month": log.month, "ok": False, "msg": "Файл олдсонгүй"})
            continue
        try:
            count = parse_and_store(str(fp), log.region, log.year, log.month, log.id, db)
            log.message = f"{REGION_LABELS.get(log.region, log.region)} {log.year}/{log.month:02d} — {count} мөр боловсруулагдлаа"
            log.status  = "ok"
            db.commit()
            results.append({"region": log.region, "year": log.year, "month": log.month, "ok": True, "rows": count})
        except Exception as exc:
            results.append({"region": log.region, "year": log.year, "month": log.month, "ok": False, "msg": str(exc)[:200]})

    return {"processed": len(to_process), "results": results}


# ── Import logs ────────────────────────────────────────────────

@router.get("/imports")
def list_imports(
    db: Session = Depends(get_db),
    _: User     = Depends(get_current_user),
):
    rows = (
        db.query(SalesImportLog)
        .order_by(SalesImportLog.id.desc())
        .limit(200)
        .all()
    )
    return [
        {
            "id":          r.id,
            "region":      r.region,
            "region_label": REGION_LABELS.get(r.region, r.region),
            "year":        r.year,
            "month":       r.month,
            "filename":    r.filename,
            "uploaded_at": r.uploaded_at.isoformat() if r.uploaded_at else "",
            "uploaded_by": r.uploaded_by,
            "status":      r.status,
            "message":     r.message,
        }
        for r in rows
    ]


# ── Latest per region/year/month ───────────────────────────────

@router.get("/latest")
def latest_imports(
    db: Session = Depends(get_db),
    _: User     = Depends(get_current_user),
):
    """Return the most recent upload for every (region, year, month) combination."""
    rows = (
        db.query(SalesImportLog)
        .filter(SalesImportLog.status == "ok")
        .order_by(SalesImportLog.id.desc())
        .all()
    )
    seen: set[tuple] = set()
    result = []
    for r in rows:
        key = (r.region, r.year, r.month)
        if key not in seen:
            seen.add(key)
            result.append({
                "region":      r.region,
                "year":        r.year,
                "month":       r.month,
                "filename":    r.filename,
                "uploaded_at": r.uploaded_at.isoformat() if r.uploaded_at else "",
                "uploaded_by": r.uploaded_by,
            })
    return result


# ── Dashboard ──────────────────────────────────────────────────

@router.get("/dashboard")
def get_dashboard(
    region: str | None = None,
    year:   int | None = None,
    month:  int | None = None,
    db: Session = Depends(get_db),
    _: User     = Depends(get_current_user),
):
    """Return pre-computed aggregates from sales_cache_rows for the dashboard."""
    q = db.query(SalesCacheRow)
    if region:
        q = q.filter(SalesCacheRow.region == region)
    if year:
        q = q.filter(SalesCacheRow.year == year)
    if month:
        q = q.filter(SalesCacheRow.month == month)
    rows = q.all()

    # ── Excluded brands шүүлтүүр ──────────────────────────────────
    _excl_raw = _load_excluded_brands()
    if _excl_raw:
        _excl = {b.strip().lower() for b in _excl_raw}
        rows = [r for r in rows if (r.brand or "").strip().lower() not in _excl]
    # ──────────────────────────────────────────────────────────────

    if not rows:
        return {
            "total_amount":  0.0,
            "top_customers": [],
            "top_brands":    [],
            "monthly_trend": [],
        }

    total = sum(r.total_amount for r in rows)

    # Top customers (by total_amount descending)
    cust_totals: dict = defaultdict(float)
    for r in rows:
        cust_totals[(r.customer_code, r.customer_name)] += r.total_amount
    top_customers = sorted(
        [
            {"customer_code": k[0], "customer_name": k[1], "total_amount": round(v, 2)}
            for k, v in cust_totals.items()
        ],
        key=lambda x: x["total_amount"],
        reverse=True,
    )

    # Top brands (by total_amount descending)
    brand_totals: dict = defaultdict(float)
    for r in rows:
        brand_totals[r.brand if r.brand else "(Брэнд байхгүй)"] += r.total_amount
    top_brands = sorted(
        [{"brand": k, "total_amount": round(v, 2)} for k, v in brand_totals.items()],
        key=lambda x: x["total_amount"],
        reverse=True,
    )

    # Monthly trend (sorted chronologically)
    trend_totals: dict = defaultdict(float)
    for r in rows:
        trend_totals[(r.year, r.month)] += r.total_amount
    monthly_trend = sorted(
        [
            {"year": k[0], "month": k[1], "total_amount": round(v, 2)}
            for k, v in trend_totals.items()
        ],
        key=lambda x: (x["year"], x["month"]),
    )

    # ── Helper: linear-regression slope as % of avg per month ──
    def _trend_slope_pct(vals: list) -> float | None:
        """Normalised slope from OLS linear regression.
        Positive = upward trend, negative = downward trend.
        Units: % of mean per additional month (robust to seasonal swings)."""
        n = len(vals)
        if n < 2:
            return None
        y_mean = sum(vals) / n
        if y_mean == 0:
            return None
        x_mean = (n - 1) / 2.0
        num = sum((i - x_mean) * (v - y_mean) for i, v in enumerate(vals))
        den = sum((i - x_mean) ** 2 for i in range(n))
        if den == 0:
            return None
        slope = num / den
        return round(slope / y_mean * 100, 1)

    # ── Rankings: per-entity monthly breakdown + trend slope ────
    all_months_set = sorted(set((r.year, r.month) for r in rows))
    phone_map = _customer_phone_map()

    cust_monthly: dict = defaultdict(lambda: defaultdict(float))
    for r in rows:
        cust_monthly[(r.customer_code, r.customer_name)][(r.year, r.month)] += r.total_amount

    customer_ranks = []
    for (code, name), monthly in cust_monthly.items():
        sm = sorted(monthly.keys())
        ml = [{"year": y, "month": m, "total": round(monthly[(y, m)], 2)} for y, m in sm]
        tot = round(sum(monthly.values()), 2)
        vals = [monthly[k] for k in sm]
        gp  = _trend_slope_pct(vals)
        customer_ranks.append({"customer_code": code, "customer_name": name,
                                "phone": phone_map.get(code, ""),
                                "monthly": ml, "total_amount": tot, "growth_pct": gp})
    customer_ranks.sort(key=lambda x: (x["growth_pct"] is None, -(x["growth_pct"] or 0)))

    brand_monthly: dict = defaultdict(lambda: defaultdict(float))
    for r in rows:
        bk = r.brand if r.brand else "(Брэнд байхгүй)"
        brand_monthly[bk][(r.year, r.month)] += r.total_amount

    brand_ranks = []
    for bname, monthly in brand_monthly.items():
        sm = sorted(monthly.keys())
        ml = [{"year": y, "month": m, "total": round(monthly[(y, m)], 2)} for y, m in sm]
        tot = round(sum(monthly.values()), 2)
        vals = [monthly[k] for k in sm]
        gp  = _trend_slope_pct(vals)
        brand_ranks.append({"brand": bname, "monthly": ml, "total_amount": tot, "growth_pct": gp})
    brand_ranks.sort(key=lambda x: (x["growth_pct"] is None, -(x["growth_pct"] or 0)))

    return {
        "total_amount":    round(total, 2),
        "top_customers":   top_customers,
        "top_brands":      top_brands,
        "monthly_trend":   monthly_trend,
        "available_months": [{"year": y, "month": m} for y, m in all_months_set],
        "customer_ranks":  customer_ranks,
        "brand_ranks":     brand_ranks,
    }


# ── Instructions ───────────────────────────────────────────────

@router.get("/instructions")
def get_instructions(_: User = Depends(get_current_user)):
    stored = _load_instructions()
    merged = {**DEFAULT_INSTRUCTIONS, **stored}
    return merged


class InstructionIn(BaseModel):
    lines: list[str]


@router.put("/instructions/{region}")
def save_instructions(
    region: str,
    body: InstructionIn,
    _: User = Depends(require_role("admin")),
):
    if region not in VALID_REGIONS:
        raise HTTPException(400, "Буруу бүс")
    data = _load_instructions()
    data[region] = [l for l in body.lines if l.strip()]
    _save_instructions(data)
    return {"ok": True}


# ── Excluded brands ─────────────────────────────────────────────

@router.get("/excluded-brands")
def get_excluded_brands(_: User = Depends(get_current_user)):
    """Return the list of brand names excluded from all sales reports."""
    return {"brands": _load_excluded_brands()}


class ExcludedBrandsIn(BaseModel):
    brands: list[str]


@router.put("/excluded-brands")
def save_excluded_brands_endpoint(
    body: ExcludedBrandsIn,
    _: User = Depends(require_role("admin")),
):
    """Persist the excluded brands list (admin only)."""
    cleaned = [b.strip() for b in body.brands if b.strip()]
    _save_excluded_brands(cleaned)
    return {"ok": True, "brands": cleaned}


@router.get("/brands")
def list_brands(
    db: Session = Depends(get_db),
    _: User     = Depends(get_current_user),
):
    """Return a sorted list of distinct brand names for autocomplete."""
    rows = db.query(SalesCacheRow.brand).distinct().all()
    return sorted({r.brand for r in rows if r.brand})


# ── Debug: trace parser for a specific customer ────────────────

@router.get("/debug-parse")
def debug_parse(
    region: str,
    year: int,
    month: int,
    customer_code: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    """Trace what the parser sees for a specific customer in the uploaded file.
    Returns the raw classified rows and comparison with DB total."""
    import math, pandas as pd

    # Find the uploaded file
    log = (
        db.query(SalesImportLog)
        .filter(
            SalesImportLog.region == region,
            SalesImportLog.year   == year,
            SalesImportLog.month  == month,
            SalesImportLog.status == "ok",
        )
        .order_by(SalesImportLog.id.desc())
        .first()
    )
    if not log:
        raise HTTPException(404, "Импортын мэдээлэл олдсонгүй")

    fp = Path(log.filepath)
    if not fp.exists():
        raise HTTPException(404, f"Файл олдсонгүй: {fp}")

    def _sf(v, d=0.0):
        try:
            x = float(v)
            return d if math.isnan(x) else x
        except: return d

    def _ss(v, d=""):
        if v is None: return d
        s = str(v).strip()
        s = s[:-2] if s.endswith(".0") else s
        return d if s.lower() in ("nan", "") else s

    def classify_row(row):
        a = _ss(row.iloc[0] if len(row) > 0 else None)
        d = _sf(row.iloc[3] if len(row) > 3 else None)
        digits = a.replace(".", "").replace(",", "").strip()
        if not digits.isdigit():    return "skip"
        if len(digits) == 6 and digits.startswith("5"): return "account"
        if d > 0:                   return "product"
        if len(digits) == 5:        return "customer"
        if len(digits) in (1, 2):   return "warehouse"
        return "skip"

    df = pd.read_excel(str(fp), header=None, dtype=str)

    result_rows = []
    cust_code = cust_name = ""
    in_target = False
    target_total_parsed = 0.0
    target_rows_parsed = 0

    for idx, raw in df.iterrows():
        kind = classify_row(raw)
        a = _ss(raw.iloc[0] if len(raw) > 0 else None)
        b = _ss(raw.iloc[1] if len(raw) > 1 else None)
        c = _ss(raw.iloc[2] if len(raw) > 2 else None)
        d = _ss(raw.iloc[3] if len(raw) > 3 else None)
        h = _ss(raw.iloc[7] if len(raw) > 7 else None)
        excel_row = int(idx) + 1

        if kind == "customer":
            if in_target:
                # We've passed the target customer's section
                result_rows.append({
                    "excel_row": excel_row, "kind": "customer_end",
                    "a": a, "b": b[:40], "d": d, "h": h,
                    "note": f"Next customer: {a} {b[:20]}"
                })
                break
            if a == customer_code or a == customer_code + ".0":
                in_target = True
                cust_code = a
                cust_name = b
                result_rows.append({
                    "excel_row": excel_row, "kind": kind,
                    "a": a, "b": b[:40], "d": d, "h": h,
                    "note": "TARGET CUSTOMER FOUND"
                })
        elif in_target:
            if kind == "product":
                amt = _sf(raw.iloc[7] if len(raw) > 7 else None)
                target_total_parsed += amt
                target_rows_parsed += 1
                result_rows.append({
                    "excel_row": excel_row, "kind": kind,
                    "a": a, "b": b[:40], "d": d, "h": h,
                    "amount": amt
                })
            else:
                result_rows.append({
                    "excel_row": excel_row, "kind": kind,
                    "a": a, "b": b[:40], "d": d, "h": h,
                    "note": f"NON-PRODUCT in target section"
                })

    # Compare with DB
    db_rows = db.query(SalesCacheRow).filter(
        SalesCacheRow.region        == region,
        SalesCacheRow.year          == year,
        SalesCacheRow.month         == month,
        SalesCacheRow.customer_code == customer_code,
    ).all()
    db_total = sum(r.total_amount for r in db_rows)

    return {
        "file":              str(fp),
        "customer_code":     customer_code,
        "customer_name":     cust_name,
        "parser_total":      round(target_total_parsed, 2),
        "parser_row_count":  target_rows_parsed,
        "db_total":          round(db_total, 2),
        "db_row_count":      len(db_rows),
        "discrepancy":       round(target_total_parsed - db_total, 2),
        "rows":              result_rows,
    }
