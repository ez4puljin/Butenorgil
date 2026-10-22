"""Эрхэтийн үлдэгдэл байршлаар — бодит цагт (app/services/erkhet_stock_live).

  GET /stock-live/search?q=        — код / нэр / баркодоор хайж үлдэгдэлтэй нь (≤ 20)
  GET /stock-live/codes?codes=a,b  — кодын жагсаалтаар (≤ 50) — Үнэ харах г.м. бусад хуудсанд
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.deps import get_current_user
from app.models.user import User
from app.services import erkhet_stock_live as svc

router = APIRouter(prefix="/stock-live", tags=["stock-live"])


def _call(fn, *a):
    try:
        return fn(*a)
    except Exception as e:      # noqa: BLE001 — erxes/Эрхэт түр унасан
        raise HTTPException(502, f"Эрхэтийн үлдэгдэл авч чадсангүй: {str(e)[:150]}")


@router.get("/search")
def search(q: str = Query(..., min_length=2, max_length=80), _: User = Depends(get_current_user)):
    return {"items": _call(svc.search, q, 20), "ttl": svc.TTL}


@router.get("/codes")
def codes(codes: str = Query(..., min_length=1, max_length=2000), _: User = Depends(get_current_user)):
    lst = [c for c in codes.split(",") if c.strip()]
    if len(lst) > svc.BATCH:
        raise HTTPException(400, f"Нэг удаад {svc.BATCH}-аас ихгүй код.")
    return {"items": _call(svc.by_codes, lst), "ttl": svc.TTL}
