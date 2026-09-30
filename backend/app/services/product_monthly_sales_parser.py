"""Сарын борлуулалтын Excel файлыг task-чилж product_monthly_sales-руу хадгална.

Файлын формат (хатуу биш):
  A багана = item_code (Эрхэт дотоод код, тоо эсвэл string)
  B багана = qty (тоо ширхэг)
  Хэрэв 1-р мөр нь header бол (B багана нь тоо биш) автомат алгасна.
  Header-т «Нийт борлуулалт» багана байвал борлуулалтын дүнг (₮, НӨАТ-гүй) мөн хадгална.

Нэг файлд нэг item_code олон удаа гарвал нийт qty, дүнг SUM хийнэ.

Upsert логик:
  - (item_code, year, month)-аар олох
  - kind=warehouse → qty/amount_warehouse, kind=showroom → qty/amount_showroom,
    kind=liquor (заалны архи) → qty/amount_liquor баганыг шинэчилнэ — бусад баганыг хөндөхгүй
  - Хэрвээ мөр байхгүй бол шинээр үүсгэнэ
"""
from __future__ import annotations

import math
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Literal

import pandas as pd
from sqlalchemy import text
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.models.product_monthly_sales import (
    ProductMonthlySales,
    PMS_KIND_AMOUNT_FIELDS,
    PMS_KIND_FIELDS,
    PMS_KINDS,
)


Kind = Literal["warehouse", "showroom", "liquor"]
UPLOAD_DIR = Path("app/data/uploads/monthly_sales")


def _safe_float(val, default: float = 0.0) -> float:
    try:
        v = float(str(val).replace(",", "")) if isinstance(val, str) else float(val)
        return default if math.isnan(v) else v
    except (TypeError, ValueError):
        return default


def _safe_code(val) -> str:
    """item_code-ыг цэвэрлэнэ. Тоонууд `123.0` → `123` болгоно."""
    if val is None:
        return ""
    s = str(val).strip()
    if not s or s.lower() == "nan":
        return ""
    # Pandas-ийн float конверт хийсэн item_code-ыг хамгаална: `12345.0` → `12345`
    if s.endswith(".0"):
        try:
            f = float(s)
            if f.is_integer():
                s = str(int(f))
        except ValueError:
            pass
    return s


def _read_excel_any(file_path) -> "pd.DataFrame":
    """Excel-ийг өргөтгөлөөс хамааруулж зөв engine-ээр уншина.
    .xlsx → openpyxl, .xls → xlrd. Алдвал нөгөө engine-ээ оролдоно
    (зарим систем буруу өргөтгөлтэй экспортолдог)."""
    name = str(file_path).lower()
    if name.endswith(".xls"):
        order = ["xlrd", "openpyxl"]
    else:
        order = ["openpyxl", "xlrd"]
    last_err: Exception | None = None
    for eng in order:
        try:
            return pd.read_excel(file_path, header=None, dtype=str, engine=eng)
        except Exception as e:
            last_err = e
    # Эцсийн оролдлого — pandas өөрөө engine сонгоё
    try:
        return pd.read_excel(file_path, header=None, dtype=str)
    except Exception:
        raise last_err if last_err else RuntimeError("Excel унших боломжгүй")


def _read_rows(file_path) -> list[list]:
    """Эхний sheet-ийн бүх мөр. calamine (.xls/.xlsx, 10-20× хурдан) → алдвал pandas."""
    try:
        from python_calamine import CalamineWorkbook
        wb = CalamineWorkbook.from_path(str(file_path))
        return wb.get_sheet_by_name(wb.sheet_names[0]).to_python()
    except Exception:
        df = _read_excel_any(file_path)
        return df.where(pd.notna(df), None).values.tolist()


