"""Миний тооллого — API (/hall-count хуудасны «Миний тооллого» горим).

Хүн бүр өөрийн тооллогыг үүсгэж, мастерт бүртгэлтэй бараагаар зэрэг тоолно. Нэг барааг
дахин уншуулбал оруулсан тоо нь өмнөхөн дээр НЭМЭГДЭНЭ. Дуусгаад .txt (code,quantity).

Эрх:
  • Тооллого үүсгэх — нэвтэрсэн хэн ч (заалны ажилтнууд .apk-аар тоолно).
  • Тоо нэмэх / засах / дуусгах — зөвхөн тухайн тооллогын ЭЗЭН.
  • Харах / .txt татах / устгах — эзэн, мөн admin/supervisor/manager (бүх хүнийхийг).

Endpoint-ууд (prefix /master-count):
  GET    /counts?scope=mine|all              — тооллогууд (all — зөвхөн менежер)
  POST   /counts                             — {name} шинэ тооллого
  GET    /counts/{id}                        — тооллого + мөрүүд
  PATCH  /counts/{id}                        — {name?, status? (open|done)}
  DELETE /counts/{id}
  GET    /lookup?q=&count_id=                — баркод/код → мастерын бараа + энэ тооллогын мөр
  POST   /counts/{id}/scan                   — {code, qty, barcode} → мөрийн тоон дээр нэмнэ
  PUT    /counts/{id}/lines/{line_id}        — {qty} гараар засах (нийт тоо)
  DELETE /counts/{id}/lines/{line_id}
  GET    /counts/{id}/export                 — .txt, мөр бүр «code,quantity»
  POST   /counts/{id}/export-link            — 5 мин хүчинтэй татах холбоос (утасны апп Chrome-оор татна)
  GET    /download/{token}                   — тэр холбоосоор .txt (нэвтрэлтгүй, богино хугацаатай)
"""
from __future__ import annotations

import math
import secrets
import time
from datetime import datetime
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db
from app.models.master_count import MC_DONE, MC_OPEN, MasterCount, MasterCountLine, MasterCountScan
from app.models.user import User
from app.services import master_index

router = APIRouter(prefix="/master-count", tags=["master-count"])

MANAGER_ROLES = ("admin", "supervisor", "manager")


def _is_manager(u: User) -> bool:
    return (u.base_role or u.role) in MANAGER_ROLES


def _uid(u: User) -> int:
    return int(getattr(u, "id", 0) or 0)


def _uname(u: User) -> str:
    return str(getattr(u, "nickname", "") or getattr(u, "username", "") or "")


def _iso(d: Optional[datetime]) -> Optional[str]:
    return d.isoformat() if d else None


def _fmt_qty(q: float) -> str:
    """12.0 → «12», 1.25 → «1.25» (бутархайг 3 орон хүртэл)."""
    q = round(float(q or 0), 3)
    return str(int(q)) if q.is_integer() else f"{q:.3f}".rstrip("0").rstrip(".")


def _count_dict(c: MasterCount, lines: int = 0, total: float = 0.0, u: Optional[User] = None) -> dict:
    return {
        "id": c.id, "name": c.name, "status": c.status,
        "owner_id": c.owner_id, "owner_name": c.owner_name,
        "created_at": _iso(c.created_at), "updated_at": _iso(c.updated_at), "finished_at": _iso(c.finished_at),
        "lines": int(lines or 0), "total_qty": float(total or 0),
        "is_owner": bool(u) and c.owner_id == _uid(u),
    }


def _line_dict(l: MasterCountLine) -> dict:
    return {"id": l.id, "code": l.code, "name": l.name, "qty": float(l.qty or 0), "scans": int(l.scans or 0),
            "first_at": _iso(l.first_at), "last_at": _iso(l.last_at)}


def _totals(db: Session, count_id: int) -> tuple[int, float]:
    n, s = db.query(func.count(MasterCountLine.id), func.sum(MasterCountLine.qty)).filter(
        MasterCountLine.count_id == count_id).one()
    return int(n or 0), float(s or 0)


