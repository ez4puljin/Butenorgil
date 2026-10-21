"""Үнэ харах — заалны таблет дээрх барааны үнийн лавлагаа.

    GET  /price-check/lookup?q=<баркод | код | нэр>
    POST /price-check/label/print {q, copies} — заалны XP-80C принтер рүү ШУУД (app/services/label_printer)

Эх сурвалж: offline POS (192.168.1.254:7000 → API 4030) — app/services/pos_price.

Эрх: нэвтэрсэн ЛЮБОЙ хэрэглэгч. Заалны таблет дундын бүртгэлээр нэвтэрдэг
бөгөөд энэ цэс нь үйлчлүүлэгч лангуун дээр аль хэдийн харж байгаа үнийг л
харуулдаг тул role-оор хязгаарлах шаардлагагүй.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse

from app.api.deps import get_current_user
from app.models.user import User
from pydantic import BaseModel

from app.services import label_printer, pos_label, pos_price

router = APIRouter(prefix="/price-check", tags=["price-check"])


@router.get("/lookup")
def lookup(
    q: str = Query(..., min_length=1, max_length=80, description="Баркод, код эсвэл нэр"),
    _: User = Depends(get_current_user),
):
    """Баркод/код/нэрээр барааны POS үнийг олно.

    Онлайн POS-оос ~0.4 сек (60 сек кэштэй). Скан хийсэн баркодыг өөр
    бараатай холихгүйн тулд ЯГ таарсныг (код эсвэл баркод) эрхэмлэнэ —
    нэрээр таарсан бол `found=false`, `others`-д санал болгоно."""
    return pos_price.lookup(q)


@router.get("/status")
def status(_: User = Depends(get_current_user)):
    """Онлайн POS-той холбогдож байгаа эсэх (UI анхааруулга, эх сурвалж харуулахад)."""
    return pos_price.status()


@router.get("/label", response_class=HTMLResponse)
def label(
    q: str = Query(..., min_length=1, max_length=80, description="Баркод эсвэл код"),
    copies: int = Query(1, ge=1, le=20),
    preview: bool = Query(False, description="Зөвхөн харах — автоматаар хэвлэхгүй"),
    _: User = Depends(get_current_user),
):
    """Үнийн шошго — хэвлэхэд бэлэн HTML (нэр, код, үнэ, бөөний ширхэг/үнэ, огноо).

    Шошгыг өөрсдөө зурна — erxes-ийн хуучин document загвар шинэчлэлтийн дараа
    ажиллахаа больсон. Бөөний мэдээлэл онлайн POS-ийн pricing-оос."""
    r = pos_price.lookup(q)
    p = r.get("product")
    if not p:
        raise HTTPException(404, "Бараа олдсонгүй.")
    try:
        return HTMLResponse(pos_label.label_page(p, copies, auto_print=not preview))
    except pos_label.LabelError as e:
        raise HTTPException(502, str(e))


class PrintIn(BaseModel):
    q: str
    copies: int = 1


@router.post("/label/print")
def label_print(body: PrintIn, _: User = Depends(get_current_user)):
    """Шошгыг заалны XP-80C (\\192.168.1.106\XP-80C Zaal) принтер рүү шууд хэвлэнэ — харилцах цонхгүй."""
    p = (pos_price.lookup((body.q or "").strip()) or {}).get("product")
    if not p:
        raise HTTPException(404, "Бараа олдсонгүй.")
    try:
        return label_printer.print_label(p, body.copies)
    except (label_printer.PrintError, pos_label.LabelError) as e:
        raise HTTPException(502, str(e))


@router.get("/bulk")
def bulk(
    q: str = Query(..., min_length=1, max_length=80),
    _: User = Depends(get_current_user),
):
    """Бөөний ширхэг/үнэ — онлайн POS-ийн pricing (шошготой ижил эх сурвалж).

    Тусдаа зам болгосон шалтгаан: шошгоны загвар render хийхэд 0.6-1.6 сек болдог
    тул үндсэн үнийг эхэлж харуулаад үүнийг ард нь ачаална."""
    p = (pos_price.lookup(q) or {}).get("product")
    if not p:
        raise HTTPException(404, "Бараа олдсонгүй.")
    try:
        return pos_label.bulk_info(p["_id"], p.get("price"))
    except Exception as e:      # noqa: BLE001 — бөөн мэдээлэл заавал биш
        return {"quantity": "", "price": "", "unit_price": "", "ok": False,
                "error": str(e)[:120]}