def _amount_col(header: list) -> int | None:
    """Header-ээс борлуулалтын дүнгийн багана: «Нийт борлуулалт» → бусад «...борлуулалт...»."""
    norm = [re.sub(r"\s+", " ", str(h or "")).strip().lower() for h in header]
    for i, h in enumerate(norm):
        if h == "нийт борлуулалт":
            return i
    for i, h in enumerate(norm):
        if "борлуулалт" in h and not any(w in h for w in ("тоо", "нөат", "хувь", "%")):
            return i
    return None


def read_sales_file(file_path, code_col: int = 0, qty_col: int = 1) -> dict:
    """Файл → {"agg": {code: [qty, amount]}, "parsed", "skipped", "amount_col"}.
    Нэг код олон мөр байвал нийлбэрлэнэ; qty <= 0 мөрийг алгасна."""
    rows = _read_rows(file_path)
    need_cols = max(code_col, qty_col) + 1
    out = {"agg": {}, "parsed": 0, "skipped": 0, "amount_col": None}
    if not rows or max(len(r) for r in rows) < need_cols:
        return out
    # Header автомат таних: 1-р мөрийн qty багана нь тоо биш бол header гэж үзнэ
    first_qty = rows[0][qty_col] if len(rows[0]) > qty_col else None
    try:
        float(str(first_qty).replace(",", ""))
        start_row, amt_col = 0, None           # header байхгүй — дүнгийн баганыг мэдэхгүй
    except (TypeError, ValueError):
        start_row, amt_col = 1, _amount_col(rows[0])
    if amt_col in (code_col, qty_col):
        amt_col = None
    agg: dict[str, list] = defaultdict(lambda: [0.0, 0.0])
    for r in rows[start_row:]:
        code = _safe_code(r[code_col] if len(r) > code_col else None)
        qty = _safe_float(r[qty_col] if len(r) > qty_col else None)
        if not code or qty <= 0:
            out["skipped"] += 1
            continue
        a = agg[code]
        a[0] += qty
        if amt_col is not None and len(r) > amt_col:
            a[1] += _safe_float(r[amt_col])
        out["parsed"] += 1
    out["agg"] = dict(agg)
    out["amount_col"] = amt_col
    return out


def parse_and_upsert(
    file_path: str | Path,
    year: int,
    month: int,
    kind: Kind,
    db: Session,
    code_col: int = 0,
    qty_col: int = 1,
) -> dict:
    """Excel файлыг уншиж product_monthly_sales-руу upsert хийнэ.

    code_col / qty_col — барааны код ба борлуулалтын тооны багана (0-based индекс).
    Тохиргооноос ирнэ (default A=0, B=1). Дүнгийн багана header-ээс автоматаар олдоно.

    Буцаах утга: {"parsed", "upserted", "skipped", "examples", "has_amount"}
    """
    if kind not in PMS_KINDS:
        raise ValueError(f"Invalid kind: {kind!r}. Must be one of {PMS_KINDS}.")
    if not (1 <= month <= 12):
        raise ValueError(f"Invalid month: {month}")
    if year < 2000 or year > 2100:
        raise ValueError(f"Invalid year: {year}")

    res = read_sales_file(file_path, max(0, int(code_col)), max(0, int(qty_col)))
    aggregated = res["agg"]
    if not aggregated:
        return {"parsed": res["parsed"], "upserted": 0, "skipped": res["skipped"], "examples": [],
                "has_amount": res["amount_col"] is not None}

    # SQLite upsert — шинэ мөрд бусад төрлийн qty/дүн = 0, байгаа мөрд зөвхөн энэ төрлийн баганууд шинэчлэгдэнэ
    qty_field = PMS_KIND_FIELDS[kind]
    amt_field = PMS_KIND_AMOUNT_FIELDS[kind]
    now = datetime.utcnow()

    rows = [
        {
            "item_code": code,
            "year": year,
            "month": month,
            **{f: (qa[0] if f == qty_field else 0.0) for f in PMS_KIND_FIELDS.values()},
            **{f: (qa[1] if f == amt_field else 0.0) for f in PMS_KIND_AMOUNT_FIELDS.values()},
            "created_at": now,
            "updated_at": now,
        }
        for code, qa in aggregated.items()
    ]

    # ── BATCH-аар оруулна — SQLite-ийн "too many SQL variables" (999) хязгаараас
    #    зайлсхийнэ. Мөр бүр 11 багана тул 80 мөр = 880 хувьсагч (аюулгүй). ──
    BATCH = 80
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        stmt = sqlite_insert(ProductMonthlySales).values(chunk)
        stmt = stmt.on_conflict_do_update(
            index_elements=["item_code", "year", "month"],
            set_={
                qty_field: getattr(stmt.excluded, qty_field),
                amt_field: getattr(stmt.excluded, amt_field),
                "updated_at": now,
            },
        )
        db.execute(stmt)
    db.commit()

    examples = list(aggregated.items())[:3]
    return {
        "parsed": res["parsed"],
        "upserted": len(aggregated),
        "skipped": res["skipped"],
        "has_amount": res["amount_col"] is not None,
        "examples": [{"item_code": c, "qty": qa[0], "amount": round(qa[1], 2)} for c, qa in examples],
    }


