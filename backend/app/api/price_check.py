"""Үнэ харах — заалны таблет дээрх барааны үнийн лавлагаа.

    GET /price-check/lookup?q=<баркод | код | нэр>

Эрх: нэвтэрсэн ЛЮБОЙ хэрэглэгч. Заалны таблет дундын бүртгэлээр нэвтэрдэг
бөгөөд энэ цэс нь үйлчлүүлэгч лангуун дээр аль хэдийн харж байгаа үнийг л
харуулдаг тул role-оор хязгаарлах шаардлагагүй.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse

from app.api.deps import get_current_user
from app.models.user import User
from app.services import pos_label, pos_price

router = APIRouter(prefix="/price-check", tags=["price-check"])


@router.get("/lookup")
def lookup(
    q: str = Query(..., min_length=1, max_length=80, description="Баркод, код эсвэл нэр"),
    _: User = Depends(get_current_user),
):
    """Баркод/код/нэрээр барааны POS үнийг олно.

    Локал POS-оос шууд уншдаг тул ~30-130 мс. Скан хийсэн баркодыг өөр
    бараатай холихгүйн тулд ЯГ таарсныг (код эсвэл баркод) эрхэмлэнэ —
    нэрээр таарсан бол `found=false`, `others`-д санал болгоно."""
    return pos_price.lookup(q)


@router.get("/status")
def status(_: User = Depends(get_current_user)):
    """Тохиргоо бүрэн эсэх (UI анхааруулга харуулахад)."""
    from app.services.pos_reconcile import local_urls
    return {"enabled": pos_price.enabled(), "pos_count": len(local_urls())}


@router.get("/label", response_class=HTMLResponse)
def label(
    q: str = Query(..., min_length=1, max_length=80, description="Баркод эсвэл код"),
    copies: int = Query(1, ge=1, le=20),
    preview: bool = Query(False, description="Зөвхөн харах — автоматаар хэвлэхгүй"),
    _: User = Depends(get_current_user),
):
    """Үнийн шошго — хэвлэхэд бэлэн HTML.

    Шошгыг erxes-ийн бэлэн загвараас татна (бөөний ширхэг/үнэ нь тэнд
    бодогддог), дээр нь хэвлэсэн огноо нэмнэ."""
    r = pos_price.lookup(q)
    p = r.get("product")
    if not p:
        raise HTTPException(404, "Бараа олдсонгүй.")
    try:
        return HTMLResponse(pos_label.label_page(p["_id"], copies, auto_print=not preview))
    except pos_label.LabelError as e:
        raise HTTPException(502, str(e))


@router.get("/bulk")
def bulk(
    q: str = Query(..., min_length=1, max_length=80),
    _: User = Depends(get_current_user),
):
    """Бөөний ширхэг/үнэ — шошготой ижил эх сурвалжаас (erxes загвар).

    Тусдаа зам болгосон шалтгаан: erxes руу 0.6-1.6 сек болдог тул үндсэн
    үнийг локал POS-оос шууд (~80 мс) харуулаад үүнийг ард нь ачаална."""
    p = (pos_price.lookup(q) or {}).get("product")
    if not p:
        raise HTTPException(404, "Бараа олдсонгүй.")
    try:
        return pos_label.bulk_info(p["_id"])
    except Exception as e:      # noqa: BLE001 — бөөн мэдээлэл заавал биш
        return {"quantity": "", "price": "", "unit_price": "", "ok": False,
                "error": str(e)[:120]}
