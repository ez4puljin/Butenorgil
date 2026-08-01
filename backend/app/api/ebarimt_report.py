"""Ebarimt тайлан — сар бүрийн 5 эх файлыг нэгтгэж харилцагч бүрээр
худалдан авалт vs Ebarimt шивэлтийг тооцно (хуучин Tailan.xlsm VBA-ийн орлуулалт).

Тооцооллын дүрэм (2026-06 сарын жинхэнэ өгөгдлөөр Tailan.xlsm-тэй 523/524 мөр
яг тулгаж баталсан; 1 зөрсөн мөр нь VBA-ийн Регистр тусгаарлагч таниагүй алдаа
байсныг энд зөв болгосон):
  • Худалдан авалт  = orgil/harhorin.xls-ийн "Гүйлгээ Кредит" багана (Кодоор)
  • Ebarimt шивэлт  = EBARIMT/EBARIMT2.xlsx-ийн "Нийт дүн" нийлбэр
                      (Харилцагчийн ТТД = Data-ийн Регистр; олон регистрийг
                       ';' ',' '.' зай зэргээр тусгаарлаж болно)
  • Ажилтан         = Data.xlsx-ийн "Нөат" багана — ажилтан бүр өөрийн
                      харилцагчдаа шүүж хардаг

Endpoint-ууд:
  POST   /ebarimt/import            — multipart (year, month, kind, file)
  GET    /ebarimt/slots             — ?year&month → 5 төрлийн төлөв
  GET    /ebarimt/download          — ?year&month&kind → түүхий файл татах
  DELETE /ebarimt/{year}/{month}/{kind}
  GET    /ebarimt/report            — ?year&month → нэгтгэсэн тайлан (mtime cache)
"""
from __future__ import annotations

import os
import re
import shutil
import threading
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_role
from app.core.audit import audit
from app.models.user import User
from app.models.ebarimt_file import EbarimtFile, EbarimtNote, EBARIMT_KINDS


router = APIRouter(prefix="/ebarimt", tags=["ebarimt"])

UPLOAD_DIR = Path("app/data/uploads/ebarimt")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


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


def _parse_purchases(path: Path) -> dict[str, float]:
    """orgil/harhorin.xls → {Код: Гүйлгээ Кредит}. Header мөрийг автоматаар олно."""
    import pandas as pd
    raw = _read_excel(path, header=None)
    start = 2  # анхдагч: 'Код' header + 'Дебет/Кредит' мөрийн дараа
    for i in range(min(6, len(raw))):
        if str(raw.iloc[i, 0]).strip() == "Код":
            start = i + 2
            break
    out: dict[str, float] = {}
    for i in range(start, len(raw)):
        code = raw.iloc[i, 0]
        if pd.isna(code):
            continue
        try:
            v = raw.iloc[i, 5]  # Гүйлгээ Кредит
            out[_norm_code(code)] = float(v) if pd.notna(v) else 0.0
        except Exception:
            continue
    return out


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


# ── Report computation (mtime cache) ─────────────────────────────────────────

_report_cache: dict[tuple[int, int], dict] = {}
_report_lock = threading.Lock()


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


def _compute_report(paths: dict[str, Path | None]) -> dict:
    if paths.get("data") is None:
        return {"rows": [], "employees": [], "error": "Data файл (харилцагчийн мэдээлэл) оруулаагүй байна."}

    customers = _parse_data(paths["data"])  # type: ignore[arg-type]
    o_map = _parse_purchases(paths["orgil"]) if paths.get("orgil") else {}
    h_map = _parse_purchases(paths["harhorin"]) if paths.get("harhorin") else {}
    v1, c1 = _parse_ebarimt(paths["ebarimt"]) if paths.get("ebarimt") else ({}, {})
    v2, c2 = _parse_ebarimt(paths["ebarimt2"]) if paths.get("ebarimt2") else ({}, {})

    rows = []
    employees: dict[str, int] = {}
    for c in customers:
        po = float(o_map.get(c["code"], 0.0))
        ph = float(h_map.get(c["code"], 0.0))
        vo = float(sum(v1.get(t, 0.0) for t in c["regs"]))
        vh = float(sum(v2.get(t, 0.0) for t in c["regs"]))
        no = int(sum(c1.get(t, 0) for t in c["regs"]))
        nh = int(sum(c2.get(t, 0) for t in c["regs"]))
        emp = c["emp"] or "(хоосон)"
        employees[emp] = employees.get(emp, 0) + 1
        rows.append({
            "employee":          emp,
            "code":              c["code"],
            "name":              c["name"],
            "registry":          c["registry"],
            "phone":             c["phone"],
            "tailbar":           c["tailbar"],
            "purchase_orgil":    po,
            "vat_orgil":         vo,
            "diff_orgil":        po - vo,
            "cnt_orgil":         no,
            "purchase_harhorin": ph,
            "vat_harhorin":      vh,
            "diff_harhorin":     ph - vh,
            "cnt_harhorin":      nh,
        })

    return {
        "rows": rows,
        "employees": [
            {"name": k, "customers": v}
            for k, v in sorted(employees.items(), key=lambda x: (-x[1], x[0]))
        ],
        "error": None,
    }


def get_report(db: Session, year: int, month: int) -> dict:
    """Тайланг mtime cache-тэйгээр буцаана — файлууд өөрчлөгдөөгүй бол
    дахин parse хийхгүй (агшин зуур)."""
    paths = _stored_paths(db, year, month)
    sig = tuple(
        (k, str(p), p.stat().st_mtime if p else 0)
        for k, p in sorted(paths.items(), key=lambda x: x[0])
    )
    key = (year, month)
    with _report_lock:
        cached = _report_cache.get(key)
        if cached and cached["sig"] == sig:
            return cached["payload"]
        payload = _compute_report(paths)
        payload["missing"] = [k for k, p in paths.items() if p is None]
        _report_cache[key] = {"sig": sig, "payload": payload}
        return payload


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
    if kind not in EBARIMT_KINDS:
        raise HTTPException(400, f"kind нь {sorted(EBARIMT_KINDS)}-ийн нэг байх ёстой.")

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
    payload = get_report(db, year, month)

    # Хэрэглэгчийн тэмдэглэлүүд — cache-ээс ГАДУУР overlay хийнэ
    # (тэмдэглэл өөрчлөгдөхөд файлын cache хүчинтэй хэвээр байдаг тул)
    notes = {
        n.code: n.note
        for n in db.query(EbarimtNote).filter(
            EbarimtNote.year == year, EbarimtNote.month == month,
        ).all()
        if (n.note or "").strip()
    }
    out_rows = [{**r, "note": notes.get(r["code"], "")} for r in payload["rows"]]

    rows = db.query(EbarimtFile).filter(
        EbarimtFile.year == year, EbarimtFile.month == month,
    ).all()
    files: dict[str, dict | None] = {k: None for k in EBARIMT_KINDS}
    for r in rows:
        if r.kind in files:
            files[r.kind] = _file_info(r)
    return {**payload, "rows": out_rows, "files": files, "year": year, "month": month}


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