def backfill_amounts(db: Session, code_col: int = 0, qty_col: int = 1,
                     only_missing: bool = True, years: list[int] | None = None) -> dict:
    """Хадгалсан анхны файлуудаас (app/data/uploads/monthly_sales/{kind}/{он}/{сар}/) борлуулалтын
    ДҮНГ нөхөж хадгална. Тоо ширхэгийг ОГТ ХӨНДӨХГҮЙ:

      бараа бүрт — тухайн slot-ийн файлуудаас (сүүлийнхээс нь эхлэн) тоо нь DB-тэй ЯГ таарсан
      файлын дүнг авна. Нэг slot-д олон удаа/буруу файл оруулсан ч зөв эх мөрийн дүн л орно.

    only_missing=True бол дүнгүй (бүх дүн 0) slot-ыг л боловсруулна (startup-д хямд, идемпотент)."""
    report = []
    for kind, qf in PMS_KIND_FIELDS.items():
        af = PMS_KIND_AMOUNT_FIELDS[kind]
        slots = db.execute(text(
            f"SELECT year, month, count(*), total({af}) FROM product_monthly_sales "
            f"WHERE {qf} > 0 GROUP BY year, month")).all()
        for y, m, n, amt_total in slots:
            if years and y not in years:
                continue
            if only_missing and (amt_total or 0) > 0:
                continue
            d = UPLOAD_DIR / kind / str(y) / f"{m:02d}"
            files = sorted(d.glob("*")) if d.exists() else []
            if not files:
                report.append({"kind": kind, "year": y, "month": m, "rows": n, "matched": 0, "files": 0,
                               "note": "файл хадгалагдаагүй"})
                continue
            parsed = []
            for f in files:
                try:
                    r = read_sales_file(f, code_col, qty_col)
                    if r["amount_col"] is not None:
                        parsed.append(r["agg"])
                except Exception as e:                            # эвдэрсэн файл бусдыг саатуулахгүй
                    print(f"[pms] {f.name} уншиж чадсангүй: {e}")
            dbq = db.execute(text(
                f"SELECT item_code, {qf} FROM product_monthly_sales WHERE year=:y AND month=:m AND {qf} > 0"),
                {"y": y, "m": m}).all()
            updates = []
            for code, q in dbq:
                for agg in reversed(parsed):                      # хамгийн сүүлийн таарсан файл
                    hit = agg.get(code)
                    if hit and abs(hit[0] - float(q or 0)) < 1e-6:
                        updates.append({"a": hit[1], "c": code})
                        break
            if updates:
                db.execute(text(f"UPDATE product_monthly_sales SET {af}=:a "
                                f"WHERE item_code=:c AND year={int(y)} AND month={int(m)}"), updates)
            report.append({"kind": kind, "year": y, "month": m, "rows": n, "matched": len(updates),
                           "files": len(files)})
    db.commit()
    return {"slots": report, "updated_rows": sum(r["matched"] for r in report)}