def _get(db: Session, count_id: int, u: User, write: bool = False) -> MasterCount:
    c = db.get(MasterCount, count_id)
    if c is None:
        raise HTTPException(404, "Тооллого олдсонгүй.")
    own = c.owner_id == _uid(u)
    if write and not own:
        raise HTTPException(403, "Зөвхөн өөрийн тооллогод өөрчлөлт оруулна.")
    if not own and not _is_manager(u):
        raise HTTPException(403, "Энэ тооллого таных биш.")
    return c


def _check_qty(q: float, allow_zero: bool = False) -> float:
    if q is None or not math.isfinite(q) or abs(q) > 1_000_000:
        raise HTTPException(400, "Тоо буруу байна.")
    if not allow_zero and abs(q) < 1e-9:
        raise HTTPException(400, "Тоо оруулна уу.")
    return round(float(q), 3)


# ── Тооллогууд ───────────────────────────────────────────────────────────────

class CountIn(BaseModel):
    name: str = ""


class CountPatch(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None      # open | done


@router.get("/counts")
def list_counts(
    scope: str = Query("mine", pattern="^(mine|all)$"),
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    q = db.query(MasterCount)
    if not (scope == "all" and _is_manager(u)):
        q = q.filter(MasterCount.owner_id == _uid(u))
    counts = q.order_by(MasterCount.updated_at.desc()).limit(300).all()
    ids = [c.id for c in counts]
    agg = {cid: (n, s) for cid, n, s in db.query(
        MasterCountLine.count_id, func.count(MasterCountLine.id), func.sum(MasterCountLine.qty)
    ).filter(MasterCountLine.count_id.in_(ids)).group_by(MasterCountLine.count_id).all()} if ids else {}
    # Нээлттэйг нь эхэнд
    counts.sort(key=lambda c: (c.status != MC_OPEN,))
    return {
        "counts": [_count_dict(c, *agg.get(c.id, (0, 0.0)), u=u) for c in counts],
        "can_manage": _is_manager(u),
        "master": master_index.stats(),
    }


@router.post("/counts")
def create_count(body: CountIn, db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    now = datetime.utcnow()
    name = (body.name or "").strip()[:200] or f"{_uname(u) or 'Тооллого'} · {datetime.now():%m-%d %H:%M}"
    c = MasterCount(name=name, status=MC_OPEN, owner_id=_uid(u), owner_name=_uname(u),
                    created_at=now, updated_at=now)
    db.add(c)
    db.commit()
    return _count_dict(c, 0, 0.0, u)


@router.get("/counts/{count_id}")
def get_count(count_id: int, db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    c = _get(db, count_id, u)
    lines = db.query(MasterCountLine).filter(MasterCountLine.count_id == c.id).order_by(
        MasterCountLine.last_at.desc()).all()
    n, total = len(lines), sum(float(l.qty or 0) for l in lines)
    return {"count": _count_dict(c, n, total, u), "lines": [_line_dict(l) for l in lines],
            "can_edit": c.owner_id == _uid(u) and c.status == MC_OPEN}


@router.patch("/counts/{count_id}")
def update_count(count_id: int, body: CountPatch, db: Session = Depends(get_db),
                 u: User = Depends(get_current_user)):
    c = _get(db, count_id, u, write=True)
    now = datetime.utcnow()
    if body.name is not None:
        name = body.name.strip()[:200]
        if not name:
            raise HTTPException(400, "Нэр хоосон байна.")
        c.name = name
    if body.status is not None:
        if body.status not in (MC_OPEN, MC_DONE):
            raise HTTPException(400, "Төлөв open эсвэл done.")
        c.status = body.status
        c.finished_at = now if body.status == MC_DONE else None
    c.updated_at = now
    db.commit()
    return _count_dict(c, *_totals(db, c.id), u=u)


@router.delete("/counts/{count_id}")
def delete_count(count_id: int, db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    c = db.get(MasterCount, count_id)
    if c is None:
        return {"ok": True, "removed": 0}
    if c.owner_id != _uid(u) and not _is_manager(u):
        raise HTTPException(403, "Зөвхөн өөрийн тооллогыг устгана.")
    db.query(MasterCountScan).filter(MasterCountScan.count_id == c.id).delete()
    db.query(MasterCountLine).filter(MasterCountLine.count_id == c.id).delete()
    db.delete(c)
    db.commit()
    return {"ok": True, "removed": 1}


# ── Бараа хайх, тоолох ───────────────────────────────────────────────────────

@router.get("/lookup")
def lookup(
    q: str = Query(..., min_length=1, max_length=80),
    count_id: int = Query(0),
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Баркод / код → мастерт бүртгэлтэй бараа (ЯГ таарсан) + энэ тооллогод өмнө тоолсон мөр."""
    p = master_index.resolve(q)
    if not p:
        return {"query": q.strip(), "found": False, "product": None, "line": None}
    if len(p.get("candidates") or []) > 1:
        # Нэг баркод хэд хэдэн бараанд — тоолж буй хүн сонгоно
        return {"query": q.strip(), "found": True, "ambiguous": True, "candidates": p["candidates"],
                "product": None, "line": None}
    line = None
    if count_id:
        c = _get(db, count_id, u)
        line = db.query(MasterCountLine).filter(MasterCountLine.count_id == c.id,
                                                MasterCountLine.code == p["code"]).first()
    return {"query": q.strip(), "found": True, "product": p, "line": _line_dict(line) if line else None}


class ScanIn(BaseModel):
    code: str
    qty: float
    barcode: str = ""


@router.post("/counts/{count_id}/scan")
def add_scan(count_id: int, body: ScanIn, db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    """Тоолсон тоог нэмнэ — бараа өмнө тоологдсон бол өмнөх тоон дээр нэмэгдэнэ."""
    c = _get(db, count_id, u, write=True)
    if c.status != MC_OPEN:
        raise HTTPException(409, "Тооллого дууссан — «Дахин нээх» дарж үргэлжлүүлнэ үү.")
    p = master_index.resolve(body.code)
    if not p:
        raise HTTPException(404, f"«{body.code}» мастерт бүртгэлгүй бараа.")
    qty = _check_qty(body.qty)
    now = datetime.utcnow()
    line = db.query(MasterCountLine).filter(MasterCountLine.count_id == c.id,
                                            MasterCountLine.code == p["code"]).first()
    if line is None:
        line = MasterCountLine(count_id=c.id, code=p["code"], name=p["name"], qty=0.0, scans=0,
                               first_at=now, last_at=now)
        db.add(line)
        try:
            db.flush()
        except IntegrityError:            # нэг тооллогод хоёр утаснаас зэрэг — байгааг нь авна
            db.rollback()
            c = _get(db, count_id, u, write=True)
            line = db.query(MasterCountLine).filter(MasterCountLine.count_id == c.id,
                                                    MasterCountLine.code == p["code"]).one()
    prev = float(line.qty or 0)
    line.qty = round(prev + qty, 3)
    line.scans = int(line.scans or 0) + 1
    line.last_at = now
    line.name = p["name"] or line.name
    db.add(MasterCountScan(count_id=c.id, line_id=line.id, code=line.code, barcode=(body.barcode or "")[:64],
                           kind="add", qty=qty, user_name=_uname(u), created_at=now))
    c.updated_at = now
    db.commit()
    n, total = _totals(db, c.id)
    return {"line": _line_dict(line), "prev": prev, "added": qty, "count": _count_dict(c, n, total, u)}


class LineSet(BaseModel):
    qty: float


def _get_line(db: Session, c: MasterCount, line_id: int) -> MasterCountLine:
    line = db.get(MasterCountLine, line_id)
    if line is None or line.count_id != c.id:
        raise HTTPException(404, "Мөр олдсонгүй.")
    return line


@router.put("/counts/{count_id}/lines/{line_id}")
def set_line(count_id: int, line_id: int, body: LineSet, db: Session = Depends(get_db),
             u: User = Depends(get_current_user)):
    """Гараар засах — мөрийн НИЙТ тоог өгсөн утгаар солино."""
    c = _get(db, count_id, u, write=True)
    if c.status != MC_OPEN:
        raise HTTPException(409, "Тооллого дууссан — «Дахин нээх» дарж засна уу.")
    line = _get_line(db, c, line_id)
    qty = _check_qty(body.qty, allow_zero=True)
    now = datetime.utcnow()
    line.qty, line.last_at = qty, now
    db.add(MasterCountScan(count_id=c.id, line_id=line.id, code=line.code, kind="set", qty=qty,
                           user_name=_uname(u), created_at=now))
    c.updated_at = now
    db.commit()
    n, total = _totals(db, c.id)
    return {"line": _line_dict(line), "count": _count_dict(c, n, total, u)}


@router.delete("/counts/{count_id}/lines/{line_id}")
def delete_line(count_id: int, line_id: int, db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    c = _get(db, count_id, u, write=True)
    if c.status != MC_OPEN:
        raise HTTPException(409, "Тооллого дууссан — «Дахин нээх» дарж засна уу.")
    line = _get_line(db, c, line_id)
    db.query(MasterCountScan).filter(MasterCountScan.line_id == line.id).delete()
    db.delete(line)
    c.updated_at = datetime.utcnow()
    db.commit()
    n, total = _totals(db, c.id)
    return {"ok": True, "count": _count_dict(c, n, total, u)}


# ── Экспорт ──────────────────────────────────────────────────────────────────

def _txt_response(db: Session, c: MasterCount) -> Response:
    """.txt — мөр бүр «code,quantity» (толгойгүй, кодын дарааллаар, 0 тоотой мөр орохгүй)."""
    lines = db.query(MasterCountLine).filter(MasterCountLine.count_id == c.id).order_by(MasterCountLine.code).all()
    body = "".join(f"{l.code},{_fmt_qty(l.qty)}\r\n" for l in lines if abs(float(l.qty or 0)) > 1e-9)
    fname = f"{c.name or 'тооллого'}.txt".replace("/", "-").replace("\\", "-")
    return Response(
        content=body.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=\"count_{c.id}.txt\"; filename*=UTF-8''{quote(fname)}"},
    )


@router.get("/counts/{count_id}/export")
def export_txt(count_id: int, db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    return _txt_response(db, _get(db, count_id, u))


# Утасны апп (Capacitor WebView) blob файл татаж чаддаггүй — тиймээс богино хугацаатай
# санамсаргүй холбоос үүсгээд Chrome-оор нээлгэнэ (Chrome өөрөө Downloads-д хадгална).
# Санах ойд (нэг процесс) — сервер дахин асвал хүчингүй болно.
_DL: dict[str, tuple[float, int]] = {}
DL_TTL = 300


@router.post("/counts/{count_id}/export-link")
def export_link(count_id: int, db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    c = _get(db, count_id, u)
    now = time.monotonic()
    for k in [k for k, (exp, _) in _DL.items() if exp < now]:
        _DL.pop(k, None)
    tok = secrets.token_urlsafe(24)
    _DL[tok] = (now + DL_TTL, c.id)
    return {"url": f"/master-count/download/{tok}", "expires_in": DL_TTL}


@router.get("/download/{token}")
def download_txt(token: str, db: Session = Depends(get_db)):
    hit = _DL.get(token)
    if not hit or hit[0] < time.monotonic():
        raise HTTPException(404, "Татах холбоосын хугацаа дууссан — «.txt татах»-ыг дахин дарна уу.")
    c = db.get(MasterCount, hit[1])
    if c is None:
        raise HTTPException(404, "Тооллого олдсонгүй.")
    return _txt_response(db, c)
