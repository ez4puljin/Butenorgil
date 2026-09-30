"""Борлуулалтын график — урьдчилан ачаалсан cube-ээс (app/services/sales_analytics.py).

  GET /sales-analytics/meta    — он/сар, байршил, ангилал, бренд, tag, cube-ийн төлөв
  GET /sales-analytics/facets  — ангилал/бренд/tag сонголтууд (бусад шүүлтээр шүүгдсэн, тоо + дүнтэй)
  GET /sales-analytics/query   — шүүлт + бүлэглэлт → KPI, байршлаар сар бүрийн цуваа, эрэмбэ, өсөлт/бууралт
Олон утгатай шүүлт (cats/brands/tags) «||»-ээр тусгаарлагдана: нэг шүүлт дотор OR, шүүлт хооронд AND.

Нэвтэрсэн хэрэглэгч бүр харна (цэс нь «universal»; админ UI-аас хязгаарлаж болно).
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db
from app.models.user import User
from app.services import sales_analytics as sa

router = APIRouter(prefix="/sales-analytics", tags=["sales-analytics"])


@router.get("/meta")
def get_meta(db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    return sa.meta(sa.get_cube(db))


@router.get("/facets")
def get_facets(
    year: Optional[int] = None,
    m_from: Optional[int] = Query(None, ge=1, le=12),
    m_to: Optional[int] = Query(None, ge=1, le=12),
    kinds: str = Query(",".join(sa.KINDS), max_length=60),
    metric: str = Query("amount", pattern="^(amount|qty)$"),
    cats: str = Query("", max_length=4000),
    brands: str = Query("", max_length=4000),
    tags: str = Query("", max_length=1000),
    q: str = Query("", max_length=80),
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Ангилал/бренд/tag-ийн сонголтууд — бусад шүүлтээр шүүгдсэн, барааны тоо + дүнтэй (хайлттай multi-select-д)."""
    cube = sa.get_cube(db)
    y = year or sa.default_year(cube)
    d_from, d_to = sa.default_months(cube, y)
    return sa.facets(cube, year=y, m_from=m_from or d_from, m_to=m_to or d_to,
                     kinds=[k for k in kinds.split(",") if k], metric=metric,
                     cats=cats, brands=brands, tags=tags, q=q)


@router.get("/query")
def run_query(
    year: Optional[int] = None,
    m_from: Optional[int] = Query(None, ge=1, le=12),
    m_to: Optional[int] = Query(None, ge=1, le=12),
    kinds: str = Query(",".join(sa.KINDS), max_length=60),
    metric: str = Query("amount", pattern="^(amount|qty)$"),
    dim: str = Query("category", pattern="^(category|brand|product|location)$"),
    cats: str = Query("", max_length=4000),
    brands: str = Query("", max_length=4000),
    tags: str = Query("", max_length=1000),
    q: str = Query("", max_length=80),
    code: str = Query("", max_length=64),
    sort: str = Query("total", pattern="^(total|growth|decline)$"),
    top: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    cube = sa.get_cube(db)
    y = year or sa.default_year(cube)
    if y not in cube["years"]:
        raise HTTPException(404, f"{y} оны борлуулалтын өгөгдөл алга.")
    d_from, d_to = sa.default_months(cube, y)
    res = sa.query(cube, year=y, m_from=m_from or d_from, m_to=m_to or d_to,
                   kinds=[k for k in kinds.split(",") if k], metric=metric, dim=dim,
                   cats=cats, brands=brands, tags=tags, q=q, code=code, sort=sort, top=top)
    return {**res, "version": cube["version"]}
