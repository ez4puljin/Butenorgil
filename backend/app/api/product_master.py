"""Барааны мастер — erxes ↔ Эрхэт идэвхтэй барааны тулгалт, Master нэгтгэлийн автоматжуулалт
(app/services/product_master_sync).

  GET  /product-master/compare            — сүүлийн тулгалтын үр дүн + ажлын төлөв
  POST /product-master/compare/run        — зөвхөн тулгалт (слот, мастерт хүрэхгүй)
  POST /product-master/master-auto/run    — хоёр жагсаалтыг татаж слотод хадгалаад мастер нэгтгэл + тулгалт
"""
from __future__ import annotations

import threading

from fastapi import APIRouter, Depends

from app.api.deps import require_role
from app.models.user import User
from app.services import product_master_sync as svc

router = APIRouter(prefix="/product-master", tags=["product-master"])
VIEW = ("admin", "supervisor", "manager")


@router.get("/compare")
def get_compare(u: User = Depends(require_role(*VIEW))):
    return {"result": svc.load_result(), "status": svc.status(), "labels": svc._LABELS}


@router.post("/compare/run")
def run_compare(u: User = Depends(require_role(*VIEW))):
    if svc.status()["running"]:
        return {"started": False, "status": svc.status()}
    threading.Thread(target=svc.run_compare, daemon=True, name="product-compare").start()
    return {"started": True}


@router.post("/master-auto/run")
def run_master(u: User = Depends(require_role(*VIEW))):
    """Гар «Мастер нэгтгэл»-тэй ижил эрх (admin/supervisor/manager)."""
    if svc.status()["running"]:
        return {"started": False, "status": svc.status()}
    threading.Thread(target=svc.run_master_auto, args=(u.username or "admin",), daemon=True,
                     name="product-master-auto").start()
    return {"started": True}
